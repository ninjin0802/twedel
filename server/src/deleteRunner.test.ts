import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ProgressEvent, Tweet } from '../../shared/types.js';
import type { RunCheckpoint, RunnerDeps } from './deleteRunner.js';
import {
  CHECKPOINT_VERSION,
  MissingTweetsError,
  RunConflictError,
  UnknownCheckpointError,
  checkpointFile,
  discardCheckpoint,
  getRun,
  listResumableRuns,
  resetRuns,
  resumeRun,
  startRun,
  stopRun,
  subscribe,
  waitForRun,
} from './deleteRunner.js';
import { logFile, readLog } from './log.js';
import type { MutateOutcome } from './x/mutate.js';
import { allTweets, clearTweets, setTweets } from './store.js';

/**
 * Every test here injects both `deleteTweet` and `sleep`. Nothing touches the
 * network and nothing waits on a real timer, which is what lets the retry ladder
 * (5s/10s/15s) and the two-minute circuit-breaker pause be tested at all.
 */

let dir: string;
let previousDataDir: string | undefined;

function tweet(id: string, overrides: Partial<Tweet> = {}): Tweet {
  return {
    id,
    createdAt: '2020-01-01T00:00:00.000Z',
    text: `tweet ${id}`,
    likeCount: 0,
    retweetCount: 0,
    isReply: false,
    isRetweet: false,
    hasMedia: false,
    source: 'archive',
    countsReliable: false,
    ...overrides,
  };
}

function load(count: number): Tweet[] {
  const tweets = Array.from({ length: count }, (_, i) => tweet(String(i + 1)));
  setTweets(tweets);
  return tweets;
}

/** Records every sleep instead of performing one. */
function fakeSleep(): { fn: (ms: number) => Promise<void>; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    fn: (ms: number) => {
      calls.push(ms);
      return Promise.resolve();
    },
  };
}

function deps(
  deleteTweet: (t: Tweet) => Promise<MutateOutcome>,
  extra: Partial<RunnerDeps> = {},
): RunnerDeps {
  return { deleteTweet, sleep: fakeSleep().fn, random: () => 0.5, ...extra };
}

/** Collect every event a run publishes. */
function record(runId: string): ProgressEvent[] {
  const events: ProgressEvent[] = [];
  subscribe(runId, (e) => events.push(e));
  return events;
}

function readCheckpoint(runId: string): RunCheckpoint {
  return JSON.parse(readFileSync(checkpointFile(runId), 'utf8')) as RunCheckpoint;
}

function remainingIds(checkpoint: RunCheckpoint): string[] {
  return checkpoint.remaining.map((t) => t.id);
}

function writeCheckpoint(runId: string, checkpoint: unknown): void {
  writeFileSync(checkpointFile(runId), JSON.stringify(checkpoint, null, 2), 'utf8');
}

beforeAll(async () => {
  previousDataDir = process.env['TWEDEL_DATA_DIR'];
  dir = await mkdtemp(join(tmpdir(), 'twedel-runner-'));
  process.env['TWEDEL_DATA_DIR'] = dir;
});

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env['TWEDEL_DATA_DIR'];
  else process.env['TWEDEL_DATA_DIR'] = previousDataDir;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  resetRuns();
  clearTweets();
  await rm(logFile(), { force: true });
  // Checkpoints deliberately outlive their run, so a leftover from the previous
  // test would show up in `listResumableRuns()` in the next one.
  for (const name of await readdir(dir)) {
    if (name.startsWith('checkpoint-')) await rm(join(dir, name), { force: true });
  }
});

afterEach(() => {
  resetRuns();
});

describe('safety: log before deleting', () => {
  /**
   * THE load-bearing test of this whole loop.
   *
   * Deletion is irreversible and the log holds the only surviving copy of a
   * tweet's text. If a delete request can be issued before its `pending` line is
   * on disk, then a crash in that window destroys text that no longer exists
   * anywhere. The assertion is deliberately made from INSIDE the first delete
   * call, reading the real file synchronously, so nothing about ordering is
   * taken on trust.
   */
  it('writes every targeted tweet to the log as pending BEFORE the first delete request', async () => {
    const tweets = load(5);
    let logAtFirstDelete: string[] | null = null;
    let deleteCalls = 0;

    const runId = startRun(
      tweets.map((t) => t.id),
      undefined,
      deps(async () => {
        deleteCalls += 1;
        if (deleteCalls === 1) {
          logAtFirstDelete = readFileSync(logFile(), 'utf8')
            .trim()
            .split('\n')
            .map((line) => JSON.parse(line) as { id: string; status: string; text: string })
            .filter((e) => e.status === 'pending')
            .map((e) => `${e.id}:${e.text}`);
        }
        return { status: 'deleted' } as MutateOutcome;
      }),
    );

    await waitForRun(runId);

    expect(deleteCalls).toBe(5);
    expect(logAtFirstDelete).toEqual([
      '1:tweet 1',
      '2:tweet 2',
      '3:tweet 3',
      '4:tweet 4',
      '5:tweet 5',
    ]);
  });

  it('writes no pending lines at all when the run cannot start (no transport)', async () => {
    load(3);
    // No injected deleteTweet -> the real one -> getTransport() throws because
    // no session exists in this process.
    const runId = startRun(['1', '2', '3'], undefined, { sleep: fakeSleep().fn });
    const final = await waitForRun(runId);

    expect(final?.state).toBe('error');
    expect(final?.message).toMatch(/Not connected to X/);
    expect(existsSync(logFile())).toBe(false);
  });

  it('refuses ids that are not loaded on the server', () => {
    load(2);
    expect(() => startRun(['1', '999'])).toThrow(MissingTweetsError);
    try {
      startRun(['1', '999']);
    } catch (err) {
      expect((err as MissingTweetsError).missing).toEqual(['999']);
    }
    expect(existsSync(logFile())).toBe(false);
  });

  it('refuses a second run while one is in flight', async () => {
    load(2);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const runId = startRun(
      ['1', '2'],
      undefined,
      deps(async () => {
        await gate;
        return { status: 'deleted' };
      }),
    );

    // The runner has to reach its first delete before we can assert "in flight".
    await new Promise((r) => setImmediate(r));
    expect(() => startRun(['1'])).toThrow(RunConflictError);

    release();
    await waitForRun(runId);
  });
});

describe('happy path', () => {
  it('counts, paces and finishes', async () => {
    const tweets = load(3);
    const sleep = fakeSleep();
    const seen: string[] = [];

    const runId = startRun(
      tweets.map((t) => t.id),
      { minDelayMs: 100, maxDelayMs: 200 },
      deps(async (t) => {
        seen.push(t.id);
        return { status: 'deleted' };
      }, { sleep: sleep.fn }),
    );
    const events = record(runId);
    const final = await waitForRun(runId);

    expect(seen).toEqual(['1', '2', '3']);
    expect(final).toMatchObject({
      runId,
      state: 'done',
      total: 3,
      done: 3,
      ok: 3,
      alreadyGone: 0,
      failed: 0,
    });
    expect(typeof final?.startedAt).toBe('string');
    expect(typeof final?.etaSec).toBe('number');
    expect(getRun(runId)?.state).toBe('done');

    // One jittered gap between items, none after the last one.
    expect(sleep.calls).toEqual([150, 150]);
    expect(events.length).toBeGreaterThan(0);
    expect(events.at(-1)?.state).toBe('done');
  });

  it('reports currentId/currentText and a null eta until the first item completes', async () => {
    load(2);
    const runId = startRun(['1', '2'], undefined, deps(async () => ({ status: 'deleted' })));
    const events = record(runId);
    await waitForRun(runId);

    // The first event is published once every target is on disk as `pending`,
    // before any tweet is in flight: nothing done, no eta to compute yet.
    expect(events[0]).toMatchObject({ done: 0, etaSec: null });
    expect(events[0]?.currentId).toBeUndefined();
    expect(events[1]?.currentId).toBe('1');
    expect(events.some((e) => e.currentText === 'tweet 2')).toBe(true);
    expect(events.at(-1)?.etaSec).toBe(0);
  });

  it('records the outcome of every item in the log', async () => {
    load(2);
    const runId = startRun(
      ['1', '2'],
      undefined,
      deps(async (t) => (t.id === '1' ? { status: 'deleted' } : { status: 'already_gone' })),
    );
    await waitForRun(runId);

    const { entries } = await readLog();
    expect(entries.map((e) => `${e.id}:${e.status}`).sort()).toEqual(['1:deleted', '2:already_gone']);
  });

  it('deduplicates ids so a tweet listed twice is deleted once', async () => {
    load(2);
    let calls = 0;
    const runId = startRun(
      ['1', '1', '2'],
      undefined,
      deps(async () => {
        calls += 1;
        return { status: 'deleted' };
      }),
    );
    const final = await waitForRun(runId);

    expect(calls).toBe(2);
    expect(final?.total).toBe(2);
  });

  it('passes isRetweet through so the caller can pick unretweet over delete', async () => {
    setTweets([tweet('1', { isRetweet: true }), tweet('2')]);
    const flags: boolean[] = [];
    const runId = startRun(
      ['1', '2'],
      undefined,
      deps(async (t) => {
        flags.push(t.isRetweet);
        return { status: 'deleted' };
      }),
    );
    await waitForRun(runId);

    expect(flags).toEqual([true, false]);
    const { entries } = await readLog();
    expect(entries.find((e) => e.id === '1')?.isRetweet).toBe(true);
  });
});

describe('already_gone', () => {
  it('counts as a success in alreadyGone and is never retried', async () => {
    load(2);
    const calls: string[] = [];
    const runId = startRun(
      ['1', '2'],
      undefined,
      deps(async (t) => {
        calls.push(t.id);
        return t.id === '1' ? { status: 'already_gone' } : { status: 'deleted' };
      }),
    );
    const final = await waitForRun(runId);

    expect(calls).toEqual(['1', '2']);
    expect(final).toMatchObject({ state: 'done', done: 2, ok: 1, alreadyGone: 1, failed: 0 });
  });

  it('resets the consecutive-failure counter like any other success', async () => {
    load(11);
    const outcomes: Record<string, MutateOutcome['status']> = {
      '1': 'failed', '2': 'failed', '3': 'failed', '4': 'failed',
      '5': 'already_gone',
      '6': 'failed', '7': 'failed', '8': 'failed', '9': 'failed',
      '10': 'deleted', '11': 'deleted',
    };
    const runId = startRun(
      Object.keys(outcomes),
      undefined,
      deps(async (t) => ({ status: outcomes[t.id] ?? 'deleted', error: 'nope' })),
    );
    const events = record(runId);
    const final = await waitForRun(runId);

    expect(final?.state).toBe('done');
    expect(final?.failed).toBe(8);
    // Never reached five in a row, so the breaker never armed.
    expect(events.some((e) => e.state === 'waiting')).toBe(false);
  });
});

describe('retry ladder', () => {
  it('retries a failure and counts one ok when it eventually succeeds', async () => {
    load(1);
    const sleep = fakeSleep();
    let calls = 0;

    const runId = startRun(
      ['1'],
      undefined,
      deps(async () => {
        calls += 1;
        return calls <= 2 ? { status: 'failed', error: 'transient' } : { status: 'deleted' };
      }, { sleep: sleep.fn }),
    );
    const final = await waitForRun(runId);

    expect(calls).toBe(3);
    expect(final).toMatchObject({ state: 'done', done: 1, ok: 1, failed: 0 });
    // Two rungs of the ladder (5s + 10s) and no pacing sleep - single item.
    // Long waits are slept in <=500ms slices so a stop request is honoured.
    expect(sleep.calls.reduce((a, b) => a + b, 0)).toBe(15_000);
    expect(sleep.calls.every((ms) => ms <= 500)).toBe(true);
  });

  it('gives up after maxRetries and records the failure with its error', async () => {
    load(1);
    const sleep = fakeSleep();
    let calls = 0;

    const runId = startRun(
      ['1'],
      undefined,
      deps(async () => {
        calls += 1;
        return { status: 'failed', error: 'permanently broken' };
      }, { sleep: sleep.fn }),
    );
    const final = await waitForRun(runId);

    // Initial attempt + three retries, i.e. the whole 5s/10s/15s ladder.
    expect(calls).toBe(4);
    expect(sleep.calls.reduce((a, b) => a + b, 0)).toBe(30_000);
    expect(final).toMatchObject({ state: 'done', done: 1, ok: 0, failed: 1 });

    const { entries } = await readLog();
    expect(entries[0]).toMatchObject({ id: '1', status: 'failed', error: 'permanently broken' });
  });

  it('treats a thrown error from the delete call as a failure, not a crash', async () => {
    load(1);
    const runId = startRun(
      ['1'],
      undefined,
      deps(async () => {
        throw new Error('socket hang up');
      }),
    );
    const final = await waitForRun(runId);

    expect(final).toMatchObject({ state: 'done', failed: 1 });
    const { entries } = await readLog();
    expect(entries[0]?.error).toContain('socket hang up');
  });
});

describe('rate limits are authoritative', () => {
  it('waits for retryAfterSec, resumes, and does not count it as a failure', async () => {
    load(1);
    const sleep = fakeSleep();
    let calls = 0;

    const runId = startRun(
      ['1'],
      undefined,
      deps(async () => {
        calls += 1;
        return calls === 1
          ? { status: 'failed', error: 'rate_limited', retryAfterSec: 30 }
          : { status: 'deleted' };
      }, { sleep: sleep.fn }),
    );
    const events = record(runId);
    const final = await waitForRun(runId);

    const waiting = events.find((e) => e.state === 'waiting');
    expect(waiting).toBeDefined();
    expect(typeof waiting?.waitingUntil).toBe('string');
    expect(Date.parse(waiting?.waitingUntil ?? '')).toBeGreaterThan(Date.now() - 1000);
    expect(waiting?.message).toMatch(/rate-limited/i);

    // 30s slept in interruptible slices, and nothing off the retry ladder.
    expect(sleep.calls.reduce((a, b) => a + b, 0)).toBe(30_000);
    expect(sleep.calls.every((ms) => ms <= 500)).toBe(true);

    expect(calls).toBe(2);
    expect(final).toMatchObject({ state: 'done', ok: 1, failed: 0 });
    expect(final?.waitingUntil).toBeUndefined();
  });

  it('falls back to the configured wait when X gives no usable reset', async () => {
    load(1);
    const sleep = fakeSleep();
    let calls = 0;
    const runId = startRun(
      ['1'],
      undefined,
      deps(async () => {
        calls += 1;
        return calls === 1
          ? { status: 'failed', error: 'rate_limited', retryAfterSec: 0 }
          : { status: 'deleted' };
      }, { sleep: sleep.fn }),
    );
    await waitForRun(runId);

    expect(sleep.calls.reduce((a, b) => a + b, 0)).toBe(60_000);
  });

  it('stops believing the rate-limit story after too many in a row', async () => {
    load(1);
    let calls = 0;
    const runId = startRun(
      ['1'],
      undefined,
      deps(async () => {
        calls += 1;
        return { status: 'failed', error: 'rate_limited', retryAfterSec: 1 };
      }),
    );
    const final = await waitForRun(runId);

    expect(calls).toBe(6);
    expect(final).toMatchObject({ state: 'done', failed: 1 });
  });
});

describe('circuit breaker', () => {
  it('pauses after five consecutive failures and aborts if the next one fails too', async () => {
    load(7);
    const sleep = fakeSleep();
    const runId = startRun(
      ['1', '2', '3', '4', '5', '6', '7'],
      undefined,
      deps(async () => ({ status: 'failed', error: 'nope' }), { sleep: sleep.fn }),
    );
    const events = record(runId);
    const final = await waitForRun(runId);

    const paused = events.find((e) => e.state === 'waiting');
    expect(paused).toBeDefined();
    expect(paused?.message).toMatch(/failed in a row/);
    expect(paused?.done).toBe(5);
    expect(typeof paused?.waitingUntil).toBe('string');

    // Six items each walking the full 30s retry ladder, one 2-minute breaker
    // pause, and five jittered gaps between items - and nothing else.
    expect(sleep.calls.reduce((a, b) => a + b, 0)).toBe(6 * 30_000 + 120_000 + 5 * 1150);

    expect(final?.state).toBe('error');
    expect(final?.done).toBe(6);
    expect(final?.failed).toBe(6);
    expect(final?.message).toMatch(/Aborted/);
    // Item 7 was never attempted.
    const { entries } = await readLog();
    expect(entries.find((e) => e.id === '7')?.status).toBe('pending');
  });

  it('a success resets the counter, so the breaker never trips', async () => {
    load(10);
    const outcomes: Record<string, MutateOutcome['status']> = {
      '1': 'failed', '2': 'failed', '3': 'failed', '4': 'failed',
      '5': 'deleted',
      '6': 'failed', '7': 'failed', '8': 'failed', '9': 'failed', '10': 'deleted',
    };
    const runId = startRun(
      Object.keys(outcomes),
      undefined,
      deps(async (t) => ({ status: outcomes[t.id] ?? 'deleted', error: 'nope' })),
    );
    const events = record(runId);
    const final = await waitForRun(runId);

    expect(events.some((e) => e.state === 'waiting')).toBe(false);
    expect(final).toMatchObject({ state: 'done', done: 10, ok: 2, failed: 8 });
  });

  it('keeps its checkpoint when it aborts, so the run can be resumed', async () => {
    load(6);
    const runId = startRun(
      ['1', '2', '3', '4', '5', '6'],
      undefined,
      deps(async () => ({ status: 'failed', error: 'nope' })),
    );
    await waitForRun(runId);

    const checkpoint = readCheckpoint(runId);
    expect(checkpoint.state).toBe('error');
    expect(checkpoint.remaining).toEqual([]);
    expect(checkpoint.failed).toBe(6);
  });
});

describe('stopping', () => {
  it('finishes the in-flight item, settles to stopped, and checkpoints the rest', async () => {
    load(5);
    const calls: string[] = [];
    let runId = '';

    runId = startRun(
      ['1', '2', '3', '4', '5'],
      undefined,
      deps(async (t) => {
        calls.push(t.id);
        // Stop is requested WHILE item 2's request is in flight.
        if (t.id === '2') stopRun(runId);
        return { status: 'deleted' };
      }),
    );
    const events = record(runId);
    const final = await waitForRun(runId);

    // Item 2 completed; item 3 was never started.
    expect(calls).toEqual(['1', '2']);
    expect(final).toMatchObject({ state: 'stopped', done: 2, ok: 2 });
    expect(events.some((e) => e.state === 'stopping')).toBe(true);

    const checkpoint = readCheckpoint(runId);
    expect(remainingIds(checkpoint)).toEqual(['3', '4', '5']);
    expect(checkpoint.done).toBe(2);

    // The in-flight item is logged as deleted, not left pending.
    const { entries } = await readLog();
    expect(entries.find((e) => e.id === '2')?.status).toBe('deleted');
    expect(entries.find((e) => e.id === '3')?.status).toBe('pending');
  });

  it('interrupts a long rate-limit wait instead of finishing it', async () => {
    load(3);
    const slept: number[] = [];
    let runId = '';

    // Stop arrives ten slices into a 15-minute backoff.
    const sleep = (ms: number): Promise<void> => {
      slept.push(ms);
      if (slept.length === 10) stopRun(runId);
      return Promise.resolve();
    };

    runId = startRun(
      ['1', '2', '3'],
      undefined,
      deps(async () => ({ status: 'failed', error: 'rate_limited', retryAfterSec: 900 }), {
        sleep,
      }),
    );
    const final = await waitForRun(runId);

    // Ten 500ms slices, not the full 900 seconds.
    expect(slept.reduce((a, b) => a + b, 0)).toBe(5_000);
    expect(final?.state).toBe('stopped');
    expect(final?.done).toBe(0);
  });

  it('returns false for an unknown or already-finished run', async () => {
    load(1);
    expect(stopRun('nope')).toBe(false);
    const runId = startRun(['1'], undefined, deps(async () => ({ status: 'deleted' })));
    await waitForRun(runId);
    expect(stopRun(runId)).toBe(false);
  });
});

describe('checkpoints', () => {
  it('writes one after every item and removes it on clean completion', async () => {
    load(3);
    const remainingSeen: string[][] = [];

    const runId = startRun(
      ['1', '2', '3'],
      undefined,
      deps(async (t) => {
        if (existsSync(checkpointFile(runId))) {
          remainingSeen.push(remainingIds(readCheckpoint(runId)));
        } else {
          remainingSeen.push([`(none before ${t.id})`]);
        }
        return { status: 'deleted' };
      }),
    );
    const final = await waitForRun(runId);

    expect(remainingSeen).toEqual([['(none before 1)'], ['2', '3'], ['3']]);
    expect(final?.state).toBe('done');
    expect(existsSync(checkpointFile(runId))).toBe(false);
  });

  it('carries the counters so a resume knows what already happened', async () => {
    load(4);
    let runId = '';
    runId = startRun(
      ['1', '2', '3', '4'],
      undefined,
      deps(async (t) => {
        if (t.id === '3') stopRun(runId);
        return t.id === '2' ? { status: 'already_gone' } : { status: 'deleted' };
      }),
    );
    await waitForRun(runId);

    const checkpoint = readCheckpoint(runId);
    expect(checkpoint).toMatchObject({
      runId,
      total: 4,
      done: 3,
      ok: 2,
      alreadyGone: 1,
      failed: 0,
    });
    expect(remainingIds(checkpoint)).toEqual(['4']);
    expect(typeof checkpoint.startedAt).toBe('string');
  });
});

describe('resuming', () => {
  /**
   * These tests exist because of one fact about this codebase: `store.ts` is
   * in-memory. After a restart the server knows nothing about any tweet, so a
   * checkpoint holding only ids is not resumable at all - the runner would know
   * neither the text it must log before deleting nor whether a given target is a
   * retweet (which needs `DeleteRetweet`, not `DeleteTweet`). Nearly every test
   * below therefore calls `clearTweets()` before resuming: an empty store IS the
   * real-world case.
   */

  const CREATED = '2020-01-01T00:00:00.000Z';

  /** Run `tweets` to completion but request a stop while `stopAt` is in flight. */
  async function interrupted(
    tweets: Tweet[],
    stopAt: string,
    outcome: (t: Tweet) => MutateOutcome = () => ({ status: 'deleted' }),
  ): Promise<string> {
    setTweets(tweets);
    let runId = '';
    runId = startRun(
      tweets.map((t) => t.id),
      undefined,
      deps(async (t) => {
        if (t.id === stopAt) stopRun(runId);
        return outcome(t);
      }),
    );
    await waitForRun(runId);
    return runId;
  }

  /** The process is gone: no runs, nothing loaded. */
  function restart(): void {
    resetRuns();
    clearTweets();
  }

  /** Every raw line of the log, uncollapsed - which is the point here. */
  function logLines(): { runId: string; id: string; status: string; text: string }[] {
    if (!existsSync(logFile())) return [];
    return readFileSync(logFile(), 'utf8')
      .trim()
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { runId: string; id: string; status: string; text: string });
  }

  it('leaves a checkpoint carrying the text and isRetweet of every remaining tweet', async () => {
    const runId = await interrupted(
      [tweet('1'), tweet('2'), tweet('3', { isRetweet: true, text: 'RT @someone' }), tweet('4')],
      '2',
    );

    const checkpoint = readCheckpoint(runId);
    expect(checkpoint.version).toBe(CHECKPOINT_VERSION);
    // Not ids: everything a resume needs to delete these safely without a store.
    expect(checkpoint.remaining).toEqual([
      { id: '3', createdAt: CREATED, text: 'RT @someone', isRetweet: true },
      { id: '4', createdAt: CREATED, text: 'tweet 4', isRetweet: false },
    ]);
    expect(checkpoint.options.maxDelayMs).toBeGreaterThanOrEqual(checkpoint.options.minDelayMs);
    expect(checkpoint).toMatchObject({ runId, total: 4, done: 2, ok: 2 });
  });

  it('completes the remaining tweets from the checkpoint alone, with an EMPTY store', async () => {
    const runId = await interrupted([tweet('1'), tweet('2'), tweet('3'), tweet('4')], '2');

    restart();
    expect(allTweets()).toEqual([]);

    const seen: string[] = [];
    const resumed = await resumeRun(
      runId,
      deps(async (t) => {
        // The text came out of the checkpoint, not out of any live source.
        seen.push(`${t.id}:${t.text}`);
        return { status: 'deleted' };
      }),
    );
    const final = await waitForRun(resumed);

    expect(resumed).toBe(runId);
    expect(seen).toEqual(['3:tweet 3', '4:tweet 4']);
    expect(final).toMatchObject({ state: 'done', total: 4, done: 4, ok: 4, failed: 0 });
    // The store was re-seeded, so every existing code path saw a normal tweet.
    expect(allTweets().map((t) => t.id).sort()).toEqual(['3', '4']);
  });

  it('never re-deletes a tweet the log already records as settled', async () => {
    const runId = await interrupted([tweet('1'), tweet('2'), tweet('3')], '2');

    // The window between "outcome written to the log" and "checkpoint written":
    // a crash there leaves a checkpoint that still lists an already-deleted
    // tweet. The log is the authority, so it must not be deleted twice.
    const checkpoint = readCheckpoint(runId);
    writeCheckpoint(runId, {
      ...checkpoint,
      done: 1,
      ok: 1,
      remaining: [{ id: '2', createdAt: CREATED, text: 'tweet 2', isRetweet: false }, ...checkpoint.remaining],
    });

    restart();
    const seen: string[] = [];
    await resumeRun(
      runId,
      deps(async (t) => {
        seen.push(t.id);
        return { status: 'deleted' };
      }),
    );
    const final = await waitForRun(runId);

    expect(seen).toEqual(['3']);
    // '1' and '2' were counted from the log rather than re-attempted.
    expect(final).toMatchObject({ state: 'done', total: 3, done: 3, ok: 3 });
  });

  it('carries startedAt and the counters so the resumed progress is continuous', async () => {
    const runId = await interrupted(
      [tweet('1'), tweet('2'), tweet('3'), tweet('4'), tweet('5')],
      '3',
      (t) => (t.id === '2' ? { status: 'already_gone' } : { status: 'deleted' }),
    );
    const before = getRun(runId);
    expect(before).toMatchObject({ state: 'stopped', done: 3, ok: 2, alreadyGone: 1 });

    restart();
    let atFirstDelete: ProgressEvent | undefined;
    await resumeRun(
      runId,
      deps(async () => {
        atFirstDelete ??= getRun(runId);
        return { status: 'deleted' };
      }),
    );
    const events = record(runId);
    const final = await waitForRun(runId);

    // The progress bar picks up where it stopped instead of restarting at 0/2.
    expect(atFirstDelete).toMatchObject({
      startedAt: before?.startedAt,
      total: 5,
      done: 3,
      ok: 2,
      alreadyGone: 1,
      failed: 0,
    });
    expect(final).toMatchObject({ state: 'done', total: 5, done: 5, ok: 4, alreadyGone: 1 });
    expect(final?.startedAt).toBe(before?.startedAt);
    expect(events.every((e) => e.total === 5 && e.done >= 3)).toBe(true);
  });

  it("round-trips a retweet's sourceTweetId through the checkpoint", async () => {
    const runId = await interrupted(
      [
        tweet('1'),
        tweet('2', { isRetweet: true, text: 'RT @someone', sourceTweetId: '90909090' }),
        tweet('3'),
      ],
      '1',
    );

    const checkpoint = readCheckpoint(runId);
    // The ORIGINAL id survives on disk, or a resumed un-retweet targets the wrong
    // thing. A non-retweet ('3') stays byte-identical to the old shape (no key).
    expect(checkpoint.remaining).toEqual([
      { id: '2', createdAt: CREATED, text: 'RT @someone', isRetweet: true, sourceTweetId: '90909090' },
      { id: '3', createdAt: CREATED, text: 'tweet 3', isRetweet: false },
    ]);
  });

  it('deletes a resumed retweet with its sourceTweetId preserved, from an EMPTY store', async () => {
    const runId = await interrupted(
      [tweet('1'), tweet('2', { isRetweet: true, text: 'RT @someone', sourceTweetId: '90909090' })],
      '1',
    );

    restart();
    expect(allTweets()).toEqual([]);

    const seen: { id: string; isRetweet: boolean; sourceTweetId?: string }[] = [];
    await resumeRun(
      runId,
      deps(async (t) => {
        seen.push({ id: t.id, isRetweet: t.isRetweet, sourceTweetId: t.sourceTweetId });
        return { status: 'deleted' };
      }),
    );
    await waitForRun(runId);

    // The deleter (mutate.deleteTweet) receives the original id, so DeleteRetweet
    // targets the right tweet even after a process restart with no store.
    expect(seen).toEqual([{ id: '2', isRetweet: true, sourceTweetId: '90909090' }]);
  });

  it('round-trips isLike through the checkpoint', async () => {
    const runId = await interrupted(
      [
        tweet('1'),
        tweet('2', { isLike: true, text: 'someone else tweet' }),
        tweet('3'),
      ],
      '1',
    );

    const checkpoint = readCheckpoint(runId);
    // The like keeps its flag; the ordinary tweet stays byte-identical (no key).
    expect(checkpoint.remaining).toEqual([
      { id: '2', createdAt: CREATED, text: 'someone else tweet', isRetweet: false, isLike: true },
      { id: '3', createdAt: CREATED, text: 'tweet 3', isRetweet: false },
    ]);
  });

  it('un-likes a resumed like (isLike reaches the deleter) from an EMPTY store', async () => {
    const runId = await interrupted(
      [tweet('1'), tweet('2', { isLike: true, text: 'someone else tweet' })],
      '1',
    );

    restart();
    expect(allTweets()).toEqual([]);

    const seen: { id: string; isLike?: boolean }[] = [];
    await resumeRun(
      runId,
      deps(async (t) => {
        seen.push({ id: t.id, isLike: t.isLike });
        return { status: 'deleted' };
      }),
    );
    await waitForRun(runId);

    // The deleter (mutate.deleteTweet) gets isLike, so it dispatches
    // UnfavoriteTweet even after a restart with no store.
    expect(seen).toEqual([{ id: '2', isLike: true }]);
    // ...and the like is recorded as such in the log.
    const { entries } = await readLog();
    expect(entries.find((e) => e.id === '2')?.isLike).toBe(true);
  });

  it('still routes a remaining retweet as a retweet after a resume', async () => {
    const runId = await interrupted(
      [tweet('1'), tweet('2', { isRetweet: true, text: 'RT @someone' }), tweet('3')],
      '1',
    );

    restart();
    const flags: [string, boolean][] = [];
    await resumeRun(
      runId,
      deps(async (t) => {
        flags.push([t.id, t.isRetweet]);
        return { status: 'deleted' };
      }),
    );
    await waitForRun(runId);

    // Getting this wrong sends DeleteTweet at a retweet: reported as success,
    // and the retweet is still there.
    expect(flags).toEqual([
      ['2', true],
      ['3', false],
    ]);
    const { entries } = await readLog();
    expect(entries.find((e) => e.id === '2')?.isRetweet).toBe(true);
  });

  it('does not write a second pending line for tweets that already have one', async () => {
    const runId = await interrupted([tweet('1'), tweet('2'), tweet('3')], '1');
    expect(logLines().filter((l) => l.status === 'pending').map((l) => l.id)).toEqual(['1', '2', '3']);

    restart();
    await resumeRun(runId, deps(async () => ({ status: 'deleted' })));
    await waitForRun(runId);

    // Still exactly one pending line per tweet: the text was already on disk
    // before anything was deleted, which is the property that matters.
    expect(logLines().filter((l) => l.status === 'pending').map((l) => l.id)).toEqual(['1', '2', '3']);
    const { entries } = await readLog();
    expect(entries).toHaveLength(3);
    expect(entries.every((e) => e.status === 'deleted')).toBe(true);
  });

  it('re-logs a pending line when the log has no record of the tweet', async () => {
    const runId = await interrupted([tweet('1'), tweet('2'), tweet('3')], '1');

    // The log was lost/rotated but the checkpoint survived. Safety wins: every
    // remaining tweet gets its text written again before any delete.
    await rm(logFile(), { force: true });
    restart();
    let logAtFirstDelete: string[] = [];
    await resumeRun(
      runId,
      deps(async () => {
        if (logAtFirstDelete.length === 0) {
          logAtFirstDelete = logLines().filter((l) => l.status === 'pending').map((l) => l.id);
        }
        return { status: 'deleted' };
      }),
    );
    await waitForRun(runId);

    expect(logAtFirstDelete).toEqual(['2', '3']);
  });

  it('refuses a checkpoint whose version it does not recognise and sets it aside', async () => {
    const runId = await interrupted([tweet('1'), tweet('2'), tweet('3')], '1');
    writeCheckpoint(runId, { ...readCheckpoint(runId), version: 99 });

    restart();
    let calls = 0;
    await expect(
      resumeRun(
        runId,
        deps(async () => {
          calls += 1;
          return { status: 'deleted' };
        }),
      ),
    ).rejects.toBeInstanceOf(UnknownCheckpointError);

    expect(calls).toBe(0);
    expect(existsSync(checkpointFile(runId))).toBe(false);
    expect(existsSync(`${checkpointFile(runId)}.unsupported`)).toBe(true);
    expect(await listResumableRuns()).toEqual([]);
  });

  it('refuses a legacy id-only checkpoint rather than resuming without the text', async () => {
    // Exactly what the pre-resume version of this file wrote.
    writeCheckpoint('run-legacy', {
      runId: 'run-legacy',
      startedAt: CREATED,
      state: 'stopped',
      total: 3,
      done: 1,
      ok: 1,
      alreadyGone: 0,
      failed: 0,
      remaining: ['2', '3'],
      updatedAt: CREATED,
    });

    await expect(resumeRun('run-legacy')).rejects.toBeInstanceOf(UnknownCheckpointError);
    expect(existsSync(checkpointFile('run-legacy'))).toBe(false);
  });

  it('refuses a torn checkpoint instead of resuming on half a file', async () => {
    writeFileSync(checkpointFile('run-torn'), '{"version": 2, "runId": "run-to', 'utf8');
    await expect(resumeRun('run-torn')).rejects.toBeInstanceOf(UnknownCheckpointError);
    expect(await listResumableRuns()).toEqual([]);
  });

  it('refuses an unknown runId and one whose id could escape the data dir', async () => {
    await expect(resumeRun('run-never-existed')).rejects.toBeInstanceOf(UnknownCheckpointError);
    await expect(resumeRun('../../etc/passwd')).rejects.toBeInstanceOf(UnknownCheckpointError);
    expect(await discardCheckpoint('../../etc/passwd')).toBe(false);
  });

  it('deletes the checkpoint when a resumed run completes cleanly', async () => {
    const runId = await interrupted([tweet('1'), tweet('2'), tweet('3')], '1');
    expect(existsSync(checkpointFile(runId))).toBe(true);

    restart();
    await resumeRun(runId, deps(async () => ({ status: 'deleted' })));
    await waitForRun(runId);

    expect(existsSync(checkpointFile(runId))).toBe(false);
    expect(await listResumableRuns()).toEqual([]);
  });

  it('answers an empty list when data/ does not exist yet', async () => {
    // A fresh checkout has no data directory until the first write. Asking
    // "anything to resume?" on boot must not be the thing that explodes.
    const previous = process.env['TWEDEL_DATA_DIR'];
    process.env['TWEDEL_DATA_DIR'] = join(dir, 'not-created-yet');
    try {
      expect(await listResumableRuns()).toEqual([]);
      await expect(resumeRun('run-anything')).rejects.toBeInstanceOf(UnknownCheckpointError);
    } finally {
      if (previous === undefined) delete process.env['TWEDEL_DATA_DIR'];
      else process.env['TWEDEL_DATA_DIR'] = previous;
    }
  });

  it('lists an interrupted run and forgets it once discarded', async () => {
    const runId = await interrupted([tweet('1'), tweet('2'), tweet('3')], '1');

    const listed = await listResumableRuns();
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ runId, remaining: 2, total: 3, ok: 1, alreadyGone: 0, failed: 0 });
    expect(typeof listed[0]?.startedAt).toBe('string');

    expect(await discardCheckpoint(runId)).toBe(true);
    expect(await listResumableRuns()).toEqual([]);
    await expect(resumeRun(runId)).rejects.toBeInstanceOf(UnknownCheckpointError);

    // Discarding the plan never touches the record of what was already deleted.
    const { entries } = await readLog();
    expect(entries.find((e) => e.id === '1')?.status).toBe('deleted');
  });

  it('does not offer, or resume, a run that is still executing', async () => {
    setTweets([tweet('1'), tweet('2'), tweet('3')]);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const runId = startRun(
      ['1', '2', '3'],
      undefined,
      deps(async (t) => {
        if (t.id === '3') await gate;
        return { status: 'deleted' };
      }),
    );

    // Wait until a checkpoint exists AND the run is still mid-flight.
    for (let i = 0; i < 200 && !existsSync(checkpointFile(runId)); i += 1) {
      await new Promise((r) => setImmediate(r));
    }
    expect(existsSync(checkpointFile(runId))).toBe(true);
    expect(getRun(runId)?.state).not.toBe('done');

    expect(await listResumableRuns()).toEqual([]);
    await expect(resumeRun(runId)).rejects.toBeInstanceOf(RunConflictError);

    release();
    await waitForRun(runId);
  });
});

describe('subscriptions and snapshots', () => {
  it('keeps the terminal event retrievable after the run ends', async () => {
    load(1);
    const runId = startRun(['1'], undefined, deps(async () => ({ status: 'deleted' })));
    await waitForRun(runId);

    const snapshot = getRun(runId);
    expect(snapshot).toMatchObject({ runId, state: 'done', done: 1, ok: 1 });
    expect(getRun('does-not-exist')).toBeUndefined();
  });

  it('stops delivering events after unsubscribe', async () => {
    load(3);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const runId = startRun(
      ['1', '2', '3'],
      undefined,
      deps(async (t) => {
        if (t.id === '1') await gate;
        return { status: 'deleted' };
      }),
    );

    const seen: ProgressEvent[] = [];
    const unsubscribe = subscribe(runId, (e) => seen.push(e));
    await new Promise((r) => setImmediate(r));
    unsubscribe();
    release();
    await waitForRun(runId);

    expect(seen.every((e) => e.state !== 'done')).toBe(true);
  });

  it('subscribing to an unknown run is a harmless no-op', () => {
    expect(() => subscribe('nope', () => undefined)()).not.toThrow();
  });
});
