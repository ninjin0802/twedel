import { useEffect, useRef, useState } from 'react';
import type { ProgressEvent, RunState } from '@shared/types';
import * as api from '../api';
import { ApiError } from '../api';

interface Props {
  runId: string;
  onFinished?: (event: ProgressEvent) => void;
  /**
   * Reports whether this panel is attached to a genuinely in-progress run
   * (running / waiting / stopping with a real snapshot behind it). App uses this
   * to gate the delete button: a settled, gone, or not-yet-confirmed run must NOT
   * block a fresh deletion.
   */
  onActiveChange?: (active: boolean) => void;
  onDismiss: () => void;
}

const STATE_LABEL: Record<RunState, string> = {
  running: '実行中',
  waiting: 'レート制限で待機中',
  stopping: '中断処理中',
  stopped: '中断しました',
  done: '完了',
  error: 'エラー',
};

const TERMINAL: RunState[] = ['stopped', 'done', 'error'];

/** Shown when a restored runId is no longer known to the server (e.g. a restart). */
export const GONE_MESSAGE =
  'この実行はもう見つかりません（サーバーが再起動された可能性があります）。';

/**
 * Decide whether a failed snapshot fetch means the run is truly gone or the
 * connection merely hiccuped.
 *
 * The signal is `ApiError.status`: a 404 is the server saying "I have no such
 * run" (stale localStorage id after a restart), while status 0 is a transport
 * failure and any 5xx is a transient server problem. A failure AFTER we already
 * had progress is always treated as transient - a live run whose SSE briefly
 * drops must stay visible with its 中断 button and recover.
 */
export function classifySnapshotError(err: unknown, hadProgress: boolean): 'gone' | 'transient' {
  if (hadProgress) return 'transient';
  if (err instanceof ApiError && err.status === 404) return 'gone';
  return 'transient';
}

function fmtDuration(totalSec: number): string {
  if (!Number.isFinite(totalSec) || totalSec < 0) return '—';
  const s = Math.floor(totalSec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * Seconds the run has been going.
 *
 * `startedAt` (ISO, set by the server - see API.md) is authoritative, which is
 * the whole point of it: a mid-run page reload must not restart the counter at
 * zero. The panel's own mount time is only a fallback for an event that carries
 * no `startedAt` (an older server, or the moments before the first snapshot
 * arrives).
 *
 * `startedAt` is stamped by the server process and compared against the
 * browser's clock. Those are usually the same machine here, but not necessarily
 * the same clock, and a browser running behind the server would otherwise
 * render a negative duration - so the result is clamped at 0 rather than shown.
 */
export function elapsedSeconds(now: number, mountedAt: number, startedAt?: string): number {
  const fromServer = startedAt ? Date.parse(startedAt) : Number.NaN;
  const origin = Number.isNaN(fromServer) ? mountedAt : fromServer;
  return Math.max(0, (now - origin) / 1000);
}

interface ProgressViewProps {
  gone: boolean;
  state: RunState;
  progress: ProgressEvent | null;
  elapsedSec: number;
  waitRemaining: number | null;
  stopping: boolean;
  connError: string | null;
  onStop: () => void;
  onDismiss: () => void;
}

/**
 * Pure presentational half of the panel. Split out so its two very different
 * looks - a live run with a 中断 button vs a gone run with only 閉じる - can be
 * asserted in the offline (no jsdom) test environment this repo uses.
 */
export function ProgressView({
  gone,
  state,
  progress,
  elapsedSec,
  waitRemaining,
  stopping,
  connError,
  onStop,
  onDismiss,
}: ProgressViewProps) {
  if (gone) {
    return (
      <section className="panel panel--run run--gone">
        <header className="panel__head">
          <h2>
            <span className="step-badge">4</span> 実行状況
          </h2>
          <span className="pill pill--gone">見つかりません</span>
        </header>
        <p className="inline-msg inline-msg--error">{GONE_MESSAGE}</p>
        <div className="modal__actions">
          <button type="button" className="btn" onClick={onDismiss}>
            閉じる
          </button>
        </div>
      </section>
    );
  }

  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const isTerminal = TERMINAL.includes(state);

  return (
    <section className={`panel panel--run run--${state}`}>
      <header className="panel__head">
        <h2>
          <span className="step-badge">4</span> 実行状況
        </h2>
        <span className={`pill pill--${state}`}>{STATE_LABEL[state]}</span>
      </header>

      <div
        className="progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total || 100}
        aria-valuenow={done}
      >
        <div className="progress__bar" style={{ width: `${pct}%` }} />
        <span className="progress__label">
          {done.toLocaleString()} / {total.toLocaleString()} ({pct.toFixed(1)}%)
        </span>
      </div>

      <div className="counters">
        <div className="counter counter--ok">
          <span className="counter__value">{(progress?.ok ?? 0).toLocaleString()}</span>
          <span className="counter__label">成功</span>
        </div>
        <div className="counter">
          <span className="counter__value">{(progress?.alreadyGone ?? 0).toLocaleString()}</span>
          <span className="counter__label">既に削除済み</span>
        </div>
        <div className="counter counter--bad">
          <span className="counter__value">{(progress?.failed ?? 0).toLocaleString()}</span>
          <span className="counter__label">失敗</span>
        </div>
        <div className="counter">
          <span className="counter__value">{fmtDuration(elapsedSec)}</span>
          <span className="counter__label">経過</span>
        </div>
        <div className="counter">
          <span className="counter__value">
            {progress?.etaSec != null ? fmtDuration(progress.etaSec) : '—'}
          </span>
          <span className="counter__label">残り (ETA)</span>
        </div>
      </div>

      {state === 'waiting' && (
        <p className="inline-msg inline-msg--waiting">
          X のレート制限に達したため待機しています。
          {waitRemaining !== null
            ? ` あと ${fmtDuration(waitRemaining)} で再開します。`
            : ' 再開時刻を待っています。'}
        </p>
      )}

      <div className="current">
        <span className="current__label">処理中</span>
        <span className="current__text">
          {progress?.currentText ?? (isTerminal ? '—' : '準備中…')}
        </span>
      </div>

      {progress?.message && <p className="inline-msg">{progress.message}</p>}
      {connError && <p className="inline-msg inline-msg--error">{connError}</p>}

      <div className="modal__actions">
        {isTerminal ? (
          <button type="button" className="btn" onClick={onDismiss}>
            閉じる
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--danger-outline"
            onClick={onStop}
            disabled={stopping}
          >
            {stopping ? '中断しています…' : '中断'}
          </button>
        )}
      </div>
    </section>
  );
}

export function ProgressPanel({ runId, onFinished, onActiveChange, onDismiss }: Props) {
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [connError, setConnError] = useState<string | null>(null);
  const [stopRequested, setStopRequested] = useState(false);
  const [gone, setGone] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  /** Fallback origin for the elapsed counter, used only until/unless the server sends `startedAt`. */
  const mountedAtRef = useRef(Date.now());
  const finishedRef = useRef(false);
  /** Whether any snapshot/stream event has ever arrived - drives the gone-vs-transient call. */
  const hadProgressRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const onActiveChangeRef = useRef(onActiveChange);
  onActiveChangeRef.current = onActiveChange;

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let unsubscribe: (() => void) | null = null;
    let cancelled = false;
    finishedRef.current = false;
    hadProgressRef.current = false;
    mountedAtRef.current = Date.now();

    const accept = (event: ProgressEvent) => {
      if (cancelled) return;
      hadProgressRef.current = true;
      setGone(false);
      setProgress(event);
      setConnError(null);
      if (event.state === 'stopping') setStopRequested(true);
      if (TERMINAL.includes(event.state) && !finishedRef.current) {
        finishedRef.current = true;
        onFinishedRef.current?.(event);
      }
    };

    // Reconnect path: pull the snapshot first so a mid-run page reload recovers state,
    // then attach to the live stream.
    (async () => {
      try {
        accept(await api.getRunSnapshot(runId));
      } catch (err) {
        if (cancelled) return;
        // A 404 with nothing received yet = a stale id the server no longer knows.
        // A transport hiccup (status 0) on a live run must NOT flip us to "gone".
        if (classifySnapshotError(err, hadProgressRef.current) === 'gone') {
          setGone(true);
        } else {
          setConnError(err instanceof Error ? err.message : String(err));
        }
      }
      if (cancelled) return;
      unsubscribe = api.subscribe<ProgressEvent>(api.runEventsUrl(runId), accept, (err) => {
        if (!cancelled) setConnError(err.message);
      });
    })();

    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [runId]);

  const state: RunState = progress?.state ?? 'running';
  const isTerminal = TERMINAL.includes(state);

  // A genuinely in-progress run is one we have a live snapshot for that has not
  // settled and is not gone. Before the first snapshot (progress === null) we
  // report inactive so a stale/unknown id never blocks the delete button.
  const active = progress != null && !isTerminal && !gone;
  useEffect(() => {
    onActiveChangeRef.current?.(active);
  }, [active]);

  async function stop() {
    setStopRequested(true);
    try {
      await api.stopRun(runId);
    } catch (err) {
      // The run is already gone/terminal on the server: resolve to a dismissable
      // state instead of sticking on 中断しています… forever.
      if (err instanceof ApiError && err.status === 404) {
        setGone(true);
        return;
      }
      // Transient failure: let go of the "stopping…" latch so 中断 can be retried.
      setStopRequested(false);
      setConnError(err instanceof Error ? err.message : String(err));
    }
  }

  const elapsedSec = elapsedSeconds(now, mountedAtRef.current, progress?.startedAt);
  const stopping = state === 'stopping' || (stopRequested && !isTerminal);

  let waitRemaining: number | null = null;
  if (state === 'waiting' && progress?.waitingUntil) {
    const until = Date.parse(progress.waitingUntil);
    if (!Number.isNaN(until)) waitRemaining = Math.max(0, (until - now) / 1000);
  }

  return (
    <ProgressView
      gone={gone}
      state={state}
      progress={progress}
      elapsedSec={elapsedSec}
      waitRemaining={waitRemaining}
      stopping={stopping}
      connError={connError}
      onStop={stop}
      onDismiss={onDismiss}
    />
  );
}
