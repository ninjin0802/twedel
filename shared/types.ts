export type TweetSource = 'archive' | 'live';

export interface Tweet {
  /** id_str (archive) / rest_id (live) */
  id: string;
  /** ISO8601 */
  createdAt: string;
  text: string;
  /** null when the source cannot be trusted for this number */
  likeCount: number | null;
  retweetCount: number | null;
  isReply: boolean;
  isRetweet: boolean;
  /**
   * For a retweet, the ORIGINAL tweet's id - the one `DeleteRetweet` needs as
   * `source_tweet_id` to actually un-retweet. The retweet's own action id (`id`
   * above) is NOT what un-retweets it. Undefined for non-retweets and for a
   * retweet whose original id could not be determined (e.g. most archive-derived
   * retweets, which carry no original id at all).
   */
  sourceTweetId?: string;
  hasMedia: boolean;
  source: TweetSource;
  /** false for archive-derived tweets: X archives store "0"/"0.0" regardless of real engagement */
  countsReliable: boolean;
  /**
   * True when this row is a LIKE the user can un-favorite (someone else's tweet
   * that the account favorited) rather than one of the account's own posts.
   *
   * A like row has `isLike: true`, `isReply/isRetweet: false`, and `id` set to the
   * LIKED tweet's id - which is exactly what `UnfavoriteTweet` needs as `tweet_id`.
   * Optional and defaulting to absent/false so every existing tweet path is
   * unchanged: a normal post simply never sets it.
   */
  isLike?: boolean;
}

export interface FilterCriteria {
  /** ISO date, inclusive */
  from?: string;
  /** ISO date, inclusive */
  to?: string;
  /** case-insensitive substring; empty/undefined = ignore */
  keyword?: string;
  keywordMode: 'include' | 'exclude';
  /** keep tweet only if likeCount <= maxLikes; ignored when null or counts unreliable */
  maxLikes: number | null;
  maxRetweets: number | null;
  includeOriginals: boolean;
  includeReplies: boolean;
  includeRetweets: boolean;
  /** when false, liked posts are excluded */
  includeLikes?: boolean;
  /** when false, tweets with media are excluded */
  includeMediaTweets: boolean;
}

export type DeleteStatus = 'pending' | 'deleted' | 'already_gone' | 'failed';

export interface DeleteLogEntry {
  runId: string;
  id: string;
  createdAt: string;
  text: string;
  isRetweet: boolean;
  /**
   * True when the row was a LIKE removed via `UnfavoriteTweet` rather than a
   * tweet/retweet deletion. Optional so pre-existing log lines (and the CSV
   * export, whose columns are frozen) round-trip unchanged.
   */
  isLike?: boolean;
  status: DeleteStatus;
  error?: string;
  /** ISO timestamp of this log line */
  at: string;
}

export type RunState = 'running' | 'waiting' | 'stopping' | 'stopped' | 'done' | 'error';

export interface ProgressEvent {
  runId: string;
  state: RunState;
  /**
   * ISO timestamp of when the run started. Supplied by the server so that the
   * elapsed-time counter survives a mid-run page reload; the UI falls back to
   * its own mount time when this is absent.
   */
  startedAt?: string;
  total: number;
  done: number;
  ok: number;
  alreadyGone: number;
  failed: number;
  currentId?: string;
  currentText?: string;
  etaSec: number | null;
  /** ISO, set while backing off on a rate limit */
  waitingUntil?: string;
  message?: string;
}

export type TransportMode = 'cookie' | 'playwright';

export interface SessionInfo {
  connected: boolean;
  mode: TransportMode;
  screenName?: string;
  userId?: string;
  /**
   * Human-readable explanation shown inline by the UI, mainly for the
   * `connected: false` case (stale cookies, wrong ct0, anti-automation block).
   * MUST NEVER contain a raw credential value - route anything credential-ish
   * through `maskSecret` first.
   */
  message?: string;
}
