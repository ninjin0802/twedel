import { describe, expect, it } from 'vitest';
import { applyFilter, summarize } from './filter.js';
import type { FilterCriteria, Tweet } from '@shared/types.js';

/** Criteria that keep everything; override one field per test. */
const ALL: FilterCriteria = {
  keywordMode: 'include',
  maxLikes: null,
  maxRetweets: null,
  includeOriginals: true,
  includeReplies: true,
  includeRetweets: true,
  includeMediaTweets: true,
};

function crit(over: Partial<FilterCriteria> = {}): FilterCriteria {
  return { ...ALL, ...over };
}

function tweet(over: Partial<Tweet> & { id: string }): Tweet {
  return {
    createdAt: '2020-06-15T12:00:00.000Z',
    text: 'hello world',
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

const original = tweet({ id: 'o', text: 'a plain original' });
const reply = tweet({ id: 'r', text: 'a reply', isReply: true });
const retweet = tweet({ id: 'rt', text: 'RT @x: a retweet', isRetweet: true });
// Retweets that are also replies count only as retweets.
const retweetReply = tweet({ id: 'rtr', text: 'RT @x: both', isRetweet: true, isReply: true });
const media = tweet({ id: 'm', text: 'with a picture', hasMedia: true });

const ALL_TWEETS = [original, reply, retweet, retweetReply, media];

function ids(ts: Tweet[]): string[] {
  return ts.map((t) => t.id);
}

describe('applyFilter - categories', () => {
  it('keeps everything when all three flags are on', () => {
    expect(ids(applyFilter(ALL_TWEETS, crit()))).toEqual(['o', 'r', 'rt', 'rtr', 'm']);
  });

  it('drops retweets when includeRetweets is false', () => {
    expect(ids(applyFilter(ALL_TWEETS, crit({ includeRetweets: false })))).toEqual(['o', 'r', 'm']);
  });

  it('drops replies when includeReplies is false', () => {
    expect(ids(applyFilter(ALL_TWEETS, crit({ includeReplies: false })))).toEqual(['o', 'rt', 'rtr', 'm']);
  });

  it('drops originals when includeOriginals is false', () => {
    expect(ids(applyFilter(ALL_TWEETS, crit({ includeOriginals: false })))).toEqual(['r', 'rt', 'rtr']);
  });

  it('categorizes a retweet-that-is-also-a-reply as a retweet only', () => {
    expect(ids(applyFilter([retweetReply], crit({ includeReplies: false })))).toEqual(['rtr']);
    expect(applyFilter([retweetReply], crit({ includeRetweets: false }))).toEqual([]);
  });

  it('returns nothing when all categories are off', () => {
    expect(
      applyFilter(
        ALL_TWEETS,
        crit({ includeOriginals: false, includeReplies: false, includeRetweets: false }),
      ),
    ).toEqual([]);
  });
});

describe('applyFilter - media', () => {
  it('drops tweets with media when includeMediaTweets is false', () => {
    expect(ids(applyFilter(ALL_TWEETS, crit({ includeMediaTweets: false })))).toEqual([
      'o',
      'r',
      'rt',
      'rtr',
    ]);
  });
});

describe('applyFilter - dates', () => {
  const early = tweet({ id: 'early', createdAt: '2020-01-01T00:00:00.000Z' });
  const startEdge = tweet({ id: 'startEdge', createdAt: '2020-06-01T00:00:00.000Z' });
  const middle = tweet({ id: 'middle', createdAt: '2020-06-15T12:00:00.000Z' });
  const endEdge = tweet({ id: 'endEdge', createdAt: '2020-06-30T23:59:59.999Z' });
  const late = tweet({ id: 'late', createdAt: '2020-07-01T00:00:00.000Z' });
  const range = [early, startEdge, middle, endEdge, late];

  it('treats both bounds as inclusive in UTC', () => {
    const res = applyFilter(range, crit({ from: '2020-06-01', to: '2020-06-30' }));
    expect(ids(res)).toEqual(['startEdge', 'middle', 'endEdge']);
  });

  it('applies from alone', () => {
    expect(ids(applyFilter(range, crit({ from: '2020-06-30' })))).toEqual(['endEdge', 'late']);
  });

  it('applies to alone', () => {
    expect(ids(applyFilter(range, crit({ to: '2020-06-01' })))).toEqual(['early', 'startEdge']);
  });

  it('treats undefined and empty-string bounds as no bound', () => {
    expect(ids(applyFilter(range, crit({ from: '', to: '' })))).toEqual(ids(range));
    expect(ids(applyFilter(range, crit()))).toEqual(ids(range));
  });

  it('matches a single-day window on that exact day', () => {
    expect(ids(applyFilter(range, crit({ from: '2020-06-15', to: '2020-06-15' })))).toEqual(['middle']);
  });

  it('tolerates surrounding whitespace and a full ISO timestamp', () => {
    expect(ids(applyFilter(range, crit({ from: '  2020-06-15  ', to: ' 2020-06-15 ' })))).toEqual(['middle']);
    expect(
      ids(applyFilter(range, crit({ from: '2020-06-15T08:00:00.000Z', to: '2020-06-15T08:00:00.000Z' }))),
    ).toEqual(['middle']);
  });

  it('THROWS on a malformed bound instead of silently ignoring it', () => {
    // Silently dropping an unparseable bound widens the delete set to every
    // tweet - the exact failure mode that must never happen in a delete tool.
    for (const bad of ['2020-6-5', '2020/06/15', '06/15/2020', 'yesterday', '20200615', '2020-06', 'x']) {
      expect(() => applyFilter(range, crit({ from: bad })), `from=${bad}`).toThrow(/from/);
      expect(() => applyFilter(range, crit({ to: bad })), `to=${bad}`).toThrow(/to/);
    }
  });

  it('THROWS on a bound that is not a real calendar day', () => {
    // Date.parse('2020-06-31') rolls over to July 1st: a `to` bound would then
    // include a day the user never selected.
    for (const bad of ['2020-06-31', '2019-02-29', '2020-13-01', '2020-00-10', '2020-06-00']) {
      expect(() => applyFilter(range, crit({ to: bad })), `to=${bad}`).toThrow(/to/);
    }
    expect(() => applyFilter(range, crit({ to: '2020-02-29' }))).not.toThrow();
  });

  it('yields nothing when from is later than to', () => {
    expect(applyFilter(range, crit({ from: '2020-07-01', to: '2020-01-01' }))).toEqual([]);
  });
});

describe('applyFilter - keyword', () => {
  const cat = tweet({ id: 'cat', text: 'I love my Cat' });
  const dog = tweet({ id: 'dog', text: 'dogs are fine too' });
  const pets = [cat, dog];

  it('include mode keeps case-insensitive substring matches', () => {
    expect(ids(applyFilter(pets, crit({ keyword: 'cAt', keywordMode: 'include' })))).toEqual(['cat']);
  });

  it('exclude mode drops matches', () => {
    expect(ids(applyFilter(pets, crit({ keyword: 'CAT', keywordMode: 'exclude' })))).toEqual(['dog']);
  });

  it('is a no-op when the keyword is empty or undefined, in both modes', () => {
    expect(ids(applyFilter(pets, crit({ keyword: '', keywordMode: 'include' })))).toEqual(['cat', 'dog']);
    expect(ids(applyFilter(pets, crit({ keyword: '', keywordMode: 'exclude' })))).toEqual(['cat', 'dog']);
    expect(ids(applyFilter(pets, crit({ keywordMode: 'exclude' })))).toEqual(['cat', 'dog']);
  });
});

describe('applyFilter - engagement', () => {
  const reliableLow = tweet({ id: 'low', likeCount: 3, retweetCount: 1, countsReliable: true, source: 'live' });
  const reliableHigh = tweet({
    id: 'high',
    likeCount: 500,
    retweetCount: 400,
    countsReliable: true,
    source: 'live',
  });
  const archiveHigh = tweet({ id: 'arch', likeCount: 500, retweetCount: 400, countsReliable: false });
  const nullCounts = tweet({ id: 'nul', likeCount: null, retweetCount: null, countsReliable: true, source: 'live' });

  it('keeps tweets at or below maxLikes when counts are reliable', () => {
    expect(ids(applyFilter([reliableLow, reliableHigh], crit({ maxLikes: 10 })))).toEqual(['low']);
    expect(ids(applyFilter([reliableLow, reliableHigh], crit({ maxLikes: 500 })))).toEqual(['low', 'high']);
  });

  it('applies maxRetweets the same way', () => {
    expect(ids(applyFilter([reliableLow, reliableHigh], crit({ maxRetweets: 1 })))).toEqual(['low']);
  });

  it('IGNORES maxLikes/maxRetweets when countsReliable is false', () => {
    expect(ids(applyFilter([archiveHigh], crit({ maxLikes: 0 })))).toEqual(['arch']);
    expect(ids(applyFilter([archiveHigh], crit({ maxRetweets: 0 })))).toEqual(['arch']);
    expect(ids(applyFilter([archiveHigh], crit({ maxLikes: 0, maxRetweets: 0 })))).toEqual(['arch']);
  });

  it('applies each bound to its own count only', () => {
    // Many likes, few retweets: maxRetweets alone must keep it, maxLikes alone must drop it.
    const skew = tweet({ id: 'skew', likeCount: 500, retweetCount: 1, countsReliable: true, source: 'live' });
    expect(ids(applyFilter([skew], crit({ maxRetweets: 10 })))).toEqual(['skew']);
    expect(applyFilter([skew], crit({ maxLikes: 10 }))).toEqual([]);
    expect(applyFilter([skew], crit({ maxLikes: 10, maxRetweets: 10 }))).toEqual([]);
  });

  it('treats the bound as inclusive, and 0 as a real bound (not "unset")', () => {
    const zero = tweet({ id: 'zero', likeCount: 0, retweetCount: 0, countsReliable: true, source: 'live' });
    const one = tweet({ id: 'one', likeCount: 1, retweetCount: 1, countsReliable: true, source: 'live' });
    expect(ids(applyFilter([zero, one], crit({ maxLikes: 0 })))).toEqual(['zero']);
    expect(ids(applyFilter([zero, one], crit({ maxRetweets: 1 })))).toEqual(['zero', 'one']);
  });

  it('neutralizes an unreliable count even when only one bound is set', () => {
    const archLikesOnly = tweet({ id: 'a1', likeCount: 500, retweetCount: null, countsReliable: false });
    const archRtOnly = tweet({ id: 'a2', likeCount: null, retweetCount: 400, countsReliable: false });
    expect(ids(applyFilter([archLikesOnly, archRtOnly], crit({ maxLikes: 0 })))).toEqual(['a1', 'a2']);
    expect(ids(applyFilter([archLikesOnly, archRtOnly], crit({ maxRetweets: 0 })))).toEqual(['a1', 'a2']);
  });

  it('ignores the bound when it is null or the count is null', () => {
    expect(ids(applyFilter([reliableHigh], crit({ maxLikes: null })))).toEqual(['high']);
    expect(ids(applyFilter([nullCounts], crit({ maxLikes: 0, maxRetweets: 0 })))).toEqual(['nul']);
  });
});

describe('applyFilter - purity', () => {
  it('does not mutate or reorder the input', () => {
    const input = [...ALL_TWEETS];
    const snapshot = JSON.stringify(input);
    const out = applyFilter(input, crit({ includeRetweets: false }));
    expect(JSON.stringify(input)).toBe(snapshot);
    expect(input).toHaveLength(5);
    expect(out).not.toBe(input);
  });

  it('handles an empty input', () => {
    expect(applyFilter([], crit())).toEqual([]);
  });
});

describe('summarize', () => {
  it('counts categories and media, and reports the date range', () => {
    const s = summarize([
      tweet({ id: 'a', createdAt: '2019-01-01T00:00:00.000Z' }),
      tweet({ id: 'b', createdAt: '2021-05-05T00:00:00.000Z', isReply: true }),
      tweet({ id: 'c', createdAt: '2020-03-03T00:00:00.000Z', isRetweet: true, hasMedia: true }),
      tweet({ id: 'd', createdAt: '2020-04-04T00:00:00.000Z', hasMedia: true }),
    ]);
    expect(s).toEqual({
      total: 4,
      originals: 2,
      replies: 1,
      retweets: 1,
      withMedia: 2,
      oldest: '2019-01-01T00:00:00.000Z',
      newest: '2021-05-05T00:00:00.000Z',
    });
  });

  it('counts a retweet that is also a reply once, as a retweet', () => {
    const s = summarize([retweetReply]);
    expect([s.total, s.retweets, s.replies, s.originals]).toEqual([1, 1, 0, 0]);
  });

  it('leaves oldest/newest undefined for an empty list', () => {
    const s = summarize([]);
    expect(s.total).toBe(0);
    expect(s.oldest).toBeUndefined();
    expect(s.newest).toBeUndefined();
  });

  it('returns real zeros (never undefined) for every count on an empty list', () => {
    const s = summarize([]);
    for (const k of ['total', 'originals', 'replies', 'retweets', 'withMedia'] as const) {
      expect(s[k], k).toBe(0);
    }
  });

  it('does not mutate or reorder the input', () => {
    const input = [...ALL_TWEETS];
    const snapshot = JSON.stringify(input);
    summarize(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });
});
