import { useEffect, useRef, useState } from 'react';
import type { Tweet } from '@shared/types';
import * as api from '../api';
import { summarize } from '../filter';
import { makeSampleTweets } from '../sample';

interface Props {
  tweets: Tweet[];
  onTweets: (tweets: Tweet[]) => void;
  connected?: boolean;
}

function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  return iso.slice(0, 10);
}

export function SourcePanel({ tweets, onTweets, connected = false }: Props) {
  const [path, setPath] = useState('');
  const [max, setMax] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filesRead, setFilesRead] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<{ file: string; reason: string }[]>([]);
  const [fetched, setFetched] = useState<number | null>(null);
  const [fetchStage, setFetchStage] = useState<string | null>(null);

  const unsubRef = useRef<(() => void) | null>(null);
  useEffect(() => () => unsubRef.current?.(), []);

  async function loadArchive() {
    if (!path.trim()) {
      setError('ZIP ファイルまたは展開済みフォルダの絶対パスを入力してください。');
      return;
    }
    setBusy(true);
    setError(null);
    setFetched(null);
    try {
      const result = await api.loadArchive(path.trim(), 'all');
      setFilesRead(result.filesRead ?? []);
      setSkipped(result.skipped ?? []);
      onTweets(result.tweets ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function loadLive() {
    setBusy(true);
    setError(null);
    setFilesRead([]);
    setSkipped([]);
    setFetched(0);
    setFetchStage('取得を開始しています…');
    try {
      const parsed = Number.parseInt(max, 10);
      const { jobId } = await api.startLiveFetch(
        Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
        'all',
      );

      await new Promise<void>((resolve, reject) => {
        unsubRef.current = api.subscribe<api.LiveProgress>(
          api.liveEventsUrl(jobId),
          (ev) => {
            setFetched(ev.fetched);
            setFetchStage(`${ev.operation ?? '取得中'}・${ev.cursorPage}ページ`);
            if (ev.error) {
              unsubRef.current?.();
              reject(new Error(ev.error));
              return;
            }
            if (ev.done) {
              unsubRef.current?.();
              resolve();
            }
          },
          (err) => {
            unsubRef.current?.();
            reject(err);
          },
        );
      });

      const { tweets: result } = await api.getLiveResult(jobId);
      onTweets(result ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      unsubRef.current = null;
      setBusy(false);
      setFetchStage(null);
    }
  }

  function loadSample() {
    setError(null);
    setFilesRead([]);
    setSkipped([]);
    setFetched(null);
    onTweets(makeSampleTweets(10000, false));
  }

  const stats = summarize(tweets);
  return (
    <section className="panel source-panel source-panel--unified">
      <header className="panel__head">
        <div><h2>まとめて取得</h2><p className="panel__subtitle">自分のポストといいねを一度に読み込みます</p></div>
      </header>
      <div className="source-kinds" aria-label="取得対象">
        <span><b>投稿</b><small>通常ポスト・返信・リポスト</small></span>
        <span className="source-kinds__plus">＋</span>
        <span><b>いいね</b><small>いいね解除できる投稿</small></span>
      </div>

      {/* Primary path: fetch live from X via the saved session. */}
      <div className="row">
        <label className="field">
          <span className="field__label">取得件数 (任意)</span>
          <input
            type="number"
            min={1}
            value={max}
            onChange={(e) => setMax(e.target.value)}
            placeholder="未指定なら全件"
          />
        </label>
        <button type="button" className="btn btn--primary" onClick={loadLive} disabled={busy || !connected}>
          {busy ? 'まとめて取得中…' : 'ポストといいねを取得'}
        </button>
        {busy && fetched !== null && <span className="live-count">取得中… {fetched}件{fetchStage ? `（${fetchStage}）` : ''}</span>}
      </div>
      {!connected && <p className="inline-msg inline-msg--waiting">Xへの接続が完了すると取得できます。</p>}
      <p className="hint">Xから自分のポストを取得したあと、いいねした投稿も続けて取得します。取得件数はそれぞれに適用されます。</p>

      {/* Archive import + sample data: secondary, tucked away but fully functional. */}
      <details className="disclosure">
        <summary>その他の取得方法（アーカイブZIP）</summary>
        <div className="row">
          <label className="field field--grow">
            <span className="field__label">アーカイブのパス (絶対パス)</span>
            <input
              type="text"
              spellCheck={false}
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="C:\Users\you\Downloads\twitter-2025-01-01.zip"
            />
          </label>
          <button type="button" className="btn" onClick={loadArchive} disabled={busy}>
            {busy ? '読み込み中…' : '読み込み'}
          </button>
        </div>
        <p className="hint">
          X からダウンロードした ZIP か展開済みフォルダを指定します。
          ポストといいねの両方を読み込みます。アーカイブのいいねには日時がなく、反応数も正確ではないため、一部の絞り込みは利用できません。
        </p>
        <p className="hint">
          バックエンド未接続でも画面を確認できます:{' '}
          <button type="button" className="btn btn--link" onClick={loadSample}>
            サンプルデータを読み込む (10,000件)
          </button>
        </p>
      </details>

      {error && <p className="inline-msg inline-msg--error">{error}</p>}

      {filesRead.length > 0 && (
        <p className="inline-msg inline-msg--ok">読み込んだファイル: {filesRead.join(', ')}</p>
      )}

      {skipped.length > 0 && (
        <details className="disclosure disclosure--warn">
          <summary>スキップされたファイル {skipped.length} 件</summary>
          <ul className="hint hint--list">
            {skipped.map((s) => (
              <li key={s.file}>
                <code>{s.file}</code> — {s.reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {tweets.length > 0 && (
        <p className="summary">
          合計 <b>{stats.total.toLocaleString()}</b> 件
          {' '}/ 通常ポスト {stats.originals.toLocaleString()} ・ 返信 {stats.replies.toLocaleString()} ・ リポスト {stats.retweets.toLocaleString()} ・ いいね {stats.likes.toLocaleString()}{' '}
          / {fmtDate(stats.oldest)} 〜 {fmtDate(stats.newest)}
        </p>
      )}
    </section>
  );
}
