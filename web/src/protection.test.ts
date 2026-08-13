import { describe, expect, it } from 'vitest';
import type { Tweet } from '@shared/types';
import { PROTECTED_POSTS_KEY, includePinnedPosts, protectionScope, readProtectedPosts, writeProtectedPosts } from './protection';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
}

function tweet(id: string, isPinned = false, isLike = false): Tweet {
  return { id, createdAt: '', text: '', likeCount: 0, retweetCount: 0, isReply: false, isRetweet: false,
    hasMedia: false, source: 'live', countsReliable: true, isPinned, isLike };
}

describe('protected posts', () => {
  it('keeps exclusions separate for each account', () => {
    const storage = memoryStorage();
    writeProtectedPosts(storage, 'account-a', new Set(['1', '2']));
    writeProtectedPosts(storage, 'account-b', new Set(['3']));
    expect([...readProtectedPosts(storage, 'account-a')]).toEqual(['1', '2']);
    expect([...readProtectedPosts(storage, 'account-b')]).toEqual(['3']);
    expect(storage.getItem(PROTECTED_POSTS_KEY)).not.toContain('undefined');
  });

  it('uses the stable user id before the changeable screen name', () => {
    expect(protectionScope('123', 'OldName')).toBe('123');
    expect(protectionScope(undefined, 'MixedCase')).toBe('@mixedcase');
  });

  it('automatically protects pinned own posts but not liked rows', () => {
    expect([...includePinnedPosts(new Set(['old']), [tweet('pin', true), tweet('like', true, true)])])
      .toEqual(['old', 'pin']);
  });

  it('fails closed to an empty set when saved preferences are corrupt', () => {
    const storage = memoryStorage();
    storage.setItem(PROTECTED_POSTS_KEY, '{broken');
    expect(readProtectedPosts(storage, 'account-a').size).toBe(0);
  });
});
