/**
 * Defensive helpers for reading X's GraphQL responses.
 *
 * X reshapes these payloads constantly - fields move between `legacy`, `core`
 * and `result`, wrappers appear and disappear, and the timeline nests entries
 * differently for pinned/promoted/community items. Hardcoding a full path like
 * `data.user.result.timeline_v2.timeline.instructions[0].entries[3].content
 * .itemContent.tweet_results.result` breaks on the first reshuffle and fails as
 * "0 tweets found" rather than as an error.
 *
 * So: search for the shape we recognise, wherever it happens to live.
 */

export type Rec = Record<string, unknown>;

export function isRecord(v: unknown): v is Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Depth-first walk. `visit` returns `true` to claim a node, which stops
 * descent INTO that node (siblings are still visited). That "claim and stop"
 * behaviour is what keeps a retweet's nested original tweet from being
 * harvested as if it were a separate top-level tweet.
 */
export function walk(node: unknown, visit: (node: Rec) => boolean): void {
  const seen = new Set<object>();

  const step = (current: unknown): void => {
    if (Array.isArray(current)) {
      for (const item of current) step(item);
      return;
    }
    if (!isRecord(current)) return;
    if (seen.has(current)) return;
    seen.add(current);
    if (visit(current)) return;
    for (const value of Object.values(current)) step(value);
  };

  step(node);
}

/** First record anywhere in the tree matching `predicate`, or `null`. */
export function deepFind(node: unknown, predicate: (n: Rec) => boolean): Rec | null {
  let hit: Rec | null = null;
  walk(node, (n) => {
    if (hit) return true;
    if (predicate(n)) {
      hit = n;
      return true;
    }
    return false;
  });
  return hit;
}

/** Read a dotted path, returning `undefined` at the first missing hop. */
export function getPath(node: unknown, path: string): unknown {
  let current: unknown = node;
  for (const key of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/** `getPath` narrowed to a non-empty string. */
export function getString(node: unknown, path: string): string | null {
  const v = getPath(node, path);
  return typeof v === 'string' && v !== '' ? v : null;
}

/** First non-empty string value stored under `key` anywhere in the tree. */
export function deepFindString(node: unknown, key: string): string | null {
  let hit: string | null = null;
  walk(node, (n) => {
    if (hit) return true;
    const v = n[key];
    if (typeof v === 'string' && v !== '') {
      hit = v;
      return true;
    }
    return false;
  });
  return hit;
}
