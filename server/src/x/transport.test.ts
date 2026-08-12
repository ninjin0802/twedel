import { HttpResponse, delay, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../config.js';
import { WEB_BEARER } from './endpoints.js';
import { setManualTransactionId } from './transactionId.js';
import { createCookieTransport } from './transport.js';

const AUTH = 'auth-token-value-that-must-never-leak';
const CT0 = 'ct0-value-that-must-never-leak';

let lastHeaders: Record<string, string> = {};
let lastBody = '';

const server = setupServer(
  http.get('https://x.com/echo', ({ request }) => {
    lastHeaders = Object.fromEntries(request.headers.entries());
    return HttpResponse.json({ ok: true });
  }),
  http.post('https://x.com/echo', async ({ request }) => {
    lastHeaders = Object.fromEntries(request.headers.entries());
    lastBody = await request.text();
    return HttpResponse.json(
      { echoed: true },
      { status: 201, headers: { 'X-Rate-Limit-Remaining': '42', 'X-Weird-Case': 'Yes' } },
    );
  }),
  http.get('https://x.com/plain', () => HttpResponse.text('not json at all')),
  http.get('https://x.com/broken-json', () =>
    HttpResponse.text('<html>oops</html>', { headers: { 'content-type': 'application/json' } }),
  ),
  http.get('https://x.com/boom', () => new HttpResponse(null, { status: 503 })),
  http.get('https://x.com/gone', () => HttpResponse.json({ errors: [] }, { status: 404 })),
  http.get('https://x.com/', ({ request }) => {
    lastHeaders = Object.fromEntries(request.headers.entries());
    return HttpResponse.html('<!doctype html><html></html>');
  }),
  http.get('https://abs.twimg.com/x-web/x-web/entry.js', ({ request }) => {
    lastHeaders = Object.fromEntries(request.headers.entries());
    return HttpResponse.text('bundle source', {
      headers: { 'content-type': 'text/javascript' },
    });
  }),
);

// `onUnhandledRequest: 'error'` is the guarantee that these tests can never
// reach the real x.com: anything not explicitly mocked fails loudly.
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => {
  server.resetHandlers();
  setManualTransactionId(null);
});
afterAll(() => server.close());

const transport = createCookieTransport({ authToken: AUTH, ct0: CT0 });

describe('createCookieTransport', () => {
  it('reports the cookie mode', () => {
    expect(transport.mode).toBe('cookie');
  });

  it('sends the full authenticated header set', async () => {
    setManualTransactionId('pinned-transaction-id');
    await transport.get('https://x.com/echo');

    expect(lastHeaders['authorization']).toBe(WEB_BEARER);
    expect(lastHeaders['x-csrf-token']).toBe(CT0);
    expect(lastHeaders['cookie']).toBe(`auth_token=${AUTH}; ct0=${CT0}`);
    expect(lastHeaders['x-twitter-auth-type']).toBe('OAuth2Session');
    expect(lastHeaders['x-twitter-active-user']).toBe('yes');
    expect(lastHeaders['x-client-transaction-id']).toBe('pinned-transaction-id');
  });

  it('mints a fresh transaction id per request when none is pinned', async () => {
    await transport.get('https://x.com/echo');
    const first = lastHeaders['x-client-transaction-id'];
    await transport.get('https://x.com/echo');
    const second = lastHeaders['x-client-transaction-id'];

    expect(first).toMatch(/^[A-Za-z0-9_-]{94}$/);
    expect(second).toMatch(/^[A-Za-z0-9_-]{94}$/);
    expect(first).not.toBe(second);
  });

  it('serialises the POST body as JSON and parses the JSON response', async () => {
    const res = await transport.post('https://x.com/echo', { variables: { tweet_id: '1' } });

    expect(lastBody).toBe(JSON.stringify({ variables: { tweet_id: '1' } }));
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ echoed: true });
  });

  it('lower-cases every response header name', async () => {
    const res = await transport.post('https://x.com/echo', {});

    expect(res.headers['x-rate-limit-remaining']).toBe('42');
    expect(res.headers['x-weird-case']).toBe('Yes');
    expect(Object.keys(res.headers).every((k) => k === k.toLowerCase())).toBe(true);
  });

  it('returns non-JSON bodies as text', async () => {
    const res = await transport.get('https://x.com/plain');
    expect(res.body).toBe('not json at all');
  });

  it('falls back to text when a JSON content-type carries non-JSON', async () => {
    const res = await transport.get('https://x.com/broken-json');
    expect(res.body).toBe('<html>oops</html>');
  });

  it('does NOT throw on non-2xx - it returns the status', async () => {
    await expect(transport.get('https://x.com/boom')).resolves.toMatchObject({ status: 503 });
    await expect(transport.get('https://x.com/gone')).resolves.toMatchObject({ status: 404 });
  });

  it('masks credentials that appear in a transport-level error', async () => {
    // Force a failure whose message embeds the raw cookies - exactly the leak
    // we must never let reach a log line or an API response.
    const spy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new Error(`socket hang up while sending cookie auth_token=${AUTH}; ct0=${CT0}`),
    );

    let message = '';
    try {
      await transport.get('https://x.com/echo');
    } catch (err) {
      message = (err as Error).message;
    } finally {
      spy.mockRestore();
    }

    expect(message).not.toBe('');
    expect(message).not.toContain(AUTH);
    expect(message).not.toContain(CT0);
    expect(message).toContain(`au…(len ${AUTH.length})`);
    expect(message).toContain(`ct…(len ${CT0.length})`);
  });

  it('closes without throwing', async () => {
    await expect(transport.close()).resolves.toBeUndefined();
  });
});

/**
 * Regression: Node's global `fetch` has NO default timeout. A socket that
 * connects and then never answers used to hang the awaiting caller forever,
 * which in the sequential delete runner froze the whole run on one tweet with
 * no error and no retry - the "途中で止まる" bug. The transport now aborts a
 * stalled request so the runner sees a normal failure.
 */
describe('createCookieTransport request timeout', () => {
  // `config` is `as const` at the type level but a plain mutable object at
  // runtime; override the ceiling for the test and restore it afterwards.
  const mutable = config as unknown as { requestTimeoutMs: number };
  const original = mutable.requestTimeoutMs;
  afterEach(() => {
    mutable.requestTimeoutMs = original;
  });

  it('aborts a request that stalls past the timeout, with a redacted message', async () => {
    mutable.requestTimeoutMs = 40;
    server.use(
      http.get('https://x.com/slow', async () => {
        await delay(3000);
        return HttpResponse.json({ never: 'reached' });
      }),
    );

    let message = '';
    try {
      await transport.get('https://x.com/slow');
      throw new Error('expected the request to abort');
    } catch (err) {
      message = (err as Error).message;
    }

    expect(message).toMatch(/no response within 0s|TimeoutError|aborted/i);
    expect(message).not.toContain(AUTH);
    expect(message).not.toContain(CT0);
  });

  it('does not abort a fast request', async () => {
    mutable.requestTimeoutMs = 5000;
    await expect(transport.get('https://x.com/echo')).resolves.toMatchObject({ status: 200 });
  });

  it('treats a timeout of 0 as "no timeout" (still resolves a normal request)', async () => {
    mutable.requestTimeoutMs = 0;
    await expect(transport.get('https://x.com/echo')).resolves.toMatchObject({ status: 200 });
  });
});

/**
 * The regression this file exists to lock down.
 *
 * The queryId scrape fetched `https://x.com` through `get()`, so the HTML page
 * request carried `authorization`, `x-twitter-auth-type`,
 * `content-type: application/json` and a made-up `x-client-transaction-id`.
 * X routes anything with an `authorization` header through its API auth stack -
 * unauthenticated, `GET https://x.com` answers 200 with no headers at all and
 * 401 with a bearer but no `x-twitter-auth-type` - and with a real session it
 * can come back 404. Which is exactly what the user saw:
 * "https://x.com answered HTTP 404, 0 bundle URL(s) discovered".
 *
 * So the assertions below are mostly ABSENCE assertions. That is the point.
 */
describe('createCookieTransport.getDocument', () => {
  it('sends a browser navigation header set: UA, html accept, language, cookies', async () => {
    const res = await transport.getDocument('https://x.com/');

    expect(res.status).toBe(200);
    expect(res.body).toContain('<html>');
    expect(lastHeaders['user-agent']).toMatch(/^Mozilla\/5\.0 .*Chrome\/\d+/);
    expect(lastHeaders['accept']).toContain('text/html');
    expect(lastHeaders['accept-language']).toBeTruthy();
    // The logged-in shell needs the cookies - they are the only thing here that
    // makes X serve a different document.
    expect(lastHeaders['cookie']).toBe(`auth_token=${AUTH}; ct0=${CT0}`);
  });

  it('sends NO api headers - each one asserted absent individually', async () => {
    await transport.getDocument('https://x.com/');

    expect(lastHeaders['authorization']).toBeUndefined();
    expect(lastHeaders['x-twitter-auth-type']).toBeUndefined();
    expect(lastHeaders['x-twitter-active-user']).toBeUndefined();
    expect(lastHeaders['x-csrf-token']).toBeUndefined();
    expect(lastHeaders['content-type']).toBeUndefined();
    expect(lastHeaders['x-client-transaction-id']).toBeUndefined();
    expect(JSON.stringify(lastHeaders)).not.toContain(WEB_BEARER);
  });

  it('sends no transaction id even when one is pinned', async () => {
    // A pinned id is for API calls. A browser navigating to a page sends none.
    setManualTransactionId('pinned-transaction-id');
    await transport.getDocument('https://x.com/');
    expect(lastHeaders['x-client-transaction-id']).toBeUndefined();
  });

  it('sends NO credentials at all to abs.twimg.com', async () => {
    // The bundle URLs come out of a document twedel did not write, and that CDN
    // needs no credentials. Not sending any is strictly better.
    const res = await transport.getDocument('https://abs.twimg.com/x-web/x-web/entry.js');

    expect(res.body).toBe('bundle source');
    expect(lastHeaders['cookie']).toBeUndefined();
    expect(lastHeaders['authorization']).toBeUndefined();
    expect(lastHeaders['x-csrf-token']).toBeUndefined();

    const serialized = JSON.stringify(lastHeaders);
    expect(serialized).not.toContain(AUTH);
    expect(serialized).not.toContain(CT0);
    expect(serialized).not.toContain(WEB_BEARER);
    // Still identifies as a browser, just an anonymous one.
    expect(lastHeaders['user-agent']).toMatch(/Chrome\/\d+/);
  });

  it('returns non-2xx rather than throwing, like get() does', async () => {
    await expect(transport.getDocument('https://x.com/boom')).resolves.toMatchObject({
      status: 503,
    });
  });

  it('masks credentials in a transport-level error', async () => {
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error(`boom with cookie auth_token=${AUTH}; ct0=${CT0}`));

    let message = '';
    try {
      await transport.getDocument('https://x.com/');
    } catch (err) {
      message = (err as Error).message;
    } finally {
      spy.mockRestore();
    }

    expect(message).not.toContain(AUTH);
    expect(message).not.toContain(CT0);
  });
});
