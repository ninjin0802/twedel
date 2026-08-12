import type { Tweet } from '@shared/types';

const WORDS = [
  '今日の作業ログ',
  'リリースしました',
  'バグ修正',
  'コーヒー',
  'ミーティング',
  '設計メモ',
  'TypeScript',
  '深夜の思いつき',
  '天気がいい',
  'テスト用の投稿',
];

/**
 * Deterministic dummy tweets so the whole UI is exercisable with no backend running.
 * `countsReliable` mirrors the source: archive rows are always unreliable.
 */
export function makeSampleTweets(count = 10000, countsReliable = true): Tweet[] {
  const tweets: Tweet[] = [];
  let seed = 20240101;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };

  const end = Date.UTC(2025, 11, 31);
  const start = Date.UTC(2011, 0, 1);

  for (let i = 0; i < count; i += 1) {
    const at = new Date(start + Math.floor(rand() * (end - start)));
    const roll = rand();
    const isRetweet = roll < 0.18;
    const isReply = !isRetweet && roll < 0.5;
    const wordCount = 1 + Math.floor(rand() * 4);
    const words: string[] = [];
    for (let w = 0; w < wordCount; w += 1) words.push(WORDS[Math.floor(rand() * WORDS.length)]!);
    tweets.push({
      id: String(1000000000000000000 + i),
      createdAt: at.toISOString(),
      text: `${isRetweet ? 'RT @someone: ' : ''}${words.join(' ')} #${i}`,
      likeCount: countsReliable ? Math.floor(rand() * 120) : null,
      retweetCount: countsReliable ? Math.floor(rand() * 40) : null,
      isReply,
      isRetweet,
      hasMedia: rand() < 0.22,
      source: countsReliable ? 'live' : 'archive',
      countsReliable,
    });
  }

  tweets.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return tweets;
}
