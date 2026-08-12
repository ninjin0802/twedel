import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { DEFAULT_QUERY_IDS, DEFAULT_QUERY_IDS_OBSERVED_AT, HOME, OPERATIONS } from './endpoints.js';
import { queryIdsFile } from './paths.js';
import type { XTransport } from './transport.js';

/**
 * GraphQL `queryId` resolution.
 *
 * Every X GraphQL call is addressed as `/graphql/<queryId>/<OperationName>`.
 * X rotates those ids on roughly a 2-4 week cadence, and much more eagerly for
 * READ operations (`UserTweetsAndReplies`, `UserByScreenName`) than for the
 * write ones. A stale id is a 404 with no explanation, so we resolve in four
 * escalating steps and only then fail loudly with instructions.
 *
 *   manual override -> disk cache -> scrape the web bundles -> hardcoded default
 *
 * The last step is a SNAPSHOT, not a constant (see `DEFAULT_QUERY_IDS`), so it
 * is never preferred over a fresh scrape, never persisted, and never used
 * silently: `defaultQueryIdsUsed()` names every operation that fell back to one
 * and the user-facing failure messages say so.
 *
 * The scrape half of that chain is the fragile one, because it depends on where
 * X happens to be serving its JavaScript this month. See "Bundle discovery"
 * below for why it no longer tries to guess that.
 */

/** Shape of `<dataDir>/queryids.json`. */
interface QueryIdCacheFile {
  version: 1;
  updatedAt: string;
  ids: Record<string, string>;
}

/**
 * Never FETCH more bundles than this in one scrape; x.com's shell references a
 * lot of chunks and each one is a network round trip. Discovery may legitimately
 * find more than this - the overflow is reported, not silently dropped.
 */
export const MAX_BUNDLES = 40;

/**
 * How many bundle fetches may be in flight at once.
 *
 * Serial fetching of 40 chunks turned a connect into a minute-long stall. The
 * scan runs in batches of this size rather than through an unordered worker pool
 * so that "first value found wins" stays deterministic (batch N is always merged
 * before batch N+1) and so each batch boundary is a cheap place to stop early.
 */
const BUNDLE_CONCURRENCY = 6;

/**
 * Hard bound on how many URLs a single HTML/bundle may contribute, so a
 * pathological (or hostile) document cannot make us build an unbounded list.
 */
const MAX_DISCOVERED_URLS = 500;

/** Operations twedel actually needs; once all are known the scan can stop. */
const WANTED_OPERATIONS: readonly string[] = Object.values(OPERATIONS);

let manualIds = new Map<string, string>();
let cache: Record<string, string> = {};
let cacheLoaded = false;
/**
 * Operations that had to fall back to `DEFAULT_QUERY_IDS` in this process.
 *
 * A default is a snapshot of what X served on one particular day, reached only
 * when everything authoritative has already failed. Using one silently is a trap:
 * the request goes out looking exactly like a healthy one and comes back as an
 * unexplained 404. So every fallback is recorded here, and the places that talk
 * to the user - the delete failure messages and `/api/diagnostics` - say so.
 */
let defaultsUsed = new Set<string>();
/** Scrape at most once per process unless `force` is passed. */
let scrapeAttempted = false;
/** Dedupe concurrent scrapes (deleting + fetching can race). */
let scrapeInFlight: Promise<void> | null = null;

/**
 * What the last scrape actually did.
 *
 * Exists so the failure message can distinguish "0 bundles discovered" (the URL
 * pattern no longer matches what X serves - discovery is broken) from "40
 * bundles fetched, 0 ids" (the bundles no longer carry `queryId` literals -
 * extraction is broken). Those two need completely different fixes and the old
 * "came up empty" message could not tell them apart.
 */
export interface ScrapeReport {
  /** The HTML document that was scraped for bundle URLs. */
  url: string;
  /** Its HTTP status; 0 when the request itself failed. */
  htmlStatus: number;
  /** Unique bundle URLs found (HTML + one level of chunk references). */
  discovered: number;
  /** Bundles fetched with a 2xx and scanned. */
  fetched: number;
  /** Bundles that 404'd, errored, or otherwise could not be read. */
  failed: number;
  /** Distinct operation names extracted across every scanned bundle. */
  extracted: number;
  /** True when discovery outran `MAX_BUNDLES` and some URLs went unfetched. */
  capped: boolean;
  /** Set when the HTML fetch itself blew up, in which case nothing else ran. */
  error?: string;
}

let lastScrape: ScrapeReport | null = null;

/** The last scrape's statistics, for diagnostics. Not sensitive. */
export function lastScrapeReport(): ScrapeReport | null {
  return lastScrape ? { ...lastScrape } : null;
}

/**
 * Pin a queryId the user copied out of DevTools (Network tab -> any graphql
 * request -> the path segment before the operation name). `null` unpins.
 * Highest precedence: it beats a cache entry we already know is wrong.
 */
export function setManualQueryId(op: string, id: string | null): void {
  const trimmed = typeof id === 'string' ? id.trim() : '';
  if (trimmed === '') manualIds.delete(op);
  else manualIds.set(op, trimmed);
}

/**
 * Drop every manual override, keeping the scraped cache.
 *
 * Lifetime of a manual queryId: it lives exactly as long as the session it was
 * pinned during. It is an explicit, hand-made intervention ("this operation is
 * 404ing, use THIS id"), and a wrong one fails as an unexplained 404 - the
 * hardest failure in this app to diagnose - so it must not outlive the session
 * the user set it for. `clearSession()` (i.e. `DELETE /api/session`) therefore
 * calls this.
 *
 * The scraped `cache` deliberately survives: a queryId belongs to X's deployed
 * web client, not to an account or a transport, so it is still valid after a
 * disconnect - and it is disk-backed anyway (`queryids.json`), which makes
 * dropping it here pure theatre plus one wasted bundle scrape.
 *
 * For the same reason a manual pin is NOT dropped when only the transport mode
 * changes: `cookie` and `playwright` address the identical GraphQL endpoints,
 * and "pin the id from DevTools" plus "switch to playwright" are the two
 * recovery steps README tells the user to try together.
 */
export function clearManualQueryIds(): void {
  manualIds = new Map();
}

/** Everything currently known, for diagnostics. Not sensitive. */
export function knownQueryIds(): Record<string, string> {
  return { ...cache, ...Object.fromEntries(manualIds) };
}

/**
 * Only the HAND-PINNED ids, for diagnostics.
 *
 * Separate from `knownQueryIds` because the two answer different questions, and
 * the difference matters when debugging: a pin the user forgot about is a
 * completely different problem from a stale scrape, and the merged view cannot
 * tell them apart. Not sensitive - a queryId is a public constant out of X's
 * own JS bundle, and the user typed these in themselves.
 */
export function manualQueryIds(): Record<string, string> {
  return Object.fromEntries(manualIds);
}

/**
 * The ids learned from the disk cache / bundle scrape, without the pins.
 * Same reasoning as `manualQueryIds`.
 */
export function cachedQueryIds(): Record<string, string> {
  return { ...cache };
}

/**
 * Operations currently running on a hardcoded default, for diagnostics.
 *
 * Not sensitive, and deliberately separate from `cachedQueryIds()`: an id that
 * came out of `endpoints.ts` on a day in the past is a completely different
 * thing from one X served this week, and merging them is how a stale constant
 * gets mistaken for a fresh one.
 */
export function defaultQueryIdsUsed(): string[] {
  return [...defaultsUsed].sort();
}

/** True when `op`'s id came from the built-in snapshot rather than from X. */
export function usedDefaultQueryId(op: string): boolean {
  return defaultsUsed.has(op);
}

/**
 * One sentence for a user staring at a failure, when the id in play was a
 * snapshot. Appended to delete failures rather than replacing them: the default
 * being stale is a plausible cause, never a proven one.
 */
export function staleDefaultNote(op: string): string {
  return (
    `Note: the queryId used for ${op} came from twedel's built-in snapshot ` +
    `(observed ${DEFAULT_QUERY_IDS_OBSERVED_AT}), because the manual pin, the cache and the ` +
    `bundle scrape all came up empty. X rotates these ids, so a snapshot goes stale on its own - ` +
    `if this keeps failing, reconnect to force a fresh scrape, or copy the current id from ` +
    `DevTools (https://x.com/i/api/graphql/<THIS_PART>/${op}) into 上級者向け.`
  );
}

/** Drop all in-memory state. Used by tests and by a future "refresh ids" action. */
export function resetQueryIdState(): void {
  manualIds = new Map();
  cache = {};
  cacheLoaded = false;
  scrapeAttempted = false;
  scrapeInFlight = null;
  lastScrape = null;
  defaultsUsed = new Set();
}

/** Read `<dataDir>/queryids.json`. A missing or corrupt file is not an error. */
export async function loadCache(): Promise<void> {
  cacheLoaded = true;
  try {
    const raw = await readFile(queryIdsFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<QueryIdCacheFile>;
    if (parsed && typeof parsed === 'object' && parsed.ids && typeof parsed.ids === 'object') {
      for (const [op, id] of Object.entries(parsed.ids)) {
        if (typeof id === 'string' && id !== '') cache[op] = id;
      }
    }
  } catch {
    // No cache yet, unreadable, or hand-edited into invalid JSON. Either way we
    // just fall through to scraping; a broken cache must never block a run.
  }
}

/** Persist everything we have learned. Failure to write is non-fatal. */
export async function saveCache(): Promise<void> {
  const file = queryIdsFile();
  const payload: QueryIdCacheFile = {
    version: 1,
    updatedAt: new Date().toISOString(),
    ids: cache,
  };
  try {
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch {
    // A read-only data dir degrades us to "scrape every process start", which
    // is slow but correct. Not worth failing a delete run over.
  }
}

function asText(body: unknown): string {
  if (typeof body === 'string') return body;
  return '';
}

/** How far apart the two halves of a pair may sit in the minified source. */
const MAX_PAIR_DISTANCE = 200;

/**
 * Quote-agnostic on purpose. The old `responsive-web` build minified string
 * literals with `"`; the current `x-web` build (rolldown) emits BACKTICKS for
 * them - verified by reading the live logged-out chunks, which are full of
 * `` `GET` `` / `` `<unknown>` `` where the old bundles had `"GET"`. Insisting on
 * one quote character is the same class of mistake as insisting on one URL path.
 * The value charclass stays word-ish, so a template literal with interpolation
 * in it cannot be mistaken for an id.
 */
const PAIR_TOKEN = /(queryId|operationName)\s*:\s*(["'`])([A-Za-z0-9_-]{3,})\2/g;

/**
 * Pull `operationName`/`queryId` pairs out of a minified bundle.
 *
 * The minifier emits BOTH field orders - `{queryId:"x",operationName:"Y"}` and
 * `{operationName:"Y",operationType:"query",queryId:"x"}` - depending on how
 * the object literal was written upstream.
 *
 * Rather than two overlapping regexes (which mis-pair across adjacent entries
 * and, worse, consume the correct pair while doing so), scan for the tokens in
 * source order and pair only ADJACENT ones of opposite kind. Two operationNames
 * in a row can therefore never be bridged to a distant queryId.
 *
 * First value found wins, so an earlier (more canonical) bundle is not
 * overwritten by a later one.
 */
export function extractQueryIds(source: string): Record<string, string> {
  const tokens: { kind: string; value: string; index: number }[] = [];
  for (const m of source.matchAll(PAIR_TOKEN)) {
    tokens.push({ kind: m[1] as string, value: m[3] as string, index: m.index });
  }

  const found: Record<string, string> = {};
  for (let i = 0; i + 1 < tokens.length; i += 1) {
    const a = tokens[i] as { kind: string; value: string; index: number };
    const b = tokens[i + 1] as { kind: string; value: string; index: number };
    if (a.kind === b.kind) continue;
    if (b.index - a.index > MAX_PAIR_DISTANCE) continue;

    const op = a.kind === 'operationName' ? a.value : b.value;
    const id = a.kind === 'queryId' ? a.value : b.value;
    if (!found[op]) found[op] = id;
  }

  return found;
}

/* -------------------------------------------------------------------------- */
/* Bundle discovery                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Discovery is deliberately SHAPE-agnostic and HOST-strict.
 *
 * Shape-agnostic: this used to hardcode
 * `abs.twimg.com/responsive-web/client-web/...`, which X simply stopped serving
 * - the current logged-out shell is `abs.twimg.com/x-web/x-web/...` and the next
 * one will be something else again. Guessing directory names is what broke, so
 * we match "a .js under a twimg host" instead, in any of the three forms a
 * script reference can take (absolute, protocol-relative, root-relative).
 *
 * Host-strict: the URLs come out of a document we did not write, and the cookie
 * transport attaches the account's cookies to whatever it is handed. Following
 * an arbitrary absolute URL found in that HTML would turn this scraper into a
 * credential-leaking fetch gadget, so only X's own asset hosts are followed.
 */
const TWIMG_OR_X_HOST = /(?:^|\.)(?:twimg\.com|x\.com)$/i;

/** `https://abs.twimg.com/<anything>.js`, and its `//abs.twimg.com/...` form. */
const SCRIPT_URL = /(?:https:)?\/\/[A-Za-z0-9.-]+\.twimg\.com\/[^"'\s<>()]+?\.js\b/g;

/** `src="/x-web/entry.js"` / `href="/assets/a.js"` - resolved against the page. */
const ROOT_RELATIVE_SCRIPT = /\b(?:src|href)\s*=\s*["'](\/[^"'\s>]+?\.js)\b[^"']*["']/gi;

/**
 * `"./assets/viewer-2XTZUe1Y.js"` - the entry bundle's own chunk manifest.
 * Resolved against the BUNDLE's url, not the page's: `./` means "next to me".
 */
const CHUNK_REF = /["'](\.{1,2}\/[^"'\s]*?\.js)\b[^"']*["']/g;

function isFollowableBundleUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return TWIMG_OR_X_HOST.test(url.hostname.toLowerCase());
}

function resolveRef(ref: string, base: string): string | null {
  try {
    return new URL(ref, base).toString();
  } catch {
    return null;
  }
}

/** Dedupe, keep source order, drop anything we refuse to follow. */
function collect(hits: { index: number; url: string | null }[]): string[] {
  hits.sort((a, b) => a.index - b.index);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const hit of hits) {
    const url = hit.url;
    if (url === null || seen.has(url) || !isFollowableBundleUrl(url)) continue;
    seen.add(url);
    out.push(url);
    if (out.length >= MAX_DISCOVERED_URLS) break;
  }
  return out;
}

/**
 * Bundle URLs referenced by an X HTML shell, in document order.
 *
 * @param baseUrl the document's own URL, for resolving root-relative srcs.
 */
export function extractBundleUrls(html: string, baseUrl: string = HOME): string[] {
  const hits: { index: number; url: string | null }[] = [];
  for (const m of html.matchAll(SCRIPT_URL)) {
    const raw = m[0];
    hits.push({ index: m.index, url: raw.startsWith('//') ? `https:${raw}` : raw });
  }
  for (const m of html.matchAll(ROOT_RELATIVE_SCRIPT)) {
    hits.push({ index: m.index, url: resolveRef(m[1] as string, baseUrl) });
  }
  return collect(hits);
}

/**
 * Relative chunk URLs a bundle references, resolved against that bundle's URL.
 *
 * X's entry bundle is a ~20KB loader: it carries no `queryId` literals at all,
 * only a list of `"./assets/<name>-<hash>.js"` specifiers. Without following
 * those one level, scraping the entry point finds exactly nothing.
 */
export function extractChunkUrls(source: string, bundleUrl: string): string[] {
  const hits: { index: number; url: string | null }[] = [];
  for (const m of source.matchAll(CHUNK_REF)) {
    hits.push({ index: m.index, url: resolveRef(m[1] as string, bundleUrl) });
  }
  return collect(hits);
}

/** Every operation twedel needs is already known - nothing left to scan for. */
function haveEveryWantedId(): boolean {
  return WANTED_OPERATIONS.every((op) => manualIds.has(op) || typeof cache[op] === 'string');
}

/**
 * A bundle's source, or `null` for any reason at all. Never throws.
 *
 * `getDocument`, not `get`: these are static files on `abs.twimg.com`, a CDN
 * that needs no credentials whatsoever - so the transport sends it none (see
 * `isXHost`). Sending the account's session to a host that does not need it is
 * pure downside.
 */
async function fetchBundle(transport: XTransport, url: string): Promise<string | null> {
  try {
    const res = await transport.getDocument(url);
    if (res.status < 200 || res.status >= 300) return null;
    return asText(res.body);
  } catch {
    // Network blip, or a chunk rotated out from under us mid-deploy. A single
    // dead chunk must never abort the whole resolution - the id we need is very
    // likely in another one.
    return null;
  }
}

/**
 * Fetch x.com, find its JS bundles, and harvest every queryId in them.
 *
 * Deliberately caches EVERY pair found, not just the operation that triggered
 * the scrape - one scrape then serves the whole run.
 *
 * Never throws: everything that went wrong is recorded in `lastScrape` so the
 * eventual error message can say what actually happened.
 */
async function scrapeQueryIds(transport: XTransport): Promise<void> {
  const report: ScrapeReport = {
    url: HOME,
    htmlStatus: 0,
    discovered: 0,
    fetched: 0,
    failed: 0,
    extracted: 0,
    capped: false,
  };
  lastScrape = report;

  let html = '';
  try {
    // A DOCUMENT fetch, not an API call. Stamping `authorization` +
    // `x-twitter-auth-type` + `content-type: application/json` onto a request
    // for an HTML page pushes it through X's API auth stack, where a real
    // logged-in session can come back 401 or 404 - which is precisely how this
    // scrape used to report "https://x.com answered HTTP 404".
    const homeRes = await transport.getDocument(HOME);
    report.htmlStatus = homeRes.status;
    html = asText(homeRes.body);
  } catch (err: unknown) {
    report.error = err instanceof Error ? err.message : String(err);
    return;
  }

  const extractedOps = new Set<string>();
  const queued = new Set<string>();
  let learned = 0;
  let attempted = 0;
  let done = false;

  /**
   * Fetch one level of bundles, `BUNDLE_CONCURRENCY` at a time, merging each
   * batch in order. Returns the relative chunk references seen along the way
   * when `collectChildren` is set (we follow exactly one level, so the second
   * pass does not collect).
   */
  const scanLevel = async (urls: string[], collectChildren: boolean): Promise<string[]> => {
    const children: string[] = [];
    for (let i = 0; i < urls.length; i += BUNDLE_CONCURRENCY) {
      if (attempted >= MAX_BUNDLES) {
        report.capped = true;
        break;
      }
      const batch = urls.slice(i, i + BUNDLE_CONCURRENCY).slice(0, MAX_BUNDLES - attempted);
      attempted += batch.length;

      const sources = await Promise.all(batch.map((url) => fetchBundle(transport, url)));
      for (let j = 0; j < batch.length; j += 1) {
        const source = sources[j];
        if (source === null) {
          report.failed += 1;
          continue;
        }
        report.fetched += 1;
        for (const [op, id] of Object.entries(extractQueryIds(source))) {
          extractedOps.add(op);
          if (!cache[op]) {
            cache[op] = id;
            learned += 1;
          }
        }
        if (collectChildren) children.push(...extractChunkUrls(source, batch[j] as string));
      }

      // Cheapest possible win: stop the moment nothing is left to look for.
      if (haveEveryWantedId()) {
        done = true;
        break;
      }
    }
    return children;
  };

  const entries = extractBundleUrls(html, HOME);
  for (const url of entries) queued.add(url);
  report.discovered = queued.size;

  const children = await scanLevel(entries, true);
  const fresh: string[] = [];
  for (const url of children) {
    if (queued.has(url)) continue;
    queued.add(url);
    fresh.push(url);
  }
  report.discovered = queued.size;

  if (!done && fresh.length > 0) await scanLevel(fresh, false);
  if (!done && attempted >= MAX_BUNDLES && queued.size > attempted) report.capped = true;

  report.extracted = extractedOps.size;
  if (learned > 0) await saveCache();
}

/** One sentence describing what the last scrape did, for the failure message. */
function scrapeSummary(): string {
  const r = lastScrape;
  if (!r) {
    return 'No bundle scrape has run in this process, so there is nothing to report about one.';
  }
  if (r.error !== undefined) {
    return `The last scrape could not even fetch ${r.url}: ${r.error}`;
  }
  const cap = r.capped ? ` (stopped at the ${MAX_BUNDLES}-bundle cap)` : '';
  return (
    `Last scrape: ${r.url} answered HTTP ${r.htmlStatus}, ` +
    `${r.discovered} bundle URL(s) discovered${cap}, ` +
    `${r.fetched} fetched, ${r.failed} failed, ` +
    `${r.extracted} operation id(s) extracted in total.`
  );
}

/**
 * Resolve the queryId for a GraphQL operation.
 *
 * @param force skip the disk cache and re-scrape - use after a 404 that looks
 *              like id rotation.
 * @throws a message naming the operation and telling the user exactly how to
 *         supply the id by hand, when every layer has failed.
 */
export async function resolveQueryId(
  op: string,
  transport: XTransport,
  opts?: { force?: boolean },
): Promise<string> {
  const force = opts?.force === true;

  // 1. Manual override always wins, even over `force`.
  const manual = manualIds.get(op);
  if (manual) return manual;

  if (!cacheLoaded) await loadCache();

  // 2. Disk/memory cache.
  if (!force) {
    const cached = cache[op];
    if (cached) return cached;
  } else {
    delete cache[op];
  }

  // 3. Scrape the live bundles (once per process, unless forced).
  if (force || !scrapeAttempted) {
    if (!scrapeInFlight) {
      scrapeAttempted = true;
      scrapeInFlight = scrapeQueryIds(transport).finally(() => {
        scrapeInFlight = null;
      });
    }
    try {
      await scrapeInFlight;
    } catch {
      // x.com unreachable or shape changed - fall through to the defaults.
    }
    const scraped = cache[op];
    if (scraped) return scraped;
  }

  // 4. Hardcoded default - a snapshot of what X served on one particular day.
  //
  //    Deliberately NOT written into `cache`: the cache is persisted to
  //    `queryids.json` (any later scrape that learns anything saves the whole
  //    thing), and a snapshot on disk is indistinguishable from an id X actually
  //    served - it would then survive restarts, outlive the scrape that could
  //    have replaced it, and show up in diagnostics as a healthy cached value.
  //    Re-taking this path costs nothing: the scrape runs at most once anyway.
  const fallback = DEFAULT_QUERY_IDS[op];
  if (fallback) {
    defaultsUsed.add(op);
    return fallback;
  }

  // 5. Out of options - say what the scrape actually saw, then what to do.
  //    "0 bundles discovered" (X moved the assets again) and "40 bundles, 0 ids"
  //    (the ids are no longer in the bundles) are different bugs; the message
  //    has to let a user tell them apart without a debugger.
  throw new Error(
    `[twedel] Could not resolve the GraphQL queryId for "${op}". ` +
      `X rotates these ids and the automatic lookup (cache + bundle scrape) came up empty. ` +
      `${scrapeSummary()} ` +
      `If the scrape's own HTTP status above is 4xx, the problem is the REQUEST, not the ` +
      `bundles: X answers 404/401 for a document fetch it declines to route, which says ` +
      `nothing about whether the page exists (GET /api/diagnostics compares the variants). ` +
      `Fix: open x.com in your browser, open DevTools > Network, filter for "${op}", ` +
      `and copy the id from the request URL ` +
      `(https://x.com/i/api/graphql/<THIS_PART>/${op}), then paste it into twedel's ` +
      `advanced settings (it calls setManualQueryId("${op}", <id>)).`,
  );
}
