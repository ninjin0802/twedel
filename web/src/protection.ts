import type { Tweet } from '@shared/types';

export const PROTECTED_POSTS_KEY = 'twedel.protectedPosts.v1';

type ProtectedByAccount = Record<string, string[]>;

export function protectionScope(userId?: string, screenName?: string): string {
  return userId?.trim() || (screenName?.trim() ? `@${screenName.trim().toLowerCase()}` : 'unconnected');
}

export function readProtectedPosts(storage: Pick<Storage, 'getItem'>, scope: string): Set<string> {
  try {
    const parsed = JSON.parse(storage.getItem(PROTECTED_POSTS_KEY) ?? '{}') as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return new Set();
    const value = (parsed as ProtectedByAccount)[scope];
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && id !== '') : []);
  } catch {
    return new Set();
  }
}

export function writeProtectedPosts(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  scope: string,
  ids: ReadonlySet<string>,
): void {
  let all: ProtectedByAccount = {};
  try {
    const parsed = JSON.parse(storage.getItem(PROTECTED_POSTS_KEY) ?? '{}') as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) all = parsed as ProtectedByAccount;
  } catch {
    // Replace a corrupt preference with a valid, minimal document.
  }
  if (ids.size > 0) all[scope] = [...ids];
  else delete all[scope];
  storage.setItem(PROTECTED_POSTS_KEY, JSON.stringify(all));
}

export function includePinnedPosts(current: ReadonlySet<string>, tweets: readonly Tweet[]): Set<string> {
  const next = new Set(current);
  for (const tweet of tweets) if (tweet.isPinned && !tweet.isLike) next.add(tweet.id);
  return next;
}
