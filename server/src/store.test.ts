import { beforeEach, describe, expect, it } from 'vitest';
import type { Tweet } from '../../shared/types.js';
import { allTweets, clearTweets, getMany, getTweet, mergeTweets, setTweets, tweetCount } from './store.js';

function tweet(id: string, overrides: Partial<Tweet> = {}): Tweet {
  return {
    id,
    createdAt: '2020-01-01T00:00:00.000Z',
    text: `tweet ${id}`,
    likeCount: null,
    retweetCount: null,
    isReply: false,
    isRetweet: false,
    hasMedia: false,
    source: 'archive',
    countsReliable: false,
    ...overrides,
  };
}

beforeEach(() => {
  clearTweets();
});

describe('store', () => {
  it('replaces the whole set when a new source is loaded', () => {
    setTweets([tweet('1'), tweet('2')]);
    setTweets([tweet('3')]);

    expect(tweetCount()).toBe(1);
    expect(getTweet('1')).toBeUndefined();
    expect(getTweet('3')?.text).toBe('tweet 3');
  });

  it('merges without discarding what is already loaded', () => {
    setTweets([tweet('1')]);
    mergeTweets([tweet('2'), tweet('1', { text: 'updated' })]);

    expect(tweetCount()).toBe(2);
    expect(getTweet('1')?.text).toBe('updated');
  });

  it('deduplicates by id on load', () => {
    setTweets([tweet('1'), tweet('1', { text: 'second copy' })]);
    expect(tweetCount()).toBe(1);
    expect(getTweet('1')?.text).toBe('second copy');
  });

  it('reports missing ids rather than silently dropping them', () => {
    setTweets([tweet('1'), tweet('2')]);
    const { found, missing } = getMany(['1', 'nope', '2']);

    expect(found.map((t) => t.id)).toEqual(['1', '2']);
    expect(missing).toEqual(['nope']);
  });

  it('preserves isRetweet, which decides delete vs unretweet', () => {
    setTweets([tweet('1', { isRetweet: true })]);
    expect(getMany(['1']).found[0]?.isRetweet).toBe(true);
  });

  it('returns everything in insertion order', () => {
    setTweets([tweet('9'), tweet('4'), tweet('7')]);
    expect(allTweets().map((t) => t.id)).toEqual(['9', '4', '7']);
  });

  it('clears', () => {
    setTweets([tweet('1')]);
    clearTweets();
    expect(tweetCount()).toBe(0);
    expect(getMany(['1']).missing).toEqual(['1']);
  });
});
