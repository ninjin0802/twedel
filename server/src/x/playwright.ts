import { resolve } from 'node:path';
import type { Page } from 'playwright';
import { maskSecret } from '../config.js';
import { BROWSER_MANAGED_HEADERS, buildDocumentHeaders, buildHeaders } from './endpoints.js';
import { dataDir } from './paths.js';
import { generateTransactionId, getManualTransactionId } from './transactionId.js';
import type { XResponse, XTransport } from './transport.js';
import { parseBodyText } from './transport.js';

/**
 * Playwright transport: issue X's API calls from inside a real, logged-in
 * Chrome window instead of from Node's HTTP client.
 *
 * WHAT THIS ACTUALLY BUYS YOU (be honest about this - the whole point of the
 * mode is that cookie mode got blocked, so overselling it wastes the user's
 * time):
 *
 *   YES - real cookies straight out of a real browser profile. No copy-paste,
 *         no staleness, `ct0` re-read from the live jar on every request so a
 *         mid-run rotation cannot 403 us.
 *   YES - a genuine Chrome TLS/HTTP2 fingerprint, a genuine User-Agent, and
 *         the `Sec-Fetch-*` / `Origin` / `Referer` set that a real x.com page
 *         produces, because the request IS made by an x.com page.
 *   YES - same-origin: we rewrite `api.x.com/...` to the `x.com/i/api/...`
 *         path X's own web client uses, so nothing is a CORS request and every
 *         response header (including `x-rate-limit-*`) is readable.
 *
 *   NO  - it does NOT produce a valid `x-client-transaction-id`. That header is
 *         computed by X's own page JavaScript for the requests X's own code
 *         issues. Calling `fetch()` ourselves from inside `page.evaluate` does
 *         not make their signing routine run for our request, and neither does
 *         `page.request`. We harvest ids off X's own traffic when we see them
 *         (below), but that is opportunistic, not a solution.
 *
 * So: this mode is a materially BETTER ATTEMPT, not a guarantee. If X hard-
 * requires a freshly signed transaction id on `DeleteTweet`, this mode fails
 * too, and the honest next step is the manual DevTools paste
 * (`setManualTransactionId`) - or accepting that the endpoint is closed to us.
 */

/* -------------------------------------------------------------------------- */
/* Minimal structural view of the Playwright objects we use                    */
/* -------------------------------------------------------------------------- */

/**
 * We depend on a hand-written subset of Playwright's surface rather than on
 * `BrowserContext` / `Page` themselves. Two reasons:
 *  - tests can implement six methods instead of ~60, and
 *  - `chromium` stays injectable, so no test can ever spawn a browser.
 * The real types are adapted to this subset in exactly one place
 * (`realLauncher`), which is the only spot that imports `playwright`.
 */
export interface PwCookie {
  name: string;
  value: string;
}

/** The payload handed to the in-page `fetch`. Must be JSON-serialisable. */
export interface PwEvalArg {
  url: string;
  method: 'GET' | 'POST';
  headers: Record<string, string>;
  /** Pre-serialised JSON body, or `null` for GET. */
  body: string | null;
}

/** What the in-page function hands back. Headers are already lower-cased. */
export interface PwEvalResult {
  status: number;
  headers: Record<string, string>;
  text: string;
  contentType: string;
  /** Set when `fetch` itself threw inside the page (offline, blocked, CORS). */
  error?: string;
}

export interface PwPage {
  goto(url: string, options?: { waitUntil?: 'domcontentloaded'; timeout?: number }): Promise<void>;
  evaluate(fn: (arg: PwEvalArg) => Promise<PwEvalResult>, arg: PwEvalArg): Promise<PwEvalResult>;
}

export interface PwRequest {
  url(): string;
  /** Playwright lower-cases these for us. */
  headers(): Record<string, string>;
}

export interface PwContext {
  cookies(urls?: string): Promise<PwCookie[]>;
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
  on(event: 'request', handler: (request: PwRequest) => void): void;
  close(): Promise<void>;
  /** `null` when the context outlived its browser. */
  browser(): { close(): Promise<void> } | null;
}

export interface PwLaunchOptions {
  headless: boolean;
  /** Always `'chrome'`: use the installed Chrome, never a downloaded build. */
  channel: 'chrome';
}

export interface PlaywrightDeps {
  launchPersistentContext(userDataDir: string, options: PwLaunchOptions): Promise<PwContext>;
  /**
   * Used ONLY for public, unauthenticated assets on hosts other than x.com
   * (the `abs.twimg.com` JS bundles the queryId scraper reads). Those are
   * cross-origin from the page, so fetching them in-page would hit CORS for no
   * benefit - they need no cookies. Injectable so tests never touch the network.
   */
  fetchAsset(url: string): Promise<XResponse>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface PlaywrightTransportOptions {
  /** Defaults to `<dataDir>/pw-profile`. */
  userDataDir?: string;
  /** How long to wait for the user to log in. Default 3 minutes. */
  loginTimeoutMs?: number;
  /** How often to re-check the cookie jar while waiting. Default 2s. */
  pollIntervalMs?: number;
  /**
   * Default `false`. Headless is only useful once the profile is already
   * logged in, and it is a much stronger automation signal - do not flip this
   * on casually.
   */
  headless?: boolean;
  /** Progress lines for the caller to surface. Never receives credentials. */
  onStatus?: (message: string) => void;
  deps?: Partial<PlaywrightDeps>;
}

export const DEFAULT_LOGIN_TIMEOUT_MS = 180_000;
export const DEFAULT_POLL_INTERVAL_MS = 2_000;

/** The page we sit on while issuing requests. Same origin as the API paths. */
export const HOME_URL = 'https://x.com/home';
export const X_ORIGIN = 'https://x.com';

export const LOGIN_PROMPT =
  'Log in to X in the Chrome window twedel just opened. This window uses a ' +
  'dedicated twedel profile, not your everyday Chrome profile, so you have to log in ' +
  'once here. The login persists - you will not be asked again.';

/* -------------------------------------------------------------------------- */
/* Defaults                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The one place that touches `playwright`.
 *
 * `channel: 'chrome'` uses the Chrome already installed on the machine, so
 * `npx playwright install` is never needed and the browser is a real,
 * real-world-fingerprinted Chrome rather than a bundled Chromium build.
 *
 * `launchPersistentContext` against a DEDICATED directory is deliberate and
 * non-negotiable: pointing it at the user's live Chrome profile fails with a
 * `ProcessSingleton` lock error whenever their browser is open, and would risk
 * mutating the profile they actually browse with.
 *
 * The adapter below is written out by hand rather than cast, so every call we
 * make against the real Playwright API is still type-checked: if Playwright
 * renames or reshapes one of these six methods, this file stops compiling
 * instead of failing at runtime in front of the user.
 */
async function realLauncher(userDataDir: string, options: PwLaunchOptions): Promise<PwContext> {
  // Imported lazily and as a value only here, so nothing else in the app - and
  // no test - pulls Playwright in just by importing this module.
  const { chromium } = await import('playwright');
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: options.channel,
    headless: options.headless,
    viewport: null,
    // Strip the automation fingerprint. Playwright's defaults set
    // `--enable-automation` (which shows the "controlled by automated software"
    // infobar) and leave `navigator.webdriver === true`. X's login challenge
    // (Arkose/FunCaptcha) detects both and refuses to complete the sign-in - the
    // window opens but the user can never log in. Dropping the switch and
    // disabling the blink feature makes this a normal-looking Chrome so the login
    // flow works. This is for the user signing into THEIR OWN account, not for
    // evading anything: the requests afterwards are plainly twedel's.
    ignoreDefaultArgs: ['--enable-automation'],
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });

  const wrapPage = (page: Page): PwPage => ({
    goto: async (url, opts) => {
      await page.goto(url, opts);
    },
    evaluate: (fn, arg) => page.evaluate(fn, arg),
  });

  const adapted: PwContext = {
    cookies: (urls) => context.cookies(urls),
    pages: () => context.pages().map(wrapPage),
    newPage: async () => wrapPage(await context.newPage()),
    on: (event, handler) => {
      context.on(event, (request) => {
        handler({ url: () => request.url(), headers: () => request.headers() });
      });
    },
    close: () => context.close(),
    browser: () => context.browser(),
  };
  return adapted;
}

const defaultDeps: PlaywrightDeps = {
  launchPersistentContext: realLauncher,
  fetchAsset: async (url: string): Promise<XResponse> => {
    const res = await fetch(url);
    const headers: Record<string, string> = {};
    res.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      status: res.status,
      headers,
      body: parseBodyText(await res.text(), headers['content-type'] ?? ''),
    };
  },
  sleep: (ms: number) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
};

/* -------------------------------------------------------------------------- */
/* URL handling                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Map a URL onto the x.com origin so the page can fetch it same-origin.
 *
 * `api.x.com/1.1/foo` -> `x.com/i/api/1.1/foo`, which is the exact path X's own
 * web client uses for the v1.1 REST endpoints. Doing this is what keeps every
 * response header readable: a cross-origin fetch only exposes the CORS-safelisted
 * headers unless the server opts in, and `x-rate-limit-remaining` /
 * `x-rate-limit-reset` are NOT safelisted - the delete runner's backoff would
 * silently degrade to the fallback delay.
 *
 * Returns `null` for hosts that are not X at all (the `abs.twimg.com` bundles),
 * which the caller fetches with plain Node `fetch` instead.
 */
export function toPageUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase();
  if (host === 'x.com' || host === 'www.x.com') {
    return `${X_ORIGIN}${url.pathname}${url.search}`;
  }
  if (host === 'api.x.com') {
    return `${X_ORIGIN}/i/api${url.pathname}${url.search}`;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* The in-page request                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Runs INSIDE the browser page, so it must be self-contained: Playwright
 * serialises it to source and everything it needs arrives through `arg`.
 *
 * `credentials: 'include'` makes the browser attach the profile's real cookies;
 * we never set a `cookie` header ourselves (browsers forbid it anyway). Headers
 * are lower-cased here so the shape matches the cookie transport exactly, and a
 * network-level failure is returned rather than thrown so the error survives
 * the serialisation boundary intact.
 */
async function inPageFetch(arg: PwEvalArg): Promise<PwEvalResult> {
  try {
    const init: RequestInit = {
      method: arg.method,
      headers: arg.headers,
      credentials: 'include',
    };
    if (arg.body !== null) init.body = arg.body;
    const res = await fetch(arg.url, init);
    const headers: Record<string, string> = {};
    res.headers.forEach((value: string, key: string) => {
      headers[key.toLowerCase()] = value;
    });
    return {
      status: res.status,
      headers,
      text: await res.text(),
      contentType: headers['content-type'] ?? '',
    };
  } catch (err: unknown) {
    return {
      status: 0,
      headers: {},
      text: '',
      contentType: '',
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    };
  }
}

/* -------------------------------------------------------------------------- */
/* Transport                                                                   */
/* -------------------------------------------------------------------------- */

function isAuthCookiePresent(cookies: PwCookie[]): boolean {
  return cookies.some((c) => c.name === 'auth_token' && c.value.trim() !== '');
}

/** The first non-empty value for `name`, or `''`. Never logs what it read. */
export function readCookie(cookies: PwCookie[], name: string): string {
  for (const c of cookies) {
    if (c.name === name && c.value !== '') return c.value;
  }
  return '';
}

/** Turn a launch failure into something the user can actually act on. */
function describeLaunchFailure(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  const lower = detail.toLowerCase();

  if (lower.includes("executable doesn't exist") || lower.includes('channel "chrome"')) {
    return (
      'Could not start Chrome. twedel uses your installed Google Chrome ' +
      '(channel "chrome"), normally at ' +
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe. Install Chrome, or ' +
      'use cookie mode instead.'
    );
  }
  if (
    lower.includes('processsingleton') ||
    lower.includes('singletonlock') ||
    lower.includes('profile appears to be in use') ||
    lower.includes('failed to create a new browser context')
  ) {
    return (
      'The twedel browser profile is already in use. Another twedel window is probably ' +
      'still open - close it (or close the Chrome window twedel opened earlier) and try again.'
    );
  }
  return `Could not start the twedel browser: ${detail}`;
}

/* -------------------------------------------------------------------------- */
/* Launch + login gate (shared by the transport and the cookie harvest)        */
/* -------------------------------------------------------------------------- */

export interface OpenOptions extends PlaywrightTransportOptions {
  /**
   * Called once with the fresh context, after the launch and BEFORE the first
   * navigation - the only window in which a `context.on(...)` listener is
   * guaranteed to see every request the page makes.
   */
  onContext?: (context: PwContext) => void;
}

/** A launched, logged-in browser context plus the teardown that owns it. */
export interface OpenedBrowser {
  context: PwContext;
  /** The page sitting on x.com. Reused rather than opening a second tab. */
  page: PwPage;
  /**
   * Idempotent teardown: closes the context AND the browser behind it, and
   * swallows both failures. Safe to call from a `finally` on any path.
   */
  close(): Promise<void>;
  /** The resolved deps, so a caller can keep using the same injected clock. */
  deps: PlaywrightDeps;
  /** The resolved poll interval, for callers that need to wait on the jar too. */
  pollIntervalMs: number;
}

/**
 * Launch the dedicated Chrome profile, sit on x.com, and return only once the
 * profile's cookie jar actually holds an `auth_token`.
 *
 * This is the half of `createPlaywrightTransport` that the cookie harvest needs
 * verbatim - one Chrome launcher, one login gate, one teardown, so a fix to any
 * of them cannot apply to only one of the two callers.
 *
 * Throws (with an actionable message) when Chrome cannot start, the profile is
 * locked, or the login never happens inside `loginTimeoutMs`. It NEVER leaves a
 * browser running on a throwing path.
 */
export async function openLoggedInContext(opts: OpenOptions = {}): Promise<OpenedBrowser> {
  const deps: PlaywrightDeps = { ...defaultDeps, ...opts.deps };
  const userDataDir = opts.userDataDir ?? resolve(dataDir(), 'pw-profile');
  const loginTimeoutMs = opts.loginTimeoutMs ?? DEFAULT_LOGIN_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const status = opts.onStatus ?? (() => {});

  let context: PwContext;
  try {
    context = await deps.launchPersistentContext(userDataDir, {
      headless: opts.headless ?? false,
      channel: 'chrome',
    });
  } catch (err: unknown) {
    throw new Error(`[twedel] ${describeLaunchFailure(err)}`);
  }

  opts.onContext?.(context);

  /* --- teardown ----------------------------------------------------------- */

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    // Idempotent: repeated calls (mode switch + clearSession + shutdown hook)
    // share the first teardown instead of racing it or throwing.
    if (!closing) {
      closing = (async () => {
        try {
          await context.close();
        } catch {
          // Already gone, or the browser died on its own. Nothing to salvage.
        }
        try {
          // A persistent context owns its browser; close it too so no
          // chrome.exe is left behind holding the profile lock.
          await context.browser()?.close();
        } catch {
          // Same.
        }
      })();
    }
    return closing;
  };

  /* --- login gate --------------------------------------------------------- */

  // EVERYTHING from here to the successful return runs inside this guard. Once
  // a browser exists, the only ways out of this function are "return it to a
  // caller who owns it" and "close it" - a thrown `context.cookies()` (a dropped
  // CDP connection, a window the user closed mid-gate) must not leave a
  // chrome.exe running with nobody holding a handle to it.
  let page: PwPage;
  try {
    page = context.pages()[0] ?? (await context.newPage());
    try {
      // Bounded by the login gate as well as by its own ceiling: a caller asking
      // for a 5s gate must not sit through a 60s navigation first.
      await page.goto(HOME_URL, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(60_000, Math.max(loginTimeoutMs, 5_000)),
      });
    } catch {
      // A slow or partially-loaded x.com is not fatal: the cookie check below is
      // the real gate, and the page may still finish loading while we poll.
    }

    const deadline = deps.now() + loginTimeoutMs;
    // Belt AND braces: the wall-clock deadline is the real bound, but a poll
    // counter guarantees termination even if the clock misbehaves. "Waits
    // forever with a browser window open" is the one failure mode this gate
    // exists to prevent, so it must not depend on a single condition.
    const maxPolls = Math.ceil(loginTimeoutMs / Math.max(pollIntervalMs, 1)) + 1;

    let loggedIn = isAuthCookiePresent(await context.cookies(X_ORIGIN));
    if (!loggedIn) status(LOGIN_PROMPT);
    for (let poll = 0; !loggedIn && poll < maxPolls && deps.now() < deadline; poll += 1) {
      await deps.sleep(pollIntervalMs);
      loggedIn = isAuthCookiePresent(await context.cookies(X_ORIGIN));
    }

    if (!loggedIn) {
      throw new Error(
        `[twedel] Timed out after ${Math.round(loginTimeoutMs / 1000)}s waiting for an X login ` +
          `in the twedel browser window. ${LOGIN_PROMPT} Then connect again.`,
      );
    }
  } catch (err: unknown) {
    await close();
    throw err;
  }

  status('Browser session is logged in to X.');
  return { context, page, close, deps, pollIntervalMs };
}

export interface PlaywrightTransport extends XTransport {
  readonly mode: 'playwright';
  /** The profile directory in use. Handy for diagnostics; never a secret. */
  readonly userDataDir: string;
  /**
   * The most recent real `x-client-transaction-id` observed on X's OWN traffic,
   * or `null`. Exposed for diagnostics only.
   */
  lastHarvestedTransactionId(): string | null;
}

/**
 * Launch Chrome, wait for the profile to be logged in to X, and return a
 * transport that issues every X request from that page.
 *
 * Throws (with an actionable message) when Chrome cannot start, the profile is
 * locked, or the login never happens inside `loginTimeoutMs`. Callers turn that
 * into `connected: false` rather than a crash.
 */
export async function createPlaywrightTransport(
  opts: PlaywrightTransportOptions = {},
): Promise<PlaywrightTransport> {
  const userDataDir = opts.userDataDir ?? resolve(dataDir(), 'pw-profile');

  /* --- transaction id harvesting (best effort, see file header) ----------- */

  let harvested: string | null = null;
  /**
   * Ids WE sent. Without this the listener would immediately "harvest" our own
   * generated value back off our own request and the whole mechanism would be a
   * no-op that looks like it works.
   */
  const ownIds = new Set<string>();

  /* --- launch + login gate ------------------------------------------------ */

  const { context, page, close, deps } = await openLoggedInContext({
    ...opts,
    userDataDir,
    // Registered before the first navigation, so no request is missed.
    onContext: (ctx) => {
      ctx.on('request', (request) => {
        try {
          const id = request.headers()['x-client-transaction-id'];
          if (!id || ownIds.has(id)) return;
          if (!request.url().includes('/i/api/')) return;
          // Honest caveats, all of them unresolved:
          //  - a real id is derived per (method, path), so reusing one on a
          //    DIFFERENT endpoint (ours) is a guess;
          //  - it may be single-use, in which case the second use is worthless;
          //  - while the page sits idle X emits few requests, so a long delete
          //    run can end up replaying ONE id many times, which is itself a
          //    signal.
          // We keep it anyway because an id with real provenance is a better bet
          // than a random one. This is odds-improving, not a way to sign requests.
          harvested = id;
        } catch {
          // A listener must never be able to take the transport down.
        }
      });
    },
  });

  /* --- requests ----------------------------------------------------------- */

  /**
   * `cookie`, `user-agent`, `referer` and `origin` are forbidden header names
   * in a browser `fetch` - setting them throws. The browser supplies all four
   * itself, genuinely, which is the entire point of this mode.
   */
  function stripBrowserManaged(headers: Record<string, string>): Record<string, string> {
    for (const name of BROWSER_MANAGED_HEADERS) delete headers[name];
    return headers;
  }

  async function send(
    method: 'GET' | 'POST',
    url: string,
    body?: unknown,
    /** Document fetch: the browser-navigation header set, no API headers. */
    asDocument = false,
  ): Promise<XResponse> {
    const pageUrl = toPageUrl(url);

    // Not an X host: a public asset (the JS bundles the queryId scraper reads).
    // No cookies needed, and in-page it would be a pointless CORS request.
    if (pageUrl === null) {
      if (method !== 'GET') {
        throw new Error(`[twedel] Refusing to POST to a non-X host from the browser: ${url}`);
      }
      return deps.fetchAsset(url);
    }

    // Re-read `ct0` from the live jar on EVERY request. X rotates it, and a
    // cached value produces a 403 (code 353) the moment it does - caching this
    // would turn a healthy session into a mysterious mid-run failure.
    const cookies = await context.cookies(X_ORIGIN);
    const ct0 = readCookie(cookies, 'ct0');

    let headers: Record<string, string>;
    if (asDocument) {
      // Cookies come from the page's own jar, so `withCookies` is moot here -
      // what matters is that NONE of the API headers are set.
      headers = stripBrowserManaged(buildDocumentHeaders({ withCookies: false }));
    } else {
      // Precedence: a value the user pinned by hand (an explicit decision) beats
      // one we happened to observe, which beats a generated one.
      const transactionId = getManualTransactionId() ?? harvested ?? generateTransactionId();
      // Trim BEFORE adding so the id currently in flight is always in the set -
      // otherwise the listener could harvest our own request back off the wire.
      if (ownIds.size > 100) ownIds.clear();
      ownIds.add(transactionId);
      headers = stripBrowserManaged(buildHeaders({ ct0, authToken: '', transactionId }));
    }

    let raw: PwEvalResult;
    try {
      raw = await page.evaluate(inPageFetch, {
        url: pageUrl,
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(body ?? {}) : null,
      });
    } catch (err: unknown) {
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      throw new Error(
        `[twedel] ${method} ${pageUrl} failed in the browser: ${redact(detail, ct0)}. ` +
          'The twedel browser window may have been closed - reconnect to reopen it.',
      );
    }

    if (raw.error !== undefined) {
      throw new Error(
        `[twedel] ${method} ${pageUrl} failed in the browser: ${redact(raw.error, ct0)}`,
      );
    }

    return {
      status: raw.status,
      headers: raw.headers,
      body: parseBodyText(raw.text, raw.contentType),
    };
  }

  return {
    mode: 'playwright',
    userDataDir,
    lastHarvestedTransactionId: () => harvested,
    get: (url) => send('GET', url),
    post: (url, body) => send('POST', url, body),
    getDocument: (url) => send('GET', url, undefined, true),
    close,
  };
}

/** Keep a rotating CSRF token out of any message that escapes this module. */
function redact(text: string, ct0: string): string {
  if (ct0.length < 4) return text;
  return text.split(ct0).join(maskSecret(ct0));
}
