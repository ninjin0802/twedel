import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FetchProgress } from './fetchTweets.js';
import {
  fetchUserLikes,
  fetchUserTweets,
  normalizeTweet,
  parseTwitterDate,
  resetTimelineSource,
  timelineSourceInUse,
} from './fetchTweets.js';
import { resetQueryIdState, setManualQueryId } from './queryId.js';
import { createCookieTransport } from './transport.js';

const ME = '1000000001';
const SOMEONE_ELSE = '2000000002';

interface TweetSpec {
  id: string;
  authorId?: string;
  createdAt?: string;
  text?: string;
  likes?: number;
  retweets?: number;
  replyTo?: string;
  media?: boolean;
  retweetOf?: string;
}

function tweetResult(spec: TweetSpec): Record<string, unknown> {
  const legacy: Record<string, unknown> = {
    id_str: spec.id,
    created_at: spec.createdAt ?? 'Wed Oct 10 20:19:24 +0000 2018',
    full_text: spec.text ?? `tweet ${spec.id}`,
    favorite_count: spec.likes ?? 0,
    retweet_count: spec.retweets ?? 0,
  };
  if (spec.replyTo) legacy['in_reply_to_status_id_str'] = spec.replyTo;
  if (spec.media) legacy['extended_entities'] = { media: [{ type: 'photo' }] };
  if (spec.retweetOf) {
    legacy['retweeted_status_result'] = {
      result: {
        __typename: 'Tweet',
        rest_id: spec.retweetOf,
        core: { user_results: { result: { __typename: 'User', rest_id: SOMEONE_ELSE } } },
        legacy: {
          id_str: spec.retweetOf,
          created_at: 'Mon Jan 01 00:00:00 +0000 2020',
          full_text: 'the original tweet by someone else',
          favorite_count: 999,
          retweet_count: 999,
        },
      },
    };
  }
  return {
    __typename: 'Tweet',
    rest_id: spec.id,
    core: { user_results: { result: { __typename: 'User', rest_id: spec.authorId ?? ME } } },
    legacy,
  };
}

/** The nesting the real timeline uses today. */
function entry(spec: TweetSpec): Record<string, unknown> {
  return {
    entryId: `tweet-${spec.id}`,
    content: {
      entryType: 'TimelineTimelineItem',
      itemContent: { itemType: 'TimelineTweet', tweet_results: { result: tweetResult(spec) } },
    },
  };
}

function cursorEntry(value: string): Record<string, unknown> {
  return {
    entryId: `cursor-bottom-${value}`,
    content: { entryType: 'TimelineTimelineCursor', cursorType: 'Bottom', value },
  };
}

function timeline(entries: unknown[]): Record<string, unknown> {
  return {
    data: {
      user: {
        result: {
          __typename: 'User',
          timeline_v2: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries }] } },
        },
      },
    },
  };
}

interface PageReply {
  body: unknown;
  headers?: Record<string, string>;
}

let pages: Record<string, PageReply> = {};
let requestedCursors: string[] = [];
let userReply: unknown = null;

/**
 * Per-operation behaviour.
 *
 * X routes some subset of its timeline operations per account - the whole reason
 * `fetchUserTweets` walks a candidate chain - so the fake has to be able to say
 * "this operation 404s and that one answers", per operation.
 */
interface OperationBehaviour {
  /** HTTP status for every request to this operation. 200 unless set. */
  status?: number;
  /** cursor -> page. Falls back to the shared `pages` map when absent. */
  pages?: Record<string, PageReply>;
}

let behaviour: Record<string, OperationBehaviour> = {};
/** Every timeline operation that was actually requested, in order. */
let requestedOperations: string[] = [];

const TIMELINE_OPERATIONS = [
  'UserTweetsAndReplies',
  'UserTweets',
  'UserOriginalsTimeline',
  'UserRepliesTimeline',
  'UserRepostsTimeline',
];

function timelineHandler(operation: string) {
  return ({ request }: { request: Request }) => {
    const raw = new URL(request.url).searchParams.get('variables') ?? '{}';
    const variables = JSON.parse(raw) as { cursor?: string };
    const cursor = variables.cursor ?? '';
    requestedOperations.push(operation);

    const own = behaviour[operation] ?? {};
    if (own.status !== undefined && own.status !== 200) {
      return HttpResponse.json({ errors: [{ message: 'nope' }] }, { status: own.status });
    }
    requestedCursors.push(cursor);
    const page = (own.pages ?? pages)[cursor];
    if (!page) return HttpResponse.json(timeline([]));
    return HttpResponse.json(page.body as Record<string, unknown>, { headers: page.headers });
  };
}

const server = setupServer(
  http.get('https://x.com/i/api/graphql/:queryId/UserByScreenName', () =>
    HttpResponse.json(userReply as Record<string, unknown>),
  ),
  ...TIMELINE_OPERATIONS.map((op) =>
    http.get(`https://x.com/i/api/graphql/:queryId/${op}`, timelineHandler(op)),
  ),
  // The likes timeline reuses the same page/behaviour machinery.
  http.get('https://x.com/i/api/graphql/:queryId/Likes', timelineHandler('Likes')),
);

let dir = '';
const transport = createCookieTransport({ authToken: 'tok', ct0: 'csrf' });

const NO_PACING = { minDelayMs: 0, maxDelayMs: 0 };

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'twedel-fetch-'));
  process.env['TWEDEL_DATA_DIR'] = dir;
  server.listen({ onUnhandledRequest: 'error' });
});

afterAll(async () => {
  server.close();
  delete process.env['TWEDEL_DATA_DIR'];
  await rm(dir, { recursive: true, force: true });
});

beforeEach(() => {
  resetQueryIdState();
  resetTimelineSource();
  setManualQueryId('UserByScreenName', 'USERQID');
  setManualQueryId('UserTweetsAndReplies', 'TIMELINEQID');
  setManualQueryId('UserTweets', 'PLAINQID');
  setManualQueryId('UserOriginalsTimeline', 'ORIGQID');
  setManualQueryId('UserRepliesTimeline', 'REPLYQID');
  setManualQueryId('UserRepostsTimeline', 'REPOSTQID');
  setManualQueryId('Likes', 'LIKESQID');
  pages = {};
  behaviour = {};
  requestedOperations = [];
  requestedCursors = [];
  userReply = {
    data: { user: { result: { __typename: 'User', rest_id: ME, legacy: { screen_name: 'me' } } } },
  };
});

afterEach(() => server.resetHandlers());

describe('parseTwitterDate', () => {
  it('parses the Twitter format explicitly', () => {
    expect(parseTwitterDate('Wed Oct 10 20:19:24 +0000 2018')).toBe('2018-10-10T20:19:24.000Z');
  });

  it('applies a non-zero UTC offset', () => {
    expect(parseTwitterDate('Wed Oct 10 20:19:24 +0900 2018')).toBe('2018-10-10T11:19:24.000Z');
    expect(parseTwitterDate('Wed Oct 10 20:19:24 -0500 2018')).toBe('2018-10-11T01:19:24.000Z');
  });

  it('handles every month name', () => {
    expect(parseTwitterDate('Sat Jan 01 00:00:00 +0000 2022')).toBe('2022-01-01T00:00:00.000Z');
    expect(parseTwitterDate('Sat Dec 31 23:59:59 +0000 2022')).toBe('2022-12-31T23:59:59.000Z');
  });

  it('returns null rather than guessing on junk', () => {
    expect(parseTwitterDate('2018-10-10')).toBeNull();
    expect(parseTwitterDate('')).toBeNull();
    expect(parseTwitterDate(undefined)).toBeNull();
    expect(parseTwitterDate('Wed Foo 10 20:19:24 +0000 2018')).toBeNull();
  });
});

describe('fetchUserTweets', () => {
  it('pages through two cursors and returns every tweet', async () => {
    pages[''] = {
      body: timeline([entry({ id: '11' }), entry({ id: '12' }), cursorEntry('PAGE2')]),
    };
    pages['PAGE2'] = { body: timeline([entry({ id: '13' }), entry({ id: '14' })]) };

    const progress: FetchProgress[] = [];
    const tweets = await fetchUserTweets({
      transport,
      screenName: 'me',
      pacing: NO_PACING,
      onProgress: (p) => progress.push(p),
    });

    expect(tweets.map((t) => t.id).sort()).toEqual(['11', '12', '13', '14']);
    expect(requestedCursors).toEqual(['', 'PAGE2']);
    // ...and every event names the timeline operation the tweets came from.
    expect(progress.at(-1)).toEqual({
      fetched: 4,
      cursorPage: 2,
      done: true,
      operation: 'UserTweetsAndReplies',
    });
  });

  it('finds tweets at an UNEXPECTED nesting depth', async () => {
    pages[''] = {
      body: {
        data: {
          some_new_wrapper: {
            v3: [
              {
                modules: [
                  {
                    // Nothing like today's path; the walker must still find it.
                    surprise: { deep: { deeper: { result: tweetResult({ id: '77' }) } } },
                  },
                ],
              },
            ],
          },
        },
      },
    };

    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });
    expect(tweets.map((t) => t.id)).toEqual(['77']);
  });

  it('unwraps TweetWithVisibilityResults', async () => {
    pages[''] = {
      body: timeline([
        {
          entryId: 'tweet-88',
          content: {
            itemContent: {
              tweet_results: {
                result: {
                  __typename: 'TweetWithVisibilityResults',
                  limitedActionResults: {},
                  tweet: tweetResult({ id: '88' }),
                },
              },
            },
          },
        },
      ]),
    };

    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });
    expect(tweets.map((t) => t.id)).toEqual(['88']);
  });

  it('stops when the cursor repeats instead of looping forever', async () => {
    pages[''] = { body: timeline([entry({ id: '21' }), cursorEntry('SAME')]) };
    pages['SAME'] = { body: timeline([entry({ id: '22' }), cursorEntry('SAME')]) };

    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });

    expect(tweets.map((t) => t.id).sort()).toEqual(['21', '22']);
    expect(requestedCursors).toEqual(['', 'SAME']);
  });

  it('continues past a duplicate-only bridge page to older tweets', async () => {
    pages[''] = { body: timeline([entry({ id: '31' }), cursorEntry('P2')]) };
    pages['P2'] = { body: timeline([entry({ id: '31' }), cursorEntry('P3')]) };
    pages['P3'] = { body: timeline([entry({ id: '32' }), cursorEntry('P4')]) };

    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });

    expect(tweets.map((t) => t.id).sort()).toEqual(['31', '32']);
    // P4 is the terminal empty page; it must be requested to prove P3's cursor
    // did not lead to still older data.
    expect(requestedCursors).toEqual(['', 'P2', 'P3', 'P4']);
  });

  it('continues past a foreign-only bridge page to an old 2018 repost', async () => {
    pages[''] = { body: timeline([entry({ id: '41' }), cursorEntry('BRIDGE')]) };
    pages['BRIDGE'] = {
      body: timeline([entry({ id: 'foreign', authorId: SOMEONE_ELSE }), cursorEntry('OLD')]),
    };
    pages['OLD'] = {
      body: timeline([entry({ id: 'old-rt', text: 'RT @someone: old', retweetOf: '900', createdAt: 'Wed Oct 10 20:19:24 +0000 2018' })]),
    };

    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });
    expect(tweets.find((tweet) => tweet.id === 'old-rt')).toMatchObject({ isRetweet: true, sourceTweetId: '900' });
    expect(requestedCursors).toEqual(['', 'BRIDGE', 'OLD']);
  });

  it("filters out other users' tweets that the timeline interleaves", async () => {
    pages[''] = {
      body: timeline([
        entry({ id: '41' }),
        entry({ id: '42', authorId: SOMEONE_ELSE }),
        entry({ id: '43' }),
      ]),
    };

    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });
    expect(tweets.map((t) => t.id).sort()).toEqual(['41', '43']);
  });

  it('does not harvest the original tweet nested inside a retweet', async () => {
    pages[''] = {
      body: timeline([entry({ id: '51', text: 'RT @someone: hi', retweetOf: '90909090' })]),
    };

    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });

    expect(tweets).toHaveLength(1);
    expect(tweets[0]?.id).toBe('51');
    expect(tweets[0]?.isRetweet).toBe(true);
  });

  it('detects a retweet from the "RT @" prefix alone', async () => {
    pages[''] = { body: timeline([entry({ id: '52', text: 'RT @someone: hello' })]) };
    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });
    expect(tweets[0]?.isRetweet).toBe(true);
  });

  it("captures the retweet's ORIGINAL id as sourceTweetId, keeping id as the retweet's own", async () => {
    pages[''] = {
      body: timeline([entry({ id: '53', text: 'RT @someone: hi', retweetOf: '90909090' })]),
    };
    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });

    // `id` stays the account's own retweet action id (the log/identity key);
    // `sourceTweetId` is the ORIGINAL tweet's id that DeleteRetweet needs.
    expect(tweets[0]?.id).toBe('53');
    expect(tweets[0]?.isRetweet).toBe(true);
    expect(tweets[0]?.sourceTweetId).toBe('90909090');
  });

  it('leaves sourceTweetId undefined for a plain tweet', async () => {
    pages[''] = { body: timeline([entry({ id: '54' })]) };
    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });
    expect(tweets[0]?.isRetweet).toBe(false);
    expect(tweets[0]?.sourceTweetId).toBeUndefined();
  });

  it('normalises to the Tweet contract with countsReliable: true', async () => {
    pages[''] = {
      body: timeline([
        entry({
          id: '61',
          createdAt: 'Wed Oct 10 20:19:24 +0000 2018',
          text: 'hello world',
          likes: 12,
          retweets: 3,
          replyTo: '999',
          media: true,
        }),
      ]),
    };

    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });

    expect(tweets[0]).toEqual({
      id: '61',
      createdAt: '2018-10-10T20:19:24.000Z',
      text: 'hello world',
      likeCount: 12,
      retweetCount: 3,
      isReply: true,
      isRetweet: false,
      hasMedia: true,
      source: 'live',
      countsReliable: true,
    });
  });

  it('sorts newest first and dedupes by id', async () => {
    pages[''] = {
      body: timeline([
        entry({ id: '71', createdAt: 'Wed Oct 10 20:19:24 +0000 2018' }),
        entry({ id: '72', createdAt: 'Fri Jan 01 00:00:00 +0000 2021' }),
        entry({ id: '71', createdAt: 'Wed Oct 10 20:19:24 +0000 2018' }),
      ]),
    };

    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });
    expect(tweets.map((t) => t.id)).toEqual(['72', '71']);
  });

  it('honours max', async () => {
    pages[''] = {
      body: timeline([entry({ id: '81' }), entry({ id: '82' }), entry({ id: '83' }), cursorEntry('P2')]),
    };
    pages['P2'] = { body: timeline([entry({ id: '84' })]) };

    const tweets = await fetchUserTweets({ transport, screenName: 'me', max: 2, pacing: NO_PACING });

    expect(tweets).toHaveLength(2);
    expect(requestedCursors).toEqual(['']);
  });

  it('returns early when the signal is already aborted', async () => {
    pages[''] = { body: timeline([entry({ id: '91' })]) };
    const controller = new AbortController();
    controller.abort();

    const tweets = await fetchUserTweets({
      transport,
      screenName: 'me',
      signal: controller.signal,
      pacing: NO_PACING,
    });

    expect(tweets).toEqual([]);
    expect(requestedCursors).toEqual([]);
  });

  it('sleeps until reset when x-rate-limit-remaining hits 0', async () => {
    pages[''] = {
      body: timeline([entry({ id: '95' }), cursorEntry('P2')]),
      headers: {
        'x-rate-limit-remaining': '0',
        'x-rate-limit-reset': String(Math.ceil(Date.now() / 1000) + 1),
      },
    };
    pages['P2'] = { body: timeline([entry({ id: '96' })]) };

    const started = Date.now();
    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });

    expect(tweets).toHaveLength(2);
    expect(Date.now() - started).toBeGreaterThanOrEqual(200);
  });

  it('fails loudly when the user id cannot be resolved', async () => {
    userReply = { data: {} };
    await expect(
      fetchUserTweets({ transport, screenName: 'ghost', pacing: NO_PACING }),
    ).rejects.toThrow(/user id/i);
  });
});

describe('normalizeTweet sourceTweetId extraction', () => {
  it('reads the ORIGINAL id from retweeted_status_result.result.rest_id', () => {
    const tweet = normalizeTweet(tweetResult({ id: '601', text: 'RT @x: hi', retweetOf: '5551212' }));
    expect(tweet?.id).toBe('601');
    expect(tweet?.isRetweet).toBe(true);
    expect(tweet?.sourceTweetId).toBe('5551212');
  });

  it('falls back to legacy.retweeted_status_id_str when the nested result is absent', () => {
    const node = {
      __typename: 'Tweet',
      rest_id: '602',
      core: { user_results: { result: { __typename: 'User', rest_id: ME } } },
      legacy: {
        id_str: '602',
        created_at: 'Wed Oct 10 20:19:24 +0000 2018',
        full_text: 'RT @x: hi',
        favorite_count: 0,
        retweet_count: 0,
        // No retweeted_status_result at all - only the flat id string.
        retweeted_status_id_str: '7778888',
      },
    };
    const tweet = normalizeTweet(node);
    expect(tweet?.isRetweet).toBe(true);
    expect(tweet?.sourceTweetId).toBe('7778888');
  });

  it('leaves sourceTweetId undefined for a plain tweet', () => {
    const tweet = normalizeTweet(tweetResult({ id: '603' }));
    expect(tweet?.isRetweet).toBe(false);
    expect(tweet?.sourceTweetId).toBeUndefined();
  });

  it('leaves sourceTweetId undefined for a bare "RT @" retweet with no original id', () => {
    // The archive-shaped case: prefix says retweet, nothing carries the origin.
    const tweet = normalizeTweet(tweetResult({ id: '604', text: 'RT @x: hi' }));
    expect(tweet?.isRetweet).toBe(true);
    expect(tweet?.sourceTweetId).toBeUndefined();
  });
});

/**
 * The timeline is a CHAIN, not one operation.
 *
 * Measured 2026-08-12: `UserTweetsAndReplies` answers 404 for a live session
 * whose `UserByScreenName` lookup succeeded with an id from the same scrape and
 * whose `Viewer` call returned 200. The id was fresh and correct - X had simply
 * stopped routing the operation while still shipping its id in the bundle. A
 * bundle listing an id is not evidence that the server still routes it.
 */
describe('the timeline candidate chain', () => {
  const SPLIT_LABEL = 'UserOriginalsTimeline + UserRepliesTimeline + UserRepostsTimeline';

  it('falls through to the SPLIT FAMILY (not UserTweets) when UserTweetsAndReplies 404s', async () => {
    // The bug this reorder fixes: UserTweets is the profile "Posts" view and
    // EXCLUDES replies, so it must not be reached while the reply-covering split
    // family is still available. The split family is tried next and merges replies.
    behaviour['UserTweetsAndReplies'] = { status: 404 };
    behaviour['UserOriginalsTimeline'] = { pages: { '': { body: timeline([entry({ id: '101' })]) } } };
    behaviour['UserRepliesTimeline'] = {
      pages: { '': { body: timeline([entry({ id: '102', replyTo: '999' })]) } },
    };
    behaviour['UserRepostsTimeline'] = { pages: { '': { body: timeline([entry({ id: '103' })]) } } };

    const progress: FetchProgress[] = [];
    const tweets = await fetchUserTweets({
      transport,
      screenName: 'me',
      pacing: NO_PACING,
      onProgress: (p) => progress.push(p),
    });

    // The reply (102) is present, which is the whole point.
    expect(tweets.map((t) => t.id).sort()).toEqual(['101', '102', '103']);
    expect(tweets.find((t) => t.id === '102')?.isReply).toBe(true);
    expect(requestedOperations).toEqual([
      'UserTweetsAndReplies',
      'UserOriginalsTimeline',
      'UserRepliesTimeline',
      'UserRepostsTimeline',
    ]);
    // UserTweets, the partial view, is never touched.
    expect(requestedOperations).not.toContain('UserTweets');
    expect(progress.at(-1)?.operation).toBe(SPLIT_LABEL);
  });

  it('uses the PARTIAL UserTweets only when the split family is also unavailable', async () => {
    behaviour['UserTweetsAndReplies'] = { status: 404 };
    behaviour['UserOriginalsTimeline'] = { status: 404 };
    behaviour['UserRepliesTimeline'] = { status: 404 };
    behaviour['UserRepostsTimeline'] = { status: 404 };
    behaviour['UserTweets'] = { pages: { '': { body: timeline([entry({ id: '101' })]) } } };

    const progress: FetchProgress[] = [];
    const tweets = await fetchUserTweets({
      transport,
      screenName: 'me',
      pacing: NO_PACING,
      onProgress: (p) => progress.push(p),
    });

    expect(tweets.map((t) => t.id)).toEqual(['101']);
    // Everything else was tried first; UserTweets is the declared last resort.
    expect(requestedOperations).toEqual([
      'UserTweetsAndReplies',
      'UserOriginalsTimeline',
      'UserRepliesTimeline',
      'UserRepostsTimeline',
      'UserTweets',
    ]);
    // The reported operation surfaces that replies were NOT covered.
    expect(progress.at(-1)?.operation).toBe('UserTweets');
    expect(timelineSourceInUse()).toBe('UserTweets');
  });

  it('merges the split family, dedupes by id and sorts newest first', async () => {
    behaviour['UserTweetsAndReplies'] = { status: 404 };
    const old = 'Wed Oct 10 20:19:24 +0000 2018';
    const mid = 'Fri Jan 01 00:00:00 +0000 2021';
    const recent = 'Sun Jan 01 00:00:00 +0000 2023';
    behaviour['UserOriginalsTimeline'] = {
      pages: { '': { body: timeline([entry({ id: 'A', createdAt: mid })]) } },
    };
    behaviour['UserRepliesTimeline'] = {
      // 'A' again: the same tweet legitimately appears in more than one stream.
      pages: {
        '': {
          body: timeline([entry({ id: 'A', createdAt: mid }), entry({ id: 'B', createdAt: recent })]),
        },
      },
    };
    behaviour['UserRepostsTimeline'] = {
      pages: { '': { body: timeline([entry({ id: 'C', createdAt: old })]) } },
    };

    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });

    expect(tweets.map((t) => t.id)).toEqual(['B', 'A', 'C']);
  });

  /**
   * A 401/403 is the session, not the operation. Walking the rest of the chain
   * would fire two more doomed requests and then report the wrong cause.
   */
  it('aborts on 401/403 instead of trying the next candidate', async () => {
    for (const status of [401, 403]) {
      requestedOperations = [];
      behaviour = { UserTweetsAndReplies: { status } };

      await expect(
        fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING }),
      ).rejects.toThrow(/rejected the session/i);
      expect(requestedOperations).toEqual(['UserTweetsAndReplies']);
    }
  });

  /**
   * A 429 is a closed rate-limit window. Falling through would spend the other
   * candidates against the same closed window and lose the backoff.
   */
  it('backs off on 429 rather than falling through', async () => {
    let hits = 0;
    server.use(
      http.get('https://x.com/i/api/graphql/:queryId/UserTweetsAndReplies', () => {
        hits += 1;
        requestedOperations.push('UserTweetsAndReplies');
        if (hits === 1) {
          return HttpResponse.json(
            { errors: [{ code: 88 }] },
            {
              status: 429,
              headers: { 'x-rate-limit-reset': String(Math.ceil(Date.now() / 1000)) },
            },
          );
        }
        return HttpResponse.json(timeline([entry({ id: '301' })]));
      }),
    );

    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });

    expect(tweets.map((t) => t.id)).toEqual(['301']);
    // Same operation, twice: the retry, not a fall-through.
    expect(requestedOperations).toEqual(['UserTweetsAndReplies', 'UserTweetsAndReplies']);
  });

  it('remembers the working candidate and stops re-probing the dead ones', async () => {
    behaviour['UserTweetsAndReplies'] = { status: 404 };
    // No per-op behaviour for the split family, so it falls back to shared pages
    // and answers - it is the candidate that works here.
    pages[''] = { body: timeline([entry({ id: '401' })]) };

    await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });
    expect(timelineSourceInUse()).toBe(SPLIT_LABEL);

    requestedOperations = [];
    await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });

    // The remembered split family is tried first and answers; the dead
    // UserTweetsAndReplies is not re-probed.
    expect(requestedOperations).toEqual([
      'UserOriginalsTimeline',
      'UserRepliesTimeline',
      'UserRepostsTimeline',
    ]);
  });

  it('names every refused operation, and does NOT blame the queryId', async () => {
    for (const op of TIMELINE_OPERATIONS) behaviour[op] = { status: 404 };

    let message = '';
    try {
      await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });
    } catch (err: unknown) {
      message = err instanceof Error ? err.message : String(err);
    }

    for (const op of TIMELINE_OPERATIONS) expect(message).toContain(op);
    // The failing URL's id is in there too, so the next question is answerable.
    expect(message).toContain('TIMELINEQID');
    expect(message).toMatch(/refused every timeline operation/i);
    expect(message).toMatch(/NOT a rotated queryId/i);
    expect(message).toMatch(/diagnostics/);
    expect(message).not.toMatch(/rotated UserTweetsAndReplies queryId/);
  });

  it('does not treat an empty timeline as a refusal', async () => {
    // No pages configured at all: every operation answers 200 with nothing.
    const tweets = await fetchUserTweets({ transport, screenName: 'me', pacing: NO_PACING });

    expect(tweets).toEqual([]);
    expect(requestedOperations).toEqual(['UserTweetsAndReplies']);
  });
});

/**
 * Likes are a separate read entirely: a like is SOMEONE ELSE'S tweet the account
 * favorited, so the "keep only rows authored by the target user" filter that the
 * tweet timelines apply would drop every single one.
 */
describe('fetchUserLikes', () => {
  it('pages through the Likes timeline and returns every liked tweet', async () => {
    behaviour['Likes'] = {
      pages: {
        '': { body: timeline([entry({ id: 'L1', authorId: SOMEONE_ELSE }), cursorEntry('P2')]) },
        P2: { body: timeline([entry({ id: 'L2', authorId: SOMEONE_ELSE })]) },
      },
    };

    const progress: FetchProgress[] = [];
    const likes = await fetchUserLikes({
      transport,
      screenName: 'me',
      pacing: NO_PACING,
      onProgress: (p) => progress.push(p),
    });

    expect(likes.map((t) => t.id).sort()).toEqual(['L1', 'L2']);
    expect(requestedOperations).toEqual(['Likes', 'Likes']);
    expect(progress.at(-1)).toMatchObject({ done: true, operation: 'Likes' });
  });

  it("does NOT drop a like just because its author is not the account", async () => {
    // The whole point: the author filter that fetchUserTweets applies must be OFF
    // here, or every like disappears.
    behaviour['Likes'] = {
      pages: { '': { body: timeline([entry({ id: 'L9', authorId: SOMEONE_ELSE })]) } },
    };

    const likes = await fetchUserLikes({ transport, screenName: 'me', pacing: NO_PACING });
    expect(likes.map((t) => t.id)).toEqual(['L9']);
  });

  it('flags every row isLike:true with isReply/isRetweet false and no sourceTweetId', async () => {
    // A liked tweet that is itself a retweet is STILL just a like: the retweet
    // detection must not mislabel it or send it down the un-retweet dispatch.
    behaviour['Likes'] = {
      pages: {
        '': {
          body: timeline([
            entry({ id: 'L1', authorId: SOMEONE_ELSE }),
            entry({ id: 'L2', authorId: SOMEONE_ELSE, text: 'RT @x: hi', retweetOf: '5551212' }),
          ]),
        },
      },
    };

    const likes = await fetchUserLikes({ transport, screenName: 'me', pacing: NO_PACING });

    expect(likes).toHaveLength(2);
    for (const like of likes) {
      expect(like.isLike).toBe(true);
      expect(like.isReply).toBe(false);
      expect(like.isRetweet).toBe(false);
      expect(like.sourceTweetId).toBeUndefined();
      expect(like.source).toBe('live');
    }
  });

  it('throws (rather than returning []) when X refuses the Likes read with a 404', async () => {
    behaviour['Likes'] = { status: 404 };
    await expect(
      fetchUserLikes({ transport, screenName: 'me', pacing: NO_PACING }),
    ).rejects.toThrow(/refused the Likes timeline/i);
  });

  it('honours max', async () => {
    behaviour['Likes'] = {
      pages: {
        '': {
          body: timeline([
            entry({ id: 'L1', authorId: SOMEONE_ELSE }),
            entry({ id: 'L2', authorId: SOMEONE_ELSE }),
            entry({ id: 'L3', authorId: SOMEONE_ELSE }),
            cursorEntry('P2'),
          ]),
        },
      },
    };
    const likes = await fetchUserLikes({ transport, screenName: 'me', max: 2, pacing: NO_PACING });
    expect(likes).toHaveLength(2);
  });
});
