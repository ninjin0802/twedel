import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppInfo, RELEASES } from './AppInfo';

describe('AppInfo', () => {
  it('shows the running version on the about page', () => {
    const html = renderToStaticMarkup(<AppInfo page="about" version="0.4.6" />);
    expect(html).toContain('Version 0.4.6');
    expect(html).toContain('Developer: ninjin');
    expect(html).toContain('更新を確認');
    expect(RELEASES.find((release) => release.version === '0.4.1')?.changes).toContain('起動時に新しいバージョンがある場合はアプリ内へ通知');
    expect(html).toContain('削除した投稿の履歴ログは保存しません');
  });

  it('shows release notes newest first', () => {
    const html = renderToStaticMarkup(<AppInfo page="updates" version="0.4.0" />);
    expect(RELEASES[0].version).toBe('0.4.6');
    expect(RELEASES[0].changes).toContain('画面上の名称を「ポスト」「返信」「リポスト」に統一');
    expect(html.indexOf('v0.4.6')).toBeLessThan(html.indexOf('v0.4.5'));
    expect(html).not.toContain('>更新を確認</button>');
    expect(html).toContain('ハンバーガーメニューを追加');
    expect(html).toContain('削除完了後に対象を一覧から自動で取り除く');
  });

  it('shows an accessible progress bar while downloading an update', () => {
    const html = renderToStaticMarkup(<AppInfo page="about" version="0.4.6" updateState={{ status: 'downloading', percent: 42 }} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain('width:42%');
    expect(html).toContain('42%');
  });
});
