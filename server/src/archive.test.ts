import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import AdmZip from 'adm-zip';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadArchive,
  normalizeArchiveLike,
  normalizeArchiveTweet,
  parseTweetsJs,
  parseTwitterDate,
} from './archive.js';
import type { Tweet } from '@shared/types.js';

const fixtureDir = fileURLToPath(new URL('./__fixtures__/', import.meta.url));
const folderArchive = join(fixtureDir, 'archive-folder');

function fixture(name: string): Promise<string> {
  return readFile(join(fixtureDir, name), 'utf8');
}

function byId(tweets: Tweet[], id: string): Tweet {
  const t = tweets.find((x) => x.id === id);
  if (t === undefined) throw new Error(`tweet ${id} not found`);
  return t;
}

describe('parseTwitterDate', () => {
  it('parses the archive created_at format to ISO8601 UTC', () => {
    expect(parseTwitterDate('Wed Oct 10 20:19:24 +0000 2018')).toBe('2018-10-10T20:19:24.000Z');
  });

  it('applies a non-zero UTC offset', () => {
    expect(parseTwitterDate('Wed Oct 10 20:19:24 +0900 2018')).toBe('2018-10-10T11:19:24.000Z');
    expect(parseTwitterDate('Wed Oct 10 20:19:24 -0500 2018')).toBe('2018-10-11T01:19:24.000Z');
  });

  it('handles every month name', () => {
    expect(parseTwitterDate('Mon Jan 01 00:00:00 +0000 2020')).toBe('2020-01-01T00:00:00.000Z');
    expect(parseTwitterDate('Tue Dec 31 23:59:59 +0000 2019')).toBe('2019-12-31T23:59:59.000Z');
  });

  it('maps all twelve month names to the right month number', () => {
    const names = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    names.forEach((name, i) => {
      const mm = String(i + 1).padStart(2, '0');
      expect(parseTwitterDate(`Mon ${name} 15 12:00:00 +0000 2020`)).toBe(`2020-${mm}-15T12:00:00.000Z`);
    });
  });

  it('accepts a single-digit day', () => {
    expect(parseTwitterDate('Fri Oct 5 20:19:24 +0000 2018')).toBe('2018-10-05T20:19:24.000Z');
  });

  it('rejects a date that does not exist on the calendar instead of rolling it over', () => {
    // Date.UTC(2019, 1, 31) silently becomes 2019-03-03; a 3-day shift can move a
    // tweet across a from/to bound and change what gets deleted.
    expect(() => parseTwitterDate('Sat Feb 31 12:00:00 +0000 2019')).toThrow(/unparseable/);
    expect(() => parseTwitterDate('Sun Jun 31 12:00:00 +0000 2019')).toThrow(/unparseable/);
    expect(() => parseTwitterDate('Sat Feb 29 12:00:00 +0000 2019')).toThrow(/unparseable/);
    // …but a real leap day is fine.
    expect(parseTwitterDate('Sat Feb 29 12:00:00 +0000 2020')).toBe('2020-02-29T12:00:00.000Z');
  });

  it('rejects an impossible UTC offset', () => {
    expect(() => parseTwitterDate('Wed Oct 10 20:19:24 +9900 2018')).toThrow(/unparseable/);
    expect(() => parseTwitterDate('Wed Oct 10 20:19:24 +0099 2018')).toThrow(/unparseable/);
    // Real-world extremes stay valid.
    expect(parseTwitterDate('Wed Oct 10 20:19:24 +1400 2018')).toBe('2018-10-10T06:19:24.000Z');
    expect(parseTwitterDate('Wed Oct 10 20:19:24 -1200 2018')).toBe('2018-10-11T08:19:24.000Z');
  });

  it('reads a zone-less ISO timestamp as UTC, never as host-local time', () => {
    // Date.parse('2018-10-10T20:19:24') is LOCAL time per spec: on a JST machine
    // that silently shifts every tweet by 9 hours.
    expect(parseTwitterDate('2018-10-10T20:19:24')).toBe('2018-10-10T20:19:24.000Z');
    expect(parseTwitterDate('2018-10-10T20:19:24.500')).toBe('2018-10-10T20:19:24.500Z');
  });

  it('honours an explicit zone on ISO input', () => {
    expect(parseTwitterDate('2018-10-10T20:19:24Z')).toBe('2018-10-10T20:19:24.000Z');
    expect(parseTwitterDate('2018-10-10T20:19:24+09:00')).toBe('2018-10-10T11:19:24.000Z');
    expect(parseTwitterDate('2018-10-10T20:19:24-0500')).toBe('2018-10-11T01:19:24.000Z');
  });

  it('rejects ISO input that Date.parse would silently roll over', () => {
    expect(() => parseTwitterDate('2020-06-31T00:00:00Z')).toThrow(/unparseable/);
    expect(() => parseTwitterDate('2018-10-10Tnope')).toThrow(/unparseable/);
  });

  it('throws on an unparseable value', () => {
    expect(() => parseTwitterDate('definitely not a date')).toThrow();
    expect(() => parseTwitterDate('')).toThrow();
    expect(() => parseTwitterDate('Wed Xyz 10 20:19:24 +0000 2018')).toThrow();
  });
});

describe('parseTweetsJs', () => {
  it('strips the plural window.YTD.tweets.partN wrapper', async () => {
    const arr = parseTweetsJs(await fixture('wrapper-plural.js'));
    expect(arr).toHaveLength(1);
    expect(normalizeArchiveTweet(arr[0])?.id).toBe('5001');
  });

  it('strips the singular window.YTD.tweet.partN wrapper', async () => {
    const arr = parseTweetsJs(await fixture('wrapper-singular.js'));
    expect(arr).toHaveLength(1);
    expect(normalizeArchiveTweet(arr[0])?.id).toBe('5002');
  });

  it('falls back to the first [ when there is no wrapper', async () => {
    const arr = parseTweetsJs(await fixture('wrapper-none.js'));
    expect(arr).toHaveLength(1);
    expect(normalizeArchiveTweet(arr[0])?.id).toBe('5003');
  });

  it('accepts an unknown window.YTD.<kind>.partN variable name', () => {
    const arr = parseTweetsJs('window.YTD.someFutureName.part7 = [{"tweet":{"id_str":"7"}}]');
    expect(arr).toHaveLength(1);
  });

  it('throws when the payload is not an array', () => {
    expect(() => parseTweetsJs('window.YTD.tweets.part0 = {"nope":true}')).toThrow(/not an array/);
  });

  it('throws when there is no JSON array at all', () => {
    expect(() => parseTweetsJs('nothing here at all')).toThrow(/no JSON array/);
  });

  it('tolerates a UTF-8 BOM, CRLF line endings and a trailing semicolon', () => {
    const withBom = '﻿window.YTD.tweets.part0 = [\r\n{"tweet":{"id_str":"b1"}}\r\n];\r\n';
    expect(parseTweetsJs(withBom)).toHaveLength(1);
    // Same file, but without the wrapper.
    expect(parseTweetsJs('﻿[\r\n{"tweet":{"id_str":"b2"}}\r\n]\r\n')).toHaveLength(1);
  });

  it('tolerates a wrapper written without spaces around the =', () => {
    expect(parseTweetsJs('window.YTD.tweets.part0=[{"tweet":{"id_str":"n1"}}]')).toHaveLength(1);
  });

  it('fails loudly rather than returning a wrong array when the first [ is not the payload', () => {
    // Bracket-notation wrapper: the fallback slices from `["part0"]`, which cannot
    // parse. What matters is that it throws instead of silently yielding ["part0"].
    expect(() => parseTweetsJs('window.YTD.tweets["part0"] = [{"tweet":{"id_str":"1"}}]')).toThrow(
      /not valid JSON/,
    );
    expect(() => parseTweetsJs('var seen = [1,2];\nwindow.YTD.tweets.part0 = [{"tweet":{}}]')).toThrow();
  });

  it('throws on a bare JSON object with no wrapper', () => {
    expect(() => parseTweetsJs('{"nope":true}')).toThrow();
  });
});

describe('normalizeArchiveTweet', () => {
  const base = {
    id_str: '42',
    created_at: 'Wed Oct 10 20:19:24 +0000 2018',
    full_text: 'hi',
  };

  it('always marks archive counts as unreliable', () => {
    const t = normalizeArchiveTweet({ tweet: base });
    expect(t?.source).toBe('archive');
    expect(t?.countsReliable).toBe(false);
  });

  it('parses float-string and numeric counts', () => {
    const t = normalizeArchiveTweet({
      tweet: { ...base, favorite_count: '0.0', retweet_count: 12 },
    });
    expect(t?.likeCount).toBe(0);
    expect(t?.retweetCount).toBe(12);
  });

  it('yields null counts when the fields are missing or unparseable', () => {
    const t = normalizeArchiveTweet({ tweet: { ...base, favorite_count: 'abc' } });
    expect(t?.likeCount).toBeNull();
    expect(t?.retweetCount).toBeNull();
  });

  it('accepts a bare tweet object without the { tweet: … } wrapper', () => {
    expect(normalizeArchiveTweet(base)?.id).toBe('42');
  });

  it('prefers full_text, falls back to text, then empty string', () => {
    expect(normalizeArchiveTweet({ tweet: { ...base, text: 'legacy' } })?.text).toBe('hi');
    const noFull: Record<string, unknown> = { ...base, text: 'legacy' };
    delete noFull['full_text'];
    expect(normalizeArchiveTweet({ tweet: noFull })?.text).toBe('legacy');
    const neither: Record<string, unknown> = { ...base };
    delete neither['full_text'];
    expect(normalizeArchiveTweet({ tweet: neither })?.text).toBe('');
  });

  it('detects retweets by the RT @ prefix and by retweeted_status keys', () => {
    expect(normalizeArchiveTweet({ tweet: { ...base, full_text: 'RT @a: b' } })?.isRetweet).toBe(true);
    expect(normalizeArchiveTweet({ tweet: { ...base, retweeted_status_id_str: '9' } })?.isRetweet).toBe(true);
    expect(normalizeArchiveTweet({ tweet: { ...base, retweeted_status: { id_str: '9' } } })?.isRetweet).toBe(true);
    expect(normalizeArchiveTweet({ tweet: base })?.isRetweet).toBe(false);
  });

  it('sets sourceTweetId only when the archive actually carries an original id', () => {
    // A bare "RT @" retweet (the usual archive shape) has no original id at all.
    expect(normalizeArchiveTweet({ tweet: { ...base, full_text: 'RT @a: b' } })?.sourceTweetId).toBeUndefined();
    // When an id IS present, it is captured so the retweet can be un-retweeted.
    expect(
      normalizeArchiveTweet({ tweet: { ...base, full_text: 'RT @a: b', retweeted_status_id_str: '9' } })
        ?.sourceTweetId,
    ).toBe('9');
    expect(
      normalizeArchiveTweet({ tweet: { ...base, full_text: 'RT @a: b', retweeted_status: { id_str: '77' } } })
        ?.sourceTweetId,
    ).toBe('77');
    // A plain tweet never carries one.
    expect(normalizeArchiveTweet({ tweet: base })?.sourceTweetId).toBeUndefined();
  });

  it('treats an empty in_reply_to_status_id_str as not a reply', () => {
    expect(normalizeArchiveTweet({ tweet: { ...base, in_reply_to_status_id_str: '1' } })?.isReply).toBe(true);
    expect(normalizeArchiveTweet({ tweet: { ...base, in_reply_to_status_id_str: '' } })?.isReply).toBe(false);
    expect(normalizeArchiveTweet({ tweet: base })?.isReply).toBe(false);
  });

  it('detects media from extended_entities or entities', () => {
    expect(
      normalizeArchiveTweet({ tweet: { ...base, extended_entities: { media: [{ id_str: 'm' }] } } })?.hasMedia,
    ).toBe(true);
    expect(normalizeArchiveTweet({ tweet: { ...base, entities: { media: [{ id_str: 'm' }] } } })?.hasMedia).toBe(
      true,
    );
    expect(normalizeArchiveTweet({ tweet: { ...base, entities: { media: [] } } })?.hasMedia).toBe(false);
    expect(normalizeArchiveTweet({ tweet: base })?.hasMedia).toBe(false);
  });

  it('returns null for a missing id_str or an unparseable created_at', () => {
    const noId: Record<string, unknown> = { ...base };
    delete noId['id_str'];
    expect(normalizeArchiveTweet({ tweet: noId })).toBeNull();
    expect(normalizeArchiveTweet({ tweet: { ...base, created_at: 'nope' } })).toBeNull();
    expect(normalizeArchiveTweet(null)).toBeNull();
  });
});

describe('normalizeArchiveLike', () => {
  it('maps tweetId -> id and fullText -> text, flagged isLike', () => {
    const like = normalizeArchiveLike({ like: { tweetId: '111', fullText: 'a liked tweet' } });
    expect(like?.id).toBe('111');
    expect(like?.text).toBe('a liked tweet');
    expect(like?.isLike).toBe(true);
    expect(like?.isReply).toBe(false);
    expect(like?.isRetweet).toBe(false);
    expect(like?.source).toBe('archive');
    expect(like?.countsReliable).toBe(false);
  });

  it('leaves createdAt empty - the archive records no like-date', () => {
    const like = normalizeArchiveLike({ like: { tweetId: '111', fullText: 'x' } });
    expect(like?.createdAt).toBe('');
  });

  it('tolerates the sparse shape: no fullText, no expandedUrl', () => {
    const like = normalizeArchiveLike({ like: { tweetId: '222' } });
    expect(like?.id).toBe('222');
    expect(like?.text).toBe('');
    expect(like?.isLike).toBe(true);
  });

  it('accepts a bare like object without the { like: … } wrapper', () => {
    expect(normalizeArchiveLike({ tweetId: '333' })?.id).toBe('333');
  });

  it('returns null when there is no usable tweetId', () => {
    expect(normalizeArchiveLike({ like: { fullText: 'no id' } })).toBeNull();
    expect(normalizeArchiveLike({ like: { tweetId: '' } })).toBeNull();
    expect(normalizeArchiveLike(null)).toBeNull();
  });

  it('parses both the singular and plural like wrapper via parseTweetsJs', () => {
    const singular = parseTweetsJs('window.YTD.like.part0 = [{"like":{"tweetId":"5001","fullText":"hi"}}]');
    expect(normalizeArchiveLike(singular[0])?.id).toBe('5001');
    const plural = parseTweetsJs('window.YTD.likes.part0 = [{"like":{"tweetId":"5002"}}]');
    expect(normalizeArchiveLike(plural[0])?.id).toBe('5002');
  });
});

describe('loadArchive (likes)', () => {
  let tmp: string;
  let zipPath: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'twedel-likes-'));
    zipPath = join(tmp, 'twitter-archive.zip');

    const zip = new AdmZip();
    zip.addFile(
      'data/like.js',
      Buffer.from(
        'window.YTD.like.part0 = [' +
          '{"like":{"tweetId":"111","fullText":"liked one","expandedUrl":"https://x.com/a/111"}},' +
          '{"like":{"tweetId":"222"}}' +
          ']',
        'utf8',
      ),
    );
    zip.addFile(
      'data/like-part1.js',
      Buffer.from(
        'window.YTD.like.part1 = [' +
          '{"like":{"tweetId":"111","fullText":"duplicate, first-wins"}},' +
          '{"like":{"tweetId":"333","fullText":"liked three"}}' +
          ']',
        'utf8',
      ),
    );
    // A tweets.js decoy: loading likes must NOT read it.
    zip.addFile(
      'data/tweets.js',
      Buffer.from(
        'window.YTD.tweets.part0 = [{"tweet":{"id_str":"tw1","created_at":"Mon Jan 01 00:00:00 +0000 2018","full_text":"a tweet"}}]',
        'utf8',
      ),
    );
    await writeFile(zipPath, zip.toBuffer());
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('reads data/like*.js, multi-part, and flags every row isLike', async () => {
    const res = await loadArchive(zipPath, 'likes');

    expect(res.kind).toBe('likes');
    expect(res.filesRead).toEqual(['data/like.js', 'data/like-part1.js']);
    expect(res.tweets.map((t) => t.id).sort()).toEqual(['111', '222', '333']);
    expect(res.tweets.every((t) => t.isLike === true)).toBe(true);
    expect(res.tweets.every((t) => t.createdAt === '')).toBe(true);
    // The tweets.js decoy is never read on the likes path.
    expect(res.tweets.some((t) => t.id === 'tw1')).toBe(false);
  });

  it('dedupes a tweetId across parts, first part wins', async () => {
    const res = await loadArchive(zipPath, 'likes');
    expect(res.tweets.filter((t) => t.id === '111')).toHaveLength(1);
    expect(byId(res.tweets, '111').text).toBe('liked one');
  });

  it('defaults to tweets: the same zip read without a kind ignores like.js', async () => {
    const res = await loadArchive(zipPath);
    expect(res.kind).toBe('tweets');
    expect(res.tweets.map((t) => t.id)).toEqual(['tw1']);
  });
});

describe('loadArchive (extracted folder)', () => {
  it('reads every data/tweet(s)[-partN].js file and ignores decoys', async () => {
    const res = await loadArchive(folderArchive);
    const names = res.filesRead.map((f) => f.replace(/\\/g, '/').split('/').pop());
    expect(names).toEqual(['tweets.js', 'tweets-part1.js', 'tweets-part2.js', 'tweets-part10.js']);
    // account.js and the top-level decoy tweets.js are never read.
    expect(res.tweets.some((t) => t.id === '9999')).toBe(false);
  });

  it('sorts parts numerically, not lexically (part10 after part2)', async () => {
    const res = await loadArchive(folderArchive);
    // id 3000 appears in both part2 and part10; first read wins.
    expect(byId(res.tweets, '3000').text).toBe('from part2');
  });

  it('dedupes ids that appear in more than one part', async () => {
    const res = await loadArchive(folderArchive);
    expect(res.tweets.filter((t) => t.id === '1001')).toHaveLength(1);
    expect(byId(res.tweets, '1001').text).toBe('hello original');
  });

  it('sorts tweets by createdAt descending', async () => {
    const res = await loadArchive(folderArchive);
    const dates = res.tweets.map((t) => t.createdAt);
    expect([...dates].sort().reverse()).toEqual(dates);
    expect(res.tweets[0]?.id).toBe('4000');
  });

  it('classifies original, retweet, reply and media tweets', async () => {
    const { tweets } = await loadArchive(folderArchive);

    const original = byId(tweets, '1001');
    expect([original.isRetweet, original.isReply, original.hasMedia]).toEqual([false, false, false]);
    expect(original.likeCount).toBe(0); // "0.0"
    expect(original.retweetCount).toBe(12); // numeric
    expect(original.countsReliable).toBe(false);

    expect(byId(tweets, '1002').isRetweet).toBe(true);
    expect(byId(tweets, '2002').isRetweet).toBe(true);
    expect(byId(tweets, '1003').isReply).toBe(true);
    expect(byId(tweets, '1004').hasMedia).toBe(true);
  });

  it('collects malformed elements into skipped instead of throwing', async () => {
    const res = await loadArchive(folderArchive);
    expect(res.skipped).toHaveLength(2);
    for (const s of res.skipped) {
      expect(s.file).toMatch(/tweets\.js$/);
      expect(s.reason).toMatch(/id_str|created_at/);
    }
    expect(res.tweets.some((t) => t.id === '1006')).toBe(false);
  });

  it('rejects a path that does not exist', async () => {
    await expect(loadArchive(join(fixtureDir, 'does-not-exist'))).rejects.toThrow(/not found/);
  });
});

describe('loadArchive (.zip)', () => {
  let tmp: string;
  let zipPath: string;

  beforeAll(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'twedel-archive-'));
    zipPath = join(tmp, 'twitter-archive.zip');

    const zip = new AdmZip();
    zip.addFile(
      'data/tweets.js',
      Buffer.from(
        'window.YTD.tweets.part0 = [' +
          '{"tweet":{"id_str":"z1","created_at":"Wed Oct 10 20:19:24 +0000 2018","full_text":"zip original","favorite_count":"0.0","retweet_count":12}},' +
          '{"tweet":{"id_str":"z2","created_at":"Thu Oct 11 09:15:00 +0000 2018","full_text":"RT @x: zip retweet"}}' +
          ']',
        'utf8',
      ),
    );
    zip.addFile(
      'data/tweets-part1.js',
      Buffer.from(
        'window.YTD.tweets.part1 = [' +
          '{"tweet":{"id_str":"z1","created_at":"Wed Oct 10 20:19:24 +0000 2018","full_text":"zip duplicate"}},' +
          '{"tweet":{"id_str":"z3","created_at":"Fri Oct 12 10:00:00 +0000 2018","full_text":"zip part one","in_reply_to_status_id_str":"7"}}' +
          ']',
        'utf8',
      ),
    );
    // Decoys: media payload, and a tweets.js that is not under data/.
    zip.addFile('data/media/foo.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]));
    zip.addFile(
      'tweets.js',
      Buffer.from(
        'window.YTD.tweets.part0 = [{"tweet":{"id_str":"decoy","created_at":"Mon Jan 01 00:00:00 +0000 2018","full_text":"nope"}}]',
        'utf8',
      ),
    );
    await writeFile(zipPath, zip.toBuffer());
  });

  afterAll(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('reads data/tweets*.js entries out of a real zip', async () => {
    const res = await loadArchive(zipPath);
    expect(res.filesRead).toEqual(['data/tweets.js', 'data/tweets-part1.js']);
    expect(res.tweets.map((t) => t.id)).toEqual(['z3', 'z2', 'z1']);
    expect(res.skipped).toEqual([]);
  });

  it('ignores media entries and tweets.js outside data/', async () => {
    const res = await loadArchive(zipPath);
    expect(res.tweets.some((t) => t.id === 'decoy')).toBe(false);
    expect(res.filesRead).not.toContain('tweets.js');
  });

  it('orders parts numerically even when the zip uses backslash separators', async () => {
    // Some Windows zippers store `data\tweets.js`. isTweetPath() accepts those, so
    // the part ordering has to accept them too - otherwise the files sort
    // lexically (part10 before part2, tweets.js last) and, with first-wins
    // dedupe, a different copy of a duplicated id wins.
    const bsDir = await mkdtemp(join(tmpdir(), 'twedel-archive-bs-'));
    const bsPath = join(bsDir, 'backslash.zip');
    const sep = String.fromCharCode(92);
    const zip = new AdmZip();
    const payload = (part: number, id: string, text: string): Buffer =>
      Buffer.from(
        `window.YTD.tweets.part${part} = [{"tweet":{"id_str":"${id}","created_at":"Wed Oct 10 20:19:24 +0000 2018","full_text":"${text}"}}]`,
        'utf8',
      );
    zip.addFile(`data${sep}tweets-part10.js`, payload(10, 'dup', 'from part10'));
    zip.addFile(`data${sep}tweets-part2.js`, payload(2, 'dup', 'from part2'));
    zip.addFile(`data${sep}tweets.js`, payload(0, 'first', 'from tweets.js'));
    await writeFile(bsPath, zip.toBuffer());

    try {
      const res = await loadArchive(bsPath);
      expect(res.filesRead.map((f) => f.split(/[/\\]/).pop())).toEqual([
        'tweets.js',
        'tweets-part2.js',
        'tweets-part10.js',
      ]);
      expect(byId(res.tweets, 'dup').text).toBe('from part2');
    } finally {
      await rm(bsDir, { recursive: true, force: true });
    }
  });

  it('normalizes zip tweets the same way as folder tweets', async () => {
    const { tweets } = await loadArchive(zipPath);
    const z1 = byId(tweets, 'z1');
    expect(z1.text).toBe('zip original'); // deduped, first part wins
    expect(z1.likeCount).toBe(0);
    expect(z1.retweetCount).toBe(12);
    expect(z1.countsReliable).toBe(false);
    expect(z1.source).toBe('archive');
    expect(byId(tweets, 'z2').isRetweet).toBe(true);
    expect(byId(tweets, 'z3').isReply).toBe(true);
  });
});
