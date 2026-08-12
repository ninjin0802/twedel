import { useState } from 'react';
import type { ResumableRun } from '../api';
import * as api from '../api';

/**
 * The "you left something unfinished" banner.
 *
 * A deletion run is paced at roughly one tweet a second, so a few thousand
 * tweets is hours and being interrupted — a stop, a crash, a reboot — is the
 * normal case rather than the exceptional one. The server keeps a checkpoint of
 * everything that run had left to do; this is the only place the user is told it
 * exists, so it sits above the whole flow rather than inside it.
 *
 * 破棄 confirms first: discarding the checkpoint means the remaining tweets can
 * never be finished from here, and that is a decision with no undo.
 */

interface Props {
  runs: ResumableRun[];
  /** The run is live again; the caller mounts `ProgressPanel` with this runId. */
  onResumed: (runId: string) => void;
  onDiscarded: (runId: string) => void;
}

function fmtStarted(iso: string): string {
  if (!iso) return '不明';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '不明';
  // Same shape the log table uses: "2026-08-12 14:03:07".
  return new Date(t).toLocaleString('sv-SE').replace('T', ' ').slice(0, 19);
}

export function ResumeBanner({ runs, onResumed, onDiscarded }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (runs.length === 0) return null;

  async function resume(runId: string) {
    setBusy(runId);
    setError(null);
    try {
      const result = await api.resumeRun(runId);
      onResumed(result.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  async function discard(run: ResumableRun) {
    const confirmed = window.confirm(
      `残り ${run.remaining.toLocaleString()} 件の削除予定を破棄します。\n` +
        'この続きは二度と再開できません。よろしいですか？\n\n' +
        '（すでに削除されたツイートの記録は削除ログに残ります）',
    );
    if (!confirmed) return;

    setBusy(run.runId);
    setError(null);
    try {
      await api.discardCheckpoint(run.runId);
      onDiscarded(run.runId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  // `run--waiting` borrows the progress panel's "paused, not failed" border.
  return (
    <section className="panel panel--run run--waiting">
      <header className="panel__head">
        <h2>中断された削除があります</h2>
        <span className="pill pill--waiting">再開できます</span>
      </header>

      {runs.map((run) => (
        <div key={run.runId}>
          <p className="inline-msg inline-msg--warn">
            {fmtStarted(run.startedAt)} に開始した削除が、残り{' '}
            <b>{run.remaining.toLocaleString()}</b> 件で中断しています（全{' '}
            {run.total.toLocaleString()} 件中 {Math.max(0, run.total - run.remaining).toLocaleString()}{' '}
            件処理済み / 成功 {run.ok.toLocaleString()}・既に削除済み{' '}
            {run.alreadyGone.toLocaleString()}・失敗 {run.failed.toLocaleString()}）。
          </p>
          <div className="row row--tight">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => void resume(run.runId)}
              disabled={busy !== null}
            >
              {busy === run.runId ? '再開しています…' : '再開'}
            </button>
            <button
              type="button"
              className="btn btn--danger-outline"
              onClick={() => void discard(run)}
              disabled={busy !== null}
            >
              破棄
            </button>
          </div>
        </div>
      ))}

      {error && <p className="inline-msg inline-msg--error">{error}</p>}

      <p className="hint">
        再開すると、中断した続きだけを削除します。すでに削除済みのツイートに再度削除を試みることは
        ありません。サーバーを再起動していても、記録済みの本文とリツイート種別から続行できます。
      </p>
    </section>
  );
}
