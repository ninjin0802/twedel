import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Tweet } from '@shared/types';
import { categoryOf } from '../filter';

interface Props {
  tweets: Tweet[];
  selectedIds: ReadonlySet<string>;
  protectedIds: ReadonlySet<string>;
  onToggle: (id: string, selected: boolean) => void;
  onSelectAll: (selected: boolean) => void;
  onProtect: (id: string, protect: boolean) => void;
}

const ROW_HEIGHT = 40;

export function badgeOf(tweet: Tweet): { label: string; className: string } {
  const category = categoryOf(tweet);
  // A like must NEVER be labelled ポスト: it is someone else's post the account
  // favorited, not one of its own posts. Checked first, matching categoryOf.
  if (category === 'like') return { label: 'いいね', className: 'badge badge--like' };
  if (category === 'retweet') return { label: 'リポスト', className: 'badge badge--rt' };
  if (category === 'reply') return { label: '返信', className: 'badge badge--reply' };
  return { label: 'ポスト', className: 'badge badge--original' };
}

const UNRELIABLE_TITLE =
  'この取得元ではいいね／リポストの正確な数値がありません（X のアーカイブは常に0で記録されます）。';

function renderCount(value: number | null, reliable: boolean) {
  if (!reliable) {
    return (
      <span className="count-unknown" title={UNRELIABLE_TITLE}>
        ?
      </span>
    );
  }
  return value === null ? '—' : value.toLocaleString();
}

export function TweetTable({ tweets, selectedIds, protectedIds, onToggle, onSelectAll, onProtect }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const headCheckRef = useRef<HTMLInputElement>(null);

  const selectedInView = useMemo(
    () => tweets.reduce((acc, t) => (selectedIds.has(t.id) ? acc + 1 : acc), 0),
    [tweets, selectedIds],
  );

  const selectableCount = useMemo(() => tweets.reduce((n, t) => n + (protectedIds.has(t.id) ? 0 : 1), 0), [tweets, protectedIds]);
  const allSelected = selectableCount > 0 && selectedInView === selectableCount;
  const someSelected = selectedInView > 0 && !allSelected;

  useEffect(() => {
    if (headCheckRef.current) headCheckRef.current.indeterminate = someSelected;
  }, [someSelected]);

  const virtualizer = useVirtualizer({
    count: tweets.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  return (
    <div className="table">
      <div className="table__scroll">
      <div className="table__head">
        <label className="table__cell table__cell--check">
          <input
            ref={headCheckRef}
            type="checkbox"
            checked={allSelected}
            disabled={selectableCount === 0}
            onChange={(e) => onSelectAll(e.target.checked)}
            aria-label="表示中のすべてを選択"
          />
        </label>
        <span className="table__cell table__cell--date">日付</span>
        <span className="table__cell table__cell--type">種別</span>
        <span className="table__cell table__cell--text">本文</span>
        <span className="table__cell table__cell--num">いいね</span>
        <span className="table__cell table__cell--num">リポスト</span>
        <span className="table__cell table__cell--protect">保護</span>
      </div>

      <div className="table__counter">
        {tweets.length.toLocaleString()}件中<b>{selectedInView.toLocaleString()}</b>件を選択中
        {protectedIds.size > 0 && <span className="table__protected-count">・保護 {tweets.filter((t) => protectedIds.has(t.id)).length.toLocaleString()}件</span>}
      </div>

      <div className="table__body" ref={scrollRef}>
        {tweets.length === 0 ? (
          <p className="table__empty">条件に一致するポストがありません。</p>
        ) : (
          <div className="table__spacer" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const tweet = tweets[row.index]!;
              const badge = badgeOf(tweet);
              const checked = selectedIds.has(tweet.id);
              const protectedPost = protectedIds.has(tweet.id);
              return (
                <div
                  key={tweet.id}
                  className={`table__row${checked ? ' is-selected' : ''}${protectedPost ? ' is-protected' : ''}`}
                  style={{ height: row.size, transform: `translateY(${row.start}px)` }}
                >
                  <label className="table__cell table__cell--check">
                    <input
                      type="checkbox"
                      checked={checked}
                      disabled={protectedPost}
                      onChange={(e) => onToggle(tweet.id, e.target.checked)}
                      aria-label={`${tweet.id} を選択`}
                    />
                  </label>
                  <span className="table__cell table__cell--date">
                    {tweet.createdAt ? tweet.createdAt.slice(0, 10) : '—'}
                  </span>
                  <span className="table__cell table__cell--type">
                    <span className={badge.className}>{badge.label}</span>
                    {tweet.hasMedia && <span className="badge badge--media">メディア</span>}
                  </span>
                  <span className="table__cell table__cell--text" title={tweet.text}>
                    {tweet.text}
                  </span>
                  <span className="table__cell table__cell--num">
                    {renderCount(tweet.likeCount, tweet.countsReliable)}
                  </span>
                  <span className="table__cell table__cell--num">
                    {renderCount(tweet.retweetCount, tweet.countsReliable)}
                  </span>
                  <span className="table__cell table__cell--protect">
                    <button
                      type="button"
                      className={`protect-button${protectedPost ? ' is-active' : ''}`}
                      onClick={() => onProtect(tweet.id, !protectedPost)}
                      aria-pressed={protectedPost}
                      aria-label={`${tweet.id} の保護を${protectedPost ? '解除' : '有効化'}`}
                      title={protectedPost ? '保護を解除' : '削除対象から保護'}
                    >{protectedPost ? '🔒' : '🔓'}</button>
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
      </div>
    </div>
  );
}
