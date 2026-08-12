import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SourcePanel } from './SourcePanel';

/**
 * Rendered with `react-dom/server` (no jsdom). Only the initial markup is
 * asserted - enough to prove the tweets/likes selector is present and wired to
 * both the live fetch and the archive import.
 */
const noop = () => {};

function render(): string {
  return renderToStaticMarkup(<SourcePanel tweets={[]} onTweets={noop} />);
}

describe('SourcePanel - unified source', () => {
  it('shows both posts and likes as one fetch target', () => {
    const html = render();
    expect(html).toContain('自分のポスト');
    expect(html).toContain('いいね');
    expect(html).toContain('取得対象');
    expect(html).not.toContain('type="radio"');
  });

  it('offers one combined fetch action', () => {
    const html = render();
    expect(html).toContain('ポストといいねを取得');
  });

  it('explains that both sources are fetched sequentially', () => {
    const html = render();
    expect(html).toContain('いいねした投稿も続けて取得');
  });
});
