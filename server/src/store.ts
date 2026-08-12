import type { Tweet } from '../../shared/types.js';

/**
 * The tweets currently loaded from a source route, keyed by id.
 *
 * Why this exists: `POST /api/run` receives nothing but ids. Before deleting
 * anything the runner has to write each tweet's TEXT to the log (deletion is
 * irreversible - the text is the only thing the user gets to keep), and it has
 * to know `isRetweet`, because a retweet cannot be deleted with `DeleteTweet`;
 * it needs `DeleteRetweet`. Both facts live here.
 *
 * Deliberately in-memory and process-scoped: it is a cache of what the UI is
 * currently looking at, not a database. A server restart simply means the user
 * loads their archive again.
 */

let tweets = new Map<string, Tweet>();

/** Replace the loaded set. Loading a new source discards the previous one. */
export function setTweets(list: readonly Tweet[]): void {
  const next = new Map<string, Tweet>();
  for (const t of list) next.set(t.id, t);
  tweets = next;
}

/** Add to / overwrite entries in the loaded set without discarding the rest. */
export function mergeTweets(list: readonly Tweet[]): void {
  for (const t of list) tweets.set(t.id, t);
}

/**
 * Add only the ids the store does not already know, and report how many.
 *
 * This is the re-seeding path used when a run is resumed after a restart. A
 * checkpoint carries a MINIMAL copy of each pending tweet (id / createdAt /
 * text / isRetweet) - enough to delete it safely, but with no engagement counts.
 * `mergeTweets` would let that minimal copy overwrite a full one the user has
 * just re-loaded from an archive, silently blanking the numbers the table shows.
 * Existing entries win here for that reason.
 */
export function mergeMissingTweets(list: readonly Tweet[]): number {
  let added = 0;
  for (const t of list) {
    if (tweets.has(t.id)) continue;
    tweets.set(t.id, t);
    added += 1;
  }
  return added;
}

export function getTweet(id: string): Tweet | undefined {
  return tweets.get(id);
}

/**
 * Resolve many ids at once, reporting the ones we do not know about.
 *
 * The caller must treat `missing` as a hard error: an id we cannot resolve is
 * an id whose text we cannot log and whose retweet-ness we cannot determine, so
 * deleting it would be both unlogged and possibly a no-op against X.
 */
export function getMany(ids: readonly string[]): { found: Tweet[]; missing: string[] } {
  const found: Tweet[] = [];
  const missing: string[] = [];
  for (const id of ids) {
    const t = tweets.get(id);
    if (t) found.push(t);
    else missing.push(id);
  }
  return { found, missing };
}

/** Everything currently loaded, in insertion order. */
export function allTweets(): Tweet[] {
  return [...tweets.values()];
}

export function clearTweets(): void {
  tweets = new Map();
}

export function tweetCount(): number {
  return tweets.size;
}
