import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { ProgressEvent, RunState, Tweet } from '../../shared/types.js';
import { config } from './config.js';
import { readLog } from './log.js';
import { getMany, mergeMissingTweets } from './store.js';
import type { MutateOutcome } from './x/mutate.js';
import { deleteTweet as realDeleteTweet } from './x/mutate.js';
import { dataDir } from './x/paths.js';
import { getTransport } from './x/session.js';

/**
 * The deletion runner.
 *
 * Everything this file does is irreversible on X's side, so the order of
 * operations matters more than the throughput:
 *
 *   resolve ids -> write EVERY target to the log as `pending` (with its text)
 *   -> only then issue the first delete.
 *
 * If the machine loses power halfway through a 20 000-tweet run, the user still
 * has the text of all 20 000. Reversing those two steps would mean the text of
 * anything deleted-but-not-yet-logged is gone forever, and no amount of
 * downstream care can recover it.
 *
 * Pacing, retries, rate-limit backoff and the circuit breaker all exist for the
 * second risk: an account that looks like a bot gets locked. Slower is fine;
 * locked is not.
 */

/** Injection seam. Production passes nothing; tests pass all of it. */
export interface RunnerDeps {
  /** Perform one deletion. Defaults to `x/mutate.deleteTweet` on the live transport. */
  deleteTweet?: (tweet: Tweet) => Promise<MutateOutcome>;
  /** Defaults to `setTimeout`. Tests pass a no-op so the suite runs instantly. */
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** `[0,1)`, used for delay jitter. */
  random?: () => number;
}

export interface RunOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
}

/** Pacing after config defaults have been applied. */
interface Pacing {
  minDelayMs: number;
  maxDelayMs: number;
}

/**
 * Shape version of `checkpoint-<runId>.json`.
 *
 * 1 (implicit, unversioned): `remaining` was a bare id list. Not resumable -
 *   `store.ts` is in-memory, so after a restart those ids resolve to nothing and
 *   we would know neither the text to log nor whether to unretweet.
 * 2: `remaining` carries a self-sufficient copy of every pending tweet.
 *
 * Anything that is not exactly the current version is quarantined rather than
 * guessed at: resuming on misread data deletes the wrong tweets, and there is no
 * undo for that.
 */
export const CHECKPOINT_VERSION = 2;

/**
 * The minimum a resume needs about one tweet.
 *
 * `text` because the pre-delete log line is the only copy the user keeps, and
 * `isRetweet` because a retweet needs `DeleteRetweet` - sending `DeleteTweet`
 * instead reports success while the retweet quietly survives.
 */
export interface CheckpointTweet {
  id: string;
  createdAt: string;
  text: string;
  isRetweet: boolean;
  /**
   * The ORIGINAL tweet's id for a retweet - what `DeleteRetweet` un-retweets by.
   * Carried through the checkpoint because without it a resumed retweet reverts
   * to sending its own action id, which un-retweets nothing. Optional: absent for
   * non-retweets and for retweets whose source id was never determined.
   */
  sourceTweetId?: string;
  /**
   * True when the item is a LIKE, so a resumed run un-favorites it via
   * `UnfavoriteTweet` instead of sending it down the delete path. Carried through
   * because, like `isRetweet`, getting the operation wrong on resume silently
   * no-ops against X. Optional: absent (and dropped by JSON) for ordinary tweets,
   * keeping the checkpoint byte-identical to the old shape for non-like runs.
   */
  isLike?: boolean;
}

/** Persisted after every item so an interrupted run can be resumed. */
export interface RunCheckpoint {
  version: number;
  runId: string;
  startedAt: string;
  state: RunState;
  total: number;
  done: number;
  ok: number;
  alreadyGone: number;
  failed: number;
  /** Tweets not yet attempted, in order, with everything a resume needs. */
  remaining: CheckpointTweet[];
  /** Effective pacing of the original run, so a resume keeps its rhythm. */
  options: Pacing;
  updatedAt: string;
}

/** One line of `GET /api/run/resumable`. */
export interface ResumableRun {
  runId: string;
  startedAt: string;
  remaining: number;
  total: number;
  ok: number;
  alreadyGone: number;
  failed: number;
}

export class MissingTweetsError extends Error {
  readonly missing: string[];
  constructor(missing: string[]) {
    const shown = missing.slice(0, 5).join(', ');
    super(
      `${missing.length} of the requested ids are not loaded on the server (${shown}` +
        `${missing.length > 5 ? ', …' : ''}). Load the tweets from an archive or a live fetch ` +
        'first: the server must know each tweet\'s text before it deletes it.',
    );
    this.name = 'MissingTweetsError';
    this.missing = missing;
  }
}

export class RunConflictError extends Error {
  readonly runId: string;
  constructor(runId: string) {
    super(`A deletion run (${runId}) is already in progress. Stop it before starting another.`);
    this.name = 'RunConflictError';
    this.runId = runId;
  }
}

/** No usable checkpoint: never existed, already finished, or quarantined. */
export class UnknownCheckpointError extends Error {
  readonly runId: string;
  constructor(runId: string, reason: 'missing' | 'unsupported' = 'missing') {
    super(
      reason === 'unsupported'
        ? `The checkpoint for ${runId} is not in a format this version understands. ` +
          'It has been set aside (.unsupported) rather than resumed on data that might be wrong.'
        : `No resumable checkpoint for ${runId}. It was either finished, discarded, or never written.`,
    );
    this.name = 'UnknownCheckpointError';
    this.runId = runId;
  }
}

type Subscriber = (e: ProgressEvent) => void;

interface RunRecord {
  event: ProgressEvent;
  subscribers: Set<Subscriber>;
  stopRequested: boolean;
  finished: Promise<void>;
}

/**
 * Never pruned: the UI reconnects to `GET /api/run/:runId` after a page reload,
 * possibly minutes after the run ended, and a 404 there looks like data loss.
 * One `ProgressEvent` per run is a rounding error in memory.
 */
const runs = new Map<string, RunRecord>();
let activeRunId: string | null = null;

/** Account/session changes must not redirect an in-flight destructive run. */
export function hasActiveRun(): boolean {
  if (activeRunId === null) return false;
  const active = runs.get(activeRunId);
  return active !== undefined && !isTerminal(active.event.state);
}

const TERMINAL: ReadonlySet<RunState> = new Set<RunState>(['done', 'stopped', 'error']);

/** Slice length for long waits, so a stop request is noticed within a second. */
const WAIT_SLICE_MS = 500;

/**
 * Consecutive 429s tolerated on a single tweet. Past this we stop believing the
 * rate-limit story and record a real failure, rather than looping forever.
 */
const MAX_RATE_LIMIT_WAITS = 5;

function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((r) => {
    setTimeout(r, ms);
  });
}

/**
 * A runId is interpolated into a filename, so it may not contain anything that
 * could walk out of `dataDir()`. Every id this process mints already matches.
 */
const SAFE_RUN_ID = /^[A-Za-z0-9._-]{1,200}$/;

export function isSafeRunId(runId: string): boolean {
  return SAFE_RUN_ID.test(runId) && !runId.includes('..');
}

export function checkpointFile(runId: string): string {
  return resolve(dataDir(), `checkpoint-${runId}.json`);
}

const CHECKPOINT_NAME = /^checkpoint-(.+)\.json$/;

function isCheckpointTweet(value: unknown): value is CheckpointTweet {
  if (value === null || typeof value !== 'object') return false;
  const t = value as Partial<CheckpointTweet>;
  return (
    typeof t.id === 'string' &&
    t.id !== '' &&
    typeof t.text === 'string' &&
    typeof t.createdAt === 'string' &&
    typeof t.isRetweet === 'boolean' &&
    // Optional, but if present it must be a string - a malformed source id would
    // send DeleteRetweet at the wrong target on resume.
    (t.sourceTweetId === undefined || typeof t.sourceTweetId === 'string') &&
    // Optional, but if present it must be a boolean - a resumed like has to route
    // to UnfavoriteTweet, and a garbage value must quarantine, not guess.
    (t.isLike === undefined || typeof t.isLike === 'boolean')
  );
}

function isPositiveish(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/**
 * Validate a parsed checkpoint STRUCTURALLY, not just by version number.
 *
 * A file claiming version 2 with a half-written `remaining` array is exactly as
 * dangerous as an unknown version: both would resume against data we cannot
 * trust. `null` here always means "quarantine, do not resume".
 */
function parseCheckpoint(raw: unknown): RunCheckpoint | null {
  if (raw === null || typeof raw !== 'object') return null;
  const c = raw as Partial<RunCheckpoint>;
  if (c.version !== CHECKPOINT_VERSION) return null;
  if (typeof c.runId !== 'string' || !isSafeRunId(c.runId)) return null;
  if (typeof c.startedAt !== 'string' || c.startedAt === '') return null;
  if (!Array.isArray(c.remaining) || !c.remaining.every(isCheckpointTweet)) return null;
  if (
    !isPositiveish(c.total) ||
    !isPositiveish(c.done) ||
    !isPositiveish(c.ok) ||
    !isPositiveish(c.alreadyGone) ||
    !isPositiveish(c.failed)
  ) {
    return null;
  }

  const options = c.options;
  const minDelayMs =
    options !== undefined && isPositiveish(options.minDelayMs) ? options.minDelayMs : config.minDelayMs;
  const maxDelayMs =
    options !== undefined && isPositiveish(options.maxDelayMs) ? options.maxDelayMs : config.maxDelayMs;

  return {
    version: CHECKPOINT_VERSION,
    runId: c.runId,
    startedAt: c.startedAt,
    state: typeof c.state === 'string' ? (c.state as RunState) : 'stopped',
    total: c.total,
    done: c.done,
    ok: c.ok,
    alreadyGone: c.alreadyGone,
    failed: c.failed,
    remaining: c.remaining,
    options: { minDelayMs, maxDelayMs: Math.max(minDelayMs, maxDelayMs) },
    updatedAt: typeof c.updatedAt === 'string' ? c.updatedAt : c.startedAt,
  };
}

/**
 * Move a checkpoint we refuse to read out of the way.
 *
 * Renamed rather than deleted: it is the only remaining record of what that run
 * still had left to do, and a human may want to look at it. Renaming also stops
 * `GET /api/run/resumable` from re-reporting the same broken file forever.
 */
async function quarantineCheckpoint(file: string): Promise<void> {
  try {
    await rm(`${file}.unsupported`, { force: true });
    await rename(file, `${file}.unsupported`);
  } catch {
    // Best effort. A checkpoint we cannot even move is still never resumed.
  }
}

type CheckpointRead =
  | { checkpoint: RunCheckpoint; reason?: undefined }
  | { checkpoint: null; reason: 'missing' | 'unsupported' };

/** Read + validate one checkpoint, quarantining anything unrecognisable. */
export async function loadCheckpoint(runId: string): Promise<CheckpointRead> {
  if (!isSafeRunId(runId)) return { checkpoint: null, reason: 'missing' };

  const file = checkpointFile(runId);
  let raw: string;
  try {
    raw = await readFile(file, 'utf8');
  } catch {
    return { checkpoint: null, reason: 'missing' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    await quarantineCheckpoint(file);
    return { checkpoint: null, reason: 'unsupported' };
  }

  const checkpoint = parseCheckpoint(parsed);
  if (!checkpoint || checkpoint.runId !== runId) {
    await quarantineCheckpoint(file);
    return { checkpoint: null, reason: 'unsupported' };
  }
  return { checkpoint };
}

/**
 * Every checkpoint on disk that is not already being worked on, newest first.
 *
 * A missing `data/` directory is the normal state of a fresh checkout, so it
 * answers `[]` rather than throwing.
 */
export async function listResumableRuns(): Promise<ResumableRun[]> {
  let names: string[];
  try {
    names = await readdir(dataDir());
  } catch {
    return [];
  }

  const out: ResumableRun[] = [];
  for (const name of names) {
    const match = CHECKPOINT_NAME.exec(name);
    if (!match) continue;
    const runId = match[1] as string;

    // A run this process is still executing owns its checkpoint; offering to
    // "resume" it would fight the loop that is currently writing it.
    const record = runs.get(runId);
    if (record && !isTerminal(record.event.state)) continue;

    const { checkpoint } = await loadCheckpoint(runId);
    if (!checkpoint) continue;

    out.push({
      runId: checkpoint.runId,
      startedAt: checkpoint.startedAt,
      remaining: checkpoint.remaining.length,
      total: checkpoint.total,
      ok: checkpoint.ok,
      alreadyGone: checkpoint.alreadyGone,
      failed: checkpoint.failed,
    });
  }

  out.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return out;
}

/**
 * Throw away a checkpoint.
 *
 * Idempotent, and deliberately never touches the deletion log: the log is the
 * user's only copy of what was deleted, and "I do not want to finish this run"
 * is not "erase the record of what it already did".
 */
export async function discardCheckpoint(runId: string): Promise<boolean> {
  if (!isSafeRunId(runId)) return false;
  const file = checkpointFile(runId);
  try {
    await rm(file, { force: true });
    await rm(`${file}.unsupported`, { force: true });
    return true;
  } catch {
    return false;
  }
}

function isTerminal(state: RunState): boolean {
  return TERMINAL.has(state);
}

/** Snapshot of a run, or `undefined` if this process never knew about it. */
export function getRun(runId: string): ProgressEvent | undefined {
  const record = runs.get(runId);
  return record ? { ...record.event } : undefined;
}

/**
 * Subscribe to progress. Returns an unsubscribe function.
 *
 * Does NOT replay the current state: the SSE route sends the snapshot from
 * `getRun` itself, so that a client which connects after the run finished still
 * gets exactly one terminal event.
 */
export function subscribe(runId: string, cb: Subscriber): () => void {
  const record = runs.get(runId);
  if (!record) return () => undefined;
  record.subscribers.add(cb);
  return () => {
    record.subscribers.delete(cb);
  };
}

/**
 * Ask a run to stop.
 *
 * Cooperative on purpose: the in-flight delete request is never abandoned. An
 * aborted request whose response we never read is the one case where X might
 * have deleted a tweet that our log still calls `pending`.
 *
 * @returns false when the run is unknown or has already settled.
 */
export function stopRun(runId: string): boolean {
  const record = runs.get(runId);
  if (!record || isTerminal(record.event.state)) return false;
  record.stopRequested = true;
  if (record.event.state !== 'stopping') {
    record.event = { ...record.event, state: 'stopping', message: 'Stopping after the current tweet…' };
    for (const cb of record.subscribers) cb({ ...record.event });
  }
  return true;
}

/** Stop everything still running. Used by the SIGINT handler. */
export function stopAllRuns(): string[] {
  const stopped: string[] = [];
  for (const [runId, record] of runs) {
    if (!isTerminal(record.event.state)) {
      stopRun(runId);
      stopped.push(runId);
    }
  }
  return stopped;
}

/** Resolves once the run has settled. Returns its terminal event. */
export async function waitForRun(runId: string): Promise<ProgressEvent | undefined> {
  const record = runs.get(runId);
  if (!record) return undefined;
  await record.finished;
  return { ...record.event };
}

/** Test-only: forget every run and clear the single-run lock. */
export function resetRuns(): void {
  runs.clear();
  activeRunId = null;
}

function resolvePacing(options: RunOptions | undefined): Pacing {
  const minDelayMs = Math.max(0, options?.minDelayMs ?? config.minDelayMs);
  const maxDelayMs = Math.max(minDelayMs, options?.maxDelayMs ?? config.maxDelayMs);
  return { minDelayMs, maxDelayMs };
}

/** Where a run picks up from. All zeroes for a fresh `startRun`. */
interface RunStart {
  /** Size of the ORIGINAL target set, so the progress bar keeps its scale. */
  total: number;
  done: number;
  ok: number;
  alreadyGone: number;
  failed: number;
  options: Pacing;
}

function attach(record: RunRecord, tweets: Tweet[], start: RunStart, deps: RunnerDeps): void {
  runs.set(record.event.runId, record);
  activeRunId = record.event.runId;

  record.finished = execute(record, tweets, start, deps).catch((err: unknown) => {
    // Last-resort net: a throw here would become an unhandled rejection and
    // leave the UI watching a run that never terminates.
    record.event = {
      ...record.event,
      state: 'error',
      message: err instanceof Error ? err.message : String(err),
    };
    for (const cb of record.subscribers) cb({ ...record.event });
  });
}

function assertNothingInFlight(): void {
  if (activeRunId !== null) {
    const active = runs.get(activeRunId);
    if (active && !isTerminal(active.event.state)) throw new RunConflictError(activeRunId);
  }
}

/**
 * Start a deletion run.
 *
 * Synchronous and returns immediately with the run id; progress arrives through
 * `getRun` / `subscribe`. Throws (rather than reporting an in-band failure) for
 * the two conditions the caller must fix before anything happens at all:
 * unknown ids and an already-running run.
 */
export function startRun(ids: string[], options?: RunOptions, deps?: RunnerDeps): string {
  // Duplicate ids would be deleted twice and inflate `total`; first wins.
  const uniqueIds = [...new Set(ids)];
  if (uniqueIds.length === 0) throw new Error('No tweet ids were supplied.');

  const { found, missing } = getMany(uniqueIds);
  if (missing.length > 0) throw new MissingTweetsError(missing);

  assertNothingInFlight();

  const runId = `run-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  const startedAt = new Date().toISOString();

  const record: RunRecord = {
    event: {
      runId,
      state: 'running',
      startedAt,
      total: found.length,
      done: 0,
      ok: 0,
      alreadyGone: 0,
      failed: 0,
      etaSec: null,
    },
    subscribers: new Set(),
    stopRequested: false,
    finished: Promise.resolve(),
  };

  attach(record, found, {
    total: found.length,
    done: 0,
    ok: 0,
    alreadyGone: 0,
    failed: 0,
    options: resolvePacing(options),
  }, deps ?? {});

  return runId;
}

/** A checkpoint record turned back into something the runner can work with. */
function toTweet(t: CheckpointTweet): Tweet {
  return {
    id: t.id,
    createdAt: t.createdAt,
    text: t.text,
    // Unknown after a restart, and irrelevant to deleting: the filters that use
    // these ran before the run was ever started.
    likeCount: null,
    retweetCount: null,
    isReply: false,
    isRetweet: t.isRetweet,
    // Load-bearing: a resumed retweet must keep the ORIGINAL id or DeleteRetweet
    // reverts to the wrong target. Omit the key entirely when absent.
    ...(t.sourceTweetId ? { sourceTweetId: t.sourceTweetId } : {}),
    // Equally load-bearing: a resumed like must keep routing to UnfavoriteTweet.
    ...(t.isLike ? { isLike: true } : {}),
    hasMedia: false,
    source: 'archive',
    countsReliable: false,
  };
}

/**
 * Resume an interrupted run from its checkpoint.
 *
 * The case this exists for is a process restart: `store.ts` is in-memory, so by
 * the time the user comes back the server knows nothing about the tweets that
 * were queued. Everything needed comes out of the checkpoint instead, and the
 * store is re-seeded from it so every downstream path (logging, retweet routing,
 * `GET /api/log`) behaves exactly as it did on the original run.
 *
 * Three things are load-bearing here:
 *  - the deletion LOG, not the checkpoint, decides what is already finished. The
 *    checkpoint is written after the log line, so the log is never behind it.
 *  - `pending` lines are only written for tweets that do not already have one,
 *    so resuming ten times does not write the log ten times.
 *  - `startedAt` and the counters carry over, so the UI sees one continuous run
 *    rather than a second one that starts at zero.
 */
export async function resumeRun(runId: string, deps?: RunnerDeps): Promise<string> {
  // Reject an in-flight run before touching its checkpoint: it may be in the
  // middle of an atomic replacement and is never a resumable candidate.
  assertNothingInFlight();
  const { checkpoint, reason } = await loadCheckpoint(runId);
  if (!checkpoint) throw new UnknownCheckpointError(runId, reason);

  const existing = runs.get(runId);
  if (existing && !isTerminal(existing.event.state)) throw new RunConflictError(runId);

  // What the log already knows about THIS run, collapsed to a latest status per
  // id (see `readLog`), which is precisely the question being asked here.
  // Read legacy logs created by older versions solely to avoid re-sending an
  // already-settled deletion after an upgrade. This version never appends to it.
  const { entries } = await readLog({ runId });
  const logged = new Map(entries.map((entry) => [entry.id, entry.status]));

  let { done, ok, alreadyGone } = checkpoint;
  const failed = checkpoint.failed;
  const pending: CheckpointTweet[] = [];
  for (const tweet of checkpoint.remaining) {
    const status = logged.get(tweet.id);
    if (status === 'deleted' || status === 'already_gone') {
      done += 1;
      if (status === 'deleted') ok += 1;
      else alreadyGone += 1;
    } else {
      pending.push(tweet);
    }
  }

  // Re-seed the store so `getMany` and the rest of the existing code paths work
  // unchanged. `mergeMissing` never overwrites a richer copy the user has just
  // loaded from an archive or a live fetch.
  mergeMissingTweets(pending.map(toTweet));
  const { found } = getMany(pending.map((t) => t.id));

  const record: RunRecord = {
    event: {
      runId,
      state: 'running',
      startedAt: checkpoint.startedAt,
      total: checkpoint.total,
      done,
      ok,
      alreadyGone,
      failed,
      etaSec: null,
    },
    subscribers: new Set(),
    stopRequested: false,
    finished: Promise.resolve(),
  };

  attach(record, found, {
    total: checkpoint.total,
    done,
    ok,
    alreadyGone,
    failed,
    options: checkpoint.options,
  }, deps ?? {});

  return runId;
}

async function execute(
  record: RunRecord,
  tweets: Tweet[],
  start: RunStart,
  deps: RunnerDeps,
): Promise<void> {
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const random = deps.random ?? Math.random;

  const runId = record.event.runId;
  const startedMs = now();

  const { minDelayMs, maxDelayMs } = start.options;
  const total = start.total;

  let ok = start.ok;
  let alreadyGone = start.alreadyGone;
  let failed = start.failed;
  let done = start.done;
  let consecutiveFailures = 0;
  /** True once the breaker has paused and is waiting to see the next outcome. */
  let breakerArmed = false;

  const publish = (patch: Partial<ProgressEvent>): void => {
    const remaining = total - done;
    const elapsedMs = now() - startedMs;
    // Throughput observed so far, not a guess: only meaningful once something
    // has actually completed, hence `null` before that. Measured over the items
    // THIS session deleted - after a resume, `done` includes work from before
    // the restart that `elapsedMs` knows nothing about.
    const doneHere = done - start.done;
    const etaSec =
      doneHere > 0 ? Math.max(0, Math.round(((elapsedMs / doneHere) * remaining) / 1000)) : null;
    record.event = {
      runId,
      state: record.event.state,
      startedAt: record.event.startedAt,
      total,
      done,
      ok,
      alreadyGone,
      failed,
      etaSec,
      currentId: undefined,
      currentText: undefined,
      waitingUntil: undefined,
      message: undefined,
      ...patch,
    };
    for (const cb of record.subscribers) cb({ ...record.event });
  };

  const writeCheckpoint = async (index: number, state: RunState): Promise<void> => {
    const checkpoint: RunCheckpoint = {
      version: CHECKPOINT_VERSION,
      runId,
      startedAt: record.event.startedAt ?? new Date().toISOString(),
      state,
      total,
      done,
      ok,
      alreadyGone,
      failed,
      // The full record, not just ids: `store.ts` is in-memory, so after a
      // restart an id on its own resolves to nothing and the resume would know
      // neither the text to log nor whether to unretweet.
      remaining: tweets.slice(index).map((t) => ({
        id: t.id,
        createdAt: t.createdAt,
        text: t.text,
        isRetweet: t.isRetweet,
        // Preserve the retweet's ORIGINAL id so a resume un-retweets the right
        // thing. `undefined` is dropped by JSON.stringify - non-retweets stay
        // byte-identical to the old checkpoint shape.
        ...(t.sourceTweetId ? { sourceTweetId: t.sourceTweetId } : {}),
        // Preserve like-ness so a resume un-favorites instead of trying to delete.
        ...(t.isLike ? { isLike: true } : {}),
      })),
      options: { minDelayMs, maxDelayMs },
      updatedAt: new Date().toISOString(),
    };
    try {
      await mkdir(dataDir(), { recursive: true });
      await writeFile(checkpointFile(runId), `${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
    } catch {
      // A checkpoint is a convenience; failing to write one must never abort a
      // run that is otherwise deleting successfully.
    }
  };

  /** Sleep in slices so a stop request is honoured during a long backoff. */
  const waitInterruptibly = async (ms: number): Promise<void> => {
    let remaining = ms;
    while (remaining > 0 && !record.stopRequested) {
      const slice = Math.min(remaining, WAIT_SLICE_MS);
      await sleep(slice);
      remaining -= slice;
    }
  };

  try {
    if (tweets.length === 0) {
      // A resume with nothing left to do: the log says every target already
      // settled. Do not bind a transport for zero deletions - a disconnected
      // session would turn "already finished" into an error.
      record.event.state = 'done';
      publish({});
      await rm(checkpointFile(runId), { force: true }).catch(() => undefined);
      return;
    }

    // Bind the transport before anything is logged: if we are not connected,
    // there is no point writing `pending` lines for deletes that cannot happen.
    const doDelete =
      deps.deleteTweet ??
      (((): ((t: Tweet) => Promise<MutateOutcome>) => {
        const transport = getTransport();
        return (t: Tweet) => realDeleteTweet(transport, t);
      })());

    // The checkpoint is temporary recovery state, not a deletion history. It
    // contains only work still pending, is replaced after every item, and is
    // removed after a clean completion.
    await writeCheckpoint(0, 'running');

    // ---- SAFETY STEP: every target is logged, with its text, before the first
    // delete request leaves this process. Do not move this below the loop.
    //
    // On a resume, a tweet whose `pending` line is already on disk is skipped:
    // the safety property is "its text is in the log before it is deleted", and
    // that is already true. Writing it again would just duplicate the log.
    publish({});

    for (let i = 0; i < tweets.length; i += 1) {
      const tweet = tweets[i] as Tweet;

      if (record.stopRequested) {
        record.event.state = 'stopping';
        await writeCheckpoint(i, 'stopping');
        break;
      }

      record.event.state = 'running';
      publish({ currentId: tweet.id, currentText: tweet.text });

      let attempt = 0;
      let rateLimitWaits = 0;
      let outcome: MutateOutcome | null = null;

      // Per-item attempt loop. Rate-limit backoff does NOT consume a retry:
      // being told "not right now" is not the same as failing.
      for (;;) {
        let result: MutateOutcome;
        try {
          result = await doDelete(tweet);
        } catch (err: unknown) {
          result = {
            status: 'failed',
            error: err instanceof Error ? err.message : String(err),
          };
        }

        if (result.status === 'failed' && result.retryAfterSec !== undefined) {
          rateLimitWaits += 1;
          if (rateLimitWaits > MAX_RATE_LIMIT_WAITS) {
            outcome = {
              status: 'failed',
              error: `X kept rate-limiting this deletion (${rateLimitWaits} times). ${result.error ?? ''}`.trim(),
            };
            break;
          }
          const waitSec = result.retryAfterSec > 0 ? result.retryAfterSec : config.rateLimitFallbackSec;
          const waitMs = waitSec * 1000;
          record.event.state = 'waiting';
          publish({
            currentId: tweet.id,
            currentText: tweet.text,
            waitingUntil: new Date(now() + waitMs).toISOString(),
            message: `X rate-limited us. Waiting ${waitSec}s for the window to reset.`,
          });
          await waitInterruptibly(waitMs);
          if (record.stopRequested) break;
          record.event.state = 'running';
          publish({ currentId: tweet.id, currentText: tweet.text });
          continue;
        }

        if (result.status !== 'failed') {
          outcome = result;
          break;
        }

        // A real failure. Walk the retry ladder before giving up on this tweet.
        if (attempt < config.maxRetries && attempt < config.retryDelaysMs.length) {
          const delay = config.retryDelaysMs[attempt] ?? 0;
          attempt += 1;
          record.event.state = 'running';
          publish({
            currentId: tweet.id,
            currentText: tweet.text,
            message: `Retry ${attempt}/${config.maxRetries} in ${Math.round(delay / 1000)}s: ${result.error ?? 'unknown error'}`,
          });
          await waitInterruptibly(delay);
          if (record.stopRequested) break;
          continue;
        }

        outcome = result;
        break;
      }

      if (outcome === null) {
        // Stopped during a backoff, before this tweet was ever settled. It keeps
        // its `pending` log line, which is the honest record: we do not know
        // whether it still exists, and it stays in `remaining`.
        record.event.state = 'stopping';
        await writeCheckpoint(i, 'stopping');
        break;
      }

      if (outcome.status === 'deleted') {
        ok += 1;
        consecutiveFailures = 0;
        breakerArmed = false;
      } else if (outcome.status === 'already_gone') {
        // Already deleted (usually by an earlier run). A success for the user,
        // counted separately so the summary is not misleading - and never
        // retried, because retrying cannot change it.
        alreadyGone += 1;
        consecutiveFailures = 0;
        breakerArmed = false;
      } else {
        failed += 1;
        consecutiveFailures += 1;
      }

      done += 1;

      await writeCheckpoint(i + 1, record.event.state);

      publish({ currentId: tweet.id, currentText: tweet.text });

      if (outcome.status === 'failed') {
        if (breakerArmed) {
          // We already paused two minutes and the very next tweet failed too.
          // Something is systematically wrong (expired cookies, rotated queryId,
          // account locked). Grinding through the rest would just deepen it.
          record.event.state = 'error';
          publish({
            message:
              `Aborted: deletions kept failing after a ${Math.round(config.consecutiveFailurePauseMs / 60000)}-minute pause. ` +
              `Last error: ${outcome.error ?? 'unknown'}`,
          });
          await writeCheckpoint(i + 1, 'error');
          return;
        }
        if (consecutiveFailures >= config.consecutiveFailureLimit) {
          const pauseMs = config.consecutiveFailurePauseMs;
          record.event.state = 'waiting';
          breakerArmed = true;
          publish({
            waitingUntil: new Date(now() + pauseMs).toISOString(),
            message:
              `${consecutiveFailures} deletions failed in a row. Pausing ${Math.round(pauseMs / 1000)}s ` +
              'in case X is throttling this account. The run aborts if the next one fails too.',
          });
          await waitInterruptibly(pauseMs);
          if (!record.stopRequested) {
            record.event.state = 'running';
            publish({});
          }
        }
      }

      if (record.stopRequested) {
        record.event.state = 'stopping';
        await writeCheckpoint(i + 1, 'stopping');
        break;
      }

      // Human-ish jitter between deletions. A metronome is a bot signature.
      if (i < tweets.length - 1) {
        const jitter = minDelayMs + Math.floor(random() * (maxDelayMs - minDelayMs + 1));
        await sleep(jitter);
      }
    }

    if (record.stopRequested) {
      record.event.state = 'stopped';
      publish({ message: `Stopped after ${done} of ${total}.` });
      return;
    }

    record.event.state = 'done';
    publish({});
    // Clean completion: nothing left to resume, so the checkpoint would only be
    // a stale file that a future "resume?" prompt would trip over.
    await rm(checkpointFile(runId), { force: true }).catch(() => undefined);
  } finally {
    if (activeRunId === runId) activeRunId = null;
  }
}
