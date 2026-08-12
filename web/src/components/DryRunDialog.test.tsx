import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Tweet } from '@shared/types';
import { DryRunDialog } from './DryRunDialog';

/**
 * Rendered with `react-dom/server` (this repo has no jsdom). The distinction the
 * dialog MUST make plain is "these likes are UN-LIKED (いいね解除), not deleted" -
 * losing that would let a user confirm an action they misread.
 */
const noop = () => {};

function tweet(over: Partial<Tweet> & { id: string }): Tweet {
  return {
    createdAt: '2020-06-15T12:00:00.000Z',
    text: `tweet ${over.id}`,
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

function like(id: string): Tweet {
  return tweet({ id, isLike: true, createdAt: '', text: `liked ${id}` });
}

function render(tweets: Tweet[]): string {
  return renderToStaticMarkup(
    <DryRunDialog tweets={tweets} busy={false} error={null} onCancel={noop} onConfirm={noop} />,
  );
}

describe('DryRunDialog - likes wording', () => {
  it('says likes will be UN-LIKED (いいね解除), not deleted, for an all-likes selection', () => {
    const html = render([like('1'), like('2')]);
    expect(html).toContain('いいね解除');
    expect(html).toContain('いいねを解除する');
    // The un-like path must NOT show the tweet-deletion banner.
    expect(html).not.toContain('削除されたツイートは X から復元できません');
  });

  it('keeps the plain delete wording for a tweets-only selection', () => {
    const html = render([tweet({ id: '1' }), tweet({ id: '2' })]);
    expect(html).toContain('削除する');
    expect(html).toContain('削除されたツイートは X から復元できません');
    expect(html).not.toContain('いいね解除');
  });

  it('breaks a mixed selection down into tweets vs likes', () => {
    const html = render([tweet({ id: '1' }), like('2'), like('3')]);
    expect(html).toContain('ツイート');
    expect(html).toContain('いいね');
    // The mixed note calls out that the likes are un-liked, not deleted.
    expect(html).toContain('いいね解除');
  });
});
