import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RiskConsent, RiskNotice } from './RiskConsent';

describe('RiskConsent', () => {
  it('discloses unofficial API and account suspension risks', () => {
    const html = renderToStaticMarkup(<RiskConsent onAccept={() => undefined} />);
    expect(html).toContain('非公式API');
    expect(html).toContain('アカウント凍結');
    expect(html).toContain('DPAPI');
    expect(html).toContain('disabled');
  });

  it('keeps the warning visible after consent', () => {
    const html = renderToStaticMarkup(<RiskNotice />);
    expect(html).toContain('利用規約');
  });
});
