import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_QUERY_IDS } from './endpoints.js';
import {
  MAX_BUNDLES,
  cachedQueryIds,
  clearManualQueryIds,
  defaultQueryIdsUsed,
  extractBundleUrls,
  extractChunkUrls,
  extractQueryIds,
  knownQueryIds,
  lastScrapeReport,
  loadCache,
  resetQueryIdState,
  resolveQueryId,
  saveCache,
  setManualQueryId,
  staleDefaultNote,
  usedDefaultQueryId,
} from './queryId.js';
import { createCookieTransport } from './transport.js';

const BUNDLE_A = 'https://abs.twimg.com/responsive-web/client-web/main.aaa111.js';
const BUNDLE_B = 'https://abs.twimg.com/responsive-web/client-web/api.bbb222.js';

/**
 * The bundle x.com actually served on 2026-08-12, verified with an
 * unauthenticated `curl https://x.com`. The old scraper's regex demanded
 * `/responsive-web/client-web/...`, which appears nowhere in that document
 * except an image path - so it discovered zero bundles and the whole resolution
 * chain collapsed into an unexplained "came up empty".
 */
const X_WEB_ENTRY = 'https://abs.twimg.com/x-web/x-web/entry-client-logged-out-BNQK7y_y.js';
/** A chunk the entry bundle references as `"./assets/viewer-2XTZUe1Y.js"`. */
const X_WEB_CHUNK = 'https://abs.twimg.com/x-web/x-web/assets/viewer-2XTZUe1Y.js';

const HOME_HTML = `<!doctype html><html><head>
  <link rel="preload" href="${BUNDLE_A}" as="script">
  <script src="${BUNDLE_B}"></script>
</head><body></body></html>`;

let homeHits = 0;
let bundleAHits = 0;
let bundleBHits = 0;
let bundleABody = '';
let bundleBBody = '';
let bundleAFails = false;

/** Overridable per test, so a test can serve X's real (new) HTML shape. */
let homeHtml = HOME_HTML;
/** url -> body for every bundle other than A/B. Anything absent 404s. */
const extraBundles = new Map<string, string>();
/** Every url the catch-all handler was asked for, in order. */
let extraHits: string[] = [];
/** Headers of the last x.com HTML request, and of the last bundle request. */
let homeHeaders: Record<string, string> = {};
let bundleHeaders: Record<string, string> = {};

const server = setupServer(
  http.get('https://x.com/', ({ request }) => {
    homeHits += 1;
    homeHeaders = Object.fromEntries(request.headers.entries());
    return HttpResponse.html(homeHtml);
  }),
  http.get(BUNDLE_A, ({ request }) => {
    bundleAHits += 1;
    bundleHeaders = Object.fromEntries(request.headers.entries());
    if (bundleAFails) return HttpResponse.error();
    return HttpResponse.text(bundleABody, { headers: { 'content-type': 'text/javascript' } });
  }),
  http.get(BUNDLE_B, () => {
    bundleBHits += 1;
    return HttpResponse.text(bundleBBody, { headers: { 'content-type': 'text/javascript' } });
  }),
  // Registered last: msw matches in order, so the two specific bundles above win.
  http.get('https://abs.twimg.com/*', ({ request }) => {
    extraHits.push(request.url);
    const body = extraBundles.get(request.url);
    if (body === undefined) return new HttpResponse(null, { status: 404 });
    return HttpResponse.text(body, { headers: { 'content-type': 'text/javascript' } });
  }),
);

let dir = '';
const AUTH = 'auth-token-that-must-never-reach-the-cdn';
const CT0 = 'ct0-that-must-never-reach-the-cdn';
const transport = createCookieTransport({ authToken: AUTH, ct0: CT0 });

beforeAll(async () => {
  // Never write to the repo's real data/ directory.
  dir = await mkdtemp(join(tmpdir(), 'twedel-queryid-'));
  process.env['TWEDEL_DATA_DIR'] = dir;
  server.listen({ onUnhandledRequest: 'error' });
});

afterAll(async () => {
  server.close();
  delete process.env['TWEDEL_DATA_DIR'];
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  resetQueryIdState();
  homeHits = 0;
  bundleAHits = 0;
  bundleBHits = 0;
  bundleAFails = false;
  bundleABody = '';
  bundleBBody = '';
  homeHtml = HOME_HTML;
  extraBundles.clear();
  extraHits = [];
  homeHeaders = {};
  bundleHeaders = {};
  await rm(join(dir, 'queryids.json'), { force: true });
});

afterEach(() => server.resetHandlers());

/**
 * Run `fn` with `op`'s built-in default removed, then put it back.
 *
 * Every operation twedel dispatches now ships a default (a snapshot - see
 * `endpoints.ts`), so the "every layer failed" path is only reachable for an
 * operation that has none. Rather than test that path through some unrelated
 * operation name, take the default away from the real one: the assertions then
 * describe the behaviour of the operation the message actually names.
 */
async function withoutDefault<T>(op: string, fn: () => Promise<T>): Promise<T> {
  const saved = DEFAULT_QUERY_IDS[op];
  DEFAULT_QUERY_IDS[op] = null;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete DEFAULT_QUERY_IDS[op];
    else DEFAULT_QUERY_IDS[op] = saved;
  }
}

async function writeCacheFile(ids: Record<string, string>): Promise<void> {
  await writeFile(
    join(dir, 'queryids.json'),
    JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), ids }),
    'utf8',
  );
}

describe('extractQueryIds', () => {
  it('extracts the forward ordering queryId-then-operationName', () => {
    const src = 'x={queryId:"FWD1234567",operationName:"UserTweetsAndReplies"},y=1';
    expect(extractQueryIds(src)).toEqual({ UserTweetsAndReplies: 'FWD1234567' });
  });

  it('extracts the reverse ordering operationName-then-queryId', () => {
    const src = '{operationName:"UserByScreenName",operationType:"query",queryId:"REV1234567"}';
    expect(extractQueryIds(src)).toEqual({ UserByScreenName: 'REV1234567' });
  });

  it('extracts BOTH orderings out of one bundle', () => {
    const src = [
      '{queryId:"AAAAAAAAAA",operationName:"DeleteTweet",operationType:"mutation"}',
      '{operationName:"UserTweetsAndReplies",operationType:"query",queryId:"BBBBBBBBBB"}',
    ].join(',');
    expect(extractQueryIds(src)).toEqual({
      DeleteTweet: 'AAAAAAAAAA',
      UserTweetsAndReplies: 'BBBBBBBBBB',
    });
  });

  /**
   * X's current x-web build minifies string literals as backticks - the live
   * logged-out chunks are full of `GET` / `<unknown>` where the old
   * responsive-web bundles had "GET". A double-quote-only matcher would find
   * nothing in them even once discovery works again.
   */
  it('extracts backtick-quoted values, as the x-web build emits them', () => {
    const src = '{queryId:`BACKTICK12`,operationName:`Viewer`}';
    expect(extractQueryIds(src)).toEqual({ Viewer: 'BACKTICK12' });
  });

  it('extracts single-quoted values too', () => {
    expect(extractQueryIds("{operationName:'DeleteTweet',queryId:'SINGLE1234'}")).toEqual({
      DeleteTweet: 'SINGLE1234',
    });
  });

  it('does not pair across mismatched quote characters', () => {
    // `queryId:"x` followed by a backtick is not a string literal at all.
    expect(extractQueryIds('{queryId:"MISMATCH12`,operationName:"Viewer"}')).toEqual({});
  });

  it('does not straddle two adjacent entries in the reverse pass', () => {
    const src =
      '{operationName:"OpOne",operationType:"query"},{operationName:"OpTwo",queryId:"CORRECTID12"}';
    expect(extractQueryIds(src)).toEqual({ OpTwo: 'CORRECTID12' });
  });
});

describe('extractBundleUrls', () => {
  it('finds the client-web bundle urls in the html shell', () => {
    expect(extractBundleUrls(HOME_HTML).sort()).toEqual([BUNDLE_B, BUNDLE_A].sort());
  });

  it('returns nothing for html with no bundles', () => {
    expect(extractBundleUrls('<html></html>')).toEqual([]);
  });

  /**
   * The exact break the user hit: X moved its client from
   * `/responsive-web/client-web/` to `/x-web/x-web/`, and a scraper that pattern
   * matches on the DIRECTORY NAME discovers nothing the day that happens.
   */
  it('discovers a bundle at a path that is not responsive-web/client-web', () => {
    const html = `<!doctype html><html><head><script type="module" crossorigin src="${X_WEB_ENTRY}"></script></head></html>`;
    expect(extractBundleUrls(html)).toEqual([X_WEB_ENTRY]);
  });

  it('is not fooled by responsive-web surviving only in an image path', () => {
    // Verbatim from the live document: the string is still there, on a PNG.
    const html =
      '<link rel="apple-touch-icon" href="https://abs.twimg.com/responsive-web/client-web/icon-ios.77d25eba.png">' +
      `<script src="${X_WEB_ENTRY}"></script>`;
    expect(extractBundleUrls(html)).toEqual([X_WEB_ENTRY]);
  });

  it('discovers protocol-relative script srcs', () => {
    const html = '<script src="//abs.twimg.com/x-web/x-web/entry.js"></script>';
    expect(extractBundleUrls(html)).toEqual(['https://abs.twimg.com/x-web/x-web/entry.js']);
  });

  it('discovers root-relative script srcs, resolved against the page url', () => {
    const html = '<script src="/x-web/entry-abc.js"></script>';
    expect(extractBundleUrls(html)).toEqual(['https://x.com/x-web/entry-abc.js']);
  });

  it('keeps document order and dedupes a url referenced twice', () => {
    const html =
      `<link rel="modulepreload" href="${X_WEB_ENTRY}">` +
      '<script src="//abs.twimg.com/x-web/second.js"></script>' +
      `<script src="${X_WEB_ENTRY}"></script>`;
    expect(extractBundleUrls(html)).toEqual([X_WEB_ENTRY, 'https://abs.twimg.com/x-web/second.js']);
  });

  it('refuses to follow a .js on a host that is not X or twimg', () => {
    // The scraper is handed URLs out of a document it did not write, and the
    // cookie transport attaches the account's cookies to whatever it is given.
    const html = '<script src="https://evil.example.com/collect.js"></script>';
    expect(extractBundleUrls(html)).toEqual([]);
  });
});

describe('extractChunkUrls', () => {
  it('resolves a ./assets ref against the parent bundle url, not the page url', () => {
    const source = 'const m={"viewer":()=>import("./assets/viewer-2XTZUe1Y.js")};';
    expect(extractChunkUrls(source, X_WEB_ENTRY)).toEqual([X_WEB_CHUNK]);
  });

  it('resolves a ../ ref too', () => {
    expect(extractChunkUrls('import("../shared/x.js")', X_WEB_ENTRY)).toEqual([
      'https://abs.twimg.com/x-web/shared/x.js',
    ]);
  });

  it('ignores absolute and non-js specifiers', () => {
    const source = 'a="https://abs.twimg.com/x-web/other.js",b="./styles/app.css"';
    expect(extractChunkUrls(source, X_WEB_ENTRY)).toEqual([]);
  });
});

describe('resolveQueryId precedence', () => {
  it('manual override beats the disk cache, the scrape and the default', async () => {
    await writeCacheFile({ DeleteTweet: 'FROM_CACHE' });
    bundleABody = '{queryId:"FROM_SCRAPE",operationName:"DeleteTweet"}';
    setManualQueryId('DeleteTweet', 'FROM_MANUAL');

    expect(await resolveQueryId('DeleteTweet', transport)).toBe('FROM_MANUAL');
    expect(homeHits).toBe(0);
  });

  it('disk cache beats the scrape and the default, without touching the network', async () => {
    await writeCacheFile({ DeleteTweet: 'FROM_CACHE' });
    bundleABody = '{queryId:"FROM_SCRAPE",operationName:"DeleteTweet"}';

    expect(await resolveQueryId('DeleteTweet', transport)).toBe('FROM_CACHE');
    expect(homeHits).toBe(0);
    expect(bundleAHits).toBe(0);
  });

  it('scrape beats the hardcoded default', async () => {
    bundleABody = '{queryId:"FROM_SCRAPE",operationName:"DeleteTweet"}';

    const id = await resolveQueryId('DeleteTweet', transport);
    expect(id).toBe('FROM_SCRAPE');
    expect(id).not.toBe(DEFAULT_QUERY_IDS['DeleteTweet']);
    expect(homeHits).toBe(1);
  });

  it('falls back to the hardcoded default when the scrape finds nothing', async () => {
    bundleABody = 'no query ids in here';
    bundleBBody = 'nor here';

    expect(await resolveQueryId('DeleteTweet', transport)).toBe(DEFAULT_QUERY_IDS['DeleteTweet']);
  });

  /**
   * A default is a snapshot taken on one day, reached only after everything
   * authoritative has failed. It must never be mistaken for a fresh id, so it is
   * reported - and, critically, never written into the cache that gets persisted
   * to `queryids.json`, where it would outlive the scrape that could replace it.
   */
  it('reports which operations are running on a snapshot, and caches none of them', async () => {
    bundleABody = 'no query ids in here';
    bundleBBody = 'nor here';

    expect(defaultQueryIdsUsed()).toEqual([]);
    await resolveQueryId('DeleteTweet', transport);

    expect(defaultQueryIdsUsed()).toEqual(['DeleteTweet']);
    expect(usedDefaultQueryId('DeleteTweet')).toBe(true);
    expect(usedDefaultQueryId('DeleteRetweet')).toBe(false);
    // Not in the cache, so it can never be persisted as if X had served it.
    expect(cachedQueryIds()['DeleteTweet']).toBeUndefined();
    expect(knownQueryIds()['DeleteTweet']).toBeUndefined();
  });

  it('prefers a fresh scrape over the snapshot, and then reports no snapshot use', async () => {
    bundleABody = '{queryId:"FROM_SCRAPE",operationName:"DeleteTweet"}';

    expect(await resolveQueryId('DeleteTweet', transport)).toBe('FROM_SCRAPE');
    expect(defaultQueryIdsUsed()).toEqual([]);
  });

  it('the snapshot note names the operation, the date and how to replace it', () => {
    const note = staleDefaultNote('DeleteTweet');
    expect(note).toContain('DeleteTweet');
    expect(note).toContain('2026-08-12');
    expect(note).toMatch(/DevTools/);
  });

  it('throws an actionable error when every layer fails', async () => {
    bundleABody = '';
    bundleBBody = '';

    await withoutDefault('UserTweetsAndReplies', async () => {
      await expect(resolveQueryId('UserTweetsAndReplies', transport)).rejects.toThrow(
        /UserTweetsAndReplies/,
      );
      await expect(resolveQueryId('UserTweetsAndReplies', transport)).rejects.toThrow(/DevTools/);
    });
  });

  it('re-scrapes when force is passed even though the cache has a value', async () => {
    await writeCacheFile({ DeleteTweet: 'STALE_CACHE' });
    bundleABody = '{queryId:"FRESH_SCRAPE",operationName:"DeleteTweet"}';

    expect(await resolveQueryId('DeleteTweet', transport, { force: true })).toBe('FRESH_SCRAPE');
    expect(homeHits).toBe(1);
  });
});

describe('scraping resilience', () => {
  it('tolerates a bundle whose fetch fails and keeps reading the others', async () => {
    bundleAFails = true;
    bundleBBody = '{operationName:"UserTweetsAndReplies",queryId:"SURVIVED123"}';

    expect(await resolveQueryId('UserTweetsAndReplies', transport)).toBe('SURVIVED123');
    expect(bundleAHits).toBe(1);
    expect(bundleBHits).toBe(1);
  });

  it('caches every pair found, not only the operation asked for', async () => {
    bundleABody = [
      '{queryId:"DELETE_ID11",operationName:"DeleteTweet"}',
      '{operationName:"UserByScreenName",queryId:"USERBY_ID11"}',
      '{queryId:"TIMELINE_ID",operationName:"UserTweetsAndReplies"}',
    ].join(',');

    expect(await resolveQueryId('DeleteTweet', transport)).toBe('DELETE_ID11');
    // Already known - no second scrape.
    expect(await resolveQueryId('UserByScreenName', transport)).toBe('USERBY_ID11');
    expect(await resolveQueryId('UserTweetsAndReplies', transport)).toBe('TIMELINE_ID');
    expect(homeHits).toBe(1);
  });
});

describe('scraping X\'s current bundle layout', () => {
  it('resolves an id from a bundle at an arbitrary path (the x-web regression)', async () => {
    homeHtml = `<!doctype html><html><head><script type="module" crossorigin src="${X_WEB_ENTRY}"></script></head></html>`;
    extraBundles.set(X_WEB_ENTRY, '{queryId:"XWEBVIEWER1",operationName:"Viewer"}');

    expect(await resolveQueryId('Viewer', transport)).toBe('XWEBVIEWER1');
    expect(extraHits).toEqual([X_WEB_ENTRY]);
  });

  it('follows a relative chunk reference one level and scans it', async () => {
    homeHtml = `<script src="${X_WEB_ENTRY}"></script>`;
    // The real entry bundle carries zero queryIds - only a chunk manifest.
    extraBundles.set(X_WEB_ENTRY, 'const m={v:()=>import("./assets/viewer-2XTZUe1Y.js")};');
    extraBundles.set(X_WEB_CHUNK, '{operationName:"Viewer",operationType:"query",queryId:"FROMCHUNK12"}');

    expect(await resolveQueryId('Viewer', transport)).toBe('FROMCHUNK12');
    expect(extraHits).toEqual([X_WEB_ENTRY, X_WEB_CHUNK]);

    const report = lastScrapeReport();
    expect(report?.discovered).toBe(2);
    expect(report?.fetched).toBe(2);
    expect(report?.extracted).toBe(1);
  });

  it('does not follow chunk references a second level deep', async () => {
    homeHtml = `<script src="${X_WEB_ENTRY}"></script>`;
    extraBundles.set(X_WEB_ENTRY, 'import("./assets/viewer-2XTZUe1Y.js")');
    extraBundles.set(X_WEB_CHUNK, 'import("./assets/deeper.js")');
    extraBundles.set('https://abs.twimg.com/x-web/x-web/assets/deeper.js', '{queryId:"TOODEEP1234",operationName:"Viewer"}');

    // The id two levels down is never seen: resolution falls through to the
    // built-in snapshot instead, and says so.
    expect(await resolveQueryId('Viewer', transport)).toBe(DEFAULT_QUERY_IDS['Viewer']);
    expect(defaultQueryIdsUsed()).toEqual(['Viewer']);
    expect(extraHits).toEqual([X_WEB_ENTRY, X_WEB_CHUNK]);
  });

  it('stops scanning as soon as every operation twedel needs is known', async () => {
    const tail: string[] = [`<script src="${X_WEB_ENTRY}"></script>`];
    for (let i = 0; i < 30; i += 1) {
      const url = `https://abs.twimg.com/x-web/x-web/tail-${i}.js`;
      tail.push(`<script src="${url}"></script>`);
      extraBundles.set(url, 'never needed');
    }
    homeHtml = tail.join('');
    extraBundles.set(
      X_WEB_ENTRY,
      [
        '{queryId:"ALL_DELETE1",operationName:"DeleteTweet"}',
        '{queryId:"ALL_UNRT111",operationName:"DeleteRetweet"}',
        '{queryId:"ALL_USERBY1",operationName:"UserByScreenName"}',
        '{queryId:"ALL_TIMELN1",operationName:"UserTweetsAndReplies"}',
        '{queryId:"ALL_PLAIN11",operationName:"UserTweets"}',
        '{queryId:"ALL_ORIGIN1",operationName:"UserOriginalsTimeline"}',
        '{queryId:"ALL_REPLIE1",operationName:"UserRepliesTimeline"}',
        '{queryId:"ALL_REPOST1",operationName:"UserRepostsTimeline"}',
        '{queryId:"ALL_LIKES111",operationName:"Likes"}',
        '{queryId:"ALL_UNFAV111",operationName:"UnfavoriteTweet"}',
        '{queryId:"ALL_VIEWER1",operationName:"Viewer"}',
      ].join(','),
    );

    expect(await resolveQueryId('Viewer', transport)).toBe('ALL_VIEWER1');

    const report = lastScrapeReport();
    expect(report?.discovered).toBe(31);
    // Everything was already known after the first batch, so the remaining
    // batches - and the whole chunk-following pass - were skipped.
    expect(report?.fetched).toBeLessThan(31);
    expect(extraHits).not.toContain('https://abs.twimg.com/x-web/x-web/tail-29.js');
    expect(report?.capped).toBe(false);
  });

  it('never fetches more than the bundle cap, and says so', async () => {
    const many: string[] = [];
    for (let i = 0; i < MAX_BUNDLES + 20; i += 1) {
      const url = `https://abs.twimg.com/x-web/x-web/chunk-${i}.js`;
      many.push(`<script src="${url}"></script>`);
      extraBundles.set(url, 'no ids in this one');
    }
    homeHtml = many.join('');

    await withoutDefault('UserTweetsAndReplies', async () => {
      await expect(resolveQueryId('UserTweetsAndReplies', transport)).rejects.toThrow(
        new RegExp(`${MAX_BUNDLES + 20} bundle URL\\(s\\) discovered \\(stopped at the ${MAX_BUNDLES}-bundle cap\\)`),
      );
    });
    expect(extraHits).toHaveLength(MAX_BUNDLES);

    const report = lastScrapeReport();
    expect(report?.capped).toBe(true);
    expect(report?.fetched).toBe(MAX_BUNDLES);
  });
});

/**
 * How the scrape asks for things.
 *
 * The user's report was `https://x.com answered HTTP 404, 0 bundle URL(s)
 * discovered` - i.e. the HTML shell itself 404'd. It 404'd because the scrape
 * asked for it through `transport.get()`, which stamps `authorization`,
 * `x-twitter-auth-type` and `content-type: application/json` onto the request.
 * X routes anything carrying an `authorization` header through its API auth
 * stack, where a plain page request has no business being.
 */
describe('the scrape fetches documents, not API calls', () => {
  it('asks for the HTML shell as a browser navigation, with no API headers', async () => {
    bundleABody = '{queryId:"DOCFETCH123",operationName:"DeleteTweet"}';
    await resolveQueryId('DeleteTweet', transport);

    expect(homeHits).toBe(1);
    expect(homeHeaders['user-agent']).toMatch(/Chrome\/\d+/);
    expect(homeHeaders['accept']).toContain('text/html');
    // The logged-in shell needs the cookies; nothing else about the request is
    // allowed to look like an API call.
    expect(homeHeaders['cookie']).toBe(`auth_token=${AUTH}; ct0=${CT0}`);
    expect(homeHeaders['authorization']).toBeUndefined();
    expect(homeHeaders['x-twitter-auth-type']).toBeUndefined();
    expect(homeHeaders['x-twitter-active-user']).toBeUndefined();
    expect(homeHeaders['x-csrf-token']).toBeUndefined();
    expect(homeHeaders['content-type']).toBeUndefined();
    expect(homeHeaders['x-client-transaction-id']).toBeUndefined();
  });

  it('sends NOTHING credential-ish to the abs.twimg.com bundles', async () => {
    bundleABody = '{queryId:"CDNFETCH123",operationName:"DeleteTweet"}';
    await resolveQueryId('DeleteTweet', transport);

    expect(bundleAHits).toBe(1);
    expect(bundleHeaders['cookie']).toBeUndefined();
    expect(bundleHeaders['authorization']).toBeUndefined();
    expect(bundleHeaders['x-csrf-token']).toBeUndefined();

    const serialized = JSON.stringify(bundleHeaders);
    expect(serialized).not.toContain(AUTH);
    expect(serialized).not.toContain(CT0);
    expect(serialized).not.toContain('Bearer ');
  });
});

describe('the "came up empty" error is diagnostic', () => {
  it('reports zero discovered bundles when discovery is what broke', async () => {
    homeHtml = '<!doctype html><html><head></head><body>no scripts at all</body></html>';

    await withoutDefault('UserTweetsAndReplies', async () => {
      await expect(resolveQueryId('UserTweetsAndReplies', transport)).rejects.toThrow(
        /Last scrape: https:\/\/x\.com answered HTTP 200, 0 bundle URL\(s\) discovered, 0 fetched, 0 failed, 0 operation id\(s\) extracted in total\./,
      );
    });
  });

  it('reports bundles fetched but nothing extracted when extraction is what broke', async () => {
    bundleABody = 'this chunk carries no graphql metadata at all';
    bundleBBody = 'nor does this one';

    let message = '';
    await withoutDefault('UserTweetsAndReplies', async () => {
      try {
        await resolveQueryId('UserTweetsAndReplies', transport);
      } catch (err: unknown) {
        message = err instanceof Error ? err.message : String(err);
      }
    });

    expect(message).toMatch(/2 bundle URL\(s\) discovered/);
    expect(message).toMatch(/2 fetched, 0 failed/);
    expect(message).toMatch(/0 operation id\(s\) extracted in total/);
    // Still actionable.
    expect(message).toMatch(/DevTools/);
    expect(message).toMatch(/setManualQueryId\("UserTweetsAndReplies"/);
  });

  it('counts a bundle that could not be fetched as failed, without aborting', async () => {
    bundleAFails = true;
    bundleBBody = '{queryId:"OTHERID1234",operationName:"DeleteTweet"}';

    await withoutDefault('UserTweetsAndReplies', async () => {
      await expect(resolveQueryId('UserTweetsAndReplies', transport)).rejects.toThrow(
        /2 bundle URL\(s\) discovered, 1 fetched, 1 failed, 1 operation id\(s\) extracted/,
      );
    });
  });

  it('names the html failure when x.com itself could not be reached', async () => {
    server.use(http.get('https://x.com/', () => HttpResponse.error()));

    await withoutDefault('UserTweetsAndReplies', async () => {
      await expect(resolveQueryId('UserTweetsAndReplies', transport)).rejects.toThrow(
        /could not even fetch https:\/\/x\.com:/,
      );
    });
  });

  it('has no report at all until a scrape actually runs', async () => {
    expect(lastScrapeReport()).toBeNull();

    await writeCacheFile({ DeleteTweet: 'FROM_CACHE' });
    expect(await resolveQueryId('DeleteTweet', transport)).toBe('FROM_CACHE');
    expect(lastScrapeReport()).toBeNull();
  });
});

describe('manual override lifetime', () => {
  it('clearManualQueryIds unpins every operation at once', () => {
    setManualQueryId('DeleteTweet', 'PINNED_A1234');
    setManualQueryId('UserTweetsAndReplies', 'PINNED_B1234');

    clearManualQueryIds();

    expect(knownQueryIds()).toEqual({});
  });

  it('unpins without discarding the scraped cache, and without re-scraping', async () => {
    bundleABody = '{queryId:"SCRAPED1234",operationName:"DeleteTweet"}';
    expect(await resolveQueryId('DeleteTweet', transport)).toBe('SCRAPED1234');

    setManualQueryId('DeleteTweet', 'PINNED_BY_HAND');
    expect(await resolveQueryId('DeleteTweet', transport)).toBe('PINNED_BY_HAND');

    clearManualQueryIds();

    // Back to what the bundle scrape learned - which is account-independent and
    // already on disk, so dropping it too would only cost a second scrape.
    expect(await resolveQueryId('DeleteTweet', transport)).toBe('SCRAPED1234');
    expect(homeHits).toBe(1);
  });

  it('is safe to call when nothing was ever pinned', () => {
    expect(() => clearManualQueryIds()).not.toThrow();
  });
});

describe('cache persistence', () => {
  it('persists a scrape to disk and reloads it in a fresh process state', async () => {
    bundleABody = '{queryId:"PERSISTED12",operationName:"UserTweetsAndReplies"}';
    expect(await resolveQueryId('UserTweetsAndReplies', transport)).toBe('PERSISTED12');

    const onDisk = JSON.parse(await readFile(join(dir, 'queryids.json'), 'utf8')) as {
      ids: Record<string, string>;
    };
    expect(onDisk.ids['UserTweetsAndReplies']).toBe('PERSISTED12');

    // Simulate a restart: no memory, no network available for a scrape.
    resetQueryIdState();
    homeHits = 0;
    expect(await resolveQueryId('UserTweetsAndReplies', transport)).toBe('PERSISTED12');
    expect(homeHits).toBe(0);
  });

  it('survives a corrupt cache file', async () => {
    await writeFile(join(dir, 'queryids.json'), '{ not json', 'utf8');
    bundleABody = '{queryId:"RECOVERED12",operationName:"UserByScreenName"}';

    await loadCache();
    expect(await resolveQueryId('UserByScreenName', transport)).toBe('RECOVERED12');
  });

  it('saveCache writes what setManualQueryId did not', async () => {
    bundleABody = '{queryId:"SAVED123456",operationName:"DeleteTweet"}';
    await resolveQueryId('DeleteTweet', transport);
    await saveCache();

    const onDisk = JSON.parse(await readFile(join(dir, 'queryids.json'), 'utf8')) as {
      version: number;
      ids: Record<string, string>;
    };
    expect(onDisk.version).toBe(1);
    expect(onDisk.ids['DeleteTweet']).toBe('SAVED123456');
  });
});
