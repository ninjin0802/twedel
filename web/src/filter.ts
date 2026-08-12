import type { FilterCriteria, Tweet } from '@shared/types';

/**
 * Client-side mirror of the server filter (`server/src/filter.ts`), so the table
 * updates without a round trip. The rules here MUST match API.md +
 * shared/types.ts exactly, and must stay behaviourally identical to the server
 * implementation for every VALID input.
 *
 * The one deliberate difference is error handling: the server THROWS on a
 * malformed date bound, which is right for a request handler but wrong inside a
 * `useMemo` that re-runs on every keystroke (a throw there blanks the app).
 * Here the same malformed input instead makes the filter **fail closed** - it
 * returns an empty set - and `validateCriteria` reports the problem so the UI
 * can show it and block the delete path.
 */

export const DEFAULT_CRITERIA: FilterCriteria = {
  keywordMode: 'include',
  maxLikes: null,
  maxRetweets: null,
  includeOriginals: true,
  includeReplies: true,
  includeRetweets: false,
  includeMediaTweets: true,
};

export type TweetCategory = 'like' | 'retweet' | 'reply' | 'original';

/**
 * Every row belongs to exactly one category. A LIKE wins over everything: a like
 * is someone else's tweet the account favorited, so it must never be labelled
 * 原文/リプライ/RT (which describe the account's OWN posts). After that: retweet
 * wins over reply, reply over original.
 */
export function categoryOf(tweet: Tweet): TweetCategory {
  if (tweet.isLike) return 'like';
  if (tweet.isRetweet) return 'retweet';
  if (tweet.isReply) return 'reply';
  return 'original';
}

export interface CriteriaError {
  field: 'from' | 'to';
  message: string;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

const BAD_FORMAT = '日付は YYYY-MM-DD 形式で入力してください';
const BAD_DAY = '存在しない日付です';

type Bound =
  /** `ms === null` means "no bound". */
  | { ok: true; ms: number | null }
  | { ok: false; message: string };

/**
 * `YYYY-MM-DD` (optionally with a `T…`/` …` time part, which is ignored) -> the
 * inclusive start or end of that UTC day.
 *
 * Undefined/empty/whitespace-only means "no bound". Anything else that is not a
 * real calendar day is an error: treating it as "no bound" would silently WIDEN
 * the delete set to every tweet. `Date.parse` is deliberately not trusted here -
 * it returns NaN for `2020-6-5` and rolls `2020-06-31` over to July 1st.
 */
function dayBound(value: string | undefined, endOfDay: boolean): Bound {
  if (value === undefined) return { ok: true, ms: null };
  const raw = value.trim();
  if (raw === '') return { ok: true, ms: null };

  const datePart = raw.length > 10 && (raw[10] === 'T' || raw[10] === ' ') ? raw.slice(0, 10) : raw;
  const m = DAY_RE.exec(datePart);
  if (m === null) return { ok: false, message: BAD_FORMAT };

  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return { ok: false, message: BAD_DAY };

  const ms = endOfDay
    ? Date.UTC(year, month - 1, day, 23, 59, 59, 999)
    : Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  if (!Number.isFinite(ms)) return { ok: false, message: BAD_DAY };

  // Round-trip so that 2020-06-31 / 2019-02-29 are rejected instead of rolling
  // over into the next month - a `to` bound would otherwise quietly swallow a
  // day the user never selected.
  const probe = new Date(ms);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    return { ok: false, message: BAD_DAY };
  }
  return { ok: true, ms };
}

/**
 * Every problem with the criteria that must be surfaced to the user, in field
 * order. An empty array means the criteria are safe to filter and to execute.
 */
export function validateCriteria(criteria: FilterCriteria): CriteriaError[] {
  const errors: CriteriaError[] = [];
  const from = dayBound(criteria.from, false);
  if (!from.ok) errors.push({ field: 'from', message: from.message });
  const to = dayBound(criteria.to, true);
  if (!to.ok) errors.push({ field: 'to', message: to.message });
  return errors;
}

function matches(tweet: Tweet, criteria: FilterCriteria, from: number | null, to: number | null): boolean {
  // 1. category gate — exactly one applies. A like is its own category and the
  //    原文/リプライ/RT toggles never gate it (they describe the account's posts).
  const category = categoryOf(tweet);
  if (category === 'retweet' && !criteria.includeRetweets) return false;
  if (category === 'reply' && !criteria.includeReplies) return false;
  if (category === 'original' && !criteria.includeOriginals) return false;

  // 2. media gate
  if (!criteria.includeMediaTweets && tweet.hasMedia) return false;

  // 3. date range, both bounds inclusive, interpreted in UTC. A dateless row (an
  //    archive like carries no like-date) bypasses the bound rather than being
  //    dropped the moment a from/to is set. Rows that DO have a date but cannot be
  //    parsed still fail closed.
  if ((from !== null || to !== null) && tweet.createdAt !== '') {
    const at = Date.parse(tweet.createdAt);
    if (!Number.isFinite(at)) return false;
    if (from !== null && at < from) return false;
    if (to !== null && at > to) return false;
  }

  // 4. keyword, case-insensitive substring; empty keyword is a no-op in both modes
  if (criteria.keyword !== undefined && criteria.keyword !== '') {
    const hit = tweet.text.toLowerCase().includes(criteria.keyword.toLowerCase());
    if (criteria.keywordMode === 'exclude' ? hit : !hit) return false;
  }

  // 5. engagement thresholds — never applied to tweets whose counts cannot be trusted
  if (tweet.countsReliable) {
    if (criteria.maxLikes !== null && tweet.likeCount !== null && tweet.likeCount > criteria.maxLikes) {
      return false;
    }
    if (
      criteria.maxRetweets !== null &&
      tweet.retweetCount !== null &&
      tweet.retweetCount > criteria.maxRetweets
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Fails closed: a malformed `from`/`to` makes this return `false` for every
 * tweet rather than pretending the bound was not there.
 */
export function matchesFilter(tweet: Tweet, criteria: FilterCriteria): boolean {
  const from = dayBound(criteria.from, false);
  const to = dayBound(criteria.to, true);
  if (!from.ok || !to.ok) return false;
  return matches(tweet, criteria, from.ms, to.ms);
}

/**
 * Apply the criteria. Returns a new array; the input is never mutated.
 *
 * Fails closed on an invalid date bound - an EMPTY array, never the unfiltered
 * set. The count this produces is what the user reads in the dry-run dialog
 * before confirming an irreversible delete, so "0 件" (plus the inline error
 * from `validateCriteria`) is the only safe answer for input we cannot parse.
 */
export function applyFilter(tweets: readonly Tweet[], criteria: FilterCriteria): Tweet[] {
  const from = dayBound(criteria.from, false);
  const to = dayBound(criteria.to, true);
  if (!from.ok || !to.ok) return [];
  return tweets.filter((t) => matches(t, criteria, from.ms, to.ms));
}

export interface TweetStats {
  total: number;
  originals: number;
  replies: number;
  retweets: number;
  /** Rows that are likes (un-favoritable), counted separately from the account's posts. */
  likes: number;
  media: number;
  oldest: string | null;
  newest: string | null;
}

export function summarize(tweets: readonly Tweet[]): TweetStats {
  const stats: TweetStats = {
    total: tweets.length,
    originals: 0,
    replies: 0,
    retweets: 0,
    likes: 0,
    media: 0,
    oldest: null,
    newest: null,
  };
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const t of tweets) {
    const category = categoryOf(t);
    if (category === 'like') stats.likes += 1;
    else if (category === 'retweet') stats.retweets += 1;
    else if (category === 'reply') stats.replies += 1;
    else stats.originals += 1;
    if (t.hasMedia) stats.media += 1;
    const at = Date.parse(t.createdAt);
    if (Number.isNaN(at)) continue;
    if (at < lo) {
      lo = at;
      stats.oldest = t.createdAt;
    }
    if (at > hi) {
      hi = at;
      stats.newest = t.createdAt;
    }
  }
  return stats;
}

/** True when at least one loaded tweet has untrustworthy engagement counts (archive export). */
export function hasUnreliableCounts(tweets: readonly Tweet[]): boolean {
  return tweets.some((t) => !t.countsReliable);
}
