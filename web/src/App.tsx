import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FilterCriteria, ProgressEvent, SessionInfo, Tweet } from '@shared/types';
import * as api from './api';
import { CredentialsPanel } from './components/CredentialsPanel';
import { AppInfo } from './components/AppInfo';
import { DryRunDialog } from './components/DryRunDialog';
import { FilterBar } from './components/FilterBar';
import { ProgressPanel } from './components/ProgressPanel';
import { ResumeBanner } from './components/ResumeBanner';
import { SourcePanel } from './components/SourcePanel';
import { TweetTable } from './components/TweetTable';
import { DEFAULT_CRITERIA, applyFilter, hasUnreliableCounts, validateCriteria } from './filter';
import { updates, type UpdateState } from './update';

type Health = 'checking' | 'online' | 'offline';
type Page = 'main' | 'settings' | 'updates' | 'about';

const RUN_KEY = 'twedel.runId';

export interface DeleteGate {
  selectedCount: number;
  /** True only while a REAL run is running / waiting / stopping (see ProgressPanel.onActiveChange). */
  runInProgress: boolean;
  criteriaValid: boolean;
}

/**
 * The delete button's disabled state, with a distinct reason for each. Kept pure
 * and exported so the gate can be asserted directly - the offline test
 * environment cannot drive App through a full run lifecycle.
 *
 * Ordered by severity: an in-progress run blocks first, then unparseable dates
 * (an irreversible delete must never run on a filter we could not read), then an
 * empty selection.
 */
export function deleteButtonState(gate: DeleteGate): { disabled: boolean; title?: string } {
  if (gate.runInProgress) {
    return { disabled: true, title: '実行中の削除が完了するまで、新しい削除は開始できません。' };
  }
  if (!gate.criteriaValid) {
    return { disabled: true, title: '絞り込み条件の日付を修正してください' };
  }
  if (gate.selectedCount === 0) {
    return { disabled: true, title: '削除するポストを選択してください' };
  }
  return { disabled: false };
}

export function App() {
  const [health, setHealth] = useState<Health>('checking');
  const [version, setVersion] = useState<string | null>(null);
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [sessionChecked, setSessionChecked] = useState(false);
  const [page, setPage] = useState<Page>('main');
  const [menuOpen, setMenuOpen] = useState(false);
  const [updateState, setUpdateState] = useState<UpdateState>({ status: 'idle' });

  const [tweets, setTweets] = useState<Tweet[]>([]);
  const [criteria, setCriteria] = useState<FilterCriteria>(DEFAULT_CRITERIA);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  const [dryRunOpen, setDryRunOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [runId, setRunId] = useState<string | null>(() => {
    try {
      return window.localStorage.getItem(RUN_KEY);
    } catch {
      return null;
    }
  });
  /**
   * Bumped when a run is resumed. A resume answers the SAME runId, so without
   * this the `[runId]` effect inside ProgressPanel would not re-run and the panel
   * would keep showing the stale "unknown runId" it got before the restart.
   */
  const [runEpoch, setRunEpoch] = useState(0);
  const [resumable, setResumable] = useState<api.ResumableRun[]>([]);
  /**
   * Whether the current run is genuinely in progress. Driven by the
   * ProgressPanel (onActiveChange) rather than by `runId !== null`, so a settled,
   * gone, or unknown (stale localStorage) run no longer blocks a new deletion.
   * Defaults to false so a stale restored runId never locks the button on mount.
   */
  const [runInProgress, setRunInProgress] = useState(false);
  const [runTargetIds, setRunTargetIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  /** Interrupted runs the server still holds a checkpoint for. */
  const refreshResumable = useCallback(async () => {
    try {
      const { runs } = await api.getResumableRuns();
      setResumable(runs ?? []);
    } catch {
      /* older server or none reachable — the banner simply stays hidden */
      setResumable([]);
    }
  }, []);

  /* health probe + existing session; the UI stays usable when the server is down */
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await api.getHealth();
        if (cancelled) return;
        setVersion(result.version ?? null);
        setHealth(result.ok ? 'online' : 'offline');
      } catch {
        if (!cancelled) setHealth('offline');
        return;
      }
      try {
        const existing = await api.getSession();
        if (!cancelled) {
          setSession(existing);
          setSessionChecked(true);
        }
      } catch {
        /* no session yet — nothing to restore */
        if (!cancelled) setSessionChecked(true);
      }
      if (!cancelled) await refreshResumable();
    })();
    return () => {
      cancelled = true;
    };
  }, [refreshResumable]);

  useEffect(() => {
    try {
      if (runId) window.localStorage.setItem(RUN_KEY, runId);
      else window.localStorage.removeItem(RUN_KEY);
    } catch {
      /* private mode / storage disabled — reconnect just won't survive a reload */
    }
  }, [runId]);

  useEffect(() => {
    if (!updates) return;
    void updates.getState().then(setUpdateState);
    return updates.onState(setUpdateState);
  }, []);

  const countsReliable = !hasUnreliableCounts(tweets);
  /**
   * Never throws, so a half-typed date cannot blank the app. While this is
   * non-empty `applyFilter` fails closed (0 件) and the delete path is blocked.
   */
  const criteriaErrors = useMemo(() => validateCriteria(criteria), [criteria]);
  const criteriaValid = criteriaErrors.length === 0;
  const filtered = useMemo(() => applyFilter(tweets, criteria), [tweets, criteria]);

  const selectedTweets = useMemo(
    () => filtered.filter((t) => selectedIds.has(t.id)),
    [filtered, selectedIds],
  );

  const deleteGate = deleteButtonState({
    selectedCount: selectedTweets.length,
    runInProgress,
    criteriaValid,
  });

  const handleTweets = useCallback((next: Tweet[]) => {
    setTweets(next);
    setSelectedIds(new Set<string>());
  }, []);

  const toggleOne = useCallback((id: string, selected: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  /** Select-all applies to the CURRENT filtered set only. */
  const toggleAll = useCallback(
    (selected: boolean) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const t of filtered) {
          if (selected) next.add(t.id);
          else next.delete(t.id);
        }
        return next;
      });
    },
    [filtered],
  );

  async function startRun() {
    // Deletion is irreversible: refuse outright rather than act on a filter
    // whose date bounds we could not parse.
    if (!criteriaValid) {
      setStartError('絞り込み条件の日付が正しくありません。修正してから実行してください。');
      return;
    }
    setStarting(true);
    setStartError(null);
    try {
      const { runId: id } = await api.startRun(selectedTweets.map((t) => t.id));
      // Optimistically block the delete button; the panel confirms/clears this
      // via onActiveChange once its first snapshot lands.
      setRunInProgress(true);
      setRunTargetIds(new Set(selectedTweets.map((tweet) => tweet.id)));
      setRunId(id);
      setDryRunOpen(false);
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  /**
   * A resume keeps the original runId, so this reuses the existing runId state
   * (and therefore its localStorage mirror) rather than tracking resumed runs
   * separately. The epoch forces ProgressPanel to re-attach to the same id.
   */
  const handleResumed = useCallback((id: string) => {
    setResumable((prev) => prev.filter((r) => r.runId !== id));
    setRunId(id);
    setRunEpoch((n) => n + 1);
  }, []);

  const handleDiscarded = useCallback(
    (id: string) => {
      setResumable((prev) => prev.filter((r) => r.runId !== id));
      // Nothing left to reconnect to: drop the remembered id too, or the panel
      // sits there reporting an unknown run forever.
      if (runId === id) {
        setRunId(null);
        setRunInProgress(false);
      }
    },
    [runId],
  );

  const handleFinished = useCallback(
    (event: ProgressEvent) => {
      if (event.state === 'done' && runTargetIds.size > 0) {
        setTweets((prev) => prev.filter((tweet) => !runTargetIds.has(tweet.id)));
        setSelectedIds((prev) => new Set([...prev].filter((id) => !runTargetIds.has(id))));
        setRunTargetIds(new Set<string>());
      }
      // A stopped/errored run leaves its checkpoint behind, so it becomes
      // resumable the moment it settles.
      if (event.state === 'stopped' || event.state === 'error') void refreshResumable();
    },
    [refreshResumable, runTargetIds],
  );

  const navigate = (next: Page) => {
    setPage(next);
    setMenuOpen(false);
  };

  return (
    <div className="app">
      <header className="app__head">
        <button
          type="button"
          className="menu-button"
          aria-label="メニューを開く"
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((open) => !open)}
        >
          <span /> <span /> <span />
        </button>
        <div className="app__brand">
          <span className="app__mark" aria-hidden="true"><img src="/icon.png" alt="" /></span>
          <div>
            <h1>twedel</h1>
            <p className="tagline">自分のポストを一括削除するローカル専用ツール</p>
          </div>
        </div>
        <div className="app__status">
          <span className="app-version">v{version ?? '0.4.8'}</span>
        </div>
      </header>

      {(updateState.status === 'available' || updateState.status === 'downloaded') && (
        <div className="update-banner" role="status">
          <span>
            {updateState.status === 'available'
              ? `新しいバージョン v${updateState.version} があります。`
              : `v${updateState.version} の更新準備ができました。`}
          </span>
          <button type="button" className="btn btn--primary" onClick={() => navigate('about')}>
            確認する
          </button>
        </div>
      )}

      {menuOpen && (
        <>
          <button className="menu-backdrop" aria-label="メニューを閉じる" onClick={() => setMenuOpen(false)} />
          <nav className="app-menu" aria-label="メインメニュー">
            <div className="app-menu__title">メニュー</div>
            <button onClick={() => navigate('main')}>ホーム</button>
            <button onClick={() => navigate('settings')}>詳細設定</button>
            <button onClick={() => navigate('updates')}>アップデート内容</button>
            <button onClick={() => navigate('about')}>バージョン情報</button>
          </nav>
        </>
      )}

      {health === 'offline' && (
        <p className="inline-msg inline-msg--warn">
          バックエンド (http://127.0.0.1:5174) に接続できません。<code>npm run dev</code> で起動して
          ください。サンプルデータで画面の確認だけは行えます。
        </p>
      )}

      {page === 'main' && <>
      <ResumeBanner runs={resumable} onResumed={handleResumed} onDiscarded={handleDiscarded} />

      <CredentialsPanel
        session={session}
        onSession={setSession}
        autoHarvest={sessionChecked && !session?.connected}
      />
      <SourcePanel tweets={tweets} onTweets={handleTweets} connected={session?.connected === true} />
      <FilterBar
        criteria={criteria}
        onChange={setCriteria}
        countsReliable={countsReliable}
        errors={criteriaErrors}
      />

      <section className="panel">
        <header className="panel__head">
          <h2>対象の選択</h2>
          <div className="row row--tight">
            <button
              type="button"
              className="btn"
              onClick={() => toggleAll(true)}
              disabled={filtered.length === 0}
            >
              表示中をすべて選択
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => setSelectedIds(new Set<string>())}
              disabled={selectedIds.size === 0}
            >
              選択を解除
            </button>
            <button
              type="button"
              className="btn btn--danger"
              onClick={() => {
                // Belt and braces: the button is already disabled while the
                // criteria are invalid, but the dry-run dialog is the last gate
                // before an irreversible delete.
                if (!criteriaValid) return;
                setStartError(null);
                setDryRunOpen(true);
              }}
              disabled={deleteGate.disabled || session?.connected !== true}
              title={session?.connected !== true ? 'Xへの接続が完了すると削除できます' : deleteGate.title}
            >
              削除を確認 ({selectedTweets.length.toLocaleString()}件)
            </button>
          </div>
        </header>

        <TweetTable
          tweets={filtered}
          selectedIds={selectedIds}
          onToggle={toggleOne}
          onSelectAll={toggleAll}
        />
      </section>

      {runId && (
        <ProgressPanel
          key={`${runId}#${runEpoch}`}
          runId={runId}
          onFinished={handleFinished}
          onActiveChange={setRunInProgress}
          onDismiss={() => {
            setRunId(null);
            setRunInProgress(false);
            setSelectedIds(new Set<string>());
          }}
        />
      )}

      {dryRunOpen && criteriaValid && (
        <DryRunDialog
          tweets={selectedTweets}
          busy={starting}
          error={startError}
          onCancel={() => setDryRunOpen(false)}
          onConfirm={startRun}
        />
      )}
      </>}

      {page === 'settings' && (
        <CredentialsPanel session={session} onSession={setSession} showDetails />
      )}
      {(page === 'updates' || page === 'about') && <AppInfo
        page={page} version={version} updateState={updateState} updateBlocked={runInProgress}
        onCheck={() => void updates?.check()}
        onDownload={() => void updates?.download()}
        onInstall={() => { if (!runInProgress) void updates?.install(); }}
      />}
    </div>
  );
}
