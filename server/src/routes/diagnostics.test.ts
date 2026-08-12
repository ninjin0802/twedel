import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../index.js';
import type { DiagnosticsPayload, DiagnosticsProbe } from '../x/diagnostics.js';
import { probeMatrix, viewerProbeUrl } from '../x/diagnostics.js';
import { WEB_BEARER } from '../x/endpoints.js';
import { resetQueryIdState, setManualQueryId } from '../x/queryId.js';
import { clearSession, setCredentials } from '../x/session.js';
import { setManualTransactionId } from '../x/transactionId.js';

/**
 * `GET /api/diagnostics` over a real socket.
 *
 * The two properties under test are the ones the route is worth having for:
 *  - it reports what X said for every probe, including the ones that throw;
 *  - it never, under any circumstance, emits a credential. The test for that
 *    scans the ENTIRE serialised response for the literal test cookies rather
 *    than checking individual fields - a field-by-field check only ever proves
 *    something about the fields somebody remembered to check.
 */

const AUTH = 'auth-token-DIAGNOSTICS-must-never-leak';
const CT0 = 'ct0-DIAGNOSTICS-must-never-leak';

let server: Server;
let base: string;
let dir: string;
let previousDataDir: string | undefined;

/** Per-URL behaviour, so a probe can be made to succeed, 404 or explode. */
let settingsStatus = 403;
let iApiHomeThrows = false;

/**
 * A string that exists ONLY inside a response body. If it ever reaches the
 * payload, the route is quoting bodies back - which is the mechanism by which a
 * credential echoed inside an error page would escape.
 */
const PAGE_MARKER = 'RAW-BODY-CONTENT-THAT-MUST-NOT-BE-QUOTED';

const msw = setupServer(
  http.get('https://x.com/i/api/1.1/account/settings.json', () =>
    HttpResponse.json(
      settingsStatus === 200
        ? { screen_name: 'owner', id_str: '42', protected: false }
        : { errors: [{ code: 32, message: 'Could not authenticate you' }] },
      { status: settingsStatus },
    ),
  ),
  http.get('https://x.com/i/api/1.1/account/verify_credentials.json', () =>
    HttpResponse.json({ errors: [{ code: 220, message: 'Not authorized.' }] }, { status: 403 }),
  ),
  http.get('https://api.x.com/1.1/account/settings.json', () =>
    HttpResponse.json(
      { errors: [{ code: 34, message: 'Sorry, that page does not exist.' }] },
      { status: 404 },
    ),
  ),
  http.get('https://x.com/i/api/graphql/:queryId/Viewer', () =>
    HttpResponse.json(
      { errors: [{ message: 'Rate limit exceeded', extensions: { code: 88 } }] },
      { status: 429 },
    ),
  ),
  // The timeline family. X routes some subset of these per account, which is
  // exactly what the new rows exist to show: the legacy combined read 404s here
  // while the split family answers.
  http.get('https://x.com/i/api/graphql/:queryId/UserTweetsAndReplies', () =>
    HttpResponse.json({ errors: [{ message: 'Not found' }] }, { status: 404 }),
  ),
  http.get('https://x.com/i/api/graphql/:queryId/UserTweets', () =>
    HttpResponse.json({ errors: [{ message: 'Not found' }] }, { status: 404 }),
  ),
  http.get('https://x.com/i/api/graphql/:queryId/UserOriginalsTimeline', () =>
    HttpResponse.json({ data: { user: { result: { __typename: 'User' } } } }),
  ),
  http.get('https://x.com/i/api/graphql/:queryId/UserRepliesTimeline', () =>
    HttpResponse.json({ data: { user: { result: { __typename: 'User' } } } }),
  ),
  http.get('https://x.com/i/api/graphql/:queryId/UserRepostsTimeline', () =>
    HttpResponse.json({ data: { user: { result: { __typename: 'User' } } } }),
  ),
  http.get('https://x.com/', () => {
    if (iApiHomeThrows) return HttpResponse.error();
    return HttpResponse.html(`<!doctype html><html><body>${PAGE_MARKER}</body></html>`);
  }),
);

async function getDiagnostics(): Promise<DiagnosticsPayload> {
  const res = await fetch(`${base}/api/diagnostics`);
  expect(res.status).toBe(200);
  return (await res.json()) as DiagnosticsPayload;
}

function probe(payload: DiagnosticsPayload, urlFragment: string): DiagnosticsProbe {
  const found = payload.probes.find((p) => p.url.includes(urlFragment));
  if (!found) throw new Error(`no probe for ${urlFragment}`);
  return found;
}

beforeAll(async () => {
  previousDataDir = process.env['TWEDEL_DATA_DIR'];
  dir = await mkdtemp(join(tmpdir(), 'twedel-diagnostics-'));
  process.env['TWEDEL_DATA_DIR'] = dir;

  // Everything aimed at x.com must be mocked (nothing may reach the real
  // network), but the test's own requests to twedel's ephemeral loopback port
  // have to pass straight through.
  msw.listen({
    onUnhandledRequest: (request, print) => {
      if (new URL(request.url).hostname === '127.0.0.1') return;
      print.error();
    },
  });
  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  msw.close();
  await new Promise<void>((r) => server.close(() => r()));
  if (previousDataDir === undefined) delete process.env['TWEDEL_DATA_DIR'];
  else process.env['TWEDEL_DATA_DIR'] = previousDataDir;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearSession();
  resetQueryIdState();
  setManualTransactionId(null);
  settingsStatus = 403;
  iApiHomeThrows = false;
});

afterEach(() => msw.resetHandlers());

/**
 * The matrix is a contract, not an implementation detail: it is the list of
 * spellings twedel claims to have compared. Pin the exact URLs.
 */
describe('the probe matrix', () => {
  it('probes the exact URLs it promises, in order', () => {
    expect(probeMatrix()).toEqual([
      { label: 'x.com (document fetch)', url: 'https://x.com', headerSet: 'document' },
      { label: 'x.com (API headers)', url: 'https://x.com', headerSet: 'api' },
      {
        label: 'v1.1 settings.json via x.com/i/api',
        url: 'https://x.com/i/api/1.1/account/settings.json',
        headerSet: 'api',
      },
      {
        label: 'v1.1 settings.json via api.x.com',
        url: 'https://api.x.com/1.1/account/settings.json',
        headerSet: 'api',
      },
      {
        label: 'v1.1 verify_credentials.json via x.com/i/api',
        url: 'https://x.com/i/api/1.1/account/verify_credentials.json',
        headerSet: 'api',
      },
    ]);
  });

  it('fetches the SAME x.com url two different ways - that is the comparison', () => {
    const home = probeMatrix().filter((p) => p.url === 'https://x.com');
    expect(home).toHaveLength(2);
    expect(home.map((p) => p.headerSet)).toEqual(['document', 'api']);
  });

  it('has no Viewer url until a queryId is known, and never scrapes for one', () => {
    resetQueryIdState();
    expect(viewerProbeUrl()).toBeNull();

    setManualQueryId('Viewer', 'ABCVIEWER123');
    const url = viewerProbeUrl() ?? '';
    expect(url).toContain('https://x.com/i/api/graphql/ABCVIEWER123/Viewer?');
    expect(url).toContain('variables=');
    expect(url).toContain('features=');
  });
});

describe('GET /api/diagnostics with no session configured', () => {
  it('answers 200 with a well-formed payload instead of erroring', async () => {
    const body = await getDiagnostics();

    expect(body.transport).toEqual({ mode: 'cookie', connected: false });
    expect(body.transactionId).toEqual({ manualPinned: false });
    expect(typeof body.generatedAt).toBe('string');
    expect(body.queryIds.known).toEqual({});
    expect(body.queryIds.lastScrape).toBeNull();
    expect(body.probes.length).toBeGreaterThan(0);
  });

  it('marks every probe skipped, with a reason, and sends no request', async () => {
    setManualQueryId('Viewer', 'ABCVIEWER123');
    setManualQueryId('UserTweetsAndReplies', 'ABCTIMELINE1');
    const body = await getDiagnostics();

    // Including the timeline rows, which have an id but nothing to send it with.
    expect(body.probes.filter((p) => p.label.startsWith('timeline '))).toHaveLength(5);
    for (const p of body.probes) {
      expect(p.skipped).toMatch(/no session is configured/);
      expect(p.status).toBeNull();
    }
  });

  it('says in the payload itself that it is safe to share', async () => {
    const body = await getDiagnostics();
    expect(body.note).toMatch(/NO credentials/i);
    expect(body.note).toMatch(/safe to paste/i);
  });
});

describe('GET /api/diagnostics with a session', () => {
  beforeEach(async () => {
    settingsStatus = 200;
    await setCredentials(AUTH, CT0, 'cookie');
  });

  it('returns one row per probe with a status and the body key names', async () => {
    const body = await getDiagnostics();

    const settings = probe(body, 'x.com/i/api/1.1/account/settings.json');
    expect(settings.status).toBe(200);
    expect(settings.jsonBody).toBe(true);
    // Key NAMES only - never the values behind them.
    expect(settings.bodyKeys.sort()).toEqual(['id_str', 'protected', 'screen_name']);
    expect(settings.bodyLength).toBeGreaterThan(0);
    expect(settings.skipped).toBeUndefined();
  });

  /**
   * The comparison the whole route exists for: is it the API header set that
   * breaks the HTML fetch? Both rows address the SAME url.
   */
  it('probes x.com both as a document and with API headers', async () => {
    const body = await getDiagnostics();

    const rows = body.probes.filter((p) => p.url === 'https://x.com');
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.headerSet).sort()).toEqual(['api', 'document']);
    for (const row of rows) expect(row.status).toBe(200);
  });

  it('probes settings.json on BOTH hosts so the routing difference is visible', async () => {
    const body = await getDiagnostics();

    expect(probe(body, 'x.com/i/api/1.1/account/settings.json').status).toBe(200);

    const legacy = probe(body, 'api.x.com/1.1/account/settings.json');
    expect(legacy.status).toBe(404);
    // A 404 that carries X's own error text is exactly the evidence that a 404
    // here is a routing refusal, not a removed endpoint.
    expect(legacy.errors?.[0]?.code).toBe(34);
    expect(legacy.errors?.[0]?.message).toMatch(/does not exist/);
  });

  it('reports verify_credentials.json through the /i/api route', async () => {
    const body = await getDiagnostics();
    const verify = probe(body, 'verify_credentials.json');
    expect(verify.url).toBe('https://x.com/i/api/1.1/account/verify_credentials.json');
    expect(verify.status).toBe(403);
    expect(verify.errors?.[0]?.code).toBe(220);
  });

  it('skips the Viewer probe, saying why, when no queryId is known', async () => {
    const body = await getDiagnostics();
    const viewer = body.probes.find((p) => p.label === 'GraphQL Viewer');
    expect(viewer?.skipped).toMatch(/no queryId is known for Viewer/);
    expect(viewer?.status).toBeNull();
  });

  it('runs the Viewer probe and reports its GraphQL errors when an id is pinned', async () => {
    setManualQueryId('Viewer', 'PINNEDVIEWER');
    const body = await getDiagnostics();

    const viewer = body.probes.find((p) => p.label === 'GraphQL Viewer');
    expect(viewer?.url).toContain('/graphql/PINNEDVIEWER/Viewer');
    expect(viewer?.status).toBe(429);
    expect(viewer?.errors).toEqual([{ message: 'Rate limit exceeded', code: 88 }]);

    // ...and the pinned id is reported as a pin, not just as "known".
    expect(body.queryIds.manual).toEqual({ Viewer: 'PINNEDVIEWER' });
    expect(body.queryIds.known['Viewer']).toBe('PINNEDVIEWER');
  });

  it('reports a pinned manual transaction id as a boolean, never the value', async () => {
    setManualTransactionId('SECRET-LOOKING-TRANSACTION-ID');
    const res = await fetch(`${base}/api/diagnostics`);
    const raw = await res.text();

    expect((JSON.parse(raw) as DiagnosticsPayload).transactionId.manualPinned).toBe(true);
    expect(raw).not.toContain('SECRET-LOOKING-TRANSACTION-ID');
  });

  it('turns a probe that throws into a row, and still answers the rest', async () => {
    iApiHomeThrows = true;
    const body = await getDiagnostics();

    const rows = body.probes.filter((p) => p.url === 'https://x.com');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.status).toBeNull();
      expect(row.error).toBeTruthy();
    }
    // The rest of the matrix ran regardless.
    expect(probe(body, 'x.com/i/api/1.1/account/settings.json').status).toBe(200);
  });

  it('reports the transport mode and the connected account', async () => {
    const body = await getDiagnostics();
    expect(body.transport).toEqual({ mode: 'cookie', connected: true, screenName: 'owner' });
  });

  /**
   * The failure this answers: the live fetch died with a 404 for
   * `UserTweetsAndReplies` while `UserByScreenName` resolved fine and `Viewer`
   * answered 200, all on the same session with ids from the same scrape. Which
   * timeline operations X routes for THIS account has to be answerable in one
   * request rather than by running a delete.
   */
  it('reports one row per timeline candidate operation', async () => {
    for (const [op, id] of Object.entries({
      UserTweetsAndReplies: 'TAR_QID',
      UserTweets: 'UT_QID',
      UserOriginalsTimeline: 'ORIG_QID',
      UserRepliesTimeline: 'REPL_QID',
      UserRepostsTimeline: 'REPO_QID',
    })) {
      setManualQueryId(op, id);
    }

    const body = await getDiagnostics();
    const rows = body.probes.filter((p) => p.label.startsWith('timeline '));

    // Rows follow the candidate probe order: the combined stream, then the
    // reply-covering split family, then the partial UserTweets last resort.
    expect(rows.map((r) => r.label)).toEqual([
      'timeline UserTweetsAndReplies',
      'timeline UserOriginalsTimeline',
      'timeline UserRepliesTimeline',
      'timeline UserRepostsTimeline',
      'timeline UserTweets',
    ]);
    // The resolved queryId is part of the URL, which is what makes a row
    // actionable: it names the exact request that 404'd.
    expect(rows[0]?.url).toContain('/graphql/TAR_QID/UserTweetsAndReplies');
    // ...and the split that is alive is visibly different from the combined
    // reads that are not: UserTweetsAndReplies (row 0) and UserTweets (row 4).
    expect(rows[0]?.status).toBe(404);
    expect(rows[4]?.status).toBe(404);
    expect(rows[1]?.status).toBe(200);
    expect(rows[2]?.status).toBe(200);
    expect(rows[3]?.status).toBe(200);
  });

  it('skips a timeline row rather than scraping for an id it does not have', async () => {
    const body = await getDiagnostics();
    const rows = body.probes.filter((p) => p.label.startsWith('timeline '));

    expect(rows).toHaveLength(5);
    for (const row of rows) {
      expect(row.skipped).toMatch(/no queryId is known for User/);
      expect(row.status).toBeNull();
    }
  });

  it('reports which timeline source is actually in use', async () => {
    const body = await getDiagnostics();
    // Nothing has fetched in this process, so there is no answer yet - and the
    // payload says so instead of implying the default is in use.
    expect(body.timelineSource).toBeNull();
  });

  /**
   * The one that matters. Scan the WHOLE serialised response, not selected
   * fields: the promise made to the user is "paste this anywhere", and that is
   * only true if it holds for text nobody thought to inspect.
   */
  it('never emits the cookie, the ct0 or the bearer anywhere in the payload', async () => {
    setManualQueryId('Viewer', 'PINNEDVIEWER');
    const raw = await (await fetch(`${base}/api/diagnostics`)).text();

    expect(raw).not.toContain(AUTH);
    expect(raw).not.toContain(CT0);
    expect(raw).not.toContain(WEB_BEARER);
    // The bearer's payload half, in case it is ever split from the "Bearer " prefix.
    expect(raw).not.toContain(WEB_BEARER.replace('Bearer ', ''));
    // No raw response body, and no request headers, ever.
    expect(raw).not.toContain(PAGE_MARKER);
    expect(raw.toLowerCase()).not.toContain('auth_token=');
    expect(raw.toLowerCase()).not.toContain('x-csrf-token');
  });
});
