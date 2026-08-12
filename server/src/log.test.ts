import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DeleteLogEntry, DeleteStatus } from '../../shared/types.js';
import { appendEntries, logFile, readLog, toCsv } from './log.js';

let dir: string;
let previousDataDir: string | undefined;

function entry(
  id: string,
  status: DeleteStatus,
  overrides: Partial<DeleteLogEntry> = {},
): DeleteLogEntry {
  return {
    runId: 'run-a',
    id,
    createdAt: '2020-01-01T00:00:00.000Z',
    text: `tweet ${id}`,
    isRetweet: false,
    status,
    at: new Date().toISOString(),
    ...overrides,
  };
}

beforeAll(async () => {
  previousDataDir = process.env['TWEDEL_DATA_DIR'];
  dir = await mkdtemp(join(tmpdir(), 'twedel-log-'));
  process.env['TWEDEL_DATA_DIR'] = dir;
});

afterAll(async () => {
  if (previousDataDir === undefined) delete process.env['TWEDEL_DATA_DIR'];
  else process.env['TWEDEL_DATA_DIR'] = previousDataDir;
  await rm(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await rm(logFile(), { force: true });
});

describe('appendEntries / readLog', () => {
  it('reads back what was appended', async () => {
    await appendEntries([entry('1', 'pending'), entry('2', 'pending')]);

    const { entries, skippedLines } = await readLog();
    expect(skippedLines).toBe(0);
    expect(entries.map((e) => e.id)).toEqual(['1', '2']);
    expect(entries[0]?.text).toBe('tweet 1');
  });

  it('returns an empty log rather than throwing when the file does not exist', async () => {
    const { entries, skippedLines } = await readLog();
    expect(entries).toEqual([]);
    expect(skippedLines).toBe(0);
  });

  it('never rewrites earlier lines - the file only ever grows', async () => {
    await appendEntries([entry('1', 'pending')]);
    const afterFirst = await readFile(logFile(), 'utf8');
    await appendEntries([entry('1', 'deleted')]);
    const afterSecond = await readFile(logFile(), 'utf8');

    expect(afterSecond.startsWith(afterFirst)).toBe(true);
    expect(afterSecond.trim().split('\n')).toHaveLength(2);
  });

  it('collapses duplicate ids to the latest status', async () => {
    await appendEntries([entry('1', 'pending'), entry('2', 'pending')]);
    await appendEntries([entry('1', 'deleted')]);
    await appendEntries([entry('2', 'failed', { error: 'boom' })]);

    const { entries } = await readLog();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.id === '1')?.status).toBe('deleted');
    expect(entries.find((e) => e.id === '2')?.status).toBe('failed');
    expect(entries.find((e) => e.id === '2')?.error).toBe('boom');
  });

  it('scopes collapsing per runId, so a tweet targeted twice keeps both rows', async () => {
    await appendEntries([entry('1', 'pending', { runId: 'run-a' })]);
    await appendEntries([entry('1', 'failed', { runId: 'run-a' })]);
    await appendEntries([entry('1', 'pending', { runId: 'run-b' })]);
    await appendEntries([entry('1', 'deleted', { runId: 'run-b' })]);

    const { entries } = await readLog();
    expect(entries).toHaveLength(2);
    expect(entries.find((e) => e.runId === 'run-a')?.status).toBe('failed');
    expect(entries.find((e) => e.runId === 'run-b')?.status).toBe('deleted');
  });

  it('survives a truncated final line and counts it', async () => {
    await appendEntries([entry('1', 'deleted'), entry('2', 'deleted')]);
    // Exactly what a process killed mid-write leaves behind.
    await appendFile(logFile(), '{"runId":"run-a","id":"3","text":"half a t', 'utf8');

    const { entries, skippedLines } = await readLog();
    expect(skippedLines).toBe(1);
    expect(entries.map((e) => e.id)).toEqual(['1', '2']);
  });

  it('skips a line that parses but is not a log entry', async () => {
    await appendEntries([entry('1', 'deleted')]);
    await appendFile(logFile(), '{"hello":"world"}\n[1,2,3]\nnot json at all\n', 'utf8');

    const { entries, skippedLines } = await readLog();
    expect(entries).toHaveLength(1);
    expect(skippedLines).toBe(3);
  });

  it('serialises concurrent appends so no line is ever interleaved', async () => {
    const batches = Array.from({ length: 25 }, (_, i) => [
      entry(String(i), 'pending', { text: `x`.repeat(500) }),
    ]);
    // Fired without awaiting: this is the mid-run shape (per-item outcome writes
    // racing the runner's own bookkeeping).
    await Promise.all(batches.map((b) => appendEntries(b)));

    const raw = await readFile(logFile(), 'utf8');
    const lines = raw.trim().split('\n');
    expect(lines).toHaveLength(25);
    for (const line of lines) expect(() => JSON.parse(line) as unknown).not.toThrow();

    const { entries, skippedLines } = await readLog();
    expect(skippedLines).toBe(0);
    expect(entries).toHaveLength(25);
  });
});

describe('readLog filters', () => {
  beforeEach(async () => {
    await appendEntries([
      entry('1', 'deleted', { runId: 'run-a', text: 'hello world' }),
      entry('2', 'failed', { runId: 'run-a', text: 'goodbye' }),
      entry('3', 'pending', { runId: 'run-b', text: 'hello again' }),
    ]);
  });

  it('filters by runId', async () => {
    const { entries } = await readLog({ runId: 'run-b' });
    expect(entries.map((e) => e.id)).toEqual(['3']);
  });

  it('filters by status AFTER collapsing, so pending means still pending', async () => {
    await appendEntries([entry('3', 'deleted', { runId: 'run-b' })]);
    const { entries } = await readLog({ status: 'pending' });
    expect(entries).toEqual([]);
  });

  it('matches q against the text, case-insensitively', async () => {
    const { entries } = await readLog({ q: 'HELLO' });
    expect(entries.map((e) => e.id).sort()).toEqual(['1', '3']);
  });

  it('matches q against the id too', async () => {
    const { entries } = await readLog({ q: '2' });
    expect(entries.map((e) => e.id)).toEqual(['2']);
  });

  it('combines filters', async () => {
    const { entries } = await readLog({ runId: 'run-a', status: 'deleted', q: 'hello' });
    expect(entries.map((e) => e.id)).toEqual(['1']);
  });
});

describe('toCsv', () => {
  it('emits a header and one row per entry', () => {
    const csv = toCsv([entry('1', 'deleted')]);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe('runId,id,createdAt,text,isRetweet,status,error,at');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"tweet 1"');
  });

  it('quotes commas, quotes and newlines so columns never shift', () => {
    const csv = toCsv([entry('1', 'deleted', { text: 'a,b "quoted"\nsecond line' })]);
    expect(csv).toContain('"a,b ""quoted""\nsecond line"');
    // The header plus one logical row; the embedded newline stays inside quotes.
    expect(csv.split('\r\n')[0]).toBe('runId,id,createdAt,text,isRetweet,status,error,at');
  });

  it('renders a missing error as an empty field, not "undefined"', () => {
    const csv = toCsv([entry('1', 'deleted')]);
    expect(csv).not.toContain('undefined');
    expect(csv).toContain(',"",');
  });

  it('handles an empty list', () => {
    expect(toCsv([]).trim()).toBe('runId,id,createdAt,text,isRetweet,status,error,at');
  });
});
