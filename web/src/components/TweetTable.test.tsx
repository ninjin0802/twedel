import { describe, expect, it } from 'vitest';
import type { Tweet } from '@shared/types';
import { badgeOf } from './TweetTable';

/**
 * The table virtualizes its rows (no rows render without a real scroll element,
 * so `react-dom/server` shows an empty body), so the chip is asserted through the
 * pure `badgeOf` helper the rows use - the same chip system as 原文/リプライ/RT.
 */
function tweet(over: Partial<Tweet> & { id: string }): Tweet {
  return {
    createdAt: '2020-06-15T12:00:00.000Z',
    text: 'x',
    likeCount: 0,
    retweetCount: 0,
    isReply: false,
    isRetweet: false,
    hasMedia: false,
    source: 'archive',
    countsReliable: false,
    ...over,
  };
}

describe('badgeOf', () => {
  it('gives a like row its own いいね chip', () => {
    const badge = badgeOf(tweet({ id: '1', isLike: true, createdAt: '' }));
    expect(badge.label).toBe('いいね');
    expect(badge.className).toContain('badge--like');
  });

  it('never mislabels a like as 原文, even when other flags are set', () => {
    // A liked tweet that happens to be a retweet is still just a like.
    const badge = badgeOf(tweet({ id: '1', isLike: true, isRetweet: true }));
    expect(badge.label).toBe('いいね');
    expect(badge.label).not.toBe('原文');
    expect(badge.label).not.toBe('RT');
  });

  it('keeps the existing chips for ordinary rows', () => {
    expect(badgeOf(tweet({ id: '1' })).label).toBe('原文');
    expect(badgeOf(tweet({ id: '2', isReply: true })).label).toBe('リプライ');
    expect(badgeOf(tweet({ id: '3', isRetweet: true })).label).toBe('RT');
  });
});
