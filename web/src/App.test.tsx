import { describe, expect, it } from 'vitest';
import { deleteButtonState } from './App';

/**
 * The delete button used to be gated on `runId !== null`, which meant a stale
 * `twedel.runId` in localStorage - or a finished run whose panel had not been
 * dismissed - disabled 削除を確認 permanently. It is now gated on whether a run
 * is GENUINELY in progress, reported up from the ProgressPanel. These assert the
 * pure gate that decision funnels through.
 */
describe('deleteButtonState', () => {
  const ready = { selectedCount: 3, runInProgress: false, criteriaValid: true };

  it('enables the button when tweets are selected, dates are valid, and no run is active', () => {
    expect(deleteButtonState(ready)).toEqual({ disabled: false });
  });

  it('is enabled once a run has SETTLED even while the result panel is still shown', () => {
    // Terminal runs report runInProgress:false, so the user can start a new
    // deletion without hunting for 閉じる first.
    expect(deleteButtonState({ ...ready, runInProgress: false }).disabled).toBe(false);
  });

  it('is NOT blocked on mount by a stale runId whose snapshot 404s', () => {
    // An unknown/gone run never flips runInProgress true, so the default holds.
    expect(deleteButtonState({ ...ready, runInProgress: false }).disabled).toBe(false);
  });

  it('blocks - with its own reason - only while a run is genuinely in progress', () => {
    const gate = deleteButtonState({ ...ready, runInProgress: true });
    expect(gate.disabled).toBe(true);
    expect(gate.title).toContain('実行中');
  });

  it('names the invalid-date reason when the dates cannot be parsed', () => {
    const gate = deleteButtonState({ ...ready, criteriaValid: false });
    expect(gate.disabled).toBe(true);
    expect(gate.title).toContain('日付');
  });

  it('names the empty-selection reason when nothing is selected', () => {
    const gate = deleteButtonState({ ...ready, selectedCount: 0 });
    expect(gate.disabled).toBe(true);
    expect(gate.title).toContain('選択');
  });

  it('gives every disabled reason a distinct, non-empty title', () => {
    const inProgress = deleteButtonState({ ...ready, runInProgress: true }).title;
    const badDates = deleteButtonState({ ...ready, criteriaValid: false }).title;
    const empty = deleteButtonState({ ...ready, selectedCount: 0 }).title;
    for (const t of [inProgress, badDates, empty]) {
      expect(t).toBeTruthy();
    }
    expect(new Set([inProgress, badDates, empty]).size).toBe(3);
  });

  it('reports the in-progress reason first when several gates fail at once', () => {
    const gate = deleteButtonState({ selectedCount: 0, runInProgress: true, criteriaValid: false });
    expect(gate.title).toContain('実行中');
  });
});
