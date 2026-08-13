import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { AppInfo, RELEASES } from './AppInfo';

describe('AppInfo', () => {
  it('shows the running version on the about page', () => {
    const html = renderToStaticMarkup(<AppInfo page="about" version="0.11.4" />);
    expect(html).toContain('Version 0.11.4');
    expect(html).toContain('Developer');
    expect(html).toContain('ninjin');
    expect(html).toContain('自分でも安心して使える、シンプルで便利なツール');
    expect(html).toContain('/developer-ninjin.jpg');
    expect(html).toContain('開発者 ninjinのアイコン');
    expect(html).toContain('更新を確認');
    expect(RELEASES.find((release) => release.version === '0.4.1')?.changes).toContain('起動時に新しいバージョンがある場合はアプリ内へ通知');
    expect(html).toContain('削除した投稿の履歴ログは保存しません');
    expect(html).toContain('OFUSEで支援する');
    expect(html).toContain('支援の有無による機能差はありません');
    expect(html).toContain('外部サイト（ofuse.me）');
  });

  it('shows release notes newest first', () => {
    const html = renderToStaticMarkup(<AppInfo page="updates" version="0.4.0" />);
    expect(RELEASES[0].version).toBe('0.11.4');
    expect(RELEASES[0].changes).toContain('CI・最新版・Windows・64-bit・MIT Licenseのバッジを追加');
    expect(html.indexOf('v0.11.4')).toBeLessThan(html.indexOf('v0.11.3'));
    expect(html).not.toContain('>更新を確認</button>');
    expect(html).toContain('ハンバーガーメニューを追加');
    expect(html).toContain('削除完了後に対象を一覧から自動で取り除く');
  });

  it('shows an accessible progress bar while downloading an update', () => {
    const html = renderToStaticMarkup(<AppInfo page="about" version="0.11.4" updateState={{ status: 'downloading', percent: 42 }} />);
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
