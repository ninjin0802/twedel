import { useEffect, useState } from 'react';
import type { DeleteLogEntry, DeleteStatus } from '@shared/types';
import * as api from '../api';

const STATUS_LABEL: Record<DeleteStatus, string> = {
  pending: '処理待ち',
  deleted: '削除済み',
  already_gone: '既に削除済み',
  failed: '失敗',
};

export function LogViewer() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<DeleteStatus | ''>('');
  const [entries, setEntries] = useState<DeleteLogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setLoading(true);
      try {
        const result = await api.getLog({ q: q || undefined, status: status || undefined });
        if (cancelled) return;
        setEntries(result.entries ?? []);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setEntries([]);
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }, 250);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [q, status, nonce]);

  return (
    <section className="panel">
      <header className="panel__head">
        <h2>削除ログ</h2>
        <a className="btn btn--link" href={api.logCsvUrl({ q: q || undefined, status: status || undefined })}>
          CSV エクスポート
        </a>
      </header>

      <div className="row">
        <label className="field field--grow">
          <span className="field__label">本文検索</span>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="キーワード" />
        </label>
        <label className="field">
          <span className="field__label">状態</span>
          <select value={status} onChange={(e) => setStatus(e.target.value as DeleteStatus | '')}>
            <option value="">すべて</option>
            <option value="pending">処理待ち</option>
            <option value="deleted">削除済み</option>
            <option value="already_gone">既に削除済み</option>
            <option value="failed">失敗</option>
          </select>
        </label>
        <button type="button" className="btn" onClick={() => setNonce((n) => n + 1)}>
          再読み込み
        </button>
      </div>

      {error && <p className="inline-msg inline-msg--error">{error}</p>}

      <div className="logtable">
        <table>
          <thead>
            <tr>
              <th>日時</th>
              <th>投稿日</th>
              <th>種別</th>
              <th>状態</th>
              <th>本文 / エラー</th>
            </tr>
          </thead>
          <tbody>
            {entries.length === 0 && !loading && (
              <tr>
                <td colSpan={5} className="logtable__empty">
                  ログはまだありません。
                </td>
              </tr>
            )}
            {entries.map((entry) => (
              <tr key={`${entry.runId}:${entry.id}:${entry.at}`}>
                <td className="nowrap">{entry.at.replace('T', ' ').slice(0, 19)}</td>
                <td className="nowrap">{entry.createdAt.slice(0, 10)}</td>
                <td className="nowrap">{entry.isRetweet ? 'リポスト' : 'ポスト'}</td>
                <td className="nowrap">
                  <span className={`badge badge--status badge--${entry.status}`}>
                    {STATUS_LABEL[entry.status]}
                  </span>
                </td>
                <td className="logtable__text">
                  {entry.text}
                  {entry.error && <span className="logtable__error"> — {entry.error}</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
