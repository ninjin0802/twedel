import type { Request } from 'express';
import { Router } from 'express';
import { z } from 'zod';
import type { ProgressEvent } from '../../../shared/types.js';
import {
  MissingTweetsError,
  RunConflictError,
  UnknownCheckpointError,
  discardCheckpoint,
  getRun,
  listResumableRuns,
  resumeRun,
  startRun,
  stopRun,
  subscribe,
} from '../deleteRunner.js';
import { HttpError, formatIssues, parseBody } from './http.js';
import { openSse } from './sse.js';

export const runRouter = Router();

const runSchema = z.object({
  ids: z.array(z.string().min(1)).min(1, 'at least one tweet id is required'),
  options: z
    .object({
      minDelayMs: z.number().int().min(0).max(600_000).optional(),
      maxDelayMs: z.number().int().min(0).max(600_000).optional(),
    })
    .optional(),
});

/**
 * A runId reaches the filesystem (`data/checkpoint-<runId>.json`), so the
 * checkpoint routes validate its shape before it can become a path. Every id
 * this server mints matches; anything that does not is a 400, not a traversal.
 */
const runIdSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9._-]+$/, 'runId may only contain letters, digits, dot, dash and underscore')
  .refine((v) => !v.includes('..'), 'runId may not contain ".."');

function parseRunId(req: Request): string {
  const result = runIdSchema.safeParse(String(req.params['runId']));
  if (!result.success) throw new HttpError(400, `Invalid runId - ${formatIssues(result.error)}`);
  return result.data;
}

const TERMINAL_STATES = new Set(['done', 'stopped', 'error']);

/**
 * Start a run.
 *
 * 400 for unknown ids is a safety rule, not tidiness: an id the server cannot
 * resolve is an id whose text it cannot write to the log, and deleting it would
 * destroy the only remaining copy. It is also an id whose `isRetweet` we do not
 * know, so the delete could silently no-op against X.
 */
runRouter.post('/run', (req, res) => {
  const body = parseBody(runSchema, req);

  if (
    body.options?.minDelayMs !== undefined &&
    body.options.maxDelayMs !== undefined &&
    body.options.maxDelayMs < body.options.minDelayMs
  ) {
    throw new HttpError(400, 'Invalid request body - options.maxDelayMs must be >= options.minDelayMs');
  }

  let runId: string;
  try {
    runId = startRun(body.ids, body.options);
  } catch (err: unknown) {
    if (err instanceof MissingTweetsError) {
      throw new HttpError(400, err.message, { missing: err.missing.slice(0, 50) });
    }
    if (err instanceof RunConflictError) {
      throw new HttpError(409, err.message, { runId: err.runId });
    }
    throw err;
  }

  res.status(202).json({ runId });
});

/**
 * Interrupted runs that still have a checkpoint on disk.
 *
 * MUST stay above `/run/:runId`, which would otherwise swallow `resumable` as a
 * run id and answer 404.
 */
runRouter.get('/run/resumable', async (_req, res) => {
  res.json({ runs: await listResumableRuns() });
});

/**
 * Resume an interrupted run.
 *
 * Everything needed comes from the checkpoint, including each pending tweet's
 * text and `isRetweet`, so this works after a restart even though the tweet
 * store is empty. 404 means there is no usable checkpoint - either it was never
 * written, or it was in a shape this version refuses to guess at.
 */
runRouter.post('/run/:runId/resume', async (req, res) => {
  const runId = parseRunId(req);
  try {
    const resumed = await resumeRun(runId);
    res.status(202).json({ runId: resumed });
  } catch (err: unknown) {
    if (err instanceof UnknownCheckpointError) throw new HttpError(404, err.message);
    if (err instanceof RunConflictError) throw new HttpError(409, err.message, { runId: err.runId });
    throw err;
  }
});

/**
 * Discard a checkpoint. Idempotent, like `stop`.
 *
 * Only the checkpoint: the deletion log is the user's sole copy of what was
 * already deleted and is never touched here.
 */
runRouter.delete('/run/:runId/checkpoint', async (req, res) => {
  await discardCheckpoint(parseRunId(req));
  res.json({ ok: true });
});

runRouter.get('/run/:runId', (req, res) => {
  const snapshot = getRun(String(req.params['runId']));
  if (!snapshot) throw new HttpError(404, 'Unknown runId. The server may have restarted since.');
  res.json(snapshot);
});

runRouter.get('/run/:runId/events', (req, res) => {
  const runId = String(req.params['runId']);
  const snapshot = getRun(runId);
  if (!snapshot) throw new HttpError(404, 'Unknown runId. The server may have restarted since.');

  const channel = openSse(req, res);
  channel.send('progress', snapshot);

  // A client reconnecting after the run finished gets exactly one event and a
  // clean close - no dangling stream, no EventSource retry loop.
  if (TERMINAL_STATES.has(snapshot.state)) {
    channel.close();
    return;
  }

  const unsubscribe = subscribe(runId, (event: ProgressEvent) => {
    channel.send('progress', event);
    if (TERMINAL_STATES.has(event.state)) channel.close();
  });

  channel.onClose(unsubscribe);
});

runRouter.post('/run/:runId/stop', (req, res) => {
  const runId = String(req.params['runId']);
  if (!getRun(runId)) throw new HttpError(404, 'Unknown runId. The server may have restarted since.');
  // Already-settled runs answer ok too: "stop" is idempotent from the UI's side.
  stopRun(runId);
  res.json({ ok: true });
});
