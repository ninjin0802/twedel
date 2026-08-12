import type { Tweet } from '../../../shared/types.js';
import { config } from '../config.js';
import { OPERATIONS, graphqlUrl } from './endpoints.js';
import { resolveQueryId, staleDefaultNote, usedDefaultQueryId } from './queryId.js';
import type { XResponse, XTransport } from './transport.js';
import { isRecord } from './walk.js';

/**
 * The destructive operations. Everything here is irreversible on X's side.
 */

export type MutateOutcome = {
  status: 'deleted' | 'already_gone' | 'failed';
  error?: string;
  /**
   * Set on a 429: seconds until the rate-limit window resets. LOOP 4's runner
   * uses it to back off for exactly as long as X asked rather than guessing.
   */
  retryAfterSec?: number;
};

/**
 * X's vocabulary for "that tweet does not exist (any more)".
 *
 * Matching this is what separates "you already deleted it in a previous run"
 * from "something is broken" - and getting it wrong makes a resumed run look
 * like a catastrophic failure.
 */
const GONE_MESSAGE = /no status found|status not found|tweet (?:is )?not found|_missing/i;

/**
 * Errors that merely *contain* "not found" while describing the operation
 * rather than the tweet. A rotated queryId produces exactly these, and reading
 * one as `already_gone` would report a run that deleted nothing as a complete
 * success - while keeping the circuit breaker from ever tripping.
 */
const NOT_GONE_MESSAGE = /operation|persisted quer|query\s*id|unknown field|feature/i;

/** Legacy error code 144: "No status found with that ID." */
const GONE_CODE = 144;

/** Keep a hostile/verbose upstream message from bloating the run log. */
const MAX_ERROR_CHARS = 400;

/**
 * The `data` key X sets on a SUCCESSFUL mutation, per operation.
 *
 * X names it as the snake_case of the operation, but not reliably: `DeleteTweet`
 * answers `data.delete_tweet`, and `DeleteRetweet` has been seen as both
 * `data.unretweet` (the name the mutation carried when it was introduced) and
 * `data.delete_retweet`. Accepting both is not sloppiness - reading a successful
 * un-retweet as a failure turns it into a retry storm against an action X has
 * already performed, and `already_gone` cannot save us because the retweet is
 * genuinely gone.
 */
const SUCCESS_KEYS: Record<string, readonly string[]> = {
  [OPERATIONS.deleteTweet]: ['delete_tweet'],
  [OPERATIONS.deleteRetweet]: ['unretweet', 'delete_retweet'],
  // X answers a successful un-like `{ data: { unfavorite_tweet: "Done" } }`.
  // `favorite_tweet` is accepted defensively: X has historically named the
  // favorite/unfavorite pair inconsistently, and reading a successful un-like as
  // a failure would send the runner back to re-do an action X already performed.
  [OPERATIONS.unfavoriteTweet]: ['unfavorite_tweet', 'favorite_tweet'],
};

function isSuccessBody(body: unknown, operation: string): boolean {
  const data = isRecord(body) ? body['data'] : undefined;
  if (!isRecord(data)) return false;
  return (SUCCESS_KEYS[operation] ?? []).some((key) => data[key] != null);
}

interface GraphQLError {
  message: string;
  code: number | null;
}

/** Pull `errors[]` out of a GraphQL body, tolerating a non-JSON payload. */
function graphqlErrors(body: unknown): GraphQLError[] {
  if (!isRecord(body)) return [];
  const raw = body['errors'];
  if (!Array.isArray(raw)) return [];
  const out: GraphQLError[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const message = typeof item['message'] === 'string' ? item['message'] : '';
    // The code sits at the top level on REST-ish errors and under
    // `extensions.code` on GraphQL ones.
    const extensions = item['extensions'];
    const codeRaw = item['code'] ?? (isRecord(extensions) ? extensions['code'] : undefined);
    out.push({ message, code: typeof codeRaw === 'number' ? codeRaw : null });
  }
  return out;
}

function isGone(errors: GraphQLError[]): boolean {
  return errors.some(
    (e) =>
      e.code === GONE_CODE || (GONE_MESSAGE.test(e.message) && !NOT_GONE_MESSAGE.test(e.message)),
  );
}

function summarize(errors: GraphQLError[], fallback: string): string {
  const text = errors
    .map((e) => (e.code === null ? e.message : `${e.message} (code ${e.code})`))
    .filter((s) => s.trim() !== '')
    .join('; ');
  return (text === '' ? fallback : text).slice(0, MAX_ERROR_CHARS);
}

/** Seconds until X will accept writes again. */
function retryAfterFrom(res: XResponse): number {
  const reset = Number(res.headers['x-rate-limit-reset']);
  if (Number.isFinite(reset) && reset > 0) {
    // Epoch seconds. Clamp: a clock skew must not produce a negative backoff.
    const delta = Math.ceil(reset - Date.now() / 1000);
    if (delta > 0) return delta;
  }
  const retryAfter = Number(res.headers['retry-after']);
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);
  return config.rateLimitFallbackSec;
}

/**
 * Remove a tweet - or a like - from the account.
 *
 * CRITICAL: a retweet is not a tweet you can delete. `DeleteTweet` on a retweet
 * id fails, and the retweet stays up. Undoing a retweet is a different
 * operation (`DeleteRetweet`) that takes the ORIGINAL tweet's id as
 * `source_tweet_id`. A LIKE is different again: it is someone else's tweet the
 * account favorited, undone with `UnfavoriteTweet { tweet_id }` where `tweet_id`
 * is the LIKED tweet's id (the `id` on a like row). Dispatching on
 * `isLike`/`isRetweet` is therefore the single most important thing this file
 * does - and only worth anything if it names operations X actually has.
 *
 * Precedence is UNAMBIGUOUS and deliberate: a like → `UnfavoriteTweet`; else a
 * retweet → `DeleteRetweet`; else `DeleteTweet`. `isLike` wins first so that a
 * liked tweet which is itself a retweet still un-likes (never un-retweets).
 *
 * Never throws for an expected X answer - the caller gets an outcome to log.
 */
export async function deleteTweet(
  transport: XTransport,
  tweet: Pick<Tweet, 'id' | 'isRetweet' | 'sourceTweetId' | 'isLike'>,
): Promise<MutateOutcome> {
  const operation = tweet.isLike
    ? OPERATIONS.unfavoriteTweet
    : tweet.isRetweet
      ? OPERATIONS.deleteRetweet
      : OPERATIONS.deleteTweet;

  let queryId: string;
  try {
    queryId = await resolveQueryId(operation, transport);
  } catch (err: unknown) {
    return {
      status: 'failed',
      error: err instanceof Error ? err.message.slice(0, MAX_ERROR_CHARS) : 'queryId lookup failed',
    };
  }

  // `DeleteRetweet` un-retweets by the ORIGINAL tweet's id, which `fetchTweets`
  // captures as `sourceTweetId`. `tweet.id` is only the account's own retweet
  // ACTION id and un-retweets nothing. Fall back to `id` when the source id is
  // absent so behaviour is no worse than before it was captured.
  //
  // `UnfavoriteTweet` takes just `{ tweet_id }` - the liked tweet's id - matching
  // the favorite/unfavorite convention X's own web client uses. No `dark_request`
  // is sent: unlike the delete mutations, this pair does not carry it, and "X
  // ignores unknown variables" is not a safe assumption to build a write on.
  const variables = tweet.isLike
    ? { tweet_id: tweet.id }
    : tweet.isRetweet
      ? { source_tweet_id: tweet.sourceTweetId ?? tweet.id, dark_request: false }
      : { tweet_id: tweet.id, dark_request: false };

  let res: XResponse;
  try {
    res = await transport.post(graphqlUrl(queryId, operation), { variables, queryId });
  } catch (err: unknown) {
    // transport.ts has already redacted the cookies out of this message.
    return {
      status: 'failed',
      error: err instanceof Error ? err.message.slice(0, MAX_ERROR_CHARS) : 'request failed',
    };
  }

  if (res.status === 429) {
    return {
      status: 'failed',
      error: 'rate_limited: X returned 429. Pausing until the rate-limit window resets.',
      retryAfterSec: retryAfterFrom(res),
    };
  }

  if (res.status === 401 || res.status === 403) {
    return {
      status: 'failed',
      error:
        `Your X session expired or was rejected (HTTP ${res.status}). ` +
        'Re-copy auth_token and ct0 from your browser and reconnect.',
    };
  }

  const errors = graphqlErrors(res.body);

  // A "no such status" error means the tweet is already gone - a success for
  // the user's purposes, most likely from an earlier run.
  if (isGone(errors)) {
    return { status: 'already_gone' };
  }

  // A BARE 404 is NOT that. Calling it `already_gone` would report a run that
  // deleted nothing as a total success, and would stop the circuit breaker from
  // ever firing. Fail loudly - but do not claim to know WHY.
  //
  // X answers 404 for two unrelated things: a queryId that has rotated out of
  // the URL, and a request it simply refuses to route. The second is not
  // hypothetical - a single header decides whether the same URL answers 404 or
  // 401 (see endpoints.ts#V11_BASE). So: name both, and point at the route that
  // can actually tell them apart.
  // A stale snapshot id is a leading suspect for exactly the failures below, and
  // nothing else in the app would ever tell the user one was in play.
  const staleNote = usedDefaultQueryId(operation) ? ` ${staleDefaultNote(operation)}` : '';

  if (res.status === 404) {
    if (errors.length > 0) {
      return {
        status: 'failed',
        error: `${summarize(errors, `X returned HTTP 404 for ${operation}.`)}${staleNote}`,
      };
    }
    return {
      status: 'failed',
      error:
        `X returned HTTP 404 for ${operation} with no GraphQL error body. A 404 does not ` +
        'mean the operation was removed: either the queryId has rotated, or X declined to ' +
        'route the request at all. Run GET /api/diagnostics (上級者向け → 診断情報) to see ' +
        `which it is, then reconnect to re-resolve the id or paste a current one from DevTools.${staleNote}`,
    };
  }

  if (res.status >= 200 && res.status < 300) {
    if (isSuccessBody(res.body, operation)) {
      return { status: 'deleted' };
    }
    if (errors.length > 0) {
      return { status: 'failed', error: summarize(errors, 'X returned an error with no message.') };
    }
    return {
      status: 'failed',
      error:
        `X returned HTTP ${res.status} but no ${operation} result. The queryId may be stale.${staleNote}`,
    };
  }

  return {
    status: 'failed',
    error: summarize(errors, `X returned HTTP ${res.status} for ${operation}.`),
  };
}
