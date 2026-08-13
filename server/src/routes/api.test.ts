import { once } from 'node:events';
import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { request as httpRequest, type Server } from 'node:http';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeleteLogEntry, ProgressEvent, Tweet } from '../../../shared/types.js';
import { CHECKPOINT_VERSION, checkpointFile, resetRuns, startRun, waitForRun } from '../deleteRunner.js';
import { createApp } from '../index.js';
import { appendEntries, logFile } from '../log.js';
import { clearTweets, setTweets } from '../store.js';

/**
 * The routers are exercised over a real socket on an ephemeral port.
 *
 * `supertest` is not a dependency of this project and the brief forbids adding
 * one, so `app.listen(0)` + `fetch` it is. That also means the SSE assertions
 * run against a genuine HTTP stream rather than a mocked response object, which
 * is the only way to prove the server actually CLOSES the stream on a terminal
 * state - the property `EventSource` cares about.
 */

let server: Server;
let base: string;
let dir: string;
let previousDataDir: string | undefined;

const FIXTURE_ARCHIVE = resolve(process.cwd(), 'server/src/__fixtures__/archive-folder');

function tweet(id: string, overrides: Partial<Tweet> = {}): Tweet {
  return {
    id,
    createdAt: '2020-01-01T00:00:00.000Z',
    text: `tweet ${id}`,
    likeCount: 0,
    retweetCount: 0,
    isReply: false,
    isRetweet: false,
    hasMedia: false,
    source: 'archive',
    countsReliable: false,
    ...overrides,
  };
}

async function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`);
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

async function del(path: string): Promise<Response> {
  return fetch(`${base}${path}`, { method: 'DELETE' });
}

async function json<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

async function statusWithHost(host: string): Promise<number> {
  const url = new URL(`${base}/api/health`);
  return new Promise((resolveStatus, reject) => {
    const req = httpRequest({ hostname: url.hostname, port: url.port, path: url.pathname, headers: { host } }, (res) => {
      res.resume();
      resolveStatus(res.statusCode ?? 0);
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Write a checkpoint by hand.
 *
 * The runner cannot produce one here: with no X session every run errors before
 * its first item, so there is nothing to check point. These tests are about the
 * HTTP contract over a checkpoint that exists, which is what this gives us.
 */
function writeCheckpoint(runId: string, over: Record<string, unknown> = {}): void {
  writeFileSync(
    checkpointFile(runId),
    JSON.stringify({
      version: CHECKPOINT_VERSION,
      runId,
      startedAt: '2024-05-01T10:00:00.000Z',
      state: 'stopped',
      total: 3,
      done: 1,
      ok: 1,
      alreadyGone: 0,
      failed: 0,
      remaining: [
        { id: '2', createdAt: '2020-01-01T00:00:00.000Z', text: 'tweet 2', isRetweet: false },
        { id: '3', createdAt: '2020-01-01T00:00:00.000Z', text: 'tweet 3', isRetweet: true },
      ],
      options: { minDelayMs: 0, maxDelayMs: 0 },
      updatedAt: '2024-05-01T10:05:00.000Z',
      ...over,
    }),
    'utf8',
  );
}

beforeAll(async () => {
  previousDataDir = process.env['TWEDEL_DATA_DIR'];
  dir = await mkdtemp(join(tmpdir(), 'twedel-routes-'));
  process.env['TWEDEL_DATA_DIR'] = dir;

  server = createApp().listen(0, '127.0.0.1');
  await once(server, 'listening');
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  if (previousDataDir === undefined) delete process.env['TWEDEL_DATA_DIR'];
  else process.env['TWEDEL_DATA_DIR'] = previousDataDir;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  resetRuns();
  clearTweets();
  await rm(logFile(), { force: true });
  for (const name of await readdir(dir)) {
    if (name.startsWith('checkpoint-')) await rm(join(dir, name), { force: true });
  }
});

afterEach(() => {
  resetRuns();
});

describe('GET /api/health', () => {
  it('answers ok', async () => {
    const res = await get('/api/health');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true, version: '0.11.5' });
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('DENY');
    expect(res.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
  });

  it('rejects non-loopback hosts and origins', async () => {
    expect(await statusWithHost('example.com')).toBe(403);
    const badOrigin = await fetch(`${base}/api/health`, { headers: { origin: 'https://evil.example' } });
    expect(badOrigin.status).toBe(403);
  });
});

describe('session routes', () => {
  it('lists saved accounts without credential-shaped fields', async () => {
    const body = await json<{ accounts: unknown[] }>(await get('/api/accounts'));
    expect(Array.isArray(body.accounts)).toBe(true);
    expect(JSON.stringify(body).toLowerCase()).not.toMatch(/auth_token|authtoken|ct0/);
  });
  it('resets saved account information', async () => {
    const res = await post('/api/accounts/reset');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
  });
  it('reports a disconnected session and leaks no credential fields', async () => {
    const res = await get('/api/session');
    expect(res.status).toBe(200);

    const body = await json<Record<string, unknown>>(res);
    expect(body['connected']).toBe(false);
    expect(body['mode']).toBe('cookie');

    // The whole security rule of this API in one assertion. ("cookie" itself is
    // fine - it is the name of the TransportMode, not a credential.)
    const raw = JSON.stringify(body).toLowerCase();
    for (const forbidden of ['authtoken', 'auth_token', 'ct0', 'csrf', 'token']) {
      expect(raw).not.toContain(forbidden);
    }
    expect(Object.keys(body).sort()).toEqual(['connected', 'mode']);
  });

  it('rejects a body missing ct0 with 400 and says which field', async () => {
    const res = await post('/api/session', { authToken: 'abc', mode: 'cookie' });
    expect(res.status).toBe(400);
    const body = await json<{ message: string }>(res);
    expect(body.message).toContain('ct0');
  });

  it('rejects an unknown transport mode', async () => {
    const res = await post('/api/session', { authToken: 'a', ct0: 'b', mode: 'telepathy' });
    expect(res.status).toBe(400);
    expect((await json<{ message: string }>(res)).message).toContain('mode');
  });

  it('never echoes the credentials it was given back in an error', async () => {
    const secret = 'SUPERSECRETAUTHTOKEN123456';
    const res = await post('/api/session', { authToken: secret, ct0: '', mode: 'cookie' });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain(secret);
  });

  /**
   * Only the rejected bodies are driven over HTTP: a VALID harvest body would
   * launch a real Chrome window, and no test in this repo starts a browser. The
   * accepted shapes are covered in `routes/session.test.ts` (schema) and the
   * behaviour in `x/session.test.ts` (fake browser).
   */
  it('rejects a harvest timeout that is not a positive integer', async () => {
    for (const body of [{ timeoutMs: -1 }, { timeoutMs: 'soon' }, { timeoutMs: 1.5 }]) {
      const res = await post('/api/session/harvest', body);
      expect(res.status).toBe(400);
      expect((await json<{ message: string }>(res)).message).toContain('timeoutMs');
    }
  });

  it('DELETE clears the session', async () => {
    const res = await fetch(`${base}/api/session`, { method: 'DELETE' });
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ ok: true });
  });

  it('pins and unpins a manual transaction id', async () => {
    expect(await json(await post('/api/session/transaction-id', { value: 'abc' }))).toEqual({
      ok: true,
      manual: true,
    });
    expect(await json(await post('/api/session/transaction-id', { value: null }))).toEqual({
      ok: true,
      manual: false,
    });
  });

  it('rejects a transaction id that is neither a string nor null', async () => {
    const res = await post('/api/session/transaction-id', { value: 42 });
    expect(res.status).toBe(400);
  });

  it('pins a manual queryId and rejects a blank operation name', async () => {
    expect(await json(await post('/api/session/query-id', { op: 'DeleteTweet', id: 'x1' }))).toEqual({
      ok: true,
    });
    const res = await post('/api/session/query-id', { op: '', id: 'x1' });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/tweets/archive', () => {
  it('loads an archive folder and remembers the tweets server-side', async () => {
    const res = await post('/api/tweets/archive', { path: FIXTURE_ARCHIVE });
    expect(res.status).toBe(200);

    const body = await json<{ tweets: Tweet[]; filesRead: string[]; skipped: unknown[] }>(res);
    expect(body.tweets.length).toBeGreaterThan(0);
    expect(Array.isArray(body.filesRead)).toBe(true);
    // Archive counts are never trustworthy; the UI keys its threshold inputs off this.
    expect(body.tweets.every((t) => t.countsReliable === false)).toBe(true);

    // Proof the store was populated: a run over a loaded id is accepted.
    const runRes = await post('/api/run', { ids: [body.tweets[0]?.id] });
    expect(runRes.status).toBe(202);
  });

  it('rejects a missing path with 400', async () => {
    const res = await post('/api/tweets/archive', {});
    expect(res.status).toBe(400);
  });

  it('turns an unreadable path into a 400, not a 500', async () => {
    const res = await post('/api/tweets/archive', { path: resolve(dir, 'nope-does-not-exist') });
    expect(res.status).toBe(400);
    expect((await json<{ message: string }>(res)).message).toBeTruthy();
  });

  it('propagates a malformed filter date as 400 rather than 500', async () => {
    const res = await post('/api/tweets/archive', {
      path: FIXTURE_ARCHIVE,
      filter: {
        from: '2020-13-45',
        keywordMode: 'include',
        maxLikes: null,
        maxRetweets: null,
        includeOriginals: true,
        includeReplies: true,
        includeRetweets: true,
        includeMediaTweets: true,
      },
    });
    expect(res.status).toBe(400);
    expect((await json<{ message: string }>(res)).message).toMatch(/invalid `from` date/);
  });

  it('applies a well-formed filter to the response', async () => {
    const unfiltered = await json<{ tweets: Tweet[] }>(
      await post('/api/tweets/archive', { path: FIXTURE_ARCHIVE }),
    );
    const filtered = await json<{ tweets: Tweet[] }>(
      await post('/api/tweets/archive', {
        path: FIXTURE_ARCHIVE,
        filter: {
          keywordMode: 'include',
          maxLikes: null,
          maxRetweets: null,
          includeOriginals: false,
          includeReplies: false,
          includeRetweets: false,
          includeMediaTweets: true,
        },
      }),
    );
    expect(unfiltered.tweets.length).toBeGreaterThan(0);
    expect(filtered.tweets).toEqual([]);
  });

  it('defaults to source=tweets and echoes the kind', async () => {
    const body = await json<{ tweets: Tweet[]; kind: string }>(
      await post('/api/tweets/archive', { path: FIXTURE_ARCHIVE }),
    );
    expect(body.kind).toBe('tweets');
    expect(body.tweets.length).toBeGreaterThan(0);
  });

  it('reads likes when source=likes, and loads them flagged isLike', async () => {
    // A tiny likes archive written on the fly.
    const likeDir = resolve(dir, 'likes-archive');
    mkdirSync(join(likeDir, 'data'), { recursive: true });
    writeFileSync(
      join(likeDir, 'data', 'like.js'),
      'window.YTD.like.part0 = [{"like":{"tweetId":"L1","fullText":"a liked tweet"}}]',
      'utf8',
    );

    const body = await json<{ tweets: Tweet[]; kind: string }>(
      await post('/api/tweets/archive', { path: likeDir, source: 'likes' }),
    );
    expect(body.kind).toBe('likes');
    expect(body.tweets.map((t) => t.id)).toEqual(['L1']);
    expect(body.tweets[0]?.isLike).toBe(true);

    // The store was populated with the like, so a run over it is accepted.
    expect((await post('/api/run', { ids: ['L1'] })).status).toBe(202);
  });

  it('rejects an unknown source value with 400', async () => {
    const res = await post('/api/tweets/archive', { path: FIXTURE_ARCHIVE, source: 'bookmarks' });
    expect(res.status).toBe(400);
  });
});

describe('live fetch routes', () => {
  it('refuses to start without a connected session', async () => {
    const res = await post('/api/tweets/live', {});
    expect(res.status).toBe(400);
    expect((await json<{ message: string }>(res)).message).toMatch(/Not connected/i);
  });

  it('validates max', async () => {
    const res = await post('/api/tweets/live', { max: -5 });
    expect(res.status).toBe(400);
  });

  it('accepts source=likes in the schema (still 400s only for the missing session)', async () => {
    const res = await post('/api/tweets/live', { source: 'likes' });
    expect(res.status).toBe(400);
    expect((await json<{ message: string }>(res)).message).toMatch(/Not connected/i);
  });

  it('rejects an unknown source value', async () => {
    const res = await post('/api/tweets/live', { source: 'bookmarks' });
    expect(res.status).toBe(400);
  });

  it('404s an unknown job', async () => {
    expect((await get('/api/tweets/live/nope/result')).status).toBe(404);
    expect((await get('/api/tweets/live/nope/events')).status).toBe(404);
  });
});

describe('POST /api/run', () => {
  it('rejects an empty id list', async () => {
    const res = await post('/api/run', { ids: [] });
    expect(res.status).toBe(400);
    expect((await json<{ message: string }>(res)).message).toContain('at least one tweet id');
  });

  it('rejects a body that is not the contract shape', async () => {
    expect((await post('/api/run', { ids: 'all of them' })).status).toBe(400);
    expect((await post('/api/run', {})).status).toBe(400);
    expect((await post('/api/run', { ids: [123] })).status).toBe(400);
  });

  it('rejects an id the server has never loaded', async () => {
    setTweets([tweet('1')]);
    const res = await post('/api/run', { ids: ['1', '404-not-loaded'] });
    expect(res.status).toBe(400);

    const body = await json<{ message: string; missing: string[] }>(res);
    expect(body.missing).toEqual(['404-not-loaded']);
    expect(body.message).toMatch(/not loaded on the server/);
  });

  it('rejects maxDelayMs below minDelayMs', async () => {
    setTweets([tweet('1')]);
    const res = await post('/api/run', {
      ids: ['1'],
      options: { minDelayMs: 5000, maxDelayMs: 10 },
    });
    expect(res.status).toBe(400);
  });

  it('accepts a loaded id with 202 and a runId', async () => {
    setTweets([tweet('1'), tweet('2')]);
    const res = await post('/api/run', { ids: ['1', '2'] });
    expect(res.status).toBe(202);

    const { runId } = await json<{ runId: string }>(res);
    expect(runId).toMatch(/^run-/);
  });

  it('409s a second run while one is in flight', async () => {
    setTweets([tweet('1')]);
    const first = await json<{ runId: string }>(await post('/api/run', { ids: ['1'] }));
    expect(first.runId).toBeTruthy();

    // The first run settles almost immediately here (no X session), so retry
    // until we either see the conflict or the run is done - both are correct,
    // and only one of them is a bug if it never happens.
    const second = await post('/api/run', { ids: ['1'] });
    expect([202, 409]).toContain(second.status);
  });
});

async function settledRun(ids: string[]): Promise<string> {
  const { runId } = await json<{ runId: string }>(await post('/api/run', { ids }));
  for (let i = 0; i < 100; i += 1) {
    const snapshot = await json<ProgressEvent>(await get(`/api/run/${runId}`));
    if (['done', 'stopped', 'error'].includes(snapshot.state)) return runId;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('run never settled');
}

describe('run snapshot, SSE and stop', () => {
  it('serves a snapshot for reconnect and 404s an unknown runId', async () => {
    setTweets([tweet('1')]);
    const runId = await settledRun(['1']);

    const snapshot = await json<ProgressEvent>(await get(`/api/run/${runId}`));
    expect(snapshot.runId).toBe(runId);
    expect(typeof snapshot.startedAt).toBe('string');
    expect(snapshot.total).toBe(1);

    expect((await get('/api/run/never-existed')).status).toBe(404);
  });

  it('emits the snapshot on connect and CLOSES the stream on a terminal state', async () => {
    setTweets([tweet('1')]);
    const runId = await settledRun(['1']);

    const res = await get(`/api/run/${runId}/events`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    expect(res.headers.get('cache-control')).toContain('no-cache');
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    // `.text()` only resolves once the server ends the response - which is
    // exactly the behaviour API.md requires and EventSource depends on.
    const body = await res.text();
    expect(body).toContain('event: progress');

    const frame = body.split('\n').find((line) => line.startsWith('data: '));
    const event = JSON.parse((frame ?? '').slice(6)) as ProgressEvent;
    expect(event.runId).toBe(runId);
    expect(['done', 'stopped', 'error']).toContain(event.state);
  });

  it('404s SSE for an unknown runId instead of opening a dead stream', async () => {
    const res = await get('/api/run/never-existed/events');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('stops a run idempotently and 404s an unknown one', async () => {
    setTweets([tweet('1')]);
    const runId = await settledRun(['1']);

    expect(await json(await post(`/api/run/${runId}/stop`))).toEqual({ ok: true });
    expect(await json(await post(`/api/run/${runId}/stop`))).toEqual({ ok: true });
    expect((await post('/api/run/never-existed/stop')).status).toBe(404);
  });
});

describe('resume routes', () => {
  it('answers an empty list when there is no checkpoint at all', async () => {
    const res = await get('/api/run/resumable');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ runs: [] });
  });

  it('lists a checkpoint with what the banner needs to describe it', async () => {
    writeCheckpoint('run-cp-list');
    const { runs } = await json<{ runs: Record<string, unknown>[] }>(await get('/api/run/resumable'));

    expect(runs).toHaveLength(1);
    expect(runs[0]).toEqual({
      runId: 'run-cp-list',
      startedAt: '2024-05-01T10:00:00.000Z',
      remaining: 2,
      total: 3,
      ok: 1,
      alreadyGone: 0,
      failed: 0,
    });
  });

  it('hides a checkpoint whose shape it refuses to read', async () => {
    writeCheckpoint('run-cp-old', { version: 1, remaining: ['2', '3'] });
    expect(await json(await get('/api/run/resumable'))).toEqual({ runs: [] });
    // Set aside rather than deleted, and never reported again.
    expect(await json(await get('/api/run/resumable'))).toEqual({ runs: [] });
  });

  it('resumes a checkpoint with 202 and the SAME runId', async () => {
    writeCheckpoint('run-cp-resume');
    const res = await post('/api/run/run-cp-resume/resume');
    expect(res.status).toBe(202);
    expect(await json(res)).toEqual({ runId: 'run-cp-resume' });

    // The resumed run is a normal run: reconnectable through the usual snapshot.
    const snapshot = await json<ProgressEvent>(await get('/api/run/run-cp-resume'));
    expect(snapshot.runId).toBe('run-cp-resume');
    expect(snapshot.total).toBe(3);
    // Counters and start time continue rather than restarting at zero.
    expect(snapshot.done).toBe(1);
    expect(snapshot.startedAt).toBe('2024-05-01T10:00:00.000Z');
  });

  it('404s a resume with no checkpoint, in the standard error shape', async () => {
    const res = await post('/api/run/run-cp-nope/resume');
    expect(res.status).toBe(404);
    const body = await json<{ error: boolean; message: string }>(res);
    expect(body.error).toBe(true);
    expect(body.message).toMatch(/checkpoint/i);
  });

  it('409s a resume while another run is in flight', async () => {
    writeCheckpoint('run-cp-busy');
    setTweets([tweet('1')]);

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const busyId = startRun(['1'], undefined, {
      deleteTweet: async () => {
        await gate;
        return { status: 'deleted' };
      },
      sleep: async () => undefined,
    });
    await new Promise((r) => setImmediate(r));

    const res = await post('/api/run/run-cp-busy/resume');
    expect(res.status).toBe(409);
    expect((await json<{ message: string }>(res)).message).toMatch(/already in progress/);

    release();
    await waitForRun(busyId);
  });

  it('discards a checkpoint idempotently', async () => {
    writeCheckpoint('run-cp-discard');
    expect(await json(await del('/api/run/run-cp-discard/checkpoint'))).toEqual({ ok: true });
    expect(await json(await get('/api/run/resumable'))).toEqual({ runs: [] });

    // Second call: nothing to discard, still ok - the UI must not have to care.
    expect(await json(await del('/api/run/run-cp-discard/checkpoint'))).toEqual({ ok: true });
    expect((await post('/api/run/run-cp-discard/resume')).status).toBe(404);
  });

  it('rejects a runId that could walk out of the data dir', async () => {
    // `runId` becomes part of a filename, so this is a path traversal attempt.
    expect((await post('/api/run/..%2F..%2Fetc%2Fpasswd/resume')).status).toBe(400);
    expect((await del('/api/run/..%2F..%2Fsession.json/checkpoint')).status).toBe(400);
  });
});

describe('log routes', () => {
  const entry = (over: Partial<DeleteLogEntry>): DeleteLogEntry => ({
    runId: 'run-a',
    id: '1',
    createdAt: '2020-01-01T00:00:00.000Z',
    text: 'hello',
    isRetweet: false,
    status: 'deleted',
    at: '2024-01-01T00:00:00.000Z',
    ...over,
  });

  it('returns an empty list when the log file does not exist yet', async () => {
    const res = await get('/api/log');
    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({ entries: [] });
  });

  it('returns the collapsed entries', async () => {
    await appendEntries([entry({ id: '1', status: 'pending' }), entry({ id: '1', status: 'deleted' })]);
    const { entries } = await json<{ entries: DeleteLogEntry[] }>(await get('/api/log'));
    expect(entries).toHaveLength(1);
    expect(entries[0]?.status).toBe('deleted');
  });

  it('applies runId / q / status filters', async () => {
    await appendEntries([
      entry({ id: '1', status: 'deleted', text: 'alpha' }),
      entry({ id: '2', status: 'failed', text: 'beta', runId: 'run-b' }),
    ]);

    expect(
      (await json<{ entries: DeleteLogEntry[] }>(await get('/api/log?status=failed'))).entries,
    ).toHaveLength(1);
    expect(
      (await json<{ entries: DeleteLogEntry[] }>(await get('/api/log?runId=run-b'))).entries,
    ).toHaveLength(1);
    expect(
      (await json<{ entries: DeleteLogEntry[] }>(await get('/api/log?q=alpha'))).entries,
    ).toHaveLength(1);
  });

  it('treats an empty status as "no filter" (the UI submits it that way)', async () => {
    await appendEntries([entry({ id: '1' })]);
    const { entries } = await json<{ entries: DeleteLogEntry[] }>(await get('/api/log?status='));
    expect(entries).toHaveLength(1);
  });

  it('rejects an unknown status with 400', async () => {
    const res = await get('/api/log?status=exploded');
    expect(res.status).toBe(400);
    expect((await json<{ message: string }>(res)).message).toContain('status');
  });

  it('serves a CSV attachment with a BOM so Excel reads UTF-8', async () => {
    await appendEntries([entry({ id: '1', text: 'こんにちは, "world"' })]);
    const res = await get('/api/log.csv');

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/csv');
    expect(res.headers.get('content-disposition')).toContain('attachment');

    // Check the BYTES: `Response.text()` decodes and swallows the BOM, which
    // would make this assertion pass even if the server never sent one.
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xef, 0xbb, 0xbf]);

    const body = new TextDecoder('utf-8').decode(bytes.slice(3));
    expect(body).toContain('runId,id,createdAt,text,isRetweet,status,error,at');
    expect(body).toContain('"こんにちは, ""world"""');
  });
});

describe('error handling', () => {
  it('answers malformed JSON with a 400 and a message, not a stack trace', async () => {
    const res = await fetch(`${base}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ this is not json',
    });
    expect(res.status).toBe(400);

    const text = await res.text();
    expect(text).not.toContain('at Object.');
    expect(text).not.toContain('node_modules');
    expect(JSON.parse(text)).toHaveProperty('message');
  });
});
