import { describe, expect, it } from 'vitest';
import type { FilterCriteria, Tweet } from '@shared/types';
import {
  DEFAULT_CRITERIA,
  applyFilter,
  categoryOf,
  matchesFilter,
  summarize,
  validateCriteria,
} from './filter';

function tweet(overrides: Partial<Tweet> = {}): Tweet {
  return {
    id: '1',
    createdAt: '2020-06-15T12:00:00.000Z',
    text: 'hello world',
    likeCount: 0,
    retweetCount: 0,
    isReply: false,
    isRetweet: false,
    hasMedia: false,
    source: 'live',
    countsReliable: true,
    ...overrides,
  };
}

function criteria(overrides: Partial<FilterCriteria> = {}): FilterCriteria {
  return { ...DEFAULT_CRITERIA, includeRetweets: true, ...overrides };
}

describe('categoryOf', () => {
  it('gives every tweet exactly one category, retweet winning over reply', () => {
    expect(categoryOf(tweet())).toBe('original');
    expect(categoryOf(tweet({ isReply: true }))).toBe('reply');
    expect(categoryOf(tweet({ isRetweet: true }))).toBe('retweet');
    expect(categoryOf(tweet({ isRetweet: true, isReply: true }))).toBe('retweet');
  });
});

describe('category gates', () => {
  it('drops originals when includeOriginals is false', () => {
    expect(matchesFilter(tweet(), criteria({ includeOriginals: false }))).toBe(false);
    expect(matchesFilter(tweet(), criteria({ includeOriginals: true }))).toBe(true);
  });

  it('drops replies when includeReplies is false', () => {
    const t = tweet({ isReply: true });
    expect(matchesFilter(t, criteria({ includeReplies: false }))).toBe(false);
    expect(matchesFilter(t, criteria({ includeReplies: true }))).toBe(true);
  });

  it('drops retweets when includeRetweets is false', () => {
    const t = tweet({ isRetweet: true });
    expect(matchesFilter(t, criteria({ includeRetweets: false }))).toBe(false);
    expect(matchesFilter(t, criteria({ includeRetweets: true }))).toBe(true);
  });

  it('judges a reply-flagged retweet only by the retweet flag', () => {
    const t = tweet({ isRetweet: true, isReply: true });
    // replies excluded but retweets included -> still kept
    expect(matchesFilter(t, criteria({ includeReplies: false, includeRetweets: true }))).toBe(true);
    // retweets excluded but replies included -> dropped
    expect(matchesFilter(t, criteria({ includeReplies: true, includeRetweets: false }))).toBe(false);
  });
});

describe('media gate', () => {
  it('drops media tweets only when includeMediaTweets is false', () => {
    const t = tweet({ hasMedia: true });
    expect(matchesFilter(t, criteria({ includeMediaTweets: true }))).toBe(true);
    expect(matchesFilter(t, criteria({ includeMediaTweets: false }))).toBe(false);
    expect(matchesFilter(tweet(), criteria({ includeMediaTweets: false }))).toBe(true);
  });
});

describe('date bounds (UTC, inclusive at both ends)', () => {
  it('keeps a tweet at exactly T00:00:00.000Z of `from`', () => {
    const t = tweet({ createdAt: '2020-06-15T00:00:00.000Z' });
    expect(matchesFilter(t, criteria({ from: '2020-06-15' }))).toBe(true);
  });

  it('keeps a tweet at exactly T23:59:59.999Z of `to`', () => {
    const t = tweet({ createdAt: '2020-06-15T23:59:59.999Z' });
    expect(matchesFilter(t, criteria({ to: '2020-06-15' }))).toBe(true);
  });

  it('keeps a single-day range that starts and ends on the tweet day', () => {
    const start = tweet({ createdAt: '2020-06-15T00:00:00.000Z' });
    const end = tweet({ createdAt: '2020-06-15T23:59:59.999Z' });
    const c = criteria({ from: '2020-06-15', to: '2020-06-15' });
    expect(matchesFilter(start, c)).toBe(true);
    expect(matchesFilter(end, c)).toBe(true);
  });

  it('drops one millisecond before `from`', () => {
    const t = tweet({ createdAt: '2020-06-14T23:59:59.999Z' });
    expect(matchesFilter(t, criteria({ from: '2020-06-15' }))).toBe(false);
  });

  it('drops one millisecond after `to`', () => {
    const t = tweet({ createdAt: '2020-06-16T00:00:00.000Z' });
    expect(matchesFilter(t, criteria({ to: '2020-06-15' }))).toBe(false);
  });

  it('interprets the bounds in UTC, not in local time', () => {
    // 2020-06-15T22:00:00Z is 2020-06-16 07:00 in JST; UTC interpretation must keep it.
    const t = tweet({ createdAt: '2020-06-15T22:00:00.000Z' });
    expect(matchesFilter(t, criteria({ from: '2020-06-15', to: '2020-06-15' }))).toBe(true);
  });

  it('treats missing bounds as unbounded', () => {
    const t = tweet({ createdAt: '1999-01-01T00:00:00.000Z' });
    expect(matchesFilter(t, criteria())).toBe(true);
  });

  it('treats undefined, empty and whitespace-only bounds as no bound', () => {
    const t = tweet({ createdAt: '1999-01-01T00:00:00.000Z' });
    expect(matchesFilter(t, criteria({ from: '', to: '' }))).toBe(true);
    expect(matchesFilter(t, criteria({ from: undefined, to: undefined }))).toBe(true);
    expect(matchesFilter(t, criteria({ from: '   ', to: '   ' }))).toBe(true);
    expect(validateCriteria(criteria({ from: '', to: '   ' }))).toEqual([]);
  });

  it('tolerates surrounding whitespace and a full ISO timestamp, like the server', () => {
    const t = tweet({ createdAt: '2020-06-15T12:00:00.000Z' });
    expect(matchesFilter(t, criteria({ from: '  2020-06-15  ', to: ' 2020-06-15 ' }))).toBe(true);
    expect(
      matchesFilter(t, criteria({ from: '2020-06-15T08:00:00.000Z', to: '2020-06-15T08:00:00.000Z' })),
    ).toBe(true);
  });

  it('yields nothing when from is later than to', () => {
    const t = tweet({ createdAt: '2020-06-15T12:00:00.000Z' });
    expect(applyFilter([t], criteria({ from: '2020-07-01', to: '2020-01-01' }))).toEqual([]);
  });
});

/**
 * A bound the code cannot parse must never be read as "no bound": that widens
 * the delete set to every loaded tweet, and the number the user confirms in the
 * dry-run dialog comes from exactly this code path.
 */
describe('malformed date bounds fail closed', () => {
  // Every one of these makes Date.parse return NaN (or, for the calendar cases,
  // silently roll over into the next month).
  const MALFORMED = [
    '2020-6-5',
    '2020/06/15',
    '06/15/2020',
    '20200615',
    '2020-13-01',
    'yesterday',
    '2020-06',
    '2020-06-15-01',
    'x',
    '--',
  ];

  const ROLLOVER = ['2020-06-31', '2019-02-29', '2020-02-30', '2020-04-31', '2020-00-10', '2020-06-00'];

  const tweets = [
    tweet({ id: 'a', createdAt: '2020-01-01T00:00:00.000Z' }),
    tweet({ id: 'b', createdAt: '2020-06-15T12:00:00.000Z' }),
    tweet({ id: 'c', createdAt: '2021-01-01T00:00:00.000Z' }),
  ];

  for (const bad of [...MALFORMED, ...ROLLOVER]) {
    it(`returns an EMPTY set (never the unfiltered set) for from=${JSON.stringify(bad)}`, () => {
      expect(applyFilter(tweets, criteria({ from: bad }))).toEqual([]);
      expect(matchesFilter(tweets[1]!, criteria({ from: bad }))).toBe(false);
    });

    it(`returns an EMPTY set (never the unfiltered set) for to=${JSON.stringify(bad)}`, () => {
      expect(applyFilter(tweets, criteria({ to: bad }))).toEqual([]);
      expect(matchesFilter(tweets[1]!, criteria({ to: bad }))).toBe(false);
    });
  }

  it('does not let a bad bound leak in through the other fields either', () => {
    // Criteria that would otherwise keep everything.
    expect(applyFilter(tweets, criteria({ from: 'yesterday', keyword: '' }))).toEqual([]);
    expect(applyFilter(tweets, criteria({ to: '2020-06-31', maxLikes: null }))).toEqual([]);
  });

  it('accepts a real leap day', () => {
    const leap = tweet({ id: 'leap', createdAt: '2020-02-29T12:00:00.000Z' });
    expect(validateCriteria(criteria({ from: '2020-02-29', to: '2020-02-29' }))).toEqual([]);
    expect(applyFilter([leap], criteria({ from: '2020-02-29', to: '2020-02-29' })).map((t) => t.id)).toEqual([
      'leap',
    ]);
  });
});

describe('validateCriteria', () => {
  it('reports no error for valid or absent bounds', () => {
    expect(validateCriteria(criteria())).toEqual([]);
    expect(validateCriteria(criteria({ from: '2020-01-01', to: '2020-12-31' }))).toEqual([]);
    expect(validateCriteria(criteria({ from: '2020-02-29' }))).toEqual([]);
    // A from later than to is a legitimate (if empty) selection, not an input error.
    expect(validateCriteria(criteria({ from: '2021-01-01', to: '2020-01-01' }))).toEqual([]);
  });

  it('blames the offending field, with a non-empty message', () => {
    for (const bad of ['2020-6-5', '2020/06/15', '06/15/2020', '20200615', '2020-13-01', 'yesterday']) {
      const fromErrors = validateCriteria(criteria({ from: bad }));
      expect(fromErrors.map((e) => e.field), `from=${bad}`).toEqual(['from']);
      expect(fromErrors[0]!.message.length).toBeGreaterThan(0);

      const toErrors = validateCriteria(criteria({ to: bad }));
      expect(toErrors.map((e) => e.field), `to=${bad}`).toEqual(['to']);
    }
  });

  it('rejects a day that does not exist on the calendar', () => {
    for (const bad of ['2020-06-31', '2019-02-29', '2020-02-30', '2020-00-10', '2020-06-00']) {
      expect(validateCriteria(criteria({ to: bad })).map((e) => e.field), `to=${bad}`).toEqual(['to']);
    }
  });

  it('reports both fields when both are bad', () => {
    expect(validateCriteria(criteria({ from: 'nope', to: '2020-06-31' })).map((e) => e.field)).toEqual([
      'from',
      'to',
    ]);
  });
});

describe('keyword', () => {
  it('matches case-insensitively as a substring in include mode', () => {
    const t = tweet({ text: 'Hello World' });
    expect(matchesFilter(t, criteria({ keyword: 'hello', keywordMode: 'include' }))).toBe(true);
    expect(matchesFilter(t, criteria({ keyword: 'WORLD', keywordMode: 'include' }))).toBe(true);
    expect(matchesFilter(t, criteria({ keyword: 'nope', keywordMode: 'include' }))).toBe(false);
  });

  it('inverts in exclude mode', () => {
    const t = tweet({ text: 'Hello World' });
    expect(matchesFilter(t, criteria({ keyword: 'hello', keywordMode: 'exclude' }))).toBe(false);
    expect(matchesFilter(t, criteria({ keyword: 'nope', keywordMode: 'exclude' }))).toBe(true);
  });

  it('uses the keyword verbatim, without trimming, exactly like the server', () => {
    // The server compares `c.keyword` as typed; trimming here would have made the
    // client keep tweets the server would delete (and vice versa).
    expect(matchesFilter(tweet({ text: 'Hello World' }), criteria({ keyword: ' wor' }))).toBe(true);
    expect(matchesFilter(tweet({ text: 'HelloWorld' }), criteria({ keyword: ' wor' }))).toBe(false);
    expect(matchesFilter(tweet({ text: 'Hello World' }), criteria({ keyword: ' ' }))).toBe(true);
    expect(matchesFilter(tweet({ text: 'HelloWorld' }), criteria({ keyword: ' ' }))).toBe(false);
  });

  it('is a no-op when empty or undefined, in both modes', () => {
    const t = tweet({ text: 'anything' });
    for (const mode of ['include', 'exclude'] as const) {
      expect(matchesFilter(t, criteria({ keyword: '', keywordMode: mode }))).toBe(true);
      expect(matchesFilter(t, criteria({ keyword: undefined, keywordMode: mode }))).toBe(true);
    }
  });
});

describe('engagement thresholds', () => {
  it('keeps tweets at or under the threshold and drops those above it', () => {
    expect(matchesFilter(tweet({ likeCount: 10 }), criteria({ maxLikes: 10 }))).toBe(true);
    expect(matchesFilter(tweet({ likeCount: 11 }), criteria({ maxLikes: 10 }))).toBe(false);
    expect(matchesFilter(tweet({ retweetCount: 5 }), criteria({ maxRetweets: 5 }))).toBe(true);
    expect(matchesFilter(tweet({ retweetCount: 6 }), criteria({ maxRetweets: 5 }))).toBe(false);
  });

  it('IGNORES both thresholds when countsReliable is false', () => {
    // Archive rows report "0" regardless of reality — filtering on them would delete the wrong tweets.
    const archived = tweet({ countsReliable: false, source: 'archive', likeCount: 0, retweetCount: 0 });
    expect(matchesFilter(archived, criteria({ maxLikes: 0, maxRetweets: 0 }))).toBe(true);

    // Even a count that would clearly fail the threshold is ignored.
    const bogus = tweet({ countsReliable: false, likeCount: 9999, retweetCount: 9999 });
    expect(matchesFilter(bogus, criteria({ maxLikes: 0, maxRetweets: 0 }))).toBe(true);
    expect(matchesFilter(bogus, criteria({ maxLikes: 5 }))).toBe(true);
    expect(matchesFilter(bogus, criteria({ maxRetweets: 5 }))).toBe(true);
  });

  it('ignores a threshold when the criterion is null', () => {
    expect(matchesFilter(tweet({ likeCount: 9999 }), criteria({ maxLikes: null }))).toBe(true);
    expect(matchesFilter(tweet({ retweetCount: 9999 }), criteria({ maxRetweets: null }))).toBe(true);
  });

  it('ignores a threshold when the count itself is null', () => {
    expect(matchesFilter(tweet({ likeCount: null }), criteria({ maxLikes: 0 }))).toBe(true);
    expect(matchesFilter(tweet({ retweetCount: null }), criteria({ maxRetweets: 0 }))).toBe(true);
  });

  it('applies maxLikes and maxRetweets independently (both must pass)', () => {
    const t = tweet({ likeCount: 1, retweetCount: 100 });
    expect(matchesFilter(t, criteria({ maxLikes: 10, maxRetweets: 10 }))).toBe(false);
    expect(matchesFilter(t, criteria({ maxLikes: 10, maxRetweets: 1000 }))).toBe(true);
  });
});

describe('applyFilter', () => {
  it('preserves order and returns only matching tweets', () => {
    const tweets = [
      tweet({ id: 'a', createdAt: '2020-01-01T00:00:00.000Z' }),
      tweet({ id: 'b', createdAt: '2021-01-01T00:00:00.000Z' }),
      tweet({ id: 'c', createdAt: '2022-01-01T00:00:00.000Z' }),
    ];
    const kept = applyFilter(tweets, criteria({ from: '2021-01-01' }));
    expect(kept.map((t) => t.id)).toEqual(['b', 'c']);
  });

  it('includes retweets by default', () => {
    const tweets = [tweet({ id: 'a' }), tweet({ id: 'rt', isRetweet: true })];
    expect(DEFAULT_CRITERIA.includeRetweets).toBe(true);
    expect(applyFilter(tweets, DEFAULT_CRITERIA).map((t) => t.id)).toEqual(['a', 'rt']);
  });

  it('includes likes by default and lets the likes checkbox exclude them', () => {
    const liked = tweet({ id: 'liked', isLike: true });
    expect(DEFAULT_CRITERIA.includeLikes).toBe(true);
    expect(applyFilter([liked], DEFAULT_CRITERIA)).toEqual([liked]);
    expect(applyFilter([liked], { ...DEFAULT_CRITERIA, includeLikes: false })).toEqual([]);
  });
});

describe('summarize', () => {
  it('counts each tweet in exactly one category and reports the date range', () => {
    const stats = summarize([
      tweet({ id: 'a', createdAt: '2020-01-01T00:00:00.000Z' }),
      tweet({ id: 'b', createdAt: '2022-01-01T00:00:00.000Z', isReply: true }),
      tweet({ id: 'c', createdAt: '2021-01-01T00:00:00.000Z', isRetweet: true, isReply: true }),
      tweet({ id: 'd', createdAt: '2021-06-01T00:00:00.000Z', hasMedia: true }),
    ]);
    expect(stats.total).toBe(4);
    expect(stats.originals).toBe(2);
    expect(stats.replies).toBe(1);
    expect(stats.retweets).toBe(1);
    expect(stats.media).toBe(1);
    expect(stats.oldest).toBe('2020-01-01T00:00:00.000Z');
    expect(stats.newest).toBe('2022-01-01T00:00:00.000Z');
  });

  it('handles an empty list', () => {
    const stats = summarize([]);
    expect(stats).toMatchObject({ total: 0, oldest: null, newest: null });
  });
});
