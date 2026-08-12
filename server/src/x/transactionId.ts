import { randomBytes } from 'node:crypto';

/**
 * `x-client-transaction-id` - X's anti-automation header.
 *
 * This is twedel's single biggest fragility risk. The real web client derives
 * the value from an obfuscated routine that mixes the HTTP method, the path and
 * an animation-frame-derived key baked into the page. We deliberately do NOT
 * reimplement that: it changes without notice and reimplementing it is exactly
 * the kind of thing that breaks silently.
 *
 * Instead there is a three-layer fallback, cheapest first:
 *
 *  1. GENERATED (default). A random value of the right *shape*. X has
 *     historically accepted well-formed-but-unverifiable ids on these endpoints,
 *     and sending nothing at all is a stronger automation signal than sending a
 *     plausible one.
 *
 *  2. MANUAL. If X starts rejecting generated values (sudden 403s across every
 *     operation, often with code 353 / "Bad Request"), the user opens DevTools
 *     on x.com, copies a real `x-client-transaction-id` off any XHR in the
 *     Network tab, and pastes it in. `setManualTransactionId()` pins it for the
 *     whole process. A real id is single-use-ish in theory but in practice is
 *     accepted repeatedly for a while - long enough to finish a delete run.
 *
 *  3. PLAYWRIGHT (LOOP 6). If a pasted real id is also rejected, the header can
 *     only be produced by the page itself. The app then switches
 *     `TransportMode` to 'playwright' and issues requests from inside a real
 *     logged-in browser context, where X's own JS computes the header for us.
 *     That mode is slower but immune to this whole class of breakage.
 */

/** Observed length of a real `x-client-transaction-id`. */
const TRANSACTION_ID_LENGTH = 94;

/** Pinned value from `setManualTransactionId`; `null` means "generate". */
let manualTransactionId: string | null = null;

/**
 * A fresh random id of the observed shape: base64url alphabet, no padding,
 * ~94 characters.
 */
export function generateTransactionId(): string {
  // 71 bytes -> 95 base64 chars (unpadded); trim to the observed 94.
  const raw = randomBytes(71)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return raw.slice(0, TRANSACTION_ID_LENGTH);
}

/**
 * Pin a transaction id copied from DevTools, or pass `null` to go back to
 * generating one per request. Layer 2 of the strategy above.
 */
export function setManualTransactionId(v: string | null): void {
  const trimmed = typeof v === 'string' ? v.trim() : '';
  manualTransactionId = trimmed === '' ? null : trimmed;
}

/** The currently pinned manual id, if any. Never logged. */
export function getManualTransactionId(): string | null {
  return manualTransactionId;
}

/**
 * The id to send on the next request: the manual override when pinned,
 * otherwise a freshly generated one (a new value per call, matching how the
 * real client emits a distinct id per request).
 */
export function getTransactionId(): string {
  return manualTransactionId ?? generateTransactionId();
}
