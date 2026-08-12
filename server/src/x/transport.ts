import type { TransportMode } from '../../../shared/types.js';
import { config, maskSecret } from '../config.js';
import { buildDocumentHeaders, buildHeaders, isXHost } from './endpoints.js';
import { getTransactionId } from './transactionId.js';

/**
 * The transport abstraction.
 *
 * Everything above this file (queryId resolution, session, fetching, deleting)
 * is written against `XTransport` and is completely unaware of whether the
 * bytes are moving via `fetch` with cookie headers or, later, via a real
 * browser page. Adding a mode must not require touching any caller.
 */

export interface XResponse {
  status: number;
  /** All header names lower-cased, so callers can index them literally. */
  headers: Record<string, string>;
  /** Parsed JSON when the response says JSON, otherwise the raw text. */
  body: unknown;
}

export interface XTransport {
  readonly mode: TransportMode;
  /** An API call: full authenticated header set (see `buildHeaders`). */
  post(url: string, body: unknown): Promise<XResponse>;
  /** An API call: full authenticated header set (see `buildHeaders`). */
  get(url: string): Promise<XResponse>;
  /**
   * Fetch a DOCUMENT the way a browser navigating to it would.
   *
   * Cookies (so the logged-in shell renders), a browser User-Agent and an HTML
   * `accept` - and none of the API headers. Aiming `get()` at an HTML page
   * turns it into an API request, which X judges by API rules and can answer
   * 401 or 404 for a session that is perfectly healthy.
   *
   * Non-X hosts (the `abs.twimg.com` JS bundles) get NO credentials at all:
   * that CDN needs none.
   */
  getDocument(url: string): Promise<XResponse>;
  close(): Promise<void>;
}

export interface CookieCredentials {
  authToken: string;
  ct0: string;
}

/**
 * Replace any occurrence of the live credentials with their masked form.
 *
 * Applied to every error message that leaves this module. `fetch` failures can
 * carry a `cause` that stringifies request details, and a future contributor
 * might interpolate a header dump into an error - this makes the raw cookie
 * unable to escape regardless.
 */
function redact(text: string, creds: CookieCredentials): string {
  let out = text;
  for (const secret of [creds.authToken, creds.ct0]) {
    if (secret && secret.length >= 4) {
      out = out.split(secret).join(maskSecret(secret));
    }
  }
  return out;
}

function lowerCaseHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key.toLowerCase()] = value;
  });
  return out;
}

/**
 * Body policy, shared by every transport so `XResponse.body` means the same
 * thing regardless of how the bytes arrived: parsed JSON when the response says
 * JSON, raw text otherwise.
 */
export function parseBodyText(text: string, contentType: string): unknown {
  if (!contentType.toLowerCase().includes('json')) return text;
  if (text.trim() === '') return text;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // X occasionally answers an HTML error page with a JSON content-type.
    // Handing the caller the raw text beats throwing on a body we never needed.
    return text;
  }
}

async function readBody(res: Response): Promise<unknown> {
  return parseBodyText(await res.text(), res.headers.get('content-type') ?? '');
}

/**
 * Cookie transport: plain HTTP using the account's `auth_token` + `ct0`.
 *
 * Uses global `fetch` (undici under the hood in Node 24) rather than undici's
 * `request` directly - one HTTP client, and the one msw can intercept in tests.
 */
export function createCookieTransport(creds: CookieCredentials): XTransport {
  const { authToken, ct0 } = creds;

  async function exchange(
    method: 'GET' | 'POST',
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<XResponse> {
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = body;
    // A request that connects and then stalls must not hang the caller forever.
    // The runner catches the resulting AbortError as a normal failed attempt.
    const timeoutMs = config.requestTimeoutMs;
    if (timeoutMs > 0) init.signal = AbortSignal.timeout(timeoutMs);

    // The timeout guards the WHOLE exchange, not just the header fetch: the
    // signal fires even while the body is streaming, so `readBody` must be inside
    // the same try/catch or a mid-body stall would throw a raw, unredacted error.
    try {
      const res = await fetch(url, init);
      return {
        status: res.status,
        headers: lowerCaseHeaders(res.headers),
        body: await readBody(res),
      };
    } catch (err: unknown) {
      // `AbortSignal.timeout` rejects with a TimeoutError; surface it as such so
      // the runner's retry ladder and circuit breaker treat it like any failure.
      const timedOut = err instanceof Error && err.name === 'TimeoutError';
      const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      const suffix = timedOut ? ` (no response within ${Math.round(timeoutMs / 1000)}s)` : '';
      // Non-2xx never lands here - only genuine transport failures do.
      throw new Error(`[twedel] ${method} ${url} failed: ${redact(detail, creds)}${suffix}`);
    }
  }

  async function send(method: 'GET' | 'POST', url: string, body?: unknown): Promise<XResponse> {
    // Fresh transaction id per request - the real client never reuses one.
    const headers = buildHeaders({ ct0, authToken, transactionId: getTransactionId() });
    return exchange(method, url, headers, method === 'POST' ? JSON.stringify(body ?? {}) : undefined);
  }

  /**
   * A browser-shaped document fetch. The cookies are attached ONLY for X's own
   * hosts: the bundle URLs come out of a document we did not write, and a
   * public CDN has no business seeing the account's session.
   */
  async function getDocument(url: string): Promise<XResponse> {
    const headers = isXHost(url)
      ? buildDocumentHeaders({ authToken, ct0 })
      : buildDocumentHeaders({ withCookies: false });
    return exchange('GET', url, headers);
  }

  return {
    mode: 'cookie',
    get: (url) => send('GET', url),
    post: (url, body) => send('POST', url, body),
    getDocument,
    close: async () => {
      // Nothing to release: `fetch` owns the global agent.
    },
  };
}

// The playwright transport lives in `./playwright.ts` - it needs a browser
// launch (and therefore an async factory), which does not belong in this file's
// synchronous, dependency-free surface. It implements exactly the `XTransport`
// contract above (`mode: 'playwright'`, same `XResponse`, a `close()` that
// really tears the browser down), so no caller changes.
//
// Read the header comment there before assuming what it fixes: it gives real
// browser cookies, a real fingerprint and same-origin requests, but it does NOT
// make X's page JavaScript sign an `x-client-transaction-id` for requests we
// issue ourselves (see transactionId.ts). It is a better attempt, not a bypass.
