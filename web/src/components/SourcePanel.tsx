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
  /** What to fetch: the account's own tweets (default) or its likes to un-favorite. */
  const [source, setSource] = useState<api.FetchSource>('tweets');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filesRead, setFilesRead] = useState<string[]>([]);
  const [skipped, setSkipped] = useState<{ file: string; reason: string }[]>([]);
  const [fetched, setFetched] = useState<number | null>(null);

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
      const result = await api.loadArchive(path.trim(), source);
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
    try {
      const parsed = Number.parseInt(max, 10);
      const { jobId } = await api.startLiveFetch(
        Number.isFinite(parsed) && parsed > 0 ? parsed : undefined,
        source,
      );

      await new Promise<void>((resolve, reject) => {
        unsubRef.current = api.subscribe<api.LiveProgress>(
          api.liveEventsUrl(jobId),
          (ev) => {
            setFetched(ev.fetched);
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
  const isLikes = source === 'likes';

  return (
    <section className="panel">
      <header className="panel__head">
        <h2>取得</h2>
      </header>

      {/* What to fetch: the account's own tweets, or its likes to un-favorite.
          Applies to BOTH the live fetch and the archive import below. */}
      <div className="row row--tight" role="radiogroup" aria-label="読み込む対象">
        <label className="field field--inline">
          <input
            type="radio"
            name="source"
            checked={!isLikes}
            disabled={busy}
            onChange={() => setSource('tweets')}
          />
          <span>自分のツイート</span>
        </label>
        <label className="field field--inline">
          <input
            type="radio"
            name="source"
            checked={isLikes}
            disabled={busy}
            onChange={() => setSource('likes')}
          />
          <span>いいね</span>
        </label>
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
          {busy ? '取得中…' : isLikes ? 'いいねを取得' : 'ライブ取得'}
        </button>
        {busy && fetched !== null && <span className="live-count">取得中… {fetched}件</span>}
      </div>
      {!connected && <p className="inline-msg inline-msg--waiting">Xへの接続が完了すると取得できます。</p>}
      <p className="hint">
        {isLikes
          ? 'X の API からいいねした投稿を直接取得します。これらは「削除」ではなくいいね解除の対象です（①で認証が必要です）。'
          : 'X の API から最新のツイートを直接取得します（①で認証が必要です）。'}
      </p>

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
          {isLikes
            ? '「いいね」を選択中は data/like.js を読み込みます。アーカイブのいいねには日時が記録されないため、期間では絞り込めません。'
            : '全期間のツイートを扱える唯一の方法ですが、いいね／RT 数は 0 で記録されるため、その 2 つでは絞り込めません。'}
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
          {stats.likes > 0 ? (
            <> / いいね {stats.likes.toLocaleString()}</>
          ) : (
            <>
              {' '}
              / 原文 {stats.originals.toLocaleString()} ・ リプライ {stats.replies.toLocaleString()} ・ RT{' '}
              {stats.retweets.toLocaleString()}
            </>
          )}{' '}
          / {fmtDate(stats.oldest)} 〜 {fmtDate(stats.newest)}
        </p>
      )}
    </section>
  );
}
