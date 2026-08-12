import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HttpResponse, http } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_QUERY_IDS } from './endpoints.js';
import { deleteTweet } from './mutate.js';
import { resetQueryIdState, setManualQueryId } from './queryId.js';
import { createCookieTransport } from './transport.js';

interface Captured {
  url: string;
  body: unknown;
}

let captured: Captured[] = [];
let reply: { status: number; body: unknown; headers?: Record<string, string> } = {
  status: 200,
  body: { data: { delete_tweet: { tweet_results: {} } } },
};

const record = async (request: Request): Promise<void> => {
  captured.push({ url: request.url, body: JSON.parse(await request.text()) as unknown });
};

const server = setupServer(
  // The bundle scrape falls back to the hardcoded default when it finds nothing.
  http.get('https://x.com/', () => HttpResponse.html('<html></html>')),
  http.post('https://x.com/i/api/graphql/:queryId/DeleteTweet', async ({ request }) => {
    await record(request);
    return HttpResponse.json(reply.body as Record<string, unknown>, {
      status: reply.status,
      headers: reply.headers,
    });
  }),
  http.post('https://x.com/i/api/graphql/:queryId/DeleteRetweet', async ({ request }) => {
    await record(request);
    return HttpResponse.json(reply.body as Record<string, unknown>, {
      status: reply.status,
      headers: reply.headers,
    });
  }),
  http.post('https://x.com/i/api/graphql/:queryId/UnfavoriteTweet', async ({ request }) => {
    await record(request);
    return HttpResponse.json(reply.body as Record<string, unknown>, {
      status: reply.status,
      headers: reply.headers,
    });
  }),
);

let dir = '';
const transport = createCookieTransport({ authToken: 'secret-auth-token', ct0: 'secret-ct0' });

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'twedel-mutate-'));
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
  setManualQueryId('DeleteTweet', 'DELQID');
  setManualQueryId('DeleteRetweet', 'UNRTQID');
  setManualQueryId('UnfavoriteTweet', 'UNFAVQID');
  captured = [];
  reply = { status: 200, body: { data: { delete_tweet: { tweet_results: {} } } } };
});

afterEach(() => server.resetHandlers());

describe('operation dispatch', () => {
  it('routes a normal tweet to DeleteTweet with tweet_id', async () => {
    const outcome = await deleteTweet(transport, { id: '123', isRetweet: false });

    expect(outcome).toEqual({ status: 'deleted' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('https://x.com/i/api/graphql/DELQID/DeleteTweet');
    expect(captured[0]?.body).toEqual({
      variables: { tweet_id: '123', dark_request: false },
      queryId: 'DELQID',
    });
  });

  it('un-retweets by the ORIGINAL id (sourceTweetId), NOT the retweet action id', async () => {
    // The bug: DeleteRetweet un-retweets by the original tweet's id. Sending the
    // account's own retweet action id (`456`) targets the wrong thing and the
    // retweet stays up. `sourceTweetId` is the id that actually works.
    reply = { status: 200, body: { data: { unretweet: { source_tweet_results: {} } } } };
    const outcome = await deleteTweet(transport, {
      id: '456',
      isRetweet: true,
      sourceTweetId: '90909090',
    });

    expect(outcome).toEqual({ status: 'deleted' });
    expect(captured[0]?.url).toBe('https://x.com/i/api/graphql/UNRTQID/DeleteRetweet');
    expect(captured[0]?.body).toEqual({
      variables: { source_tweet_id: '90909090', dark_request: false },
      queryId: 'UNRTQID',
    });
  });

  it('falls back to the retweet id when sourceTweetId is absent (no worse than before)', async () => {
    reply = { status: 200, body: { data: { unretweet: { source_tweet_results: {} } } } };
    const outcome = await deleteTweet(transport, { id: '456', isRetweet: true });

    expect(outcome).toEqual({ status: 'deleted' });
    expect(captured[0]?.url).toBe('https://x.com/i/api/graphql/UNRTQID/DeleteRetweet');
    expect(captured[0]?.body).toEqual({
      variables: { source_tweet_id: '456', dark_request: false },
      queryId: 'UNRTQID',
    });
  });

  it('never sends sourceTweetId as tweet_id on the plain delete path', async () => {
    // A sourceTweetId on a non-retweet is meaningless; DeleteTweet must still use
    // the tweet's own id.
    const outcome = await deleteTweet(transport, {
      id: '123',
      isRetweet: false,
      sourceTweetId: '90909090',
    });

    expect(outcome).toEqual({ status: 'deleted' });
    expect(captured[0]?.body).toEqual({
      variables: { tweet_id: '123', dark_request: false },
      queryId: 'DELQID',
    });
  });

  /**
   * The regression this rename exists for. `UnretweetTweet` is not an operation
   * X has - it appears nowhere in the ~100 operation names extracted from x.com's
   * live bundles on 2026-08-12 - so every retweet twedel tried to remove was
   * addressed to a URL that could only ever 404, and no retweet could ever be
   * undone. The name must never come back, in any spelling of the URL.
   */
  it('never addresses the non-existent UnretweetTweet operation', async () => {
    reply = { status: 200, body: { data: { unretweet: {} } } };
    await deleteTweet(transport, { id: '456', isRetweet: true });

    expect(captured[0]?.url).not.toContain('UnretweetTweet');
    expect(captured[0]?.url).toContain('/DeleteRetweet');
  });

  /**
   * X names the success key as the snake_case of the operation, and has used
   * both spellings for this one. Reading a successful un-retweet as `failed`
   * would send the runner back to re-do an action X has already performed.
   */
  it('accepts either success key X uses for a removed retweet', async () => {
    for (const key of ['unretweet', 'delete_retweet']) {
      captured = [];
      reply = { status: 200, body: { data: { [key]: { source_tweet_results: {} } } } };

      await expect(deleteTweet(transport, { id: '456', isRetweet: true })).resolves.toEqual({
        status: 'deleted',
      });
    }
  });

  it('does not accept a retweet success key on the plain delete path', async () => {
    // `DeleteTweet` answers `data.delete_tweet` and nothing else; a body naming a
    // different mutation is not this mutation's success.
    reply = { status: 200, body: { data: { delete_retweet: {} } } };
    const outcome = await deleteTweet(transport, { id: '1', isRetweet: false });
    expect(outcome.status).toBe('failed');
  });
});

describe('un-favorite (likes) dispatch', () => {
  it('routes a like to UnfavoriteTweet with { tweet_id: id } and no dark_request', async () => {
    // A like is un-favorited by the LIKED tweet's id (which twedel stores as the
    // row's `id`). UnfavoriteTweet takes just `{ tweet_id }` - matching X's own
    // favorite/unfavorite convention - and X answers `data.unfavorite_tweet`.
    reply = { status: 200, body: { data: { unfavorite_tweet: 'Done' } } };
    const outcome = await deleteTweet(transport, { id: '321', isRetweet: false, isLike: true });

    expect(outcome).toEqual({ status: 'deleted' });
    expect(captured).toHaveLength(1);
    expect(captured[0]?.url).toBe('https://x.com/i/api/graphql/UNFAVQID/UnfavoriteTweet');
    expect(captured[0]?.body).toEqual({
      variables: { tweet_id: '321' },
      queryId: 'UNFAVQID',
    });
  });

  it('accepts favorite_tweet defensively as the success key too', async () => {
    reply = { status: 200, body: { data: { favorite_tweet: 'Done' } } };
    await expect(
      deleteTweet(transport, { id: '321', isRetweet: false, isLike: true }),
    ).resolves.toEqual({ status: 'deleted' });
  });

  it('maps a not-found like to already_gone (already un-liked)', async () => {
    reply = {
      status: 200,
      body: { errors: [{ message: 'No status found with that ID.', code: 144 }] },
    };
    await expect(
      deleteTweet(transport, { id: '321', isRetweet: false, isLike: true }),
    ).resolves.toEqual({ status: 'already_gone' });
  });

  /**
   * Dispatch precedence is `isLike` FIRST: a liked tweet that is itself a retweet
   * must still be un-LIKED, never un-retweeted. Sending it to DeleteRetweet would
   * act on the account's own timeline instead of removing the favorite.
   */
  it('un-likes a row even when it is also flagged isRetweet (like wins)', async () => {
    reply = { status: 200, body: { data: { unfavorite_tweet: 'Done' } } };
    const outcome = await deleteTweet(transport, {
      id: '321',
      isRetweet: true,
      isLike: true,
      sourceTweetId: '90909090',
    });

    expect(outcome).toEqual({ status: 'deleted' });
    expect(captured[0]?.url).toBe('https://x.com/i/api/graphql/UNFAVQID/UnfavoriteTweet');
    // Never the retweet path, and never the source id.
    expect(captured[0]?.url).not.toContain('DeleteRetweet');
    expect(captured[0]?.body).toEqual({ variables: { tweet_id: '321' }, queryId: 'UNFAVQID' });
  });

  it('un-favorites via the hardcoded default id when nothing else resolves', async () => {
    resetQueryIdState();
    reply = { status: 200, body: { data: { unfavorite_tweet: 'Done' } } };

    const outcome = await deleteTweet(transport, { id: '5', isRetweet: false, isLike: true });

    expect(outcome).toEqual({ status: 'deleted' });
    expect(captured[0]?.url).toBe(
      `https://x.com/i/api/graphql/${DEFAULT_QUERY_IDS['UnfavoriteTweet'] as string}/UnfavoriteTweet`,
    );
  });
});

describe('already_gone mapping', () => {
  it('maps HTTP 404 carrying a gone error', async () => {
    reply = {
      status: 404,
      body: { errors: [{ message: '_Missing: No status found with that ID.' }] },
    };
    await expect(deleteTweet(transport, { id: '1', isRetweet: false })).resolves.toEqual({
      status: 'already_gone',
    });
  });

  // Regression: a BARE 404 means the GraphQL URL itself is wrong, and the
  // queryId is part of that URL. Calling it `already_gone` would report a run
  // that deleted nothing as a total success and would never trip the breaker.
  it('does NOT map a bare HTTP 404 - that is a stale queryId, not a gone tweet', async () => {
    reply = { status: 404, body: {} };
    const out = await deleteTweet(transport, { id: '1', isRetweet: false });
    expect(out.status).toBe('failed');
    expect(out.error).toMatch(/queryId/i);
  });

  /**
   * ...but it does not claim to KNOW it is the queryId either. X answers 404
   * both for a rotated id and for a request it declines to route (one header
   * flips the same URL between 404 and 401), and the two need different fixes.
   */
  it('names both causes of a bare 404 and points at /api/diagnostics', async () => {
    reply = { status: 404, body: {} };
    const out = await deleteTweet(transport, { id: '1', isRetweet: false });

    expect(out.error).toMatch(/404 does not mean the operation was removed/i);
    expect(out.error).toMatch(/declined to route/i);
    expect(out.error).toMatch(/diagnostics/);
  });

  // Regression: "Operation not found" from a rotated queryId used to satisfy
  // the old broad /not found/ pattern and be swallowed as a success.
  it('does NOT treat an operation-level "not found" as a gone tweet', async () => {
    reply = {
      status: 200,
      body: { errors: [{ message: 'Operation not found: DeleteTweet' }] },
    };
    const out = await deleteTweet(transport, { id: '1', isRetweet: false });
    expect(out.status).toBe('failed');
  });

  it('does NOT treat a persisted-query miss as a gone tweet', async () => {
    reply = {
      status: 200,
      body: { errors: [{ message: 'PersistedQueryNotFound' }] },
    };
    const out = await deleteTweet(transport, { id: '1', isRetweet: false });
    expect(out.status).toBe('failed');
  });

  it('maps "No status found with that ID."', async () => {
    reply = {
      status: 200,
      body: { errors: [{ message: 'No status found with that ID.', code: 144 }] },
    };
    await expect(deleteTweet(transport, { id: '1', isRetweet: false })).resolves.toEqual({
      status: 'already_gone',
    });
  });

  it('maps error code 144 even when the message is unfamiliar', async () => {
    reply = { status: 200, body: { errors: [{ message: 'gibberish', code: 144 }] } };
    await expect(deleteTweet(transport, { id: '1', isRetweet: false })).resolves.toEqual({
      status: 'already_gone',
    });
  });

  it('maps a code nested under extensions', async () => {
    reply = { status: 200, body: { errors: [{ message: 'nope', extensions: { code: 144 } }] } };
    await expect(deleteTweet(transport, { id: '1', isRetweet: false })).resolves.toEqual({
      status: 'already_gone',
    });
  });

  it('maps a _Missing tombstone message', async () => {
    reply = { status: 200, body: { errors: [{ message: 'TweetResultByIdQuery_Missing' }] } };
    await expect(deleteTweet(transport, { id: '1', isRetweet: false })).resolves.toEqual({
      status: 'already_gone',
    });
  });
});

describe('failure mapping', () => {
  it('429 surfaces retryAfterSec from x-rate-limit-reset', async () => {
    const resetAt = Math.ceil(Date.now() / 1000) + 90;
    reply = { status: 429, body: {}, headers: { 'x-rate-limit-reset': String(resetAt) } };

    const outcome = await deleteTweet(transport, { id: '1', isRetweet: false });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/rate_limited/);
    expect(outcome.retryAfterSec).toBeGreaterThan(80);
    expect(outcome.retryAfterSec).toBeLessThanOrEqual(91);
  });

  it('429 falls back to retry-after, then to the configured default', async () => {
    reply = { status: 429, body: {}, headers: { 'retry-after': '30' } };
    await expect(deleteTweet(transport, { id: '1', isRetweet: false })).resolves.toMatchObject({
      retryAfterSec: 30,
    });

    reply = { status: 429, body: {} };
    const outcome = await deleteTweet(transport, { id: '1', isRetweet: false });
    expect(outcome.retryAfterSec).toBe(60);
  });

  it('401 and 403 report an expired session', async () => {
    for (const status of [401, 403]) {
      reply = { status, body: {} };
      const outcome = await deleteTweet(transport, { id: '1', isRetweet: false });
      expect(outcome.status).toBe('failed');
      expect(outcome.error).toMatch(/session expired|expired or was rejected/i);
      expect(outcome.retryAfterSec).toBeUndefined();
    }
  });

  it('reports a 200 with no result as failed, hinting at a stale queryId', async () => {
    reply = { status: 200, body: { data: {} } };
    const outcome = await deleteTweet(transport, { id: '1', isRetweet: false });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/queryId/);
  });

  it('surfaces an unrelated GraphQL error verbatim', async () => {
    reply = { status: 200, body: { errors: [{ message: 'Rate limit exceeded', code: 88 }] } };
    const outcome = await deleteTweet(transport, { id: '1', isRetweet: false });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('Rate limit exceeded');
    expect(outcome.error).toContain('88');
  });

  it('reports a 500 as failed', async () => {
    reply = { status: 500, body: {} };
    await expect(deleteTweet(transport, { id: '1', isRetweet: false })).resolves.toMatchObject({
      status: 'failed',
    });
  });
});

describe('credential safety', () => {
  it('never leaks cookie values into the outcome, whatever X answers', async () => {
    const replies: (typeof reply)[] = [
      { status: 401, body: {} },
      { status: 429, body: {} },
      { status: 500, body: { errors: [{ message: 'boom' }] } },
      { status: 200, body: { data: {} } },
    ];

    for (const r of replies) {
      reply = r;
      const outcome = await deleteTweet(transport, { id: '1', isRetweet: false });
      const text = JSON.stringify(outcome);
      expect(text).not.toContain('secret-auth-token');
      expect(text).not.toContain('secret-ct0');
    }
  });

  it('still deletes via the hardcoded default when nothing else resolves', async () => {
    resetQueryIdState();

    const outcome = await deleteTweet(transport, { id: '1', isRetweet: false });

    expect(outcome).toEqual({ status: 'deleted' });
    expect(captured[0]?.url).toBe(
      `https://x.com/i/api/graphql/${DEFAULT_QUERY_IDS['DeleteTweet'] as string}/DeleteTweet`,
    );
  });

  it('un-retweets via the hardcoded default too', async () => {
    resetQueryIdState();
    reply = { status: 200, body: { data: { delete_retweet: {} } } };

    const outcome = await deleteTweet(transport, { id: '9', isRetweet: true });

    expect(outcome).toEqual({ status: 'deleted' });
    expect(captured[0]?.url).toBe(
      `https://x.com/i/api/graphql/${DEFAULT_QUERY_IDS['DeleteRetweet'] as string}/DeleteRetweet`,
    );
  });
});

/**
 * A default queryId is a snapshot of what X served on one particular day, only
 * ever reached once everything authoritative has failed. Using one silently is
 * the trap the stale `DeleteTweet` default was: the request looks healthy and
 * comes back as an unexplained 404. So when a delete fails on an id that came out
 * of the snapshot, the outcome has to say so.
 */
describe('a stale default id is never used silently', () => {
  it('names the snapshot in the failure when the default id 404s', async () => {
    resetQueryIdState();
    reply = { status: 404, body: {} };

    const outcome = await deleteTweet(transport, { id: '1', isRetweet: false });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toMatch(/built-in snapshot/);
    expect(outcome.error).toContain('2026-08-12');
    expect(outcome.error).toMatch(/DevTools/);
  });

  it('says nothing about snapshots when the id was pinned by hand', async () => {
    reply = { status: 404, body: {} };

    const outcome = await deleteTweet(transport, { id: '1', isRetweet: false });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).not.toMatch(/built-in snapshot/);
  });
});
