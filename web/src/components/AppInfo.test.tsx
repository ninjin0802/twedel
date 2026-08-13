import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppInfo, RELEASES } from './AppInfo';

describe('AppInfo', () => {
  it('shows the running version on the about page', () => {
    const html = renderToStaticMarkup(<AppInfo page="about" version="0.10.0" />);
    expect(html).toContain('Version 0.10.0');
    expect(html).toContain('Developer: ninjin');
    expect(html).toContain('更新を確認');
    expect(RELEASES.find((release) => release.version === '0.4.1')?.changes).toContain('起動時に新しいバージョンがある場合はアプリ内へ通知');
    expect(html).toContain('削除した投稿の履歴ログは保存しません');
  });

  it('shows release notes newest first', () => {
    const html = renderToStaticMarkup(<AppInfo page="updates" version="0.4.0" />);
    expect(RELEASES[0].version).toBe('0.10.0');
    expect(RELEASES[0].changes).toContain('保護中のポストを一括選択と削除対象から常に除外');
    expect(html.indexOf('v0.10.0')).toBeLessThan(html.indexOf('v0.9.0'));
    expect(html).not.toContain('>更新を確認</button>');
    expect(html).toContain('ハンバーガーメニューを追加');
    expect(html).toContain('削除完了後に対象を一覧から自動で取り除く');
  });

  it('shows an accessible progress bar while downloading an update', () => {
    const html = renderToStaticMarkup(<AppInfo page="about" version="0.10.0" updateState={{ status: 'downloading', percent: 42 }} />);
    expect(html).toContain('role="progressbar"');
    expect(html).toContain('aria-valuenow="42"');
    expect(html).toContain('width:42%');
    expect(html).toContain('42%');
  });

  it('shows release notes with an available update', () => {
    const html = renderToStaticMarkup(<AppInfo page="about" version="0.4.7" updateState={{ status: 'available', version: '0.4.8', releaseNotes: '- 更新内容A\n- 更新内容B' }} />);
    expect(html).toContain('v0.4.8 を利用できます');
    expect(html).toContain('更新内容A');
    expect(html).toContain('更新内容B');
  });
});
