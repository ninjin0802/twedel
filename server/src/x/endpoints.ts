/**
 * Single source of truth for everything X-shaped.
 *
 * When X changes a host, a header name, a GraphQL operation name or a queryId,
 * THIS FILE should be the only thing that needs editing. Nothing else in
 * `server/src/x/` may hardcode an x.com URL or a header string.
 */

/**
 * X's PUBLIC web-client bearer token.
 *
 * This is NOT a credential and NOT a secret. X ships this exact string inside
 * their own public JavaScript bundle; it is byte-for-byte identical for every
 * visitor of x.com, logged in or not. It identifies "the web client" as an app,
 * not a user. The per-user authentication is entirely in the `auth_token` cookie
 * + the `ct0` CSRF token, which ARE secrets and always go through `maskSecret`.
 *
 * Do not put this in an env var, do not gitignore it, do not mask it in logs -
 * treat it like a user-agent string.
 */
export const WEB_BEARER =
  'Bearer AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs%3D1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA';

/** GraphQL endpoints live behind the web app host, not api.x.com. */
export const GRAPHQL_BASE = 'https://x.com/i/api/graphql';

/**
 * The legacy `api.x.com` host.
 *
 * Kept exported because it names a real thing and `playwright.ts#toPageUrl`
 * still has to recognise URLs written against it, but it is NOT where twedel
 * addresses the v1.1 endpoints any more - see `V11_BASE`.
 */
export const API_BASE = 'https://api.x.com';

/**
 * Where the v1.1 REST probes are sent: the same-origin `/i/api` path X's own web
 * client uses.
 *
 * Measured on 2026-08-12 through a REAL, CONNECTED cookie session (`GET
 * /api/diagnostics`), which is what finally settled this:
 *
 *   GET x.com/i/api/1.1/account/settings.json           -> 404, code 34
 *   GET api.x.com/1.1/account/settings.json             -> 404, code 34
 *   GET x.com/i/api/1.1/account/verify_credentials.json -> 404, code 34
 *
 * Same code-34 body ("Sorry, that page does not exist") on BOTH hosts, with
 * credentials X was simultaneously accepting elsewhere (the GraphQL `Viewer`
 * operation answered 200 for the same session). That is not a routing refusal
 * and not a header problem: these v1.1 endpoints have been RETIRED. See
 * `X_ERROR_PAGE_DOES_NOT_EXIST`.
 *
 * The general lesson still holds and is still worth stating, because it is the
 * one that used to send readers off editing endpoint constants: a bare 404 from
 * X, on its own, is not evidence that something was removed - flipping a single
 * request header flips other URLs between 404 and 401. What makes THIS case a
 * retirement is the error code, on both hosts, from an authenticated session.
 *
 * They are kept as cheap fallback probes: they need no rotating queryId, so on
 * the day the bundle scrape breaks they cost one request to rule out.
 */
export const V11_BASE = 'https://x.com/i/api';

/**
 * X API error code 34, "Sorry, that page does not exist."
 *
 * X's way of saying an endpoint is gone, as opposed to the bare 404 it also
 * returns for requests it declines to route. Recognising it is what lets twedel
 * report "this endpoint has been retired" instead of an unexplained 404 that
 * implies the user misconfigured something.
 */
export const X_ERROR_PAGE_DOES_NOT_EXIST = 34;

/** The web app itself - scraped for the JS bundles that carry the queryIds. */
export const HOME = 'https://x.com';

/** Origin used for `origin` / `referer` on API requests, and by `isXHost`. */
export const X_ORIGIN = 'https://x.com';

/**
 * The User-Agent twedel claims, on BOTH the API requests and the document
 * fetches. Bump it when it goes stale - a UA several years out of date is its
 * own automation signal. (Chrome 151 is what is installed on the dev machine.)
 *
 * Not a credential, not a secret: it is the same string every Chrome on the
 * planet sends.
 */
export const BROWSER_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
  'Chrome/151.0.0.0 Safari/537.36';

/** What Chrome sends as `accept` on a top-level navigation. */
export const DOCUMENT_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,' +
  'image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';

const DOCUMENT_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';

/**
 * Headers a real browser sets itself and refuses to let `fetch` override.
 * The playwright transport strips exactly these before handing our header set
 * to `page.evaluate` - setting any of them in a browser `fetch` throws.
 */
export const BROWSER_MANAGED_HEADERS: readonly string[] = [
  'cookie',
  'user-agent',
  'referer',
  'origin',
];

/**
 * True for `x.com` and its subdomains - the ONLY hosts the account's cookies
 * may be attached to.
 *
 * The queryId scraper hands us URLs it found inside a document we did not
 * write, and those point at `abs.twimg.com`. That CDN needs no credentials at
 * all, so not sending any is both correct and strictly safer.
 */
export function isXHost(rawUrl: string): boolean {
  let host: string;
  try {
    host = new URL(rawUrl).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'x.com' || host.endsWith('.x.com');
}

/**
 * GraphQL operations twedel uses. Kept as a const map so callers cannot typo an
 * operation name that `resolveQueryId` would then fail to resolve at runtime.
 */
export const OPERATIONS = {
  deleteTweet: 'DeleteTweet',
  /**
   * Undoing a retweet.
   *
   * NOT `UnretweetTweet`: that operation name does not exist. A scrape of x.com's
   * live bundles on 2026-08-12 extracted ~100 operation names and `UnretweetTweet`
   * was not among any of them, while `DeleteRetweet` was - and it is what X's own
   * web client sends when you un-retweet something. twedel spent that entire time
   * dispatching every retweet to an operation X has never heard of, which is why
   * no retweet could ever be removed. Its variables are unchanged
   * (`{ source_tweet_id, dark_request }`); only the name was wrong.
   */
  deleteRetweet: 'DeleteRetweet',
  userByScreenName: 'UserByScreenName',
  /**
   * The timeline family.
   *
   * `UserTweetsAndReplies` used to be THE timeline read, and its id is still
   * shipped in X's bundles - but on 2026-08-12 a live session that resolved
   * `UserByScreenName` fine and got a 200 out of `Viewer` got a 404 out of this
   * one. X appears to have split the combined timeline into per-kind operations
   * and stopped routing the legacy entry, without removing it from the bundle.
   *
   * A BUNDLE LISTING AN ID IS NOT EVIDENCE THE SERVER STILL ROUTES IT. So these
   * are candidates to be probed in order, not constants to depend on - see
   * `fetchTweets.ts#TIMELINE_CANDIDATES`. The three `*Timeline` operations are
   * the split family, and a deletion tool needs all three (originals, replies
   * AND reposts) to see everything the account has.
   */
  userTweetsAndReplies: 'UserTweetsAndReplies',
  userTweets: 'UserTweets',
  userOriginalsTimeline: 'UserOriginalsTimeline',
  userRepliesTimeline: 'UserRepliesTimeline',
  userRepostsTimeline: 'UserRepostsTimeline',
  /**
   * The account's LIKES timeline - the tweets it has favorited, authored by other
   * people. Read-only here; removing a like is the separate `unfavoriteTweet`
   * mutation. Its rows must NOT be run through the "author is the target user"
   * filter the tweet timelines use, because by definition a like's author is
   * someone else (see `fetchTweets.ts#fetchUserLikes`).
   */
  likes: 'Likes',
  /**
   * Un-favoriting a tweet. Variables `{ tweet_id }`, where `tweet_id` is the
   * LIKED tweet's id (the `id` twedel stores on a like row). Success body is
   * `{ data: { unfavorite_tweet: "Done" } }`. This is the like counterpart of
   * `DeleteTweet`/`DeleteRetweet`; see `mutate.ts` for the dispatch precedence.
   */
  unfavoriteTweet: 'UnfavoriteTweet',
  viewer: 'Viewer',
} as const;

export type OperationName = (typeof OPERATIONS)[keyof typeof OPERATIONS];

/**
 * v1.1 REST paths used as queryId-FREE identity probes, relative to `V11_BASE`.
 *
 * Their value is that they need no rotating queryId: when the bundle scrape is
 * broken (X moves its JS around, see `queryId.ts`) they cost one request to try.
 *
 * As of 2026-08-12 both answer 404 with error code 34 on every host - they have
 * been retired (see `V11_BASE`) - so they are FALLBACKS now, not the primary
 * probe. `session.ts` tries GraphQL `Viewer` first, which is what actually
 * answers.
 */
export const V11_PROBE_PATHS = {
  settings: '/1.1/account/settings.json',
  verifyCredentials: '/1.1/account/verify_credentials.json',
} as const;

/**
 * The day every value in `DEFAULT_QUERY_IDS` was read off X's live bundles.
 *
 * Reported to the user whenever a default is actually used, because "this id is
 * a snapshot from <date>" is the single most useful thing to know when a delete
 * starts 404ing.
 */
export const DEFAULT_QUERY_IDS_OBSERVED_AT = '2026-08-12';

/**
 * Last-resort queryIds, used only when the manual override, the disk cache and
 * the bundle scrape have all come up empty (see `queryId.ts`).
 *
 * EVERY value here is a SNAPSHOT, not a constant. All of them were extracted
 * from x.com's own JS bundles on 2026-08-12 (`DEFAULT_QUERY_IDS_OBSERVED_AT`)
 * and all of them are expected to rot: X rotates these ids on roughly a 2-4 week
 * cadence, faster for the reads than for the writes. The previous
 * `DeleteTweet` default (`VaenaVgh5q5ih7kvyVjgtg`) was described here as "stable
 * for a very long time" and was, by that day, simply wrong - which is the worst
 * possible failure for a value that is only ever reached when everything else
 * has already broken.
 *
 * So: the SCRAPE is authoritative, these are a last resort, and `queryId.ts`
 * records every operation that had to fall back to one so the failure message
 * and `/api/diagnostics` can say "this id came out of a snapshot from <date>"
 * rather than presenting it as a fact. Nothing here is ever preferred over a
 * fresh scrape, and nothing here is written into the on-disk cache, where it
 * would become indistinguishable from a scraped id.
 *
 * NOTE: typed `string | null` rather than `Record<string, string>` so an
 * operation we know about but deliberately have no default for can be spelled
 * out as `null` instead of being silently absent.
 */
export const DEFAULT_QUERY_IDS: Record<string, string | null> = {
  DeleteTweet: 'nxpZCY2K-I6QoFHAHeojFQ',
  DeleteRetweet: 'ZyZigVsNiFO6v1dEks1eWg',
  UserByScreenName: 'Gb-d6r0vxPOADdG62OEBpQ',
  // The timeline family. A live id here does not mean X routes the operation:
  // `UserTweetsAndReplies` 404s for a session that `UserByScreenName` and
  // `Viewer` both answer. They are probed in order; see `fetchTweets.ts`.
  UserTweetsAndReplies: 'qUpkZU6eN8MbtQb7rC_pYg',
  UserTweets: 'SXVCYB8XHSS25nzIljNtZA',
  UserOriginalsTimeline: 'jcbfqPu_2XMNOwVyGypRhw',
  UserRepliesTimeline: 'dRUXRSlEIPlVmPgOQ8Z43g',
  UserRepostsTimeline: 'bV_DHAIvQ945LAA1-eIIow',
  // The likes read + the un-like write. Measured off this account's live bundle
  // on 2026-08-12; same "the scrape is authoritative, this is a rotting snapshot"
  // caveat as every other value here.
  Likes: 'xA8fDIbrJfy4ojjjXmSR-A',
  UnfavoriteTweet: 'ZYKSe-w7KEslx3JhSIk5LA',
  Viewer: '5XShkXk2oO2J7SYmTu6pvw',
};

/**
 * `features` blob X requires on GraphQL reads. Missing/extra keys produce a
 * `The following features cannot be null: ...` error listing exactly what to
 * add, so when X moves the goalposts the fix is a one-line edit here.
 */
export const TIMELINE_FEATURES: Record<string, boolean> = {
  responsive_web_graphql_exclude_directive_enabled: true,
  verified_phone_label_enabled: false,
  creator_subscriptions_tweet_preview_api_enabled: true,
  responsive_web_graphql_timeline_navigation_enabled: true,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  communities_web_enable_tweet_community_results_fetch: true,
  c9s_tweet_anatomy_moderator_badge_enabled: true,
  articles_preview_enabled: true,
  tweetypie_unmention_optimization_enabled: true,
  responsive_web_edit_tweet_api_enabled: true,
  graphql_is_translatable_rweb_tweet_is_translatable_enabled: true,
  view_counts_everywhere_api_enabled: true,
  longform_notetweets_consumption_enabled: true,
  responsive_web_twitter_article_tweet_consumption_enabled: true,
  tweet_awards_web_tipping_enabled: false,
  creator_subscriptions_quote_tweet_preview_enabled: false,
  freedom_of_speech_not_reach_fetch_enabled: true,
  standardized_nudges_misinfo: true,
  tweet_with_visibility_results_prefer_gql_limited_actions_policy_enabled: true,
  rweb_video_timestamps_enabled: true,
  longform_notetweets_rich_text_read_enabled: true,
  longform_notetweets_inline_media_enabled: true,
  responsive_web_enhance_cards_enabled: false,
};

/** `fieldToggles` blob for UserByScreenName. */
export const USER_FIELD_TOGGLES: Record<string, boolean> = {
  withAuxiliaryUserLabels: false,
};

/** `https://x.com/i/api/graphql/<queryId>/<OperationName>` */
export function graphqlUrl(queryId: string, operationName: string): string {
  return `${GRAPHQL_BASE}/${queryId}/${operationName}`;
}

export interface HeaderInput {
  /** CSRF token cookie. Goes in BOTH the cookie jar and `x-csrf-token`. */
  ct0: string;
  /** Session cookie. The actual credential. */
  authToken: string;
  /** `x-client-transaction-id`; omitted when not supplied. */
  transactionId?: string | undefined;
}

/**
 * Build the header set X's web client sends on every authenticated API request.
 *
 * The `ct0` value appears twice on purpose: X validates that the `x-csrf-token`
 * header matches the `ct0` cookie (classic double-submit CSRF defence). If they
 * disagree you get a 403 with code 353, not a helpful message.
 *
 * `user-agent` / `referer` / `origin` are here because a real x.com XHR carries
 * all three and twedel used to carry none of them - an XHR that claims to come
 * from nowhere, from a client that names itself `node`, is a needless tell.
 * They are added, never substituted: everything this function sent before, it
 * still sends.
 *
 * This header set is for API calls ONLY. Do not aim it at an HTML page - see
 * `buildDocumentHeaders`.
 */
export function buildHeaders(input: HeaderInput): Record<string, string> {
  const headers: Record<string, string> = {
    authorization: WEB_BEARER,
    'x-csrf-token': input.ct0,
    cookie: `auth_token=${input.authToken}; ct0=${input.ct0}`,
    'x-twitter-auth-type': 'OAuth2Session',
    'x-twitter-active-user': 'yes',
    'content-type': 'application/json',
    accept: '*/*',
    'user-agent': BROWSER_USER_AGENT,
    referer: `${X_ORIGIN}/`,
    origin: X_ORIGIN,
  };
  if (input.transactionId) {
    headers['x-client-transaction-id'] = input.transactionId;
  }
  return headers;
}

export interface DocumentHeaderInput {
  /** Session cookie. Omitted from the jar when empty. */
  authToken?: string | undefined;
  /** CSRF cookie. Sent as a COOKIE only - never as `x-csrf-token` here. */
  ct0?: string | undefined;
  /**
   * Set `false` for hosts that are not X (the `abs.twimg.com` bundles): a
   * public CDN needs no credentials, so it gets none.
   */
  withCookies?: boolean;
}

/**
 * Headers for fetching a DOCUMENT - what a browser sends when it navigates.
 *
 * This exists because aiming `buildHeaders` at `https://x.com` is wrong, and
 * measurably so. Unauthenticated, same day, same client:
 *
 *   GET x.com, no headers at all                       -> 200
 *   GET x.com, bearer + x-twitter-auth-type + friends   -> 200
 *   GET x.com, bearer WITHOUT x-twitter-auth-type       -> 401
 *
 * i.e. X routes `x.com` through its API auth stack the moment an
 * `authorization` header appears, and then judges the request by API rules -
 * where a real session that disagrees with any of those headers can come back
 * 404. The queryId scrape fetches the HTML shell, so it was doing exactly this
 * on every connect.
 *
 * Deliberately absent, and asserted absent by the tests: `authorization`,
 * `x-twitter-auth-type`, `x-twitter-active-user`, `x-csrf-token`,
 * `content-type`, `x-client-transaction-id`. A browser navigating to a page
 * sends none of them, and the cookies alone are what make the shell render
 * logged-in.
 */
export function buildDocumentHeaders(input: DocumentHeaderInput = {}): Record<string, string> {
  const headers: Record<string, string> = {
    'user-agent': BROWSER_USER_AGENT,
    accept: DOCUMENT_ACCEPT,
    'accept-language': DOCUMENT_ACCEPT_LANGUAGE,
  };

  if (input.withCookies === false) return headers;

  const jar: string[] = [];
  if (input.authToken) jar.push(`auth_token=${input.authToken}`);
  if (input.ct0) jar.push(`ct0=${input.ct0}`);
  if (jar.length > 0) headers['cookie'] = jar.join('; ');

  return headers;
}
