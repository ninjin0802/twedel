/**
 * X (Twitter) data-archive parser.
 *
 * Accepts either the raw `.zip` you download from X, or an already-extracted
 * folder. Only the tweet payload files are read: a real archive is several GB
 * of media, so entries that do not match the tweet-file pattern are never
 * pulled into memory.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { text as streamToText } from 'node:stream/consumers';
import { openPromise } from 'yauzl';
import type { Tweet } from '@shared/types.js';

/** Which payload family a caller wants out of an archive. */
export type ArchiveKind = 'tweets' | 'likes';

export interface ArchiveLoadResult {
  tweets: Tweet[];
  /** Paths (folder) or zip entry names that were actually read, in read order. */
  filesRead: string[];
  /** Elements/files we could not turn into a Tweet. Never fatal. */
  skipped: { file: string; reason: string }[];
  /** Which family was loaded, so the caller can route the rows (likes un-favorite). */
  kind: ArchiveKind;
}

/**
 * `tweets.js`, `tweets-part1.js`, and the older singular `tweet.js` /
 * `tweet-part1.js`. Matched case-insensitively against the basename only.
 */
const TWEET_FILE_RE = /^tweets?(?:-part(\d+))?\.js$/i;

/**
 * `like.js`, `like-part1.js`, and the plural `likes.js` / `likes-part1.js`,
 * matched the same defensive way as the tweet files. The X archive ships the
 * account's favorites in `data/like.js` (split into `like-partN.js` when large).
 */
const LIKE_FILE_RE = /^likes?(?:-part(\d+))?\.js$/i;

/**
 * Wrapper assignment at the top of every archive payload file. The variable is
 * `window.YTD.tweets.part0` in some archives and `window.YTD.tweet.part0` in
 * others, so the segment is matched generically rather than by name.
 */
const WRAPPER_RE = /^\s*window\.YTD\.[A-Za-z_$][\w$]*\.part\d+\s*=\s*/;

const MONTHS: Readonly<Record<string, number>> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

/** `"Wed Oct 10 20:19:24 +0000 2018"` */
const TWITTER_DATE_RE =
  /^[A-Za-z]{3}\s+([A-Za-z]{3})\s+(\d{1,2})\s+(\d{2}):(\d{2}):(\d{2})\s+([+-])(\d{2})(\d{2})\s+(\d{4})$/;

/**
 * ISO8601 with an *optional* zone, matched strictly so that `Date.parse`'s
 * implementation-defined tolerance never decides what a timestamp means.
 */
const ISO_DATE_RE =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?(?:(Z|z)|([+-])(\d{2}):?(\d{2}))?$/;

/**
 * Build a UTC timestamp from already-validated components, rejecting values that
 * `Date.UTC` would silently roll over (`Feb 31` -> `Mar 3`). A 3-day drift is
 * enough to move a tweet across a from/to bound and change what gets deleted.
 */
function utcFromParts(
  year: number,
  monthIdx: number,
  day: number,
  hh: number,
  mm: number,
  ss: number,
  ms: number,
  offsetMin: number,
): number | null {
  if (monthIdx < 0 || monthIdx > 11 || day < 1 || day > 31) return null;
  if (hh > 23 || mm > 59 || ss > 59) return null;
  if (!Number.isFinite(offsetMin) || Math.abs(offsetMin) > 14 * 60) return null;
  const local = Date.UTC(year, monthIdx, day, hh, mm, ss, ms);
  if (!Number.isFinite(local)) return null;
  const probe = new Date(local);
  // Round-trip: rejects Feb 30, Jun 31, Feb 29 in a non-leap year, …
  if (
    probe.getUTCFullYear() !== year ||
    probe.getUTCMonth() !== monthIdx ||
    probe.getUTCDate() !== day
  ) {
    return null;
  }
  const utcMs = local - offsetMin * 60_000;
  return Number.isFinite(utcMs) ? utcMs : null;
}

/** `+0930` -> 570. NaN for a nonsense offset such as `+9900` or `+0099`. */
function offsetToMinutes(sign: string, hours: number, minutes: number): number {
  if (hours > 14 || minutes > 59) return Number.NaN;
  return (hours * 60 + minutes) * (sign === '-' ? -1 : 1);
}

/**
 * Parse the archive's `created_at` format into an ISO8601 UTC timestamp.
 *
 * The format is *not* ISO8601 and `new Date(string)` parsing of it is
 * implementation-defined, so it is decoded explicitly. Already-ISO input is
 * accepted as a convenience; a zone-less ISO value is read as **UTC** rather
 * than as host-local time (which is what `Date.parse` would do, making the
 * result depend on the machine's timezone). Throws when the value cannot be
 * understood - callers record those tweets as skipped rather than guessing.
 */
export function parseTwitterDate(s: string): string {
  if (typeof s !== 'string') throw new Error(`unparseable created_at: ${String(s)}`);
  const raw = s.trim();

  const m = TWITTER_DATE_RE.exec(raw);
  if (m) {
    const monthIdx = Object.prototype.hasOwnProperty.call(MONTHS, m[1]!.toLowerCase())
      ? MONTHS[m[1]!.toLowerCase()]
      : undefined;
    if (monthIdx === undefined) throw new Error(`unparseable created_at: ${s}`);
    const offsetMin = offsetToMinutes(m[6]!, Number(m[7]), Number(m[8]));
    const utcMs = utcFromParts(
      Number(m[9]),
      monthIdx,
      Number(m[2]),
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      0,
      offsetMin,
    );
    if (utcMs === null) throw new Error(`unparseable created_at: ${s}`);
    return new Date(utcMs).toISOString();
  }

  // Defensive: some tooling re-writes archives with ISO timestamps.
  const iso = ISO_DATE_RE.exec(raw);
  if (iso) {
    const offsetMin =
      iso[9] === undefined
        ? 0 // no zone (or `Z`): UTC, never host-local
        : offsetToMinutes(iso[9], Number(iso[10]), Number(iso[11]));
    const utcMs = utcFromParts(
      Number(iso[1]),
      Number(iso[2]) - 1,
      Number(iso[3]),
      Number(iso[4]),
      Number(iso[5]),
      iso[6] === undefined ? 0 : Number(iso[6]),
      iso[7] === undefined ? 0 : Number(iso[7].padEnd(3, '0')),
      offsetMin,
    );
    if (utcMs !== null) return new Date(utcMs).toISOString();
  }

  throw new Error(`unparseable created_at: ${s}`);
}

/**
 * Strip the `window.YTD.<kind>.partN = ` wrapper and JSON.parse the payload.
 * Falls back to slicing from the first `[` when there is no wrapper.
 */
export function parseTweetsJs(content: string): unknown[] {
  let body: string;
  const stripped = content.replace(WRAPPER_RE, '');
  if (stripped.length !== content.length) {
    body = stripped;
  } else {
    const start = content.indexOf('[');
    if (start === -1) throw new Error('tweet payload contains no JSON array');
    body = content.slice(start);
  }

  const trimmed = body.trim().replace(/;\s*$/, '');
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`tweet payload is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`tweet payload is not an array (got ${typeof parsed})`);
  }
  return parsed;
}

/** Archive counts arrive as `12`, `"12"`, `"0.0"` or not at all. */
function parseCount(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t === '') return null;
    const n = Number.parseFloat(t);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function hasMediaEntities(t: Record<string, any>): boolean {
  const ext = t['extended_entities'];
  if (ext && Array.isArray(ext.media) && ext.media.length > 0) return true;
  const ent = t['entities'];
  return Boolean(ent && Array.isArray(ent.media) && ent.media.length > 0);
}

/**
 * Turn one raw archive element into a {@link Tweet}. Returns null when the
 * element has no usable id or an undecodable date; callers record those as
 * skipped rather than failing the whole load.
 */
export function normalizeArchiveTweet(raw: any): Tweet | null {
  if (raw === null || typeof raw !== 'object') return null;

  // Normally `{ tweet: {...} }`, but fall back to the element itself when it
  // carries `id_str` directly.
  const t: Record<string, any> =
    raw.tweet !== null && typeof raw.tweet === 'object' ? raw.tweet : raw;

  const id = t['id_str'];
  if (typeof id !== 'string' || id === '') return null;

  let createdAt: string;
  try {
    createdAt = parseTwitterDate(t['created_at']);
  } catch {
    return null;
  }

  const fullText = typeof t['full_text'] === 'string' ? t['full_text'] : undefined;
  const text = fullText ?? (typeof t['text'] === 'string' ? t['text'] : '');

  // The official export carries no retweet flag: the `RT @…` prefix is the only
  // signal for most retweets, so the loose prefix test is kept on purpose. It
  // has no false negatives (every archived retweet starts with exactly that),
  // and its false positives - an original tweet quoting the text "RT @x" - fail
  // safe: such a tweet is routed to unretweet (a no-op) instead of being
  // deleted. Tightening this to `^RT @handle: ` would trade those harmless
  // misses for the dangerous direction, where a real retweet is classified as
  // an original and gets deleted even though the user unchecked "retweets".
  const isRetweet =
    text.startsWith('RT @') ||
    t['retweeted_status'] !== undefined ||
    t['retweeted_status_id_str'] !== undefined;

  const inReplyTo = t['in_reply_to_status_id_str'];
  const isReply = typeof inReplyTo === 'string' && inReplyTo !== '';

  // The ORIGINAL tweet's id, which DeleteRetweet needs as source_tweet_id.
  // CAVEAT: an X archive usually does NOT carry it - retweets appear as a
  // `full_text` starting "RT @" with no `retweeted_status`/`retweeted_status_id_str`
  // at all. When that is the case `sourceTweetId` stays undefined and the
  // retweet is effectively NOT un-retweetable from an archive alone (mutate.ts
  // falls back to the archive id_str, which un-retweets nothing). We do not
  // pretend otherwise. Only when an id is actually present do we set it.
  const rtStatus = t['retweeted_status'];
  const sourceTweetId =
    (typeof t['retweeted_status_id_str'] === 'string' && t['retweeted_status_id_str'] !== ''
      ? (t['retweeted_status_id_str'] as string)
      : undefined) ??
    (rtStatus !== null &&
    typeof rtStatus === 'object' &&
    typeof (rtStatus as Record<string, unknown>)['id_str'] === 'string' &&
    (rtStatus as Record<string, unknown>)['id_str'] !== ''
      ? ((rtStatus as Record<string, unknown>)['id_str'] as string)
      : undefined);

  return {
    id,
    createdAt,
    text,
    // Populated so the UI can show the number, but see countsReliable: the
    // archive stores "0"/"0.0" regardless of real engagement.
    likeCount: parseCount(t['favorite_count']),
    retweetCount: parseCount(t['retweet_count']),
    isReply,
    isRetweet,
    ...(sourceTweetId ? { sourceTweetId } : {}),
    hasMedia: hasMediaEntities(t),
    source: 'archive',
    countsReliable: false,
  };
}

/**
 * Turn one raw archive LIKE element into a {@link Tweet} flagged `isLike`.
 *
 * The archive's like payload is sparse: `{ like: { tweetId, fullText, expandedUrl } }`
 * with NO `created_at` and NO engagement counts. So:
 *  - `tweetId` -> `id` (the liked tweet's id, what `UnfavoriteTweet` needs).
 *  - `fullText` -> `text` (often truncated by X; still enough to recognise).
 *  - `createdAt` is left EMPTY: the archive simply does not record WHEN you liked
 *    it. The date filter treats an empty createdAt as "no date info" and never
 *    excludes it on a date bound (see `filter.ts`), rather than silently dropping
 *    every like the moment a from/to is set.
 *
 * Returns null when there is no usable id.
 */
export function normalizeArchiveLike(raw: any): Tweet | null {
  if (raw === null || typeof raw !== 'object') return null;

  // Normally `{ like: {...} }`, but fall back to the element itself when it
  // carries `tweetId` directly.
  const l: Record<string, any> =
    raw.like !== null && typeof raw.like === 'object' ? raw.like : raw;

  const id = l['tweetId'];
  if (typeof id !== 'string' || id === '') return null;

  const text = typeof l['fullText'] === 'string' ? l['fullText'] : '';

  return {
    id,
    // No like-date in the archive: an explicit empty sentinel the date filter
    // recognises, never a guessed timestamp.
    createdAt: '',
    text,
    likeCount: null,
    retweetCount: null,
    isReply: false,
    isRetweet: false,
    isLike: true,
    hasMedia: false,
    source: 'archive',
    // Archives carry no reliable counts for likes either.
    countsReliable: false,
  };
}

/**
 * Last path segment, splitting on both separators. `basename()` alone is
 * platform-dependent: on POSIX it does not split `data\tweets.js`, which some
 * Windows zippers produce and which {@link isTweetPath} accepts.
 */
function lastSegment(p: string): string {
  const segments = splitZipPath(p);
  return segments[segments.length - 1] ?? basename(p);
}

/** Sort key: unsuffixed file first, then -part1, -part2, … numerically. */
function partOrder(fileName: string, fileRe: RegExp): number {
  const m = fileRe.exec(lastSegment(fileName));
  if (!m) return Number.MAX_SAFE_INTEGER;
  return m[1] === undefined ? -1 : Number(m[1]);
}

/**
 * True when `segments` describes a payload file (of the requested kind) sitting
 * under a `data/` directory at any depth (zip entries look like `data/tweets.js`).
 */
function isPayloadPath(segments: string[], fileRe: RegExp): boolean {
  const name = segments[segments.length - 1];
  if (name === undefined || !fileRe.test(name)) return false;
  return segments.slice(0, -1).some((s) => s.toLowerCase() === 'data');
}

function splitZipPath(entryName: string): string[] {
  return entryName.split(/[/\\]+/).filter((s) => s !== '');
}

function sortPayloadFiles<T>(items: T[], nameOf: (item: T) => string, fileRe: RegExp): T[] {
  return [...items].sort((a, b) => {
    const d = partOrder(nameOf(a), fileRe) - partOrder(nameOf(b), fileRe);
    if (d !== 0) return d;
    return nameOf(a).localeCompare(nameOf(b));
  });
}

/** Recursively collect payload files (of the requested kind) from a folder. */
async function collectFolderFiles(root: string, fileRe: RegExp): Promise<string[]> {
  const found: string[] = [];
  // Include the root's own name so that pointing directly at `…/data` works.
  const rootName = basename(root);

  async function walk(dir: string, relSegments: string[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        await walk(full, [...relSegments, e.name]);
      } else if (e.isFile()) {
        if (isPayloadPath([rootName, ...relSegments, e.name], fileRe)) found.push(full);
      }
    }
  }

  await walk(root, []);
  return sortPayloadFiles(found, (f) => f, fileRe);
}

async function readZipPayloads(
  zipPath: string,
  fileRe: RegExp,
): Promise<{ name: string; content: string }[]> {
  const zip = await openPromise(zipPath, { lazyEntries: true });
  const matches: { name: string; content: string }[] = [];

  for await (const entry of zip.eachEntry()) {
    // Directory entries end with '/'; everything non-matching is skipped
    // without ever opening a read stream for it.
    if (entry.fileName.endsWith('/')) continue;
    if (!isPayloadPath(splitZipPath(entry.fileName), fileRe)) continue;
    const stream = await zip.openReadStreamPromise(entry);
    matches.push({ name: entry.fileName, content: await streamToText(stream) });
  }

  return sortPayloadFiles(matches, (m) => m.name, fileRe);
}

interface KindConfig {
  fileRe: RegExp;
  normalize: (raw: unknown) => Tweet | null;
  missingReason: string;
  skipReason: (i: number) => string;
}

function kindConfig(kind: ArchiveKind): KindConfig {
  if (kind === 'likes') {
    return {
      fileRe: LIKE_FILE_RE,
      normalize: (raw) => normalizeArchiveLike(raw),
      missingReason: 'no data/like.js (or likes.js) payload found in archive',
      skipReason: (i) => `element ${i}: missing tweetId`,
    };
  }
  return {
    fileRe: TWEET_FILE_RE,
    normalize: (raw) => normalizeArchiveTweet(raw),
    missingReason: 'no data/tweets.js (or tweet.js) payload found in archive',
    skipReason: (i) => `element ${i}: missing id_str or unparseable created_at`,
  };
}

/**
 * Load every tweet - or every like - from an X archive.
 *
 * @param path a `.zip` archive or an already-extracted folder.
 * @param kind `'tweets'` (default, unchanged behaviour) or `'likes'` to read
 *             `data/like.js` and flag every row `isLike` for un-favoriting.
 */
export async function loadArchive(
  path: string,
  kind: ArchiveKind = 'tweets',
): Promise<ArchiveLoadResult> {
  const cfg = kindConfig(kind);
  const abs = resolve(path);
  const st = await stat(abs).catch(() => null);
  if (st === null) throw new Error(`archive not found: ${abs}`);

  const payloads: { name: string; content: string }[] = [];
  if (st.isDirectory()) {
    const files = await collectFolderFiles(abs, cfg.fileRe);
    for (const f of files) payloads.push({ name: f, content: await readFile(f, 'utf8') });
  } else {
    payloads.push(...(await readZipPayloads(abs, cfg.fileRe)));
  }

  const filesRead: string[] = [];
  const skipped: { file: string; reason: string }[] = [];
  const byId = new Map<string, Tweet>();

  for (const { name, content } of payloads) {
    let elements: unknown[];
    try {
      elements = parseTweetsJs(content);
    } catch (err) {
      skipped.push({ file: name, reason: (err as Error).message });
      continue;
    }
    filesRead.push(name);

    for (let i = 0; i < elements.length; i++) {
      let tweet: Tweet | null = null;
      try {
        tweet = cfg.normalize(elements[i]);
      } catch (err) {
        skipped.push({ file: name, reason: `element ${i}: ${(err as Error).message}` });
        continue;
      }
      if (tweet === null) {
        skipped.push({ file: name, reason: cfg.skipReason(i) });
        continue;
      }
      // Parts can overlap; first occurrence in part order wins. What gets
      // deleted is the id, and the id is identical by definition - only the
      // cosmetic fields (text, flags) could differ between copies, and real
      // exports write byte-identical duplicates. First-wins keeps the result
      // deterministic and independent of how many parts the export was split
      // into; the alternative (last-wins) would make it depend on part count.
      if (!byId.has(tweet.id)) byId.set(tweet.id, tweet);
    }
  }

  if (payloads.length === 0) {
    skipped.push({ file: abs, reason: cfg.missingReason });
  }

  // Tweets sort newest-first by createdAt. Likes carry no like-date (createdAt is
  // ''), so this leaves them in the archive's own order - which is the closest
  // thing to "most recently liked first" the export gives us.
  const tweets = [...byId.values()].sort((a, b) =>
    a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
  );

  return { tweets, filesRead, skipped, kind };
}
