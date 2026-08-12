import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ProgressEvent, RunState } from '@shared/types';
import { ApiError } from '../api';
import { GONE_MESSAGE, ProgressView, classifySnapshotError } from './ProgressPanel';

/**
 * Rendered with `react-dom/server` (this repo has no jsdom): the container
 * `ProgressPanel` owns the effects/SSE, while the pure `ProgressView` owns the
 * markup - so the two looks that matter here (a live run with 中断 vs a gone run
 * with only 閉じる) can be asserted directly from props.
 */
const noop = () => {};

function progressEvent(state: RunState): ProgressEvent {
  return {
    runId: 'r1',
    state,
    total: 10,
    done: 4,
    ok: 4,
    alreadyGone: 0,
    failed: 0,
    etaSec: null,
  };
}

function view(props: Partial<Parameters<typeof ProgressView>[0]>): string {
  return renderToStaticMarkup(
    <ProgressView
      gone={false}
      state="running"
      progress={progressEvent('running')}
      elapsedSec={0}
      waitRemaining={null}
      stopping={false}
      connError={null}
      onStop={noop}
      onDismiss={noop}
      {...props}
    />,
  );
}

describe('classifySnapshotError', () => {
  it('treats a 404 with nothing received yet as a gone run', () => {
    expect(classifySnapshotError(new ApiError('HTTP 404', 404), false)).toBe('gone');
  });

  it('treats a connection failure (status 0) as transient, not gone', () => {
    expect(classifySnapshotError(new ApiError('接続できません', 0), false)).toBe('transient');
  });

  it('treats any failure AFTER progress arrived as transient - a live SSE hiccup', () => {
    // Even a 404 here means the stream blipped on a run we were already watching.
    expect(classifySnapshotError(new ApiError('HTTP 404', 404), true)).toBe('transient');
  });

  it('treats a non-ApiError throw as transient', () => {
    expect(classifySnapshotError(new Error('boom'), false)).toBe('transient');
  });

  it('treats a 5xx as transient rather than gone', () => {
    expect(classifySnapshotError(new ApiError('HTTP 503', 503), false)).toBe('transient');
  });
});

describe('ProgressView - gone (unknown run) state', () => {
  it('renders the "gone" explanation and a 閉じる button, never a 中断 button', () => {
    const html = view({ gone: true });
    expect(html).toContain(GONE_MESSAGE);
    expect(html).toContain('閉じる');
    expect(html).not.toContain('中断');
    // No fake 実行中 pill either.
    expect(html).not.toContain('実行中');
  });
});

describe('ProgressView - live run', () => {
  it('shows a 中断 button (not 閉じる) while running', () => {
    const html = view({ state: 'running', progress: progressEvent('running') });
    expect(html).toContain('中断');
    expect(html).toContain('実行中');
    expect(html).not.toContain('閉じる');
  });

  it('keeps the run visible with 中断 when a transient error arrives after progress', () => {
    // The run does not flip to the gone/閉じる view while reconnecting.
    const html = view({
      state: 'running',
      progress: progressEvent('running'),
    });
    expect(html).toContain('中断');
    expect(html).not.toContain('進捗ストリームが切断されました');
    expect(html).not.toContain(GONE_MESSAGE);
  });

  it('shows 中断しています… while a stop is in flight', () => {
    const html = view({ state: 'running', stopping: true });
    expect(html).toContain('中断しています…');
    expect(html).toContain('disabled');
  });

  it('moves to 中断しました with a 閉じる button once the run is stopped', () => {
    const html = view({ state: 'stopped', progress: progressEvent('stopped'), stopping: false });
    expect(html).toContain('中断しました');
    expect(html).toContain('閉じる');
    // A terminal run offers no 中断 action.
    expect(html).not.toContain('btn--danger-outline');
  });
});
