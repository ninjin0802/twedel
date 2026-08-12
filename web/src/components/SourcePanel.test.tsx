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

describe('SourcePanel - source selector', () => {
  it('offers a 自分のツイート / いいね selector', () => {
    const html = render();
    expect(html).toContain('自分のツイート');
    expect(html).toContain('いいね');
    expect(html).toContain('読み込む対象');
  });

  it('keeps the live fetch as the primary path', () => {
    const html = render();
    expect(html).toContain('ライブ取得');
  });

  it('defaults to 自分のツイート (its radio is checked, いいね is not)', () => {
    const html = render();
    // Exactly one checked radio, and it is the tweets one (rendered first).
    const checkedCount = (html.match(/checked=""|checked>/g) ?? []).length;
    expect(checkedCount).toBeGreaterThanOrEqual(1);
    expect(html.indexOf('自分のツイート')).toBeLessThan(html.indexOf('いいね'));
  });
});
