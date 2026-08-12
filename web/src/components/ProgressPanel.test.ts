import { describe, expect, it } from 'vitest';
import { elapsedSeconds } from './ProgressPanel';

/**
 * API.md: "The server MUST set `ProgressEvent.startedAt` so the UI's
 * elapsed-time counter survives a page reload." These tests are the client half
 * of that sentence.
 */
const MOUNT = Date.parse('2024-05-01T12:00:00.000Z');

describe('elapsedSeconds', () => {
  it('measures from the run start, not from when the panel mounted', () => {
    // The reload case: the run began 10 minutes before this panel existed.
    const startedAt = '2024-05-01T11:50:00.000Z';
    expect(elapsedSeconds(MOUNT + 5_000, MOUNT, startedAt)).toBe(605);
  });

  it('keeps counting from the same origin as time passes', () => {
    const startedAt = '2024-05-01T11:59:00.000Z';
    expect(elapsedSeconds(MOUNT, MOUNT, startedAt)).toBe(60);
    expect(elapsedSeconds(MOUNT + 30_000, MOUNT, startedAt)).toBe(90);
  });

  it('falls back to mount time when the event carries no startedAt', () => {
    expect(elapsedSeconds(MOUNT + 42_000, MOUNT, undefined)).toBe(42);
  });

  it('falls back to mount time when startedAt is unparseable', () => {
    expect(elapsedSeconds(MOUNT + 42_000, MOUNT, 'not a date')).toBe(42);
  });

  it('clamps clock skew to zero instead of rendering a negative duration', () => {
    // Server clock ahead of the browser's: startedAt is "in the future".
    const startedAt = '2024-05-01T12:00:30.000Z';
    expect(elapsedSeconds(MOUNT, MOUNT, startedAt)).toBe(0);
  });

  it('never goes negative on the fallback path either', () => {
    expect(elapsedSeconds(MOUNT - 1_000, MOUNT, undefined)).toBe(0);
  });
});
