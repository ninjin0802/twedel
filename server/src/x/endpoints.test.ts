import { describe, expect, it } from 'vitest';
import { maskSecret } from '../config.js';
import {
  API_BASE,
  BROWSER_MANAGED_HEADERS,
  BROWSER_USER_AGENT,
  DEFAULT_QUERY_IDS,
  DEFAULT_QUERY_IDS_OBSERVED_AT,
  GRAPHQL_BASE,
  OPERATIONS,
  V11_BASE,
  V11_PROBE_PATHS,
  WEB_BEARER,
  X_ERROR_PAGE_DOES_NOT_EXIST,
  buildDocumentHeaders,
  buildHeaders,
  graphqlUrl,
  isXHost,
} from './endpoints.js';

const AUTH = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0';
const CT0 = 'ff00ff00ff00ff00ff00ff00ff00ff00';

describe('buildHeaders', () => {
  it('produces every header X requires', () => {
    const h = buildHeaders({ authToken: AUTH, ct0: CT0 });

    expect(h['authorization']).toBe(WEB_BEARER);
    expect(h['x-twitter-auth-type']).toBe('OAuth2Session');
    expect(h['x-twitter-active-user']).toBe('yes');
    expect(h['content-type']).toBe('application/json');
    expect(h['accept']).toBe('*/*');
    expect(h['cookie']).toBeDefined();
    expect(h['x-csrf-token']).toBeDefined();
  });

  /**
   * A real x.com XHR carries all three. twedel used to carry none of them: an
   * API request that claims to come from nowhere, issued by a client that names
   * itself `node`, is a free automation tell.
   */
  it('identifies itself as a browser: user-agent, referer and origin', () => {
    const h = buildHeaders({ authToken: AUTH, ct0: CT0 });

    expect(h['user-agent']).toBe(BROWSER_USER_AGENT);
    expect(h['user-agent']).toMatch(/^Mozilla\/5\.0 /);
    expect(h['user-agent']).toMatch(/Chrome\/\d+/);
    expect(h['referer']).toBe('https://x.com/');
    expect(h['origin']).toBe('https://x.com');
  });

  it('ADDS to the old header set rather than replacing any of it', () => {
    // Every header this function has ever sent, enumerated: adding the browser
    // identity must not quietly drop one of them.
    const h = buildHeaders({ authToken: AUTH, ct0: CT0, transactionId: 'tid' });
    expect(Object.keys(h).sort()).toEqual(
      [
        'accept',
        'authorization',
        'content-type',
        'cookie',
        'origin',
        'referer',
        'user-agent',
        'x-client-transaction-id',
        'x-csrf-token',
        'x-twitter-active-user',
        'x-twitter-auth-type',
      ].sort(),
    );
  });

  it('embeds ct0 in BOTH the cookie jar and x-csrf-token (double-submit CSRF)', () => {
    const h = buildHeaders({ authToken: AUTH, ct0: CT0 });

    expect(h['x-csrf-token']).toBe(CT0);
    expect(h['cookie']).toBe(`auth_token=${AUTH}; ct0=${CT0}`);
    expect(h['cookie']).toContain(`ct0=${CT0}`);
    expect(h['cookie']).toContain(`auth_token=${AUTH}`);
  });

  it('omits x-client-transaction-id unless one is supplied', () => {
    expect(buildHeaders({ authToken: AUTH, ct0: CT0 })['x-client-transaction-id']).toBeUndefined();
    expect(
      buildHeaders({ authToken: AUTH, ct0: CT0, transactionId: 'tid-123' })[
        'x-client-transaction-id'
      ],
    ).toBe('tid-123');
  });
});

/**
 * The regression this whole change is about: the queryId scrape fetched the
 * HTML shell through the API header set, and an `authorization` header on
 * `https://x.com` puts the request through X's API auth stack (401 without
 * `x-twitter-auth-type`, and 404 for a real session it declines to route).
 */
describe('buildDocumentHeaders', () => {
  it('looks like a browser navigation: UA, html accept, language, cookies', () => {
    const h = buildDocumentHeaders({ authToken: AUTH, ct0: CT0 });

    expect(h['user-agent']).toBe(BROWSER_USER_AGENT);
    expect(h['accept']).toContain('text/html');
    expect(h['accept']).toContain('application/xhtml+xml');
    expect(h['accept-language']).toBeDefined();
    expect(h['cookie']).toBe(`auth_token=${AUTH}; ct0=${CT0}`);
  });

  it('sends NONE of the API headers - asserted one by one', () => {
    const h = buildDocumentHeaders({ authToken: AUTH, ct0: CT0 });

    expect(h['authorization']).toBeUndefined();
    expect(h['x-twitter-auth-type']).toBeUndefined();
    expect(h['x-twitter-active-user']).toBeUndefined();
    expect(h['x-csrf-token']).toBeUndefined();
    expect(h['content-type']).toBeUndefined();
    expect(h['x-client-transaction-id']).toBeUndefined();
    // Nothing in the whole header set may carry the bearer.
    expect(JSON.stringify(h)).not.toContain(WEB_BEARER);
  });

  it('sends no cookie header at all when credentials are refused', () => {
    const h = buildDocumentHeaders({ authToken: AUTH, ct0: CT0, withCookies: false });

    expect(h['cookie']).toBeUndefined();
    expect(JSON.stringify(h)).not.toContain(AUTH);
    expect(JSON.stringify(h)).not.toContain(CT0);
    // Still a browser-shaped request, just an anonymous one.
    expect(h['user-agent']).toBe(BROWSER_USER_AGENT);
  });

  it('omits the cookie header when there is no session to send', () => {
    expect(buildDocumentHeaders()['cookie']).toBeUndefined();
    expect(buildDocumentHeaders({ authToken: '', ct0: '' })['cookie']).toBeUndefined();
  });

  it('sends only the half of the jar it has', () => {
    expect(buildDocumentHeaders({ ct0: CT0 })['cookie']).toBe(`ct0=${CT0}`);
    expect(buildDocumentHeaders({ authToken: AUTH })['cookie']).toBe(`auth_token=${AUTH}`);
  });
});

describe('isXHost', () => {
  it('accepts x.com and its subdomains - the only hosts our cookies may reach', () => {
    expect(isXHost('https://x.com')).toBe(true);
    expect(isXHost('https://x.com/i/api/1.1/account/settings.json')).toBe(true);
    expect(isXHost('https://api.x.com/1.1/account/settings.json')).toBe(true);
  });

  it('rejects the CDN and anything that merely looks like X', () => {
    expect(isXHost('https://abs.twimg.com/x-web/x-web/entry.js')).toBe(false);
    expect(isXHost('https://notx.com/')).toBe(false);
    expect(isXHost('https://x.com.evil.example/')).toBe(false);
    expect(isXHost('not a url')).toBe(false);
  });
});

describe('the v1.1 probe route', () => {
  /**
   * Measured unauthenticated on 2026-08-12 with an identical header set:
   *   x.com/i/api/1.1/account/settings.json -> 403 (exists, wants auth)
   *   api.x.com/1.1/account/settings.json   -> 404 / 401
   * `playwright.ts` had already worked this out independently and rewrites
   * `api.x.com` onto `/i/api`; the cookie transport now addresses it directly.
   */
  it('is the same-origin /i/api path, not api.x.com', () => {
    expect(V11_BASE).toBe('https://x.com/i/api');
    expect(`${V11_BASE}${V11_PROBE_PATHS.settings}`).toBe(
      'https://x.com/i/api/1.1/account/settings.json',
    );
    expect(`${V11_BASE}${V11_PROBE_PATHS.verifyCredentials}`).toBe(
      'https://x.com/i/api/1.1/account/verify_credentials.json',
    );
  });

  it('still names api.x.com, because toPageUrl has to recognise it', () => {
    expect(API_BASE).toBe('https://api.x.com');
  });
});

describe('BROWSER_MANAGED_HEADERS', () => {
  it('lists exactly the headers a browser fetch refuses to let us set', () => {
    // The playwright transport strips these before `page.evaluate`; setting any
    // of them inside a real browser `fetch` throws a TypeError.
    expect([...BROWSER_MANAGED_HEADERS].sort()).toEqual(
      ['cookie', 'origin', 'referer', 'user-agent'].sort(),
    );
    // ...and buildHeaders sets all of them, which is why the strip is needed.
    const h = buildHeaders({ authToken: AUTH, ct0: CT0 });
    for (const name of BROWSER_MANAGED_HEADERS) expect(h[name]).toBeDefined();
  });
});

describe('graphqlUrl', () => {
  it('assembles /graphql/<queryId>/<OperationName>', () => {
    expect(graphqlUrl('abc123', 'DeleteTweet')).toBe(`${GRAPHQL_BASE}/abc123/DeleteTweet`);
  });
});

/**
 * The un-retweet operation.
 *
 * `UnretweetTweet` was a guess, and a wrong one: it appears in NONE of the ~100
 * operation names extracted from x.com's live bundles on 2026-08-12. Every
 * retweet twedel tried to remove went to a URL that could only 404. The name is
 * pinned here so it cannot drift back by accident.
 */
describe('OPERATIONS', () => {
  it('names the un-retweet operation DeleteRetweet, which X actually has', () => {
    expect(OPERATIONS.deleteRetweet).toBe('DeleteRetweet');
  });

  it('contains the string "UnretweetTweet" nowhere at all', () => {
    expect(JSON.stringify(OPERATIONS)).not.toContain('Unretweet');
    expect(JSON.stringify(DEFAULT_QUERY_IDS)).not.toContain('Unretweet');
  });
});

/**
 * Pinned so that changing one is a DELIBERATE act with a measurement behind it,
 * never a drive-by edit. Every value was read off X's live bundles on
 * `DEFAULT_QUERY_IDS_OBSERVED_AT`; they are snapshots and they will rot. The
 * previous `DeleteTweet` value, `VaenaVgh5q5ih7kvyVjgtg`, was documented as
 * "stable for a very long time" and was measurably wrong by that date - which is
 * a 404 on every delete precisely when the scrape has already failed.
 */
describe('DEFAULT_QUERY_IDS', () => {
  it('matches the ids measured on the recorded date', () => {
    expect(DEFAULT_QUERY_IDS).toEqual({
      DeleteTweet: 'nxpZCY2K-I6QoFHAHeojFQ',
      DeleteRetweet: 'ZyZigVsNiFO6v1dEks1eWg',
      UserByScreenName: 'Gb-d6r0vxPOADdG62OEBpQ',
      UserTweetsAndReplies: 'qUpkZU6eN8MbtQb7rC_pYg',
      UserTweets: 'SXVCYB8XHSS25nzIljNtZA',
      UserOriginalsTimeline: 'jcbfqPu_2XMNOwVyGypRhw',
      UserRepliesTimeline: 'dRUXRSlEIPlVmPgOQ8Z43g',
      UserRepostsTimeline: 'bV_DHAIvQ945LAA1-eIIow',
      Likes: 'xA8fDIbrJfy4ojjjXmSR-A',
      UnfavoriteTweet: 'ZYKSe-w7KEslx3JhSIk5LA',
      Viewer: '5XShkXk2oO2J7SYmTu6pvw',
    });
  });

  it('no longer carries the stale DeleteTweet id', () => {
    expect(DEFAULT_QUERY_IDS['DeleteTweet']).not.toBe('VaenaVgh5q5ih7kvyVjgtg');
  });

  it('records when the snapshot was taken, so its age is visible', () => {
    expect(DEFAULT_QUERY_IDS_OBSERVED_AT).toBe('2026-08-12');
  });

  it('has a default for every operation twedel dispatches', () => {
    for (const op of Object.values(OPERATIONS)) {
      expect(typeof DEFAULT_QUERY_IDS[op]).toBe('string');
    }
  });
});

describe('X_ERROR_PAGE_DOES_NOT_EXIST', () => {
  // The code both retired v1.1 endpoints return, on both hosts, to a live
  // session X is simultaneously serving GraphQL for.
  it('is X error code 34', () => {
    expect(X_ERROR_PAGE_DOES_NOT_EXIST).toBe(34);
  });
});

describe('maskSecret', () => {
  it('never reveals more than the first two characters', () => {
    const masked = maskSecret(AUTH);
    expect(masked).toBe(`a1…(len ${AUTH.length})`);
    expect(masked).not.toContain(AUTH);
    expect(masked).not.toContain(AUTH.slice(0, 8));
  });
});
