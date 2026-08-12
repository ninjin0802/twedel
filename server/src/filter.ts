/**
 * Pure tweet filtering + summary. No I/O, no mutation of the input array.
 */
import type { FilterCriteria, Tweet } from '@shared/types.js';

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * `YYYY-MM-DD` (optionally with a `T…` time part, which is ignored) -> the
 * inclusive start or end of that UTC day.
 *
 * Undefined/empty means "no bound". Anything else that is not a real calendar
 * day **throws**: silently ignoring a malformed bound would widen the delete
 * set to every tweet, and silently dropping everything would hide the mistake.
 * `Date.parse` is deliberately not trusted here - it rolls `2020-06-31` over to
 * July 1st and returns NaN for `2020-6-5`.
 */
function dayBoundMs(value: string | undefined, label: 'from' | 'to', endOfDay: boolean): number | null {
  if (value === undefined) return null;
  const raw = value.trim();
  if (raw === '') return null;

  const datePart = raw.length > 10 && (raw[10] === 'T' || raw[10] === ' ') ? raw.slice(0, 10) : raw;
  const m = DAY_RE.exec(datePart);
  const bad = (): never => {
    throw new Error(`invalid \`${label}\` date ${JSON.stringify(value)}: expected YYYY-MM-DD`);
  };
  if (m === null) bad();

  const year = Number(m![1]);
  const month = Number(m![2]);
  const day = Number(m![3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) bad();

  const ms = endOfDay
    ? Date.UTC(year, month - 1, day, 23, 59, 59, 999)
    : Date.UTC(year, month - 1, day, 0, 0, 0, 0);
  if (!Number.isFinite(ms)) bad();

  // Round-trip so that 2020-02-30 / 2019-02-29 are rejected instead of rolling over.
  const probe = new Date(ms);
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== month - 1 ||
    probe.getUTCDate() !== day
  ) {
    bad();
  }
  return ms;
}

function categoryAllowed(t: Tweet, c: FilterCriteria): boolean {
  // A like is its own thing: the 原文/リプライ/RT toggles describe the account's
  // OWN posts, none of which a like is, so those switches never gate it.
  if (t.isLike) return true;
  // Exactly one category per tweet: retweet > reply > original.
  if (t.isRetweet) return c.includeRetweets;
  if (t.isReply) return c.includeReplies;
  return c.includeOriginals;
}

/**
 * Apply the user's criteria. Returns a new array; the input is never mutated.
 *
 * Engagement bounds (`maxLikes` / `maxRetweets`) are deliberately ignored for
 * tweets with `countsReliable === false`: X archives store "0"/"0.0" for every
 * tweet, so filtering on them would silently queue the wrong tweets for
 * deletion.
 *
 * @throws when `from`/`to` is present but is not a real `YYYY-MM-DD` day.
 */
export function applyFilter(tweets: Tweet[], c: FilterCriteria): Tweet[] {
  const from = dayBoundMs(c.from, 'from', false);
  const to = dayBoundMs(c.to, 'to', true);
  const needle = c.keyword !== undefined && c.keyword !== '' ? c.keyword.toLowerCase() : null;

  return tweets.filter((t) => {
    if (!categoryAllowed(t, c)) return false;

    if (!c.includeMediaTweets && t.hasMedia) return false;

    if ((from !== null || to !== null) && t.createdAt !== '') {
      // A dateless row (an archive like carries no like-date) is never excluded
      // by a date bound - dropping every like the moment a from/to is set would
      // silently hide exactly the rows the user came to un-favorite. Rows that DO
      // have a date but cannot be parsed still fail closed, as before.
      const ms = Date.parse(t.createdAt);
      if (!Number.isFinite(ms)) return false;
      if (from !== null && ms < from) return false;
      if (to !== null && ms > to) return false;
    }

    if (needle !== null) {
      const hit = t.text.toLowerCase().includes(needle);
      if (c.keywordMode === 'exclude' ? hit : !hit) return false;
    }

    if (t.countsReliable) {
      if (c.maxLikes !== null && t.likeCount !== null && t.likeCount > c.maxLikes) return false;
      if (c.maxRetweets !== null && t.retweetCount !== null && t.retweetCount > c.maxRetweets) {
        return false;
      }
    }

    return true;
  });
}

export function summarize(tweets: Tweet[]): {
  total: number;
  originals: number;
  replies: number;
  retweets: number;
  withMedia: number;
  oldest?: string;
  newest?: string;
} {
  let originals = 0;
  let replies = 0;
  let retweets = 0;
  let withMedia = 0;
  let oldest: string | undefined;
  let newest: string | undefined;

  for (const t of tweets) {
    if (t.isRetweet) retweets++;
    else if (t.isReply) replies++;
    else originals++;
    if (t.hasMedia) withMedia++;
    if (oldest === undefined || t.createdAt < oldest) oldest = t.createdAt;
    if (newest === undefined || t.createdAt > newest) newest = t.createdAt;
  }

  return { total: tweets.length, originals, replies, retweets, withMedia, oldest, newest };
}
