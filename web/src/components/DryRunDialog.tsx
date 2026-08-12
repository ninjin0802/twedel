import { useEffect, useRef, useState } from 'react';
import type { Tweet } from '@shared/types';
import { summarize } from '../filter';

interface Props {
  tweets: Tweet[];
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function DryRunDialog({ tweets, busy, error, onCancel, onConfirm }: Props) {
  const [typed, setTyped] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const stats = summarize(tweets);
  const expected = String(stats.total);
  const armed = typed.trim() === expected && stats.total > 0 && !busy;

  // Likes are UN-LIKED (いいね解除), not deleted - a distinction worth stating
  // plainly. `tweetCount` is everything that is not a like.
  const likeCount = stats.likes;
  const tweetCount = stats.total - likeCount;
  const allLikes = likeCount > 0 && tweetCount === 0;
  const mixed = likeCount > 0 && tweetCount > 0;
  const actionLabel = allLikes ? 'いいねを解除する' : '削除する';

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div className="modal-backdrop" role="presentation" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dryrun-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="dryrun-title">最終確認 (ドライラン)</h2>

        {allLikes ? (
          <p className="danger-banner">
            この操作は取り消せません。選択した {likeCount.toLocaleString()} 件はいいね解除されます（削除では
            ありません）。解除するとその投稿をいいねした記録は残りません。
          </p>
        ) : (
          <p className="danger-banner">
            この操作は取り消せません。削除されたポストは X から復元できません。
          </p>
        )}

        <dl className="kv">
          <div>
            <dt>{allLikes ? 'いいね解除の対象' : '対象'}</dt>
            <dd>
              <b className="big">{stats.total.toLocaleString()}</b> 件
            </dd>
          </div>
          <div>
            <dt>内訳</dt>
            <dd>
              {allLikes ? (
                <>いいね {likeCount.toLocaleString()}</>
              ) : mixed ? (
                <>
                  ポスト {tweetCount.toLocaleString()}（通常ポスト {stats.originals.toLocaleString()} / 返信{' '}
                  {stats.replies.toLocaleString()} / リポスト {stats.retweets.toLocaleString()}） / いいね{' '}
                  {likeCount.toLocaleString()}
                </>
              ) : (
                <>
                  通常ポスト {stats.originals.toLocaleString()} / 返信 {stats.replies.toLocaleString()} / リポスト{' '}
                  {stats.retweets.toLocaleString()}
                </>
              )}
            </dd>
          </div>
          <div>
            <dt>期間</dt>
            <dd>
              {stats.oldest?.slice(0, 10) ?? '—'} 〜 {stats.newest?.slice(0, 10) ?? '—'}
            </dd>
          </div>
        </dl>

        {mixed && (
          <p className="inline-msg inline-msg--warn">
            いいね {likeCount.toLocaleString()} 件が含まれています。これらは「削除」ではなく
            いいね解除 として処理されます。
          </p>
        )}

        {!allLikes && stats.retweets > 0 && (
          <p className="inline-msg inline-msg--warn">
            リポスト {stats.retweets.toLocaleString()} 件が含まれています。これらは「削除」ではなく
            リポストの取り消しとして処理されます。元の投稿者のポストは残ります。
          </p>
        )}

        <div className="sample">
          <div className="sample__label">先頭 {Math.min(5, tweets.length)} 件のプレビュー</div>
          <ul>
            {tweets.slice(0, 5).map((t) => (
              <li key={t.id}>
                <span className="sample__date">{t.createdAt.slice(0, 10)}</span>
                <span className="sample__text">{t.text}</span>
              </li>
            ))}
          </ul>
        </div>

        <label className="field">
          <span className="field__label">
            実行するには件数 <code>{expected}</code> をそのまま入力してください
          </span>
          <input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={expected}
          />
        </label>

        {error && <p className="inline-msg inline-msg--error">{error}</p>}

        <div className="modal__actions">
          <button type="button" className="btn" onClick={onCancel} disabled={busy}>
            キャンセル
          </button>
          <button type="button" className="btn btn--danger" onClick={onConfirm} disabled={!armed}>
            {busy ? '開始中…' : `${stats.total.toLocaleString()}件を${actionLabel}`}
          </button>
        </div>
      </div>
    </div>
  );
}
