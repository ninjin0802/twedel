import { useEffect, useMemo, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { Tweet } from '@shared/types';
import { categoryOf } from '../filter';

interface Props {
  tweets: Tweet[];
  selectedIds: ReadonlySet<string>;
  onToggle: (id: string, selected: boolean) => void;
  onSelectAll: (selected: boolean) => void;
}

const ROW_HEIGHT = 40;

export function badgeOf(tweet: Tweet): { label: string; className: string } {
  const category = categoryOf(tweet);
  // A like must NEVER be labelled 原文: it is someone else's tweet the account
  // favorited, not one of its own posts. Checked first, matching categoryOf.
  if (category === 'like') return { label: 'いいね', className: 'badge badge--like' };
  if (category === 'retweet') return { label: 'RT', className: 'badge badge--rt' };
  if (category === 'reply') return { label: 'リプライ', className: 'badge badge--reply' };
  return { label: '原文', className: 'badge badge--original' };
}

const UNRELIABLE_TITLE =
  'この取得元ではいいね／RT の正確な数値がありません（X のアーカイブは常に 0 で記録されます）。';

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

export function TweetTable({ tweets, selectedIds, onToggle, onSelectAll }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const headCheckRef = useRef<HTMLInputElement>(null);

  const selectedInView = useMemo(
    () => tweets.reduce((acc, t) => (selectedIds.has(t.id) ? acc + 1 : acc), 0),
    [tweets, selectedIds],
  );

  const allSelected = tweets.length > 0 && selectedInView === tweets.length;
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
            disabled={tweets.length === 0}
            onChange={(e) => onSelectAll(e.target.checked)}
            aria-label="表示中のすべてを選択"
          />
        </label>
        <span className="table__cell table__cell--date">日付</span>
        <span className="table__cell table__cell--type">種別</span>
        <span className="table__cell table__cell--text">本文</span>
        <span className="table__cell table__cell--num">いいね</span>
        <span className="table__cell table__cell--num">RT</span>
      </div>

      <div className="table__counter">
        {tweets.length.toLocaleString()}件中<b>{selectedInView.toLocaleString()}</b>件を選択中
      </div>

      <div className="table__body" ref={scrollRef}>
        {tweets.length === 0 ? (
          <p className="table__empty">条件に一致するツイートがありません。</p>
        ) : (
          <div className="table__spacer" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((row) => {
              const tweet = tweets[row.index]!;
              const badge = badgeOf(tweet);
              const checked = selectedIds.has(tweet.id);
              return (
                <div
                  key={tweet.id}
                  className={`table__row${checked ? ' is-selected' : ''}`}
                  style={{ height: row.size, transform: `translateY(${row.start}px)` }}
                >
                  <label className="table__cell table__cell--check">
                    <input
                      type="checkbox"
                      checked={checked}
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
