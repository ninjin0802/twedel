import type { Tweet } from '../../../shared/types.js';
import { config } from '../config.js';
import { OPERATIONS, TIMELINE_FEATURES, USER_FIELD_TOGGLES, graphqlUrl } from './endpoints.js';
import { resolveQueryId } from './queryId.js';
import type { XResponse, XTransport } from './transport.js';
import type { Rec } from './walk.js';
import { deepFind, getPath, getString, isRecord, walk } from './walk.js';

/**
 * Reading the account's own timeline via GraphQL.
 *
 * Two hard-won rules shape this file:
 *  1. Never hardcode the full nesting path (see walk.ts) - X reshuffles it.
 *  2. Never trust `new Date(twitterDateString)` - see `parseTwitterDate`.
 */

export interface FetchProgress {
  fetched: number;
  cursorPage: number;
  done: boolean;
  /**
   * Which timeline source produced these tweets - the candidate's label (see
   * `TIMELINE_CANDIDATES`), e.g. `UserTweetsAndReplies`.
   *
   * Additive to the SSE contract, and present for a reason: when a timeline read
   * goes wrong, "which operation was X actually being asked for" is the first
   * question, and it used to be unanswerable without a debugger.
   *
   * It is also how "replies were NOT covered" is surfaced: a value of
   * `UserTweets` (the profile "Posts" view, the partial last-resort candidate)
   * means the account's replies were excluded from this fetch - the combined
   * stream and the split family both failed to route. Any other value means
   * full coverage. See `TIMELINE_CANDIDATES`.
   */
  operation?: string;
}

export interface FetchTweetsOptions {
  transport: XTransport;
  screenName: string;
  max?: number;
  onProgress?: (p: FetchProgress) => void;
  signal?: AbortSignal;
  /**
   * Overrides the global pacing window. Additive to the LOOP 3 contract so
   * tests can run with zero delay; production leaves it unset.
   */
  pacing?: { minDelayMs: number; maxDelayMs: number };
}

/** Tweets per page. 20 is what the real web client asks for. */
const PAGE_SIZE = 20;

/* -------------------------------------------------------------------------- */
/* Timeline candidates                                                         */
/* -------------------------------------------------------------------------- */

export interface TimelineVariablesInput {
  userId: string;
  cursor: string | null;
  count: number;
}

export interface TimelineOperationSpec {
  operation: string;
  /**
   * Per-operation, NOT shared. The split timeline operations are separate
   * GraphQL fields and nothing guarantees they take the same arguments; baking
   * one variables blob for all of them would rediscover this file's original
   * mistake one layer down.
   */
  variables: (input: TimelineVariablesInput) => Record<string, unknown>;
  features: Record<string, boolean>;
}

export interface TimelineCandidate {
  /** What progress events and error messages call this source. */
  label: string;
  /** Fetched in order and MERGED; more than one means the split family. */
  ops: readonly TimelineOperationSpec[];
}

/** The arguments the combined timeline operations have always taken. */
function combinedTimelineVariables(input: TimelineVariablesInput): Record<string, unknown> {
  const variables: Record<string, unknown> = {
    userId: input.userId,
    count: input.count,
    includePromotedContent: false,
    withCommunity: true,
    withVoice: true,
    withV2Timeline: true,
  };
  if (input.cursor) variables['cursor'] = input.cursor;
  return variables;
}

/**
 * The split-family arguments.
 *
 * Spelled out separately from `combinedTimelineVariables` even though it is
 * currently a subset: these are different operations, they are new, and the
 * moment one of them wants an argument the others do not, the fix has to be a
 * one-line edit here rather than a refactor.
 */
function splitTimelineVariables(input: TimelineVariablesInput): Record<string, unknown> {
  const variables: Record<string, unknown> = {
    userId: input.userId,
    count: input.count,
    includePromotedContent: false,
    withVoice: true,
  };
  if (input.cursor) variables['cursor'] = input.cursor;
  return variables;
}

/**
 * The LIKES timeline's arguments.
 *
 * Spelled out separately from the tweet-timeline builders - even though it is
 * currently the combined shape - for the reason stated on `splitTimelineVariables`:
 * `Likes` is a different operation and the day it wants an argument the others do
 * not, the fix must be a one-line edit here rather than a shared-blob refactor.
 */
export function likesTimelineVariables(input: TimelineVariablesInput): Record<string, unknown> {
  const variables: Record<string, unknown> = {
    userId: input.userId,
    count: input.count,
    includePromotedContent: false,
    withClientEventToken: false,
    withVoice: true,
    withV2Timeline: true,
  };
  if (input.cursor) variables['cursor'] = input.cursor;
  return variables;
}

/**
 * Where the account's tweets come from, in the order they are tried.
 *
 * Measured 2026-08-12: `UserTweetsAndReplies` - the operation this file used to
 * hardcode - answers 404 for a live session that `UserByScreenName` resolves
 * against and that `Viewer` answers 200 for. Its queryId was freshly scraped and
 * correct. X still SHIPS the id; it just does not route the operation any more.
 *
 * So the timeline is a chain, tried in order, falling through on 404 ONLY:
 *
 *  1. `UserTweetsAndReplies` - the COMPLETE single stream (originals + replies +
 *     reposts) when X still routes it. First because one read covers everything.
 *  2. The split family, merged: originals + replies + reposts. This is the
 *     COMPLETE coverage when the combined stream does not route - it is the
 *     equivalent of (1) reassembled from the per-kind operations, so it is tried
 *     BEFORE the partial `UserTweets`, not after it.
 *  3. `UserTweets` - the profile "Posts" view. This is a PARTIAL last resort: it
 *     EXCLUDES replies, so anything the account replied to never appears and can
 *     never be selected for deletion. It is kept only so that a total failure of
 *     (1) and (2) still yields *something* rather than nothing; when it is the
 *     source that worked, the reported `operation` says so (see `fetchUserTweets`)
 *     so the user can tell replies were not covered.
 *
 * The previous order put `UserTweets` at position 2, which was the bug: on an
 * account where `UserTweetsAndReplies` 404s but `UserTweets` answers 200, the
 * chain stopped at the partial view and the account's replies were never fetched.
 *
 * A 401/403 is a session problem and must abort; a 429 is a rate limit and must
 * back off. Neither may fall through - falling through would burn the remaining
 * candidates against a wall and report the wrong cause.
 */
export const TIMELINE_CANDIDATES: readonly TimelineCandidate[] = [
  {
    label: OPERATIONS.userTweetsAndReplies,
    ops: [
      {
        operation: OPERATIONS.userTweetsAndReplies,
        variables: combinedTimelineVariables,
        features: TIMELINE_FEATURES,
      },
    ],
  },
  {
    label: `${OPERATIONS.userOriginalsTimeline} + ${OPERATIONS.userRepliesTimeline} + ${OPERATIONS.userRepostsTimeline}`,
    ops: [
      {
        operation: OPERATIONS.userOriginalsTimeline,
        variables: splitTimelineVariables,
        features: TIMELINE_FEATURES,
      },
      {
        operation: OPERATIONS.userRepliesTimeline,
        variables: splitTimelineVariables,
        features: TIMELINE_FEATURES,
      },
      {
        operation: OPERATIONS.userRepostsTimeline,
        variables: splitTimelineVariables,
        features: TIMELINE_FEATURES,
      },
    ],
  },
  {
    label: OPERATIONS.userTweets,
    ops: [
      {
        operation: OPERATIONS.userTweets,
        variables: combinedTimelineVariables,
        features: TIMELINE_FEATURES,
      },
    ],
  },
];

/**
 * The candidate that last worked, remembered for the life of the process.
 *
 * Without this, every page of every run re-probes the dead operations first:
 * two guaranteed 404s per page, which is both slow and exactly the kind of
 * traffic pattern worth not generating.
 */
let workingCandidate: string | null = null;

/** Which timeline source is in use, for diagnostics. `null` until one works. */
export function timelineSourceInUse(): string | null {
  return workingCandidate;
}

/** Forget the remembered source. Used by tests and by a reconnect. */
export function resetTimelineSource(): void {
  workingCandidate = null;
}

/** The remembered candidate first, then the rest in their declared order. */
function candidateOrder(): TimelineCandidate[] {
  const remembered = TIMELINE_CANDIDATES.find((c) => c.label === workingCandidate);
  if (!remembered) return [...TIMELINE_CANDIDATES];
  return [remembered, ...TIMELINE_CANDIDATES.filter((c) => c !== remembered)];
}

/** Absolute page ceiling - a belt-and-braces guard against a cursor loop. */
const MAX_PAGES = 1000;

/**
 * Old history can contain a small bridge of duplicate/context-only pages, but
 * an endlessly changing cursor with no usable rows is not useful progress.
 */
const MAX_CONSECUTIVE_EMPTY_PAGES = 5;

/** Consecutive 429s tolerated on one page before giving up. */
const MAX_RATE_LIMIT_RETRIES = 5;

/** Never sleep longer than this on a rate limit, however far out the reset is. */
const MAX_RATE_LIMIT_WAIT_MS = 15 * 60 * 1000;

const MONTHS: Record<string, number> = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

const TWITTER_DATE =
  /^[A-Za-z]{3} ([A-Za-z]{3}) (\d{2}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2}) (\d{4})$/;

/**
 * Parse `"Wed Oct 10 20:19:24 +0000 2018"` to an ISO string.
 *
 * Explicitly, because `new Date(str)` on this format is implementation-defined:
 * V8 happens to accept it, but it also silently accepts garbage as `Invalid
 * Date` and - worse - some runtimes reinterpret the offset against the local
 * timezone. Getting this wrong shifts tweets across a date boundary, which for
 * a date-range delete filter means deleting the wrong tweets.
 *
 * Returns `null` when the string is not in the expected format; the caller
 * drops the tweet rather than guessing a timestamp.
 */
export function parseTwitterDate(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const m = TWITTER_DATE.exec(input.trim());
  if (!m) return null;

  const month = MONTHS[m[1] as string];
  if (month === undefined) return null;

  const day = Number(m[2]);
  const hour = Number(m[3]);
  const minute = Number(m[4]);
  const second = Number(m[5]);
  const sign = m[6] === '-' ? -1 : 1;
  const offsetMin = sign * (Number(m[7]) * 60 + Number(m[8]));
  const year = Number(m[9]);

  const utcMs = Date.UTC(year, month, day, hour, minute, second) - offsetMin * 60_000;
  if (!Number.isFinite(utcMs)) return null;
  return new Date(utcMs).toISOString();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolvePromise) => {
    if (signal?.aborted) {
      resolvePromise();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolvePromise();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolvePromise();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Jittered human-ish gap between pages. */
function pacingDelay(opts: FetchTweetsOptions): number {
  const min = opts.pacing?.minDelayMs ?? config.minDelayMs;
  const max = opts.pacing?.maxDelayMs ?? config.maxDelayMs;
  if (max <= min) return Math.max(0, min);
  return min + Math.floor(Math.random() * (max - min + 1));
}

/** Milliseconds until `x-rate-limit-reset` (epoch seconds), clamped. */
function msUntilReset(headers: Record<string, string>): number {
  const resetSec = Number(headers['x-rate-limit-reset']);
  const waitMs = Number.isFinite(resetSec)
    ? resetSec * 1000 - Date.now()
    : config.rateLimitFallbackSec * 1000;
  return Math.min(Math.max(waitMs, 0), MAX_RATE_LIMIT_WAIT_MS);
}

/**
 * Honour `x-rate-limit-remaining` / `x-rate-limit-reset`.
 *
 * X hands out a budget per 15-minute window and answers 429 once it is spent.
 * Sleeping proactively when `remaining` hits 0 keeps us from ever generating
 * the 429 in the first place, which matters because repeated 429s are exactly
 * the signal that gets an account flagged.
 */
async function honorRateLimit(res: XResponse, signal?: AbortSignal): Promise<void> {
  const remaining = Number(res.headers['x-rate-limit-remaining']);
  if (!Number.isFinite(remaining) || remaining > 0) return;
  await sleep(msUntilReset(res.headers), signal);
}

/**
 * Collect timeline tweet objects wherever they are nested.
 *
 * `walk` stops descending once a Tweet is claimed, which is deliberate: a
 * retweet carries the ORIGINAL tweet inside `legacy.retweeted_status_result`,
 * and a quote tweet carries the quoted one. Descending into those would return
 * other people's tweets as if they were ours.
 */
export function collectTweetNodes(body: unknown): Rec[] {
  const out: Rec[] = [];
  walk(body, (node) => {
    const typename = node['__typename'];
    if (typename === 'Tweet') {
      out.push(node);
      return true;
    }
    if (typename === 'TweetWithVisibilityResults') {
      // Limited-visibility wrapper: the real tweet hangs off `.tweet`.
      const inner = node['tweet'];
      if (isRecord(inner)) out.push(inner);
      return true;
    }
    return false;
  });
  return out;
}

/** The `cursor-bottom-*` value that fetches the next (older) page. */
export function findBottomCursor(body: unknown): string | null {
  let cursor: string | null = null;

  // Preferred: the timeline entry whose id marks the bottom of the page.
  walk(body, (node) => {
    if (cursor) return true;
    const entryId = node['entryId'];
    if (typeof entryId === 'string' && entryId.startsWith('cursor-bottom')) {
      const value =
        getString(node, 'content.value') ??
        getString(node, 'content.itemContent.value') ??
        getString(node, 'value');
      if (value) {
        cursor = value;
        return true;
      }
    }
    return false;
  });
  if (cursor) return cursor;

  // Fallback: a bare cursor object with no surrounding entry.
  const bare = deepFind(
    body,
    (n) => n['cursorType'] === 'Bottom' && typeof n['value'] === 'string' && n['value'] !== '',
  );
  return bare ? (bare['value'] as string) : null;
}

function authorIdOf(tweet: Rec): string | null {
  return (
    getString(tweet, 'core.user_results.result.rest_id') ??
    getString(tweet, 'legacy.user_id_str') ??
    getString(tweet, 'core.user_results.result.legacy.id_str')
  );
}

/**
 * Map one GraphQL tweet result onto the frozen `Tweet` contract.
 * Returns `null` for anything we cannot read confidently.
 */
export function normalizeTweet(node: Rec): Tweet | null {
  const legacy = node['legacy'];
  if (!isRecord(legacy)) return null;

  const id = getString(node, 'rest_id') ?? getString(legacy, 'id_str');
  if (!id) return null;

  const createdAt = parseTwitterDate(legacy['created_at']);
  if (!createdAt) return null;

  const text = typeof legacy['full_text'] === 'string' ? (legacy['full_text'] as string) : '';

  const likeRaw = legacy['favorite_count'];
  const rtRaw = legacy['retweet_count'];

  const media = getPath(legacy, 'extended_entities.media') ?? getPath(legacy, 'entities.media');
  const hasMedia = Array.isArray(media) && media.length > 0;

  const isRetweet = legacy['retweeted_status_result'] != null || text.startsWith('RT @');

  // For a retweet, `id`/`rest_id` is the id of the account's OWN retweet action,
  // NOT the id `DeleteRetweet` un-retweets by. The operation takes the ORIGINAL
  // tweet's id as `source_tweet_id`, which lives on the nested retweeted status.
  // Read it defensively (X reshuffles these paths) and never descend into the
  // retweeted status for anything else - see `collectTweetNodes`. `undefined`
  // when it cannot be read: `mutate.ts` then falls back to `id`, no worse than
  // before this was captured.
  const sourceTweetId = isRetweet
    ? (getString(legacy, 'retweeted_status_result.result.rest_id') ??
      getString(legacy, 'retweeted_status_result.result.legacy.id_str') ??
      getString(legacy, 'retweeted_status_id_str') ??
      undefined)
    : undefined;

  return {
    id,
    createdAt,
    text,
    likeCount: typeof likeRaw === 'number' ? likeRaw : null,
    retweetCount: typeof rtRaw === 'number' ? rtRaw : null,
    isReply: typeof legacy['in_reply_to_status_id_str'] === 'string',
    isRetweet,
    ...(sourceTweetId ? { sourceTweetId } : {}),
    hasMedia,
    source: 'live',
    // Live counts come straight from X and ARE trustworthy - unlike the
    // archive, which stores "0"/"0.0" for every engagement number.
    countsReliable: true,
  };
}

/** Resolve `screenName` to the numeric `rest_id` the timeline query needs. */
async function resolveUserId(transport: XTransport, screenName: string): Promise<string> {
  const queryId = await resolveQueryId(OPERATIONS.userByScreenName, transport);
  const params = new URLSearchParams({
    variables: JSON.stringify({ screen_name: screenName, withSafetyModeUserFields: true }),
    features: JSON.stringify(TIMELINE_FEATURES),
    fieldToggles: JSON.stringify(USER_FIELD_TOGGLES),
  });
  const res = await transport.get(
    `${graphqlUrl(queryId, OPERATIONS.userByScreenName)}?${params.toString()}`,
  );

  if (res.status === 401 || res.status === 403) {
    throw new Error('[twedel] X rejected the session while looking up the account (401/403).');
  }

  const user = deepFind(
    res.body,
    (n) => n['__typename'] === 'User' && typeof n['rest_id'] === 'string',
  );
  const restId = user ? (user['rest_id'] as string) : null;
  if (!restId) {
    throw new Error(
      `[twedel] Could not resolve a user id for "@${screenName}" (HTTP ${res.status}). ` +
        'The account may be suspended, the UserByScreenName queryId may have rotated, or X ' +
        'may have declined to route the request (it answers 404 for that too). ' +
        'GET /api/diagnostics (上級者向け → 診断情報) shows which.',
    );
  }
  return restId;
}

/** Everything one operation's paging loop needs, so the loop itself stays flat. */
interface TimelineRun {
  opts: FetchTweetsOptions;
  userId: string;
  byId: Map<string, Tweet>;
  /** Pages read so far, across every operation of this fetch. */
  page: number;
  emit: (label: string, done: boolean) => void;
  /**
   * Keep rows whose author is NOT the target user. `false` for the tweet
   * timelines (a timeline interleaves other accounts' posts, and only ours are
   * ours to delete); `true` for the LIKES timeline, where every row is by
   * definition someone else's tweet - filtering by author would drop them all.
   */
  keepForeignAuthors: boolean;
  /**
   * Stamp every row as a like (`isLike:true`, `isReply/isRetweet:false`, no
   * `sourceTweetId`). A like is a like regardless of whether the liked tweet is
   * itself a retweet, so the retweet/reply detection in `normalizeTweet` must not
   * be allowed to mislabel it and send it down the wrong un-favorite dispatch.
   */
  markAsLike: boolean;
}

/**
 * Recast a normalized tweet as an un-favoritable LIKE row.
 *
 * Drops `sourceTweetId` and forces `isReply/isRetweet:false` so the mutate
 * dispatch is unambiguous: `UnfavoriteTweet` acts on `id` (the liked tweet's id).
 */
function asLike(tweet: Tweet): Tweet {
  const { sourceTweetId: _drop, ...rest } = tweet;
  return { ...rest, isReply: false, isRetweet: false, isLike: true };
}

/** Why one operation could not be used. Always a 404-shaped refusal. */
interface Refusal {
  operation: string;
  reason: string;
}

/**
 * Page ONE timeline operation to exhaustion, merging into `run.byId`.
 *
 * Returns a `Refusal` when X answers 404 - the caller then tries the next
 * candidate. Everything that is NOT a 404 keeps its old behaviour, deliberately:
 * a 401/403 throws (the session is the problem, and the next candidate would
 * fail identically), a 429 sleeps and retries the same cursor (falling through
 * on a rate limit would spend the remaining candidates against a closed window).
 */
async function runTimelineOperation(
  run: TimelineRun,
  spec: TimelineOperationSpec,
  label: string,
): Promise<Refusal | null> {
  const { opts, userId, byId } = run;
  const { transport, max, signal } = opts;

  let queryId: string;
  try {
    queryId = await resolveQueryId(spec.operation, transport);
  } catch (err: unknown) {
    // No id at all is a reason to move on, not to abort: another candidate may
    // well resolve. The message is carried into the final error.
    return {
      operation: spec.operation,
      reason: `${spec.operation}: no queryId could be resolved (${err instanceof Error ? err.message : String(err)})`,
    };
  }

  let cursor: string | null = null;
  const seenCursors = new Set<string>();
  let rateLimitRetries = 0;
  // Each split timeline owns its own budget. Sharing one global ceiling meant
  // a long originals/replies history could consume every page before the
  // dedicated repost operation even started.
  let operationPages = 0;
  let consecutiveEmptyPages = 0;

  while (operationPages < MAX_PAGES) {
    if (signal?.aborted) return null;

    const params = new URLSearchParams({
      variables: JSON.stringify(spec.variables({ userId, cursor, count: PAGE_SIZE })),
      features: JSON.stringify(spec.features),
    });
    const url = `${graphqlUrl(queryId, spec.operation)}?${params.toString()}`;
    const res = await transport.get(url);

    if (res.status === 401 || res.status === 403) {
      throw new Error('[twedel] X rejected the session while reading the timeline (401/403).');
    }
    if (res.status === 429) {
      // Budget already spent. Wait for the window to roll over and retry the
      // same cursor - but bounded, so a permanently-429ing account surfaces as
      // an error instead of hanging the run forever.
      rateLimitRetries += 1;
      if (rateLimitRetries > MAX_RATE_LIMIT_RETRIES) {
        throw new Error(
          '[twedel] X kept answering 429 while reading the timeline. Wait a while before retrying.',
        );
      }
      await sleep(msUntilReset(res.headers), signal);
      if (signal?.aborted) return null;
      continue;
    }
    rateLimitRetries = 0;

    if (res.status === 404) {
      // The whole reason this function returns instead of throwing. Name the
      // operation AND the id, because "which URL 404'd" is the only question
      // worth asking next.
      return {
        operation: spec.operation,
        reason: `${spec.operation} (queryId ${queryId}) → HTTP 404`,
      };
    }
    if (res.status < 200 || res.status >= 300) {
      throw new Error(
        `[twedel] Timeline request failed with HTTP ${res.status} for ${spec.operation} ` +
          `(queryId ${queryId}). GET /api/diagnostics (上級者向け → 診断情報) shows what X ` +
          'answers for every timeline operation.',
      );
    }

    run.page += 1;
    operationPages += 1;

    let added = 0;
    for (const node of collectTweetNodes(res.body)) {
      // Timelines interleave other accounts' posts (conversation context,
      // "who to follow", pinned replies). Only ours are ours to delete - EXCEPT
      // on the likes timeline, where every row is deliberately someone else's.
      if (!run.keepForeignAuthors && authorIdOf(node) !== userId) continue;
      const normalized = normalizeTweet(node);
      if (!normalized) continue;
      const tweet = run.markAsLike ? asLike(normalized) : normalized;
      if (byId.has(tweet.id)) continue;
      byId.set(tweet.id, tweet);
      added += 1;
      if (max !== undefined && byId.size >= max) break;
    }

    run.emit(label, false);

    consecutiveEmptyPages = added === 0 ? consecutiveEmptyPages + 1 : 0;

    if (max !== undefined && byId.size >= max) return null;

    const next = findBottomCursor(res.body);
    // Loop guards: X keeps handing back a cursor forever at the end of a
    // timeline, and a repeated cursor means we are re-reading the same page.
    if (!next || seenCursors.has(next)) return null;
    // Do NOT stop on the FIRST empty page. Old timelines often
    // contain a bridge page made entirely of duplicate pinned/context rows or
    // foreign conversation entries. Its Bottom cursor can still lead to older
    // posts/reposts. A bounded streak still has to stop: X can rotate opaque
    // end cursors forever, which otherwise leaves the UI at 0件 indefinitely.
    if (consecutiveEmptyPages >= MAX_CONSECUTIVE_EMPTY_PAGES) return null;

    seenCursors.add(next);
    cursor = next;

    await honorRateLimit(res, signal);
    if (signal?.aborted) return null;
    await sleep(pacingDelay(opts), signal);
  }
  return null;
}

/**
 * The error for "X refused every timeline operation we know about".
 *
 * Explicitly NOT "the queryId rotated". Measured 2026-08-12: the ids come out of
 * X's own current bundles and `UserByScreenName` resolves against the same
 * session with an id from the same scrape, so blaming rotation sends the reader
 * to re-scrape ids that are already correct.
 */
function allRefusedError(refusals: Refusal[]): Error {
  return new Error(
    '[twedel] X refused every timeline operation twedel knows: ' +
      `${refusals.map((r) => r.reason).join('; ')}. ` +
      'This is NOT a rotated queryId: these ids come from X\'s own current bundles, and the ' +
      'account lookup (UserByScreenName) succeeded with an id from the same scrape. X is ' +
      'declining to serve these operations to this session. GET /api/diagnostics ' +
      '(上級者向け → 診断情報) reports the status X returns for each timeline operation ' +
      'individually; if a NEW one appears there, add it to TIMELINE_CANDIDATES.',
  );
}

/**
 * Fetch the account's tweets and replies, newest first.
 *
 * Pages until the timeline is exhausted, `max` is reached, the cursor stops
 * advancing, or the caller aborts. Aborting returns what was collected so far
 * rather than throwing - a partial list is still useful to filter and review.
 *
 * The source is chosen at runtime (see `TIMELINE_CANDIDATES`): X no longer
 * routes the operation this used to hardcode, so a 404 walks to the next
 * candidate instead of failing the fetch.
 */
export async function fetchUserTweets(opts: FetchTweetsOptions): Promise<Tweet[]> {
  const { transport, screenName, max, onProgress, signal } = opts;

  const byId = new Map<string, Tweet>();
  const run: TimelineRun = {
    opts,
    userId: '',
    byId,
    page: 0,
    emit: (label, done) => {
      onProgress?.({ fetched: byId.size, cursorPage: run.page, done, operation: label });
    },
    keepForeignAuthors: false,
    markAsLike: false,
  };

  if (signal?.aborted) {
    onProgress?.({ fetched: 0, cursorPage: 0, done: true });
    return [];
  }

  run.userId = await resolveUserId(transport, screenName);

  const refusals: Refusal[] = [];
  let used: string | null = null;

  for (const candidate of candidateOrder()) {
    if (signal?.aborted) break;

    // A candidate is refused only when EVERY operation in it was refused: the
    // split family is still worth using if two of its three answer, and a
    // partial timeline beats no timeline for something the user then filters.
    let answered = false;
    for (const spec of candidate.ops) {
      const refusal = await runTimelineOperation(run, spec, candidate.label);
      if (refusal) refusals.push(refusal);
      else answered = true;
      if (signal?.aborted) break;
      if (max !== undefined && byId.size >= max) break;
    }

    if (answered) {
      used = candidate.label;
      // Remember it so the next run does not re-probe the dead ones.
      workingCandidate = candidate.label;
      break;
    }
  }

  if (used === null && refusals.length > 0) throw allRefusedError(refusals);

  const tweets = [...byId.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  const result = max !== undefined ? tweets.slice(0, max) : tweets;
  onProgress?.({
    fetched: result.length,
    cursorPage: run.page,
    done: true,
    ...(used === null ? {} : { operation: used }),
  });
  return result;
}

/**
 * Fetch the account's LIKES (favorited tweets), newest first.
 *
 * Reuses the exact pagination / pacing / rate-limit / cursor machinery
 * `fetchUserTweets` uses, with two deliberate differences:
 *
 *  1. It queries the single `Likes` operation - there is no candidate chain here,
 *     so a 404 is a real failure (the operation did not route), not a fall-through.
 *  2. It does NOT filter by author (`keepForeignAuthors: true`): a like is by
 *     definition someone else's tweet, so the tweet-timeline's "keep only rows
 *     authored by the target user" rule would drop every single like.
 *
 * Every row is stamped `isLike: true` (with `isReply/isRetweet:false`) so the
 * un-favorite dispatch in `mutate.ts` is unambiguous, and `id` is the LIKED
 * tweet's id - exactly what `UnfavoriteTweet` takes as `tweet_id`.
 */
export async function fetchUserLikes(opts: FetchTweetsOptions): Promise<Tweet[]> {
  const { transport, screenName, max, onProgress, signal } = opts;

  const byId = new Map<string, Tweet>();
  const run: TimelineRun = {
    opts,
    userId: '',
    byId,
    page: 0,
    emit: (label, done) => {
      onProgress?.({ fetched: byId.size, cursorPage: run.page, done, operation: label });
    },
    keepForeignAuthors: true,
    markAsLike: true,
  };

  if (signal?.aborted) {
    onProgress?.({ fetched: 0, cursorPage: 0, done: true });
    return [];
  }

  run.userId = await resolveUserId(transport, screenName);

  const refusal = await runTimelineOperation(
    run,
    {
      operation: OPERATIONS.likes,
      variables: likesTimelineVariables,
      features: TIMELINE_FEATURES,
    },
    OPERATIONS.likes,
  );

  // Unlike the tweet timeline there is no next candidate to try: a 404 here means
  // X did not route the Likes read for this session, which is a hard failure the
  // caller must see rather than silently returning an empty like list.
  if (refusal && !signal?.aborted) {
    throw new Error(
      `[twedel] X refused the Likes timeline: ${refusal.reason}. ` +
        'This is NOT a rotated queryId - the id comes from X\'s own current bundles and the ' +
        'account lookup (UserByScreenName) succeeded with an id from the same scrape. X is ' +
        'declining to serve the likes read to this session. GET /api/diagnostics ' +
        '(上級者向け → 診断情報) shows what X answers for the Likes probe.',
    );
  }

  const likes = [...byId.values()].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );
  const result = max !== undefined ? likes.slice(0, max) : likes;
  onProgress?.({
    fetched: result.length,
    cursorPage: run.page,
    done: true,
    operation: OPERATIONS.likes,
  });
  return result;
}
