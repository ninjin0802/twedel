import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_QUERY_IDS } from './endpoints.js';
import type { PlaywrightDeps, PwContext, PwCookie, PwPage } from './playwright.js';
import { knownQueryIds, resetQueryIdState, setManualQueryId } from './queryId.js';
import {
  HARVEST_CONNECTED_MESSAGE,
  clearSession,
  getSavedAccounts,
  getSession,
  getTransport,
  harvestSession,
  removeSavedAccount,
  resetSavedAccounts,
  switchSavedAccount,
  setCredentials,
} from './session.js';

const AUTH = 'auth-token-4d8f2a1b9c7e';
const CT0 = 'ct0-9f3e2d1c8b7a';

interface Reply {
  status: number;
  body: unknown;
}

let settingsReply: Reply = { status: 200, body: { screen_name: 'owner' } };
/**
 * The second queryId-free probe. Defaulted to 404 so it stays INERT unless a
 * test opts in - every pre-existing expectation about "settings.json, then
 * Viewer" keeps meaning what it meant.
 */
let verifyReply: Reply = { status: 404, body: {} };
let viewerReply: Reply = { status: 200, body: {} };
let settingsHits = 0;
let verifyHits = 0;
let viewerHits = 0;
/**
 * Requests that went to the LEGACY `api.x.com` host. Must stay 0: that host
 * answers 404/401 for the very paths `x.com/i/api` answers 403 for, and every
 * "settings.json → HTTP 404" the user saw came out of it.
 */
let apiHostHits = 0;
/** Headers seen on the probe requests, so the header set can be asserted. */
let settingsHeaders: Record<string, string> = {};
/** What x.com's HTML shell serves the queryId scraper. Empty = scrape broken. */
let homeHtml = '<!doctype html><html><head></head><body></body></html>';

const settingsHandler = ({ request }: { request: Request }) => {
  settingsHits += 1;
  settingsHeaders = Object.fromEntries(request.headers.entries());
  return HttpResponse.json(settingsReply.body as Record<string, unknown>, {
    status: settingsReply.status,
  });
};

const verifyHandler = () => {
  verifyHits += 1;
  return HttpResponse.json(verifyReply.body as Record<string, unknown>, {
    status: verifyReply.status,
  });
};

const server = setupServer(
  // Both transports now address the v1.1 probes through the same-origin
  // `/i/api` path X's own web client uses.
  http.get('https://x.com/i/api/1.1/account/settings.json', settingsHandler),
  http.get('https://x.com/i/api/1.1/account/verify_credentials.json', verifyHandler),
  // The legacy host is still mocked - but only so a request to it is COUNTED
  // rather than blowing up as an unhandled request. Nothing should reach it.
  http.get('https://api.x.com/1.1/*', () => {
    apiHostHits += 1;
    return HttpResponse.json({ errors: [{ code: 34, message: 'Sorry, that page does not exist.' }] }, { status: 404 });
  }),
  http.get('https://x.com/i/api/graphql/:queryId/Viewer', () => {
    viewerHits += 1;
    return HttpResponse.json(viewerReply.body as Record<string, unknown>, { status: viewerReply.status });
  }),
  // The queryId scraper's first stop when no id is pinned or cached.
  http.get('https://x.com/', () => HttpResponse.html(homeHtml)),
);

let dir = '';

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'twedel-session-'));
  process.env['TWEDEL_DATA_DIR'] = dir;
  server.listen({ onUnhandledRequest: 'error' });
});

afterAll(async () => {
  server.close();
  delete process.env['TWEDEL_DATA_DIR'];
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await clearSession();
  await rm(join(dir, 'accounts.json'), { force: true });
  resetQueryIdState();
  settingsHits = 0;
  verifyHits = 0;
  viewerHits = 0;
  apiHostHits = 0;
  settingsHeaders = {};
  settingsReply = { status: 200, body: { screen_name: 'owner' } };
  verifyReply = { status: 404, body: {} };
  viewerReply = { status: 200, body: {} };
  homeHtml = '<!doctype html><html><head></head><body></body></html>';
});

afterEach(() => server.resetHandlers());

describe('setCredentials - happy path', () => {
  it('returns the screen name from account/settings.json', async () => {
    const info = await setCredentials(AUTH, CT0, 'cookie');

    expect(info.connected).toBe(true);
    expect(info.mode).toBe('cookie');
    expect(info.screenName).toBe('owner');
    expect(settingsHits).toBe(1);
  });

  it('never returns the cookies themselves', async () => {
    const info = await setCredentials(AUTH, CT0, 'cookie');
    const serialized = JSON.stringify(info);

    expect(serialized).not.toContain(AUTH);
    expect(serialized).not.toContain(CT0);
    expect(Object.keys(info).sort()).toEqual(['connected', 'mode', 'screenName', 'userId']);
  });

  it('picks up a user id when the response offers one', async () => {
    settingsReply = { status: 200, body: { screen_name: 'owner', id_str: '4242' } };
    const info = await setCredentials(AUTH, CT0, 'cookie');
    expect(info.userId).toBe('4242');
  });

  it('leaves userId undefined when the response has none', async () => {
    const info = await setCredentials(AUTH, CT0, 'cookie');
    expect(info.userId).toBeUndefined();
  });

  it('persists the session to <dataDir>/session.json', async () => {
    await setCredentials(AUTH, CT0, 'cookie');
    const stored = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')) as {
      authToken: string;
      ct0: string;
      screenName: string;
    };

    expect(stored.authToken).toBe(AUTH);
    expect(stored.ct0).toBe(CT0);
    expect(stored.screenName).toBe('owner');
  });

  it('saves multiple accounts and switches without exposing credentials', async () => {
    settingsReply = { status: 200, body: { screen_name: 'first', id_str: '1' } };
    await setCredentials(AUTH, CT0, 'cookie');
    settingsReply = { status: 200, body: { screen_name: 'second', id_str: '2' } };
    await setCredentials('second-auth-token', 'second-ct0-token', 'cookie');

    const accounts = await getSavedAccounts();
    expect(accounts.map((account) => account.screenName).sort()).toEqual(['first', 'second']);
    expect(JSON.stringify(accounts)).not.toContain(AUTH);
    expect(JSON.stringify(accounts)).not.toContain(CT0);

    settingsReply = { status: 200, body: { screen_name: 'first', id_str: '1' } };
    const switched = await switchSavedAccount('id:1');
    expect(switched).toMatchObject({ connected: true, screenName: 'first', userId: '1' });
    expect((await getSavedAccounts()).find((account) => account.id === 'id:1')?.active).toBe(true);
  });

  it('refuses a saved label whose cookies resolve to a different account', async () => {
    settingsReply = { status: 200, body: { screen_name: 'first', id_str: '1' } };
    await setCredentials(AUTH, CT0, 'cookie');
    settingsReply = { status: 200, body: { screen_name: 'different', id_str: '999' } };
    const switched = await switchSavedAccount('id:1');
    expect(switched).toMatchObject({ connected: false, mode: 'cookie' });
    expect(switched?.message).toMatch(/一致しません/);
  });

  it('removes the active account without migrating it back from session.json', async () => {
    settingsReply = { status: 200, body: { screen_name: 'owner', id_str: '42' } };
    await setCredentials(AUTH, CT0, 'cookie');
    expect(await removeSavedAccount('id:42')).toBe(true);
    expect(await getSavedAccounts()).toEqual([]);
    await expect(getSession()).resolves.toEqual({ connected: false, mode: 'cookie' });
  });

  it('resets every saved account and the current connection', async () => {
    await setCredentials(AUTH, CT0, 'cookie');
    await resetSavedAccounts();
    expect(await getSavedAccounts()).toEqual([]);
    await expect(getSession()).resolves.toEqual({ connected: false, mode: 'cookie' });
  });
});

/**
 * The route the probes take.
 *
 * `api.x.com/1.1/account/settings.json` answers 404 (or 401, depending on one
 * header) where `x.com/i/api/1.1/account/settings.json` answers 403 - "exists,
 * authenticate". The user's whole failure report was two of these 404s in a
 * row, read as "the endpoint is gone".
 */
describe('the v1.1 probes address x.com/i/api', () => {
  it('hits the /i/api URL and never the legacy api.x.com host', async () => {
    settingsReply = { status: 404, body: {} };
    verifyReply = { status: 404, body: {} };
    setManualQueryId('Viewer', 'VIEWERQID');
    viewerReply = { status: 404, body: {} };

    await setCredentials(AUTH, CT0, 'cookie');

    expect(settingsHits).toBe(1);
    expect(verifyHits).toBe(1);
    expect(apiHostHits).toBe(0);
  });

  it('sends the full API header set on them, browser identity included', async () => {
    await setCredentials(AUTH, CT0, 'cookie');

    expect(settingsHeaders['authorization']).toBeTruthy();
    expect(settingsHeaders['x-twitter-auth-type']).toBe('OAuth2Session');
    expect(settingsHeaders['x-csrf-token']).toBe(CT0);
    expect(settingsHeaders['user-agent']).toMatch(/Chrome\/\d+/);
    expect(settingsHeaders['referer']).toBe('https://x.com/');
    expect(settingsHeaders['origin']).toBe('https://x.com');
  });
});

/**
 * Probe order.
 *
 * Measured 2026-08-12 on a live session: both v1.1 endpoints answer 404 + code
 * 34 (retired) while GraphQL `Viewer` answers 200. Leading with two dead
 * endpoints cost two requests per connect and made every failure message open
 * with two irrelevant causes.
 */
describe('the probe chain leads with Viewer', () => {
  it('tries Viewer FIRST and never touches the v1.1 endpoints when it answers', async () => {
    setManualQueryId('Viewer', 'VIEWERQID');
    viewerReply = {
      status: 200,
      body: {
        data: {
          viewer: {
            user_results: {
              result: { rest_id: '13579', legacy: { screen_name: 'viewer-owner' } },
            },
          },
        },
      },
    };

    const info = await setCredentials(AUTH, CT0, 'cookie');

    expect(info.connected).toBe(true);
    expect(info.screenName).toBe('viewer-owner');
    expect(viewerHits).toBe(1);
    expect(settingsHits).toBe(0);
    expect(verifyHits).toBe(0);
  });

  it('still falls through to the v1.1 probes when Viewer answers nothing useful', async () => {
    setManualQueryId('Viewer', 'VIEWERQID');
    viewerReply = { status: 500, body: {} };
    settingsReply = { status: 200, body: { screen_name: 'owner' } };

    const info = await setCredentials(AUTH, CT0, 'cookie');

    expect(info.connected).toBe(true);
    expect(viewerHits).toBe(1);
    expect(settingsHits).toBe(1);
  });
});

describe('setCredentials - rejection', () => {
  it('returns connected:false with an actionable message on 401', async () => {
    settingsReply = { status: 401, body: { errors: [{ code: 32, message: 'Could not authenticate you' }] } };
    const info = await setCredentials(AUTH, CT0, 'cookie');

    expect(info.connected).toBe(false);
    expect(info.message).toMatch(/stale or wrong/i);
    expect(info.message).toMatch(/auth_token/);
    expect(info.message).toMatch(/ct0/);
    expect(info.message).not.toContain(AUTH);
    expect(info.message).not.toContain(CT0);
  });

  it('returns connected:false on 403 too', async () => {
    settingsReply = { status: 403, body: {} };
    const info = await setCredentials(AUTH, CT0, 'cookie');
    expect(info.connected).toBe(false);
    expect(info.message).toMatch(/DevTools/);
  });

  it('rejects blank credentials without any network call', async () => {
    const info = await setCredentials('', CT0, 'cookie');
    expect(info.connected).toBe(false);
    expect(settingsHits).toBe(0);
  });

});

/* -------------------------------------------------------------------------- */
/* Playwright mode                                                             */
/* -------------------------------------------------------------------------- */

/**
 * A minimal fake browser context. No chrome.exe is ever started: `deps` is
 * injected all the way down, and `page.evaluate` just runs the in-page function
 * against the global `fetch` that msw has already intercepted.
 */
function fakeBrowser(options: { loggedIn?: boolean; jar?: () => PwCookie[] } = {}) {
  const state = { closed: 0, browserClosed: 0, clock: 0 };
  const page: PwPage = {
    goto: async () => {},
    evaluate: (fn, arg) => fn(arg),
  };
  const context: PwContext = {
    cookies: async () =>
      options.loggedIn === false
        ? []
        : (options.jar?.() ?? [
            { name: 'auth_token', value: 'from-the-browser' },
            { name: 'ct0', value: 'ct0-from-the-browser' },
          ]),
    pages: () => [page],
    newPage: async () => page,
    on: () => {},
    close: async () => {
      state.closed += 1;
    },
    browser: () => ({
      close: async () => {
        state.browserClosed += 1;
      },
    }),
  };
  const deps: Partial<PlaywrightDeps> = {
    launchPersistentContext: async () => context,
    // Virtual clock: the login gate polls against `now`/`sleep`, so a test that
    // waits for the timeout costs nothing in real time.
    sleep: async (ms: number) => {
      state.clock += ms;
    },
    now: () => state.clock,
  };
  return { state, deps };
}

function connectPw(over: Partial<PlaywrightDeps> = {}, loggedIn = true) {
  const browser = fakeBrowser({ loggedIn });
  const opts = {
    userDataDir: join(dir, 'pw-profile'),
    loginTimeoutMs: 10,
    pollIntervalMs: 1,
    deps: { ...browser.deps, ...over },
  };
  // The pasted cookies are deliberately empty: playwright mode ignores them.
  return { browser, result: setCredentials('', '', 'playwright', opts) };
}

describe('setCredentials - playwright mode', () => {
  it('connects with empty cookies and resolves the screen name the same way', async () => {
    const { result } = connectPw();
    const info = await result;

    expect(info.connected).toBe(true);
    expect(info.mode).toBe('playwright');
    expect(info.screenName).toBe('owner');
    expect(settingsHits).toBe(1);
    expect(getTransport().mode).toBe('playwright');
  });

  it('says plainly that the pasted cookies are unused and that it is not a bypass', async () => {
    const info = await connectPw().result;
    expect(info.message).toMatch(/auth_token and ct0 are not used in playwright mode/i);
    expect(info.message).toMatch(/x-client-transaction-id/);
    expect(info.message).toMatch(/can still be refused/i);
  });

  it('records the mode on disk so a restart reports playwright, not a stale cookie session', async () => {
    await connectPw().result;
    const stored = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')) as {
      mode: string;
      authToken: string;
      ct0: string;
    };
    expect(stored.mode).toBe('playwright');
    expect(stored.authToken).toBe('');
    expect(stored.ct0).toBe('');
  });

  it('cannot rehydrate a browser session, but remembers the mode', async () => {
    await connectPw().result;
    vi.resetModules();
    const fresh = await import('./session.js');
    await expect(fresh.getSession()).resolves.toEqual({ connected: false, mode: 'playwright' });
  });

  it('reports a launch failure with an actionable message instead of throwing', async () => {
    const { result } = connectPw({
      launchPersistentContext: () =>
        Promise.reject(new Error("Executable doesn't exist at chrome.exe")),
    });
    const info = await result;

    expect(info.connected).toBe(false);
    expect(info.mode).toBe('playwright');
    expect(info.message).toMatch(/Install Chrome/i);
    expect(settingsHits).toBe(0);
  });

  it('reports a login timeout without leaving the browser running', async () => {
    const { browser, result } = connectPw({}, false);
    const info = await result;

    expect(info.connected).toBe(false);
    expect(info.message).toMatch(/log in to x/i);
    expect(browser.state.closed).toBe(1);
    expect(browser.state.browserClosed).toBe(1);
  });

  it('blames the anti-automation check, not the cookies, on a 403', async () => {
    settingsReply = { status: 403, body: {} };

    const { browser, result } = connectPw();
    const info = await result;

    expect(info.connected).toBe(false);
    expect(info.message).toMatch(/not a cookie problem/i);
    expect(info.message).toMatch(/x-client-transaction-id/);
    expect(browser.state.closed).toBe(1);
  });

  it('closes the browser when the session is cleared', async () => {
    const { browser, result } = connectPw();
    await result;

    await clearSession();

    expect(browser.state.closed).toBe(1);
    expect(browser.state.browserClosed).toBe(1);
    expect(() => getTransport()).toThrow();
  });

  it('tears the browser down when switching back to cookie mode', async () => {
    const { browser, result } = connectPw();
    await result;

    await setCredentials(AUTH, CT0, 'cookie');

    expect(browser.state.closed).toBe(1);
    expect(browser.state.browserClosed).toBe(1);
    expect(getTransport().mode).toBe('cookie');
  });

  it('tears the old browser down before launching a new one', async () => {
    const first = connectPw();
    await first.result;
    const second = connectPw();
    await second.result;

    expect(first.browser.state.closed).toBe(1);
    expect(getTransport().mode).toBe('playwright');
  });
});

/* -------------------------------------------------------------------------- */
/* Harvest ("Chromeから取得")                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The point of the harvest is that it ends in an ORDINARY COOKIE SESSION: the
 * browser is a delivery mechanism for two strings and is closed again, so
 * nothing downstream (the delete runner, the live fetch, `session.json`) has to
 * learn about a third mode.
 *
 * Still no chrome.exe anywhere: the same injected `deps` seam, the same fake
 * context, and msw answering the probe chain that runs afterwards.
 */
const HARVESTED_AUTH = 'harvested-auth-token-1a2b3c';
const HARVESTED_CT0 = 'harvested-ct0-9z8y7x';

function harvestWith(
  jar: () => PwCookie[] = () => [
    { name: 'auth_token', value: HARVESTED_AUTH },
    { name: 'ct0', value: HARVESTED_CT0 },
  ],
  over: Partial<PlaywrightDeps> = {},
  loggedIn = true,
) {
  const browser = fakeBrowser({ loggedIn, jar });
  return {
    browser,
    result: harvestSession({
      userDataDir: join(dir, 'pw-profile'),
      loginTimeoutMs: 10,
      pollIntervalMs: 1,
      deps: { ...browser.deps, ...over },
    }),
  };
}

describe('harvestSession', () => {
  it('stores a COOKIE-mode session - not a playwright one - and names the account', async () => {
    const { browser, result } = harvestWith();
    const info = await result;

    expect(info.connected).toBe(true);
    expect(info.mode).toBe('cookie');
    expect(info.screenName).toBe('owner');
    // The harvested cookies went through the ordinary probe chain...
    expect(settingsHits).toBe(1);
    // ...and drive the fast direct transport from here on.
    expect(getTransport().mode).toBe('cookie');
    await expect(getSession()).resolves.toMatchObject({ connected: true, mode: 'cookie' });
    // The browser is NOT kept around, unlike playwright transport mode.
    expect(browser.state.closed).toBe(1);
    expect(browser.state.browserClosed).toBe(1);
  });

  it('persists the harvested cookies as a cookie session on disk', async () => {
    await harvestWith().result;
    const stored = JSON.parse(await readFile(join(dir, 'session.json'), 'utf8')) as {
      mode: string;
      authToken: string;
      ct0: string;
      screenName: string;
    };

    expect(stored.mode).toBe('cookie');
    expect(stored.authToken).toBe(HARVESTED_AUTH);
    expect(stored.ct0).toBe(HARVESTED_CT0);
    expect(stored.screenName).toBe('owner');
  });

  it('says where the cookies came from and that the window is gone on purpose', async () => {
    const info = await harvestWith().result;
    expect(info.message).toBe(HARVEST_CONNECTED_MESSAGE);
    expect(info.message).toMatch(/closed on purpose/);
    expect(info.message).toMatch(/harvest again/);
  });

  it('never returns the cookies it just harvested', async () => {
    const info = await harvestWith().result;
    const serialized = JSON.stringify(info);
    expect(serialized).not.toContain(HARVESTED_AUTH);
    expect(serialized).not.toContain(HARVESTED_CT0);
  });

  it('reports a login that never happens as a cookie-mode failure, browser closed', async () => {
    const { browser, result } = harvestWith(undefined, {}, false);
    const info = await result;

    expect(info.connected).toBe(false);
    // cookie, not playwright: the UI is sitting in cookie mode and the fallback
    // it should offer is the manual paste, not a different transport.
    expect(info.mode).toBe('cookie');
    expect(info.message).toMatch(/Timed out/);
    expect(info.message).toMatch(/log in to x/i);
    expect(browser.state.closed).toBe(1);
    expect(browser.state.browserClosed).toBe(1);
    expect(settingsHits).toBe(0);
  });

  it('reports a jar with no ct0 without pretending it connected', async () => {
    const { browser, result } = harvestWith(() => [
      { name: 'auth_token', value: HARVESTED_AUTH },
    ]);
    const info = await result;

    expect(info.connected).toBe(false);
    expect(info.mode).toBe('cookie');
    expect(info.message).toMatch(/ct0: missing/);
    expect(info.message).not.toContain(HARVESTED_AUTH);
    expect(settingsHits).toBe(0);
    expect(browser.state.closed).toBe(1);
  });

  it('surfaces a missing Chrome as an install instruction', async () => {
    const { result } = harvestWith(undefined, {
      launchPersistentContext: () =>
        Promise.reject(new Error("Executable doesn't exist at chrome.exe")),
    });
    const info = await result;

    expect(info.connected).toBe(false);
    expect(info.mode).toBe('cookie');
    expect(info.message).toMatch(/Install Chrome/i);
  });

  it('reports cookies X rejects as stale cookies, not as a harvest success', async () => {
    settingsReply = { status: 401, body: {} };
    viewerReply = { status: 401, body: {} };

    const info = await harvestWith().result;

    expect(info.connected).toBe(false);
    expect(info.mode).toBe('cookie');
    expect(info.message).toMatch(/stale or wrong/i);
    expect(info.message).not.toBe(HARVEST_CONNECTED_MESSAGE);
  });

  it('closes a live playwright browser first - it holds the profile lock', async () => {
    const pw = connectPw();
    await pw.result;
    expect(getTransport().mode).toBe('playwright');

    const { result } = harvestWith();
    const info = await result;

    expect(pw.browser.state.closed).toBe(1);
    expect(pw.browser.state.browserClosed).toBe(1);
    expect(info.connected).toBe(true);
    expect(getTransport().mode).toBe('cookie');
  });
});

/**
 * The user-visible bug: a settings.json that answered 404 was flattened into
 * "inconclusive", the code fell through to `Viewer`, `Viewer` could not resolve
 * its rotating queryId, and the user was shown a queryId error for a problem
 * that had nothing to do with queryIds. Every probe now has to say what it saw.
 */
describe('probe failures name themselves', () => {
  it('names a 404 from settings.json instead of hiding behind the Viewer error', async () => {
    settingsReply = { status: 404, body: {} };

    const info = await setCredentials(AUTH, CT0, 'cookie');

    expect(info.connected).toBe(false);
    expect(info.message).toMatch(/settings\.json → HTTP 404/);
  });

  it('names a 429, which is a rate limit and not a shape problem', async () => {
    settingsReply = { status: 429, body: { errors: [{ code: 88 }] } };

    const info = await setCredentials(AUTH, CT0, 'cookie');

    expect(info.connected).toBe(false);
    expect(info.message).toMatch(/settings\.json → HTTP 429 with a JSON object body/);
  });

  it('names a 200 whose shape changed, and says the body WAS json', async () => {
    settingsReply = { status: 200, body: { protected: false, language: 'en' } };

    const info = await setCredentials(AUTH, CT0, 'cookie');

    expect(info.connected).toBe(false);
    expect(info.message).toMatch(
      /settings\.json → HTTP 200 with a JSON object body but no screen_name anywhere in it/,
    );
  });

  it('names a 500 that answered html rather than json', async () => {
    server.use(
      // The probe route: `x.com/i/api`, not `api.x.com` - see endpoints.ts#V11_BASE.
      http.get('https://x.com/i/api/1.1/account/settings.json', () => {
        settingsHits += 1;
        return new HttpResponse('<html>Something went wrong</html>', {
          status: 500,
          headers: { 'content-type': 'text/html' },
        });
      }),
    );

    const info = await setCredentials(AUTH, CT0, 'cookie');

    expect(info.message).toMatch(/settings\.json → HTTP 500 with a non-JSON body \(\d+ chars of text\)/);
    // The body itself is never quoted back - it can echo anything.
    expect(info.message).not.toContain('Something went wrong');
  });

  it('chains all three causes, in the order they were tried', async () => {
    settingsReply = { status: 404, body: {} };
    verifyReply = { status: 503, body: {} };
    viewerReply = { status: 500, body: {} };
    setManualQueryId('Viewer', 'VIEWERQID');

    const info = await setCredentials(AUTH, CT0, 'cookie');

    expect(info.connected).toBe(false);
    const message = info.message ?? '';
    expect(message).toMatch(/Viewer → HTTP 500/);
    expect(message).toMatch(/settings\.json → HTTP 404/);
    expect(message).toMatch(/verify_credentials\.json → HTTP 503/);
    // Viewer leads now: it is the only probe X still answers.
    expect(message.indexOf('Viewer →')).toBeLessThan(message.indexOf('settings.json'));
    expect(message.indexOf('settings.json')).toBeLessThan(message.indexOf('verify_credentials'));
    // Still says what it is, in words.
    expect(message).toMatch(/could not read the account screen name/i);
  });

  /**
   * The one case the v1.1 fallbacks exist for: `Viewer` needs a rotating
   * queryId, and when not even the snapshot can supply one it has nothing to
   * send. It must FALL THROUGH - the probes that need no id at all are exactly
   * what is left - and every cause must still reach the user.
   */
  it('falls through to the v1.1 probes when Viewer has no queryId at all', async () => {
    settingsReply = { status: 404, body: {} };
    verifyReply = { status: 404, body: {} };
    // An HTML shell with no bundles: the scrape finds nothing, and with the
    // built-in snapshot taken away there is no id left to try.
    const savedDefault = DEFAULT_QUERY_IDS['Viewer'];
    DEFAULT_QUERY_IDS['Viewer'] = null;
    let message = '';
    try {
      message = (await setCredentials(AUTH, CT0, 'cookie')).message ?? '';
    } finally {
      DEFAULT_QUERY_IDS['Viewer'] = savedDefault ?? null;
    }

    expect(message).toMatch(/Viewer → \[twedel\] Could not resolve the GraphQL queryId/);
    // ...and the queryId error carries the scrape diagnostics with it.
    expect(message).toMatch(/0 bundle URL\(s\) discovered/);
    // The cheap probes still ran, and still reported for themselves.
    expect(settingsHits).toBe(1);
    expect(verifyHits).toBe(1);
    expect(message).toMatch(/settings\.json →/);
    expect(message).toMatch(/verify_credentials\.json →/);
  });

  /**
   * Both v1.1 endpoints answer 404 + code 34 on every host, for a session X is
   * simultaneously serving GraphQL to. That is a retirement, and saying so is
   * the difference between "nothing to fix here" and a user re-copying cookies.
   */
  it('reports a v1.1 404 with code 34 as a retirement, not as a mystery', async () => {
    const gone = {
      status: 404,
      body: { errors: [{ code: 34, message: 'Sorry, that page does not exist' }] },
    };
    settingsReply = gone;
    verifyReply = gone;
    viewerReply = { status: 500, body: {} };
    setManualQueryId('Viewer', 'VIEWERQID');

    const message = (await setCredentials(AUTH, CT0, 'cookie')).message ?? '';

    expect(message).toMatch(/settings\.json → HTTP 404 with X API error 34/);
    expect(message).toMatch(/this v1\.1 endpoint has been retired by X/);
    expect(message).toMatch(/verify_credentials\.json → HTTP 404 with X API error 34/);
    // Not the generic description, and not an invitation to go hunting.
    expect(message).not.toMatch(/settings\.json → HTTP 404 with a JSON object body/);
    expect(message).not.toMatch(/404 here does not mean the endpoint was removed/);
    expect(message).toMatch(/no header, host or cookie brings them back/);
    expect(message).toMatch(/diagnostics/);
  });

  /**
   * The message used to end "X may have changed the response shape.", which for
   * a run of 404s is simply the wrong diagnosis - and an expensive one, because
   * it sends the reader off editing endpoint constants. A single header flips
   * the same URL between 404 and 401.
   */
  it('does not blame a 404 on a changed response shape', async () => {
    settingsReply = { status: 404, body: {} };
    verifyReply = { status: 404, body: {} };

    const message = (await setCredentials(AUTH, CT0, 'cookie')).message ?? '';

    expect(message).not.toMatch(/changed the response shape/i);
    expect(message).toMatch(/404 here does not mean the endpoint was removed/i);
    expect(message).toMatch(/404 and 401/);
    // ...and it names the route that can actually tell them apart.
    expect(message).toMatch(/diagnostics/);
  });

  it('never leaks the cookies into a chained failure message', async () => {
    settingsReply = { status: 404, body: {} };
    verifyReply = { status: 404, body: {} };

    const info = await setCredentials(AUTH, CT0, 'cookie');

    expect(info.message).not.toContain(AUTH);
    expect(info.message).not.toContain(CT0);
  });
});

/**
 * The unblock: with the bundle scrape completely broken, a v1.1 endpoint that
 * needs no queryId is what still lets a user connect.
 */
describe('setCredentials - verify_credentials fallback', () => {
  it('connects through verify_credentials.json when settings.json is gone', async () => {
    settingsReply = { status: 404, body: {} };
    verifyReply = { status: 200, body: { screen_name: 'owner3', id_str: '1234567' } };

    const info = await setCredentials(AUTH, CT0, 'cookie');

    expect(info.connected).toBe(true);
    expect(info.screenName).toBe('owner3');
    expect(info.userId).toBe('1234567');
    expect(settingsHits).toBe(1);
    expect(verifyHits).toBe(1);
    // Viewer is tried first now and answered nothing useful; the queryId-free
    // fallback is what actually identified the account.
    expect(viewerHits).toBe(1);
  });

  it('is not consulted at all when settings.json already answered', async () => {
    await setCredentials(AUTH, CT0, 'cookie');
    expect(verifyHits).toBe(0);
  });

  it('treats a 401 from it as stale cookies, not as a shape change', async () => {
    settingsReply = { status: 404, body: {} };
    verifyReply = { status: 401, body: {} };

    const info = await setCredentials(AUTH, CT0, 'cookie');

    expect(info.connected).toBe(false);
    expect(info.message).toMatch(/stale or wrong/i);
    // A 401 from ANY probe is definitive, so the chain stops there.
    expect(verifyHits).toBe(1);
  });
});

describe('deep screen_name lookup', () => {
  it('finds a screen_name nested deeper in the settings body', async () => {
    settingsReply = {
      status: 200,
      body: { account: { user: { screen_name: 'nested-owner', id_str: '55667788' } } },
    };

    const info = await setCredentials(AUTH, CT0, 'cookie');

    expect(info.connected).toBe(true);
    expect(info.screenName).toBe('nested-owner');
    expect(info.userId).toBe('55667788');
    // settings.json answered, so the verify fallback behind it never ran.
    expect(verifyHits).toBe(0);
  });

  it('finds one nested in the verify_credentials body too', async () => {
    settingsReply = { status: 404, body: {} };
    verifyReply = { status: 200, body: { data: { user: { screen_name: 'deep-owner' } } } };

    const info = await setCredentials(AUTH, CT0, 'cookie');

    expect(info.connected).toBe(true);
    expect(info.screenName).toBe('deep-owner');
  });
});

describe('setCredentials - Viewer fallback', () => {
  it('falls back to the Viewer GraphQL op when settings.json is unavailable', async () => {
    settingsReply = { status: 404, body: {} };
    viewerReply = {
      status: 200,
      body: {
        data: {
          viewer: {
            user_results: {
              result: { __typename: 'User', rest_id: '99887766', legacy: { screen_name: 'owner2' } },
            },
          },
        },
      },
    };
    setManualQueryId('Viewer', 'VIEWERQID');

    const info = await setCredentials(AUTH, CT0, 'cookie');
    expect(info.connected).toBe(true);
    expect(info.screenName).toBe('owner2');
    expect(info.userId).toBe('99887766');
  });

  it('reports a shape change when neither probe yields a screen name', async () => {
    settingsReply = { status: 404, body: {} };
    viewerReply = { status: 200, body: { data: {} } };
    setManualQueryId('Viewer', 'VIEWERQID');

    const info = await setCredentials(AUTH, CT0, 'cookie');
    expect(info.connected).toBe(false);
    expect(info.message).toMatch(/screen name/i);
  });
});

describe('getSession / getTransport / clearSession', () => {
  it('reports disconnected before anything is set', async () => {
    await expect(getSession()).resolves.toEqual({ connected: false, mode: 'cookie' });
  });

  it('getTransport throws until connected, then returns the cookie transport', async () => {
    expect(() => getTransport()).toThrow(/Not connected/);
    await setCredentials(AUTH, CT0, 'cookie');
    expect(getTransport().mode).toBe('cookie');
  });

  it('rehydrates from disk in a fresh module state without re-validating', async () => {
    await setCredentials(AUTH, CT0, 'cookie');

    // Simulate a server restart: brand new module registry, same data dir.
    vi.resetModules();
    const fresh = await import('./session.js');
    settingsHits = 0;

    const info = await fresh.getSession();
    expect(info).toEqual({ connected: true, mode: 'cookie', screenName: 'owner', userId: undefined });
    expect(settingsHits).toBe(0);
    expect(fresh.getTransport().mode).toBe('cookie');
  });

  it('clearSession forgets the session in memory and on disk', async () => {
    await setCredentials(AUTH, CT0, 'cookie');
    await clearSession();

    await expect(readFile(join(dir, 'session.json'), 'utf8')).rejects.toThrow();
    await expect(getSession()).resolves.toEqual({ connected: false, mode: 'cookie' });
    expect(() => getTransport()).toThrow();
  });
});

/**
 * A manual queryId is a hand-made intervention scoped to the session it was made
 * in. Surviving a disconnect means a later reconnect - possibly as a different
 * account - silently addresses X with an id nobody remembers pinning, and a
 * wrong queryId surfaces as an unexplained 404.
 */
describe('manual queryId lifetime', () => {
  it('clearSession unpins a queryId that was pinned during the session', async () => {
    await setCredentials(AUTH, CT0, 'cookie');
    setManualQueryId('UserTweetsAndReplies', 'PINNED_BY_HAND');
    expect(knownQueryIds()['UserTweetsAndReplies']).toBe('PINNED_BY_HAND');

    await clearSession();

    expect(knownQueryIds()['UserTweetsAndReplies']).toBeUndefined();
  });

  it('does not carry a pin into a reconnect as a different account', async () => {
    await setCredentials(AUTH, CT0, 'cookie');
    setManualQueryId('UserTweetsAndReplies', 'PINNED_BY_HAND');

    // What the UI's "切断・消去" button does, then a fresh connect.
    await clearSession();
    settingsReply = { status: 200, body: { screen_name: 'someone-else' } };
    const info = await setCredentials('other-auth-token', 'other-ct0', 'cookie');

    expect(info.screenName).toBe('someone-else');
    expect(knownQueryIds()['UserTweetsAndReplies']).toBeUndefined();
  });

  it('KEEPS a pin across a plain transport-mode switch', async () => {
    // A queryId belongs to X's deployed web client, not to an account or a
    // transport, and "pin the id from DevTools" + "switch to playwright" are the
    // two recovery steps README tells the user to try together - so switching
    // mode without disconnecting must not throw the pin away.
    await setCredentials(AUTH, CT0, 'cookie');
    setManualQueryId('DeleteTweet', 'PINNED_BY_HAND');

    await connectPw().result;
    expect(getTransport().mode).toBe('playwright');
    expect(knownQueryIds()['DeleteTweet']).toBe('PINNED_BY_HAND');
  });
});
