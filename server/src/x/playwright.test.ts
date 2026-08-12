import { afterEach, describe, expect, it, vi } from 'vitest';
import { WEB_BEARER } from './endpoints.js';
import type {
  PlaywrightDeps,
  PlaywrightTransportOptions,
  PwContext,
  PwCookie,
  PwEvalArg,
  PwEvalResult,
  PwPage,
  PwRequest,
} from './playwright.js';
import { createPlaywrightTransport, toPageUrl } from './playwright.js';
import { setManualTransactionId } from './transactionId.js';
import type { XResponse } from './transport.js';

/**
 * Everything here runs against a fake Playwright context.
 *
 * NOTHING in this file may launch a browser or touch the network: `deps` is
 * injected on every call, so `realLauncher` (the only code that imports
 * `playwright`) is never reached, and `fetchAsset` is a stub. If a test ever
 * starts spawning chrome.exe, it is because someone dropped the `deps` argument.
 */

/* -------------------------------------------------------------------------- */
/* Fakes                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A response shaped like the browser's, with header casing under our control -
 * a real `Response` lower-cases for us and would hide a missing `.toLowerCase()`.
 */
function fakeResponse(
  status: number,
  headers: Record<string, string>,
  text: string,
): Response {
  return {
    status,
    headers: {
      forEach(cb: (value: string, key: string) => void) {
        for (const [k, v] of Object.entries(headers)) cb(v, k);
      },
    },
    text: () => Promise.resolve(text),
  } as unknown as Response;
}

interface Exchange {
  status: number;
  headers: Record<string, string>;
  text: string;
}

class FakePage implements PwPage {
  gotoCalls: string[] = [];
  evalArgs: PwEvalArg[] = [];
  /** Replaced per test to control what the in-page `fetch` sees. */
  reply: (arg: PwEvalArg) => Exchange = () => ({
    status: 200,
    headers: { 'Content-Type': 'application/json' },
    text: '{"ok":true}',
  });
  /** When set, `evaluate` rejects - e.g. the window was closed mid-run. */
  evaluateError: Error | null = null;

  async goto(url: string): Promise<void> {
    this.gotoCalls.push(url);
  }

  async evaluate(
    fn: (arg: PwEvalArg) => Promise<PwEvalResult>,
    arg: PwEvalArg,
  ): Promise<PwEvalResult> {
    this.evalArgs.push(arg);
    if (this.evaluateError) throw this.evaluateError;
    // Run the REAL in-page function with a stubbed `fetch`, so the header
    // lower-casing and body handling under test are the shipped ones.
    const exchange = this.reply(arg);
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(fakeResponse(exchange.status, exchange.headers, exchange.text));
    try {
      return await fn(arg);
    } finally {
      spy.mockRestore();
    }
  }
}

class FakeContext implements PwContext {
  page = new FakePage();
  cookieJar: PwCookie[] = [
    { name: 'auth_token', value: 'browser-auth-token' },
    { name: 'ct0', value: 'ct0-first' },
  ];
  cookieCalls = 0;
  closed = 0;
  browserClosed = 0;
  newPages = 0;
  private requestHandler: ((r: PwRequest) => void) | null = null;

  async cookies(): Promise<PwCookie[]> {
    this.cookieCalls += 1;
    return this.cookieJar;
  }

  pages(): PwPage[] {
    return [this.page];
  }

  async newPage(): Promise<PwPage> {
    this.newPages += 1;
    return this.page;
  }

  on(_event: 'request', handler: (request: PwRequest) => void): void {
    this.requestHandler = handler;
  }

  /** Simulate X's own page code issuing a signed request. */
  emitRequest(url: string, headers: Record<string, string>): void {
    this.requestHandler?.({ url: () => url, headers: () => headers });
  }

  async close(): Promise<void> {
    this.closed += 1;
  }

  browser(): { close(): Promise<void> } | null {
    return {
      close: async () => {
        this.browserClosed += 1;
      },
    };
  }
}

interface Harness {
  ctx: FakeContext;
  deps: PlaywrightDeps;
  launches: number;
  /** Virtual clock, advanced only by `sleep`. */
  clock: number;
  assetCalls: string[];
}

function harness(overrides: Partial<PlaywrightDeps> = {}): Harness {
  const ctx = new FakeContext();
  const h: Harness = {
    ctx,
    launches: 0,
    clock: 0,
    assetCalls: [],
    deps: {} as PlaywrightDeps,
  };
  h.deps = {
    launchPersistentContext: async () => {
      h.launches += 1;
      return ctx;
    },
    fetchAsset: async (url: string): Promise<XResponse> => {
      h.assetCalls.push(url);
      return { status: 200, headers: {}, body: 'bundle-source' };
    },
    sleep: async (ms: number) => {
      h.clock += ms;
    },
    now: () => h.clock,
    ...overrides,
  };
  return h;
}

function connect(h: Harness, opts: PlaywrightTransportOptions = {}) {
  return createPlaywrightTransport({
    userDataDir: 'C:\\nope\\pw-profile',
    loginTimeoutMs: 10_000,
    pollIntervalMs: 1_000,
    deps: h.deps,
    ...opts,
  });
}

afterEach(() => {
  setManualTransactionId(null);
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */

describe('toPageUrl', () => {
  it('keeps x.com URLs on the x.com origin', () => {
    expect(toPageUrl('https://x.com/i/api/graphql/QID/DeleteTweet')).toBe(
      'https://x.com/i/api/graphql/QID/DeleteTweet',
    );
    expect(toPageUrl('https://x.com/i/api/graphql/QID/Viewer?variables=%7B%7D')).toBe(
      'https://x.com/i/api/graphql/QID/Viewer?variables=%7B%7D',
    );
  });

  it('rewrites api.x.com onto the same-origin /i/api path', () => {
    expect(toPageUrl('https://api.x.com/1.1/account/settings.json')).toBe(
      'https://x.com/i/api/1.1/account/settings.json',
    );
  });

  it('returns null for hosts that are not X', () => {
    expect(toPageUrl('https://abs.twimg.com/responsive-web/client-web/main.js')).toBeNull();
    expect(toPageUrl('not a url')).toBeNull();
  });
});

describe('createPlaywrightTransport - login gate', () => {
  it('resolves once auth_token is in the jar', async () => {
    const h = harness();
    const t = await connect(h);

    expect(t.mode).toBe('playwright');
    expect(h.launches).toBe(1);
    expect(h.ctx.page.gotoCalls).toEqual(['https://x.com/home']);
    await t.close();
  });

  it('launches real Chrome, headed, against a dedicated profile dir', async () => {
    const seen: { dir: string; headless: boolean; channel: string }[] = [];
    const h = harness();
    const base = h.deps.launchPersistentContext;
    h.deps.launchPersistentContext = async (dir, options) => {
      seen.push({ dir, headless: options.headless, channel: options.channel });
      return base(dir, options);
    };

    const t = await connect(h);
    expect(seen).toEqual([
      { dir: 'C:\\nope\\pw-profile', headless: false, channel: 'chrome' },
    ]);
    expect(t.userDataDir).toBe('C:\\nope\\pw-profile');
    await t.close();
  });

  it('polls while logged out and then fails with an actionable message', async () => {
    const h = harness();
    h.ctx.cookieJar = [{ name: 'ct0', value: 'ct0-only' }];

    await expect(connect(h)).rejects.toThrow(/Log in to X in the Chrome window/i);
    // Bounded: it stopped rather than hanging, and it polled while waiting.
    expect(h.clock).toBeGreaterThanOrEqual(10_000);
    expect(h.ctx.cookieCalls).toBeGreaterThan(1);
    // And it did not leave a browser running.
    expect(h.ctx.closed).toBe(1);
    expect(h.ctx.browserClosed).toBe(1);
  });

  it('treats a blank auth_token as logged out', async () => {
    const h = harness();
    h.ctx.cookieJar = [{ name: 'auth_token', value: '   ' }];
    await expect(connect(h)).rejects.toThrow(/Timed out/i);
  });

  it('still terminates if the clock never advances', async () => {
    // The gate exists to stop twedel hanging forever with a browser window
    // open, so it must not depend on the wall clock alone.
    const h = harness({ now: () => 0, sleep: async () => {} });
    h.ctx.cookieJar = [];
    await expect(connect(h, { loginTimeoutMs: 60_000, pollIntervalMs: 1_000 })).rejects.toThrow(
      /Timed out/,
    );
  });

  it('reports the elapsed timeout in seconds', async () => {
    const h = harness();
    h.ctx.cookieJar = [];
    await expect(connect(h, { loginTimeoutMs: 5_000 })).rejects.toThrow(/after 5s/);
  });

  it('surfaces a missing Chrome as an install instruction, not a stack trace', async () => {
    const h = harness({
      launchPersistentContext: () =>
        Promise.reject(
          new Error("Executable doesn't exist at C:\\Program Files\\Google\\Chrome\\..."),
        ),
    });
    await expect(connect(h)).rejects.toThrow(/Install Chrome, or use cookie mode/i);
  });

  it('explains a locked profile', async () => {
    const h = harness({
      launchPersistentContext: () =>
        Promise.reject(new Error('ProcessSingleton: failed to acquire the profile lock')),
    });
    await expect(connect(h)).rejects.toThrow(/already in use/i);
  });

  it('opens a page when the context has none', async () => {
    const h = harness();
    vi.spyOn(h.ctx, 'pages').mockReturnValue([]);
    const t = await connect(h);
    expect(h.ctx.newPages).toBe(1);
    await t.close();
  });

  it('closes the browser when the gate itself throws, not just when it times out', async () => {
    // A dropped CDP connection (or a window the user closed mid-gate) makes
    // `context.cookies()` reject. Letting that escape would leave a chrome.exe
    // running with nobody holding a handle to it - invisible in the app, and
    // holding the profile lock against the next attempt.
    const h = harness();
    vi.spyOn(h.ctx, 'cookies').mockRejectedValue(new Error('Target closed'));

    await expect(connect(h)).rejects.toThrow(/Target closed/);
    expect(h.ctx.closed).toBe(1);
    expect(h.ctx.browserClosed).toBe(1);
  });

  it('does not give up when the initial navigation fails', async () => {
    const h = harness();
    vi.spyOn(h.ctx.page, 'goto').mockRejectedValue(new Error('net::ERR_TIMED_OUT'));
    const t = await connect(h);
    expect(t.mode).toBe('playwright');
    await t.close();
  });
});

describe('createPlaywrightTransport - XTransport contract', () => {
  it('lower-cases every response header name', async () => {
    const h = harness();
    const t = await connect(h);
    h.ctx.page.reply = () => ({
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Weird-Case': 'Yes' },
      text: '{"ok":true}',
    });

    const res = await t.get('https://x.com/i/api/1.1/account/settings.json');
    expect(res.headers['x-weird-case']).toBe('Yes');
    expect(Object.keys(res.headers).every((k) => k === k.toLowerCase())).toBe(true);
    await t.close();
  });

  it('keeps x-rate-limit-* across the page.evaluate round trip', async () => {
    // The delete runner's backoff reads exactly these two. If the browser round
    // trip drops them, every 429 silently degrades to the fallback delay.
    const h = harness();
    const t = await connect(h);
    h.ctx.page.reply = () => ({
      status: 429,
      headers: {
        'Content-Type': 'application/json',
        'X-Rate-Limit-Remaining': '0',
        'X-Rate-Limit-Reset': '1893456000',
      },
      text: '{"errors":[]}',
    });

    const res = await t.post('https://x.com/i/api/graphql/QID/DeleteTweet', {});
    expect(res.status).toBe(429);
    expect(res.headers['x-rate-limit-remaining']).toBe('0');
    expect(res.headers['x-rate-limit-reset']).toBe('1893456000');
    await t.close();
  });

  it('parses JSON bodies and passes other content types through as text', async () => {
    const h = harness();
    const t = await connect(h);

    h.ctx.page.reply = () => ({
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8' },
      text: '{"data":{"delete_tweet":{}}}',
    });
    await expect(t.post('https://x.com/i/api/graphql/QID/DeleteTweet', {})).resolves.toMatchObject({
      body: { data: { delete_tweet: {} } },
    });

    h.ctx.page.reply = () => ({
      status: 200,
      headers: { 'content-type': 'text/html' },
      text: '<html>hi</html>',
    });
    await expect(t.get('https://x.com/')).resolves.toMatchObject({ body: '<html>hi</html>' });

    h.ctx.page.reply = () => ({
      status: 200,
      headers: { 'content-type': 'application/json' },
      text: '<html>oops</html>',
    });
    await expect(t.get('https://x.com/')).resolves.toMatchObject({ body: '<html>oops</html>' });

    await t.close();
  });

  it('returns non-2xx instead of throwing', async () => {
    const h = harness();
    const t = await connect(h);
    for (const status of [403, 404, 429, 503]) {
      h.ctx.page.reply = () => ({ status, headers: {}, text: '' });
      await expect(t.get('https://x.com/i/api/1.1/account/settings.json')).resolves.toMatchObject({
        status,
      });
    }
    await t.close();
  });

  it('serialises the POST body and issues the request same-origin', async () => {
    const h = harness();
    const t = await connect(h);
    await t.post('https://api.x.com/1.1/statuses/destroy.json', { tweet_id: '1' });

    const arg = h.ctx.page.evalArgs.at(-1) as PwEvalArg;
    expect(arg.method).toBe('POST');
    expect(arg.url).toBe('https://x.com/i/api/1.1/statuses/destroy.json');
    expect(arg.body).toBe(JSON.stringify({ tweet_id: '1' }));
    await t.close();
  });

  it('sends no body on GET', async () => {
    const h = harness();
    const t = await connect(h);
    await t.get('https://x.com/i/api/1.1/account/settings.json');
    expect((h.ctx.page.evalArgs.at(-1) as PwEvalArg).body).toBeNull();
    await t.close();
  });

  it('wraps an evaluate failure and tells the user the window may be gone', async () => {
    const h = harness();
    const t = await connect(h);
    h.ctx.page.evaluateError = new Error('Target page, context or browser has been closed');

    await expect(t.get('https://x.com/i/api/1.1/account/settings.json')).rejects.toThrow(
      /may have been closed/i,
    );
    await t.close();
  });

  it('surfaces an in-page fetch failure as an error, not a fake 0 response', async () => {
    const h = harness();
    const t = await connect(h);
    h.ctx.page.evaluate = async (fn, arg) => fn(arg);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));

    await expect(t.get('https://x.com/i/api/1.1/account/settings.json')).rejects.toThrow(
      /Failed to fetch/,
    );
    await t.close();
  });

  it('never leaks the ct0 value into an error message', async () => {
    const h = harness();
    h.ctx.cookieJar = [
      { name: 'auth_token', value: 'browser-auth-token' },
      { name: 'ct0', value: 'ct0-super-secret-value' },
    ];
    const t = await connect(h);
    h.ctx.page.evaluateError = new Error('boom while sending ct0=ct0-super-secret-value');

    let message = '';
    try {
      await t.get('https://x.com/i/api/x');
    } catch (e: unknown) {
      message = (e as Error).message;
    }
    expect(message).not.toContain('ct0-super-secret-value');
    expect(message).toContain('ct…(len 22)');
    await t.close();
  });
});

describe('createPlaywrightTransport - headers', () => {
  it('sends the authenticated header set without a cookie header', async () => {
    const h = harness();
    const t = await connect(h);
    await t.get('https://x.com/i/api/1.1/account/settings.json');

    const { headers } = h.ctx.page.evalArgs.at(-1) as PwEvalArg;
    expect(headers['authorization']).toBe(WEB_BEARER);
    expect(headers['x-csrf-token']).toBe('ct0-first');
    expect(headers['x-twitter-auth-type']).toBe('OAuth2Session');
    expect(headers['x-twitter-active-user']).toBe('yes');
    // The browser forbids it and the page's own jar is the whole point.
    expect(headers['cookie']).toBeUndefined();
    // The auth_token value must never be written into a header by us.
    expect(JSON.stringify(headers)).not.toContain('browser-auth-token');
    await t.close();
  });

  it('re-reads ct0 from the jar on every request instead of caching it', async () => {
    const h = harness();
    const t = await connect(h);

    await t.get('https://x.com/i/api/1.1/account/settings.json');
    expect((h.ctx.page.evalArgs.at(-1) as PwEvalArg).headers['x-csrf-token']).toBe('ct0-first');

    // X rotates ct0 mid-session; a cached value would 403 from here on.
    h.ctx.cookieJar = [
      { name: 'auth_token', value: 'browser-auth-token' },
      { name: 'ct0', value: 'ct0-rotated' },
    ];
    const before = h.ctx.cookieCalls;
    await t.get('https://x.com/i/api/1.1/account/settings.json');

    expect((h.ctx.page.evalArgs.at(-1) as PwEvalArg).headers['x-csrf-token']).toBe('ct0-rotated');
    expect(h.ctx.cookieCalls).toBe(before + 1);
    await t.close();
  });

  it('generates a fresh transaction id per request when nothing was harvested', async () => {
    const h = harness();
    const t = await connect(h);
    await t.get('https://x.com/i/api/a');
    await t.get('https://x.com/i/api/b');

    const [a, b] = h.ctx.page.evalArgs.map((e) => e.headers['x-client-transaction-id']);
    expect(a).toMatch(/^[A-Za-z0-9_-]{94}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{94}$/);
    expect(a).not.toBe(b);
    await t.close();
  });

  it('prefers a transaction id harvested from X own traffic', async () => {
    const h = harness();
    const t = await connect(h);

    h.ctx.emitRequest('https://x.com/i/api/graphql/QID/HomeTimeline', {
      'x-client-transaction-id': 'REAL-ID-FROM-X',
    });
    await t.get('https://x.com/i/api/a');

    expect((h.ctx.page.evalArgs.at(-1) as PwEvalArg).headers['x-client-transaction-id']).toBe(
      'REAL-ID-FROM-X',
    );
    expect(t.lastHarvestedTransactionId()).toBe('REAL-ID-FROM-X');
    await t.close();
  });

  it('ignores requests that are ours, and non-API traffic', async () => {
    const h = harness();
    const t = await connect(h);

    // Our own request is echoed back by the listener - harvesting it would make
    // the whole mechanism a no-op that merely looks like it works.
    await t.get('https://x.com/i/api/a');
    const ours = (h.ctx.page.evalArgs.at(-1) as PwEvalArg).headers[
      'x-client-transaction-id'
    ] as string;
    h.ctx.emitRequest('https://x.com/i/api/a', { 'x-client-transaction-id': ours });
    expect(t.lastHarvestedTransactionId()).toBeNull();

    // Not an API call: an id there is not one we want to reuse.
    h.ctx.emitRequest('https://x.com/home', { 'x-client-transaction-id': 'PAGE-ID' });
    expect(t.lastHarvestedTransactionId()).toBeNull();

    // Requests with no such header at all must not blow the listener up.
    h.ctx.emitRequest('https://x.com/i/api/b', {});
    expect(t.lastHarvestedTransactionId()).toBeNull();
    await t.close();
  });

  it('lets a manually pinned id win over a harvested one', async () => {
    const h = harness();
    const t = await connect(h);
    h.ctx.emitRequest('https://x.com/i/api/graphql/QID/X', {
      'x-client-transaction-id': 'REAL-ID-FROM-X',
    });
    setManualTransactionId('PINNED-BY-USER');

    await t.get('https://x.com/i/api/a');
    expect((h.ctx.page.evalArgs.at(-1) as PwEvalArg).headers['x-client-transaction-id']).toBe(
      'PINNED-BY-USER',
    );
    await t.close();
  });
});

describe('createPlaywrightTransport - getDocument', () => {
  it('sends none of the API headers when fetching a document', async () => {
    const h = harness();
    const t = await connect(h);
    await t.getDocument('https://x.com/');

    const { headers, url } = h.ctx.page.evalArgs.at(-1) as PwEvalArg;
    expect(url).toBe('https://x.com/');
    expect(headers['authorization']).toBeUndefined();
    expect(headers['x-twitter-auth-type']).toBeUndefined();
    expect(headers['x-twitter-active-user']).toBeUndefined();
    expect(headers['x-csrf-token']).toBeUndefined();
    expect(headers['content-type']).toBeUndefined();
    expect(headers['x-client-transaction-id']).toBeUndefined();
    expect(headers['accept']).toContain('text/html');
    await t.close();
  });

  it('sets none of the headers a browser fetch would refuse', async () => {
    // `cookie`, `user-agent`, `referer` and `origin` throw when set on a real
    // in-page `fetch`. The browser supplies all four itself - genuinely, which
    // is the entire point of this mode.
    const h = harness();
    const t = await connect(h);

    await t.getDocument('https://x.com/');
    await t.get('https://x.com/i/api/1.1/account/settings.json');

    for (const arg of h.ctx.page.evalArgs) {
      expect(arg.headers['cookie']).toBeUndefined();
      expect(arg.headers['user-agent']).toBeUndefined();
      expect(arg.headers['referer']).toBeUndefined();
      expect(arg.headers['origin']).toBeUndefined();
    }
    await t.close();
  });

  it('routes a non-X document (a bundle) to the credential-free asset fetch', async () => {
    const h = harness();
    const t = await connect(h);
    const before = h.ctx.page.evalArgs.length;

    const res = await t.getDocument('https://abs.twimg.com/x-web/x-web/entry.js');

    expect(res.body).toBe('bundle-source');
    expect(h.assetCalls).toEqual(['https://abs.twimg.com/x-web/x-web/entry.js']);
    expect(h.ctx.page.evalArgs.length).toBe(before);
    await t.close();
  });
});

describe('createPlaywrightTransport - non-X hosts', () => {
  it('fetches public JS bundles outside the page', async () => {
    const h = harness();
    const t = await connect(h);
    const evaluatesBefore = h.ctx.page.evalArgs.length;

    const res = await t.get('https://abs.twimg.com/responsive-web/client-web/main.abc.js');
    expect(res.body).toBe('bundle-source');
    expect(h.assetCalls).toEqual(['https://abs.twimg.com/responsive-web/client-web/main.abc.js']);
    // No cookies are needed for a public asset, and in-page it would be a
    // pointless cross-origin request.
    expect(h.ctx.page.evalArgs.length).toBe(evaluatesBefore);
    await t.close();
  });

  it('refuses to POST to a non-X host', async () => {
    const h = harness();
    const t = await connect(h);
    await expect(t.post('https://abs.twimg.com/anything', {})).rejects.toThrow(/Refusing to POST/);
    await t.close();
  });
});

describe('createPlaywrightTransport - close', () => {
  it('closes the context and the browser exactly once, however often it is called', async () => {
    const h = harness();
    const t = await connect(h);

    await t.close();
    await t.close();
    await Promise.all([t.close(), t.close()]);

    expect(h.ctx.closed).toBe(1);
    expect(h.ctx.browserClosed).toBe(1);
  });

  it('still closes the browser when closing the context throws', async () => {
    const h = harness();
    const t = await connect(h);
    vi.spyOn(h.ctx, 'close').mockRejectedValue(new Error('already gone'));

    await expect(t.close()).resolves.toBeUndefined();
    expect(h.ctx.browserClosed).toBe(1);
  });

  it('tolerates a context whose browser is already gone', async () => {
    const h = harness();
    const t = await connect(h);
    vi.spyOn(h.ctx, 'browser').mockReturnValue(null);
    await expect(t.close()).resolves.toBeUndefined();
  });
});
