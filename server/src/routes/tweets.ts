import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import type { FilterCriteria, Tweet } from '../../../shared/types.js';
import { loadArchive } from '../archive.js';
import { applyFilter } from '../filter.js';
import { setTweets } from '../store.js';
import { fetchUserLikes, fetchUserTweets } from '../x/fetchTweets.js';
import { getSession, getTransport } from '../x/session.js';
import { HttpError, parseBody } from './http.js';
import { openSse } from './sse.js';

export const tweetsRouter = Router();

/**
 * Tweet sources.
 *
 * Both routes end with `setTweets(...)`: the server has to hold the loaded set
 * in memory because `POST /api/run` receives only ids, and it must know each
 * tweet's text (to log it before deleting) and whether it is a retweet (to pick
 * `DeleteRetweet` over `DeleteTweet`).
 */

/**
 * `'tweets'` (default) preserves the frozen behaviour; `'likes'` reads the LIKES
 * side instead (live: the Likes timeline; archive: `data/like.js`), flagging every
 * row `isLike` so the run route un-favorites it. Omitting it is exactly the old
 * request.
 */
const sourceSchema = z.enum(['tweets', 'likes']).default('tweets');

const archiveSchema = z.object({
  path: z.string().min(1, 'an absolute path to the archive .zip or extracted folder is required'),
  source: sourceSchema,
  /**
   * Additive extension to the frozen contract: when present the RESPONSE is
   * filtered, but the store still holds every tweet that was read, so the user
   * can widen the filter client-side without re-reading a multi-GB archive.
   */
  filter: z
    .object({
      from: z.string().optional(),
      to: z.string().optional(),
      keyword: z.string().optional(),
      keywordMode: z.enum(['include', 'exclude']).default('include'),
      maxLikes: z.number().nullable().default(null),
      maxRetweets: z.number().nullable().default(null),
      includeOriginals: z.boolean().default(true),
      includeReplies: z.boolean().default(true),
      includeRetweets: z.boolean().default(true),
      includeMediaTweets: z.boolean().default(true),
    })
    .optional(),
});

const liveSchema = z.object({
  max: z.number().int().positive().max(1_000_000).optional(),
  source: sourceSchema,
});

/**
 * `applyFilter` THROWS on a malformed `from`/`to` - deliberately, because
 * silently ignoring a bad date bound would widen a delete set to every tweet.
 * That must reach the user as a 400 they can fix, never as a 500.
 */
function filterOrThrow(tweets: Tweet[], criteria: FilterCriteria): Tweet[] {
  try {
    return applyFilter(tweets, criteria);
  } catch (err: unknown) {
    throw new HttpError(400, err instanceof Error ? err.message : 'Invalid filter criteria.');
  }
}

tweetsRouter.post('/tweets/archive', async (req, res) => {
  const body = parseBody(archiveSchema, req);

  let result;
  try {
    result = await loadArchive(body.path, body.source);
  } catch (err: unknown) {
    // A wrong path / unreadable zip is user error, not a server fault.
    throw new HttpError(400, err instanceof Error ? err.message : 'Could not read that archive.');
  }

  setTweets(result.tweets);

  const tweets = body.filter ? filterOrThrow(result.tweets, body.filter as FilterCriteria) : result.tweets;
  res.json({ tweets, filesRead: result.filesRead, skipped: result.skipped, kind: result.kind });
});

/* ------------------------------------------------------------- live fetch */

interface LiveProgress {
  fetched: number;
  cursorPage: number;
  done: boolean;
  /**
   * Which timeline operation the tweets are coming from. X routes some subset of
   * its timeline operations per account (see `fetchTweets.ts`), so a run that
   * silently used a fallback source has to say which one.
   */
  operation?: string;
  error?: string;
}

interface LiveJob {
  jobId: string;
  progress: LiveProgress;
  tweets: Tweet[] | null;
  error: string | null;
  subscribers: Set<(p: LiveProgress) => void>;
  startedAt: number;
}

const jobs = new Map<string, LiveJob>();

/** Keep the handful a session could plausibly reconnect to; drop the rest. */
const MAX_JOBS = 10;

function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS) return;
  const oldest = [...jobs.values()].sort((a, b) => a.startedAt - b.startedAt);
  for (const job of oldest.slice(0, jobs.size - MAX_JOBS)) jobs.delete(job.jobId);
}

function publishJob(job: LiveJob, patch: Partial<LiveProgress>): void {
  job.progress = { ...job.progress, ...patch };
  for (const cb of job.subscribers) cb({ ...job.progress });
}

tweetsRouter.post('/tweets/live', async (req, res) => {
  const body = parseBody(liveSchema, req);

  // Fail fast here rather than inside the job: a 202 followed by an immediate
  // SSE error is a much worse experience than a 400 with the same message.
  const session = await getSession();
  if (!session.connected || !session.screenName) {
    throw new HttpError(
      400,
      'Not connected to X. Enter your auth_token and ct0 cookies before fetching live tweets.',
    );
  }

  const jobId = `job-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const job: LiveJob = {
    jobId,
    progress: { fetched: 0, cursorPage: 0, done: false },
    tweets: null,
    error: null,
    subscribers: new Set(),
    startedAt: Date.now(),
  };
  jobs.set(jobId, job);
  pruneJobs();

  const screenName = session.screenName;
  // Same job machinery for both; only which fetcher runs differs. Omitting
  // `source` defaults to 'tweets', so the existing contract is unchanged.
  const fetchFor = body.source === 'likes' ? fetchUserLikes : fetchUserTweets;
  void (async () => {
    try {
      const transport = getTransport();
      const tweets = await fetchFor({
        transport,
        screenName,
        ...(body.max !== undefined ? { max: body.max } : {}),
        onProgress: (p) => {
          // The terminal frame is published below, after the store is populated,
          // so a client that races to `/result` on `done` never sees a 409.
          if (!p.done) {
            publishJob(job, {
              fetched: p.fetched,
              cursorPage: p.cursorPage,
              ...(p.operation === undefined ? {} : { operation: p.operation }),
            });
          }
        },
      });
      job.tweets = tweets;
      setTweets(tweets);
      publishJob(job, { fetched: tweets.length, done: true });
    } catch (err: unknown) {
      job.error = err instanceof Error ? err.message : String(err);
      publishJob(job, { done: true, error: job.error });
    }
  })();

  res.status(202).json({ jobId });
});

tweetsRouter.get('/tweets/live/:jobId/events', (req, res) => {
  const job = jobs.get(String(req.params['jobId']));
  if (!job) throw new HttpError(404, 'Unknown live-fetch job. It may have expired; start a new one.');

  const channel = openSse(req, res);
  // Snapshot first: the client subscribes AFTER the POST returns, so a fast
  // fetch can be finished before anyone is listening.
  channel.send('progress', job.progress);
  if (job.progress.done) {
    channel.close();
    return;
  }

  const unsubscribe = ((): (() => void) => {
    const cb = (p: LiveProgress): void => {
      channel.send('progress', p);
      if (p.done) channel.close();
    };
    job.subscribers.add(cb);
    return () => job.subscribers.delete(cb);
  })();

  channel.onClose(unsubscribe);
});

tweetsRouter.get('/tweets/live/:jobId/result', (req, res) => {
  const job = jobs.get(String(req.params['jobId']));
  if (!job) throw new HttpError(404, 'Unknown live-fetch job. It may have expired; start a new one.');
  if (job.error !== null) throw new HttpError(502, job.error);
  if (job.tweets === null) {
    throw new HttpError(409, 'That live fetch is still running. Wait for the progress stream to finish.');
  }
  res.json({ tweets: job.tweets });
});

/** Test-only: drop every remembered live job. */
export function resetLiveJobs(): void {
  jobs.clear();
}
