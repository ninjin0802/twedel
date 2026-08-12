import type { NextFunction, Request, Response } from 'express';
import type { ZodType } from 'zod';
import { maskSecret } from '../config.js';

/**
 * Shared request plumbing: validation, error shape, and credential scrubbing.
 *
 * The web client reads `message` off every non-2xx body (see `web/src/api.ts`),
 * so an error that carries no `message` shows up in the UI as a bare
 * "HTTP 500" - useless for the class of problems twedel actually hits (stale
 * cookies, rotated queryIds, a mistyped archive path).
 */

export class HttpError extends Error {
  readonly status: number;
  readonly extra: Record<string, unknown>;
  constructor(status: number, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.extra = extra;
  }
}

/**
 * Anything that looks like a cookie/token value, masked before it can reach a
 * response body or a console line.
 *
 * Belt and braces: `x/transport.ts` already redacts its own errors and no route
 * echoes a credential deliberately. This catches the case nobody thought of -
 * a stack frame, a driver message, a future contributor's `JSON.stringify(req.body)`.
 */
const CREDENTIAL_PATTERNS: readonly RegExp[] = [
  /\b(auth_token|authToken|ct0|csrf_token|bearer)\b\s*[=:]\s*"?([A-Za-z0-9%_\-.]{8,})"?/gi,
  /\bcookie\b\s*[=:]\s*"?([^"\s;]{8,})"?/gi,
];

export function scrubCredentials(text: string): string {
  let out = text;
  for (const re of CREDENTIAL_PATTERNS) {
    out = out.replace(re, (match, ...groups: unknown[]) => {
      const value = groups.filter((g): g is string => typeof g === 'string').pop();
      if (!value) return match;
      return match.replace(value, maskSecret(value));
    });
  }
  return out;
}

/** Turn zod issues into one actionable sentence WITHOUT echoing the values. */
export function formatIssues(error: { issues: readonly { path: PropertyKey[]; message: string }[] }): string {
  return error.issues
    .map((i) => `${i.path.length > 0 ? i.path.join('.') : 'body'}: ${i.message}`)
    .join('; ');
}

/** Validate `req.body`, throwing a 400 `HttpError` on failure. */
export function parseBody<T>(schema: ZodType<T>, req: Request): T {
  const result = schema.safeParse(req.body ?? {});
  if (!result.success) {
    throw new HttpError(400, `Invalid request body - ${formatIssues(result.error)}`);
  }
  return result.data;
}

/** Validate `req.query`, throwing a 400 `HttpError` on failure. */
export function parseQuery<T>(schema: ZodType<T>, req: Request): T {
  const result = schema.safeParse(req.query ?? {});
  if (!result.success) {
    throw new HttpError(400, `Invalid query string - ${formatIssues(result.error)}`);
  }
  return result.data;
}

/**
 * Middleware upstream of ours attaches its own status to an error - notably
 * `express.json()`, which throws a 400 for a malformed body. Honour that rather
 * than reporting the user's typo as a 500, but only inside the 4xx range: a
 * library that claims 500 does not get to bypass our own reporting.
 */
function clientErrorStatus(err: unknown): number | null {
  if (err === null || typeof err !== 'object') return null;
  const candidate = (err as { status?: unknown; statusCode?: unknown });
  const raw = typeof candidate.status === 'number' ? candidate.status : candidate.statusCode;
  if (typeof raw !== 'number' || !Number.isInteger(raw)) return null;
  return raw >= 400 && raw <= 499 ? raw : null;
}

/**
 * Terminal error middleware.
 *
 * Never sends a stack trace: this server is loopback-only but its responses are
 * rendered in a browser, and a stack is exactly where a credential that slipped
 * through everything else would surface.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }

  const status = err instanceof HttpError ? err.status : clientErrorStatus(err) ?? 500;
  const raw =
    err instanceof Error ? err.message : typeof err === 'string' ? err : 'Unexpected server error.';
  const message = scrubCredentials(raw);
  const extra = err instanceof HttpError ? err.extra : {};

  if (status >= 500) {
    // Server-side only, and still scrubbed.
    console.error('[twedel] request failed:', message);
  }

  res.status(status).json({ error: true, message, ...extra });
}
