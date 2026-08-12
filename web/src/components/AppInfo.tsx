import type { UpdateState } from '../update';

interface Props {
  page: 'updates' | 'about';
  version: string | null;
  updateState?: UpdateState;
  updateBlocked?: boolean;
  onCheck?: () => void;
  onDownload?: () => void;
  onInstall?: () => void;
}

export const RELEASES = [
  {
    version: '0.4.3',
    title: 'バックグラウンド自動インストール',
    changes: ['更新のダウンロード完了後にインストーラーをバックグラウンドで自動実行', 'インストール完了後に更新済みアプリを自動で再起動'],
  },
  {
    version: '0.4.2',
    title: '更新キャッシュのクリーンアップ',
    changes: ['更新成功後の初回起動でダウンロード済みインストーラーを自動削除', 'アプリアイコンを新しいデザインへ刷新'],
  },
  {
    version: '0.4.1',
    title: '更新画面の改善',
    changes: ['アップデート操作をバージョン情報ページへ移動', '起動時に新しいバージョンがある場合はアプリ内へ通知'],
  },
  {
    version: '0.4.0',
    title: '自動アップデート',
    changes: ['GitHub Releasesから更新を確認', 'ダウンロード進捗を表示', '再起動して更新に対応', 'ヘッダーの接続バッジを小さなバージョン表示に変更'],
  },
  {
    version: '0.3.0',
    title: 'メニューと情報ページ',
    changes: ['ハンバーガーメニューを追加', '詳細設定を通常画面から分離', 'アップデート内容とバージョン情報ページを追加', '削除完了後に対象を一覧から自動で取り除く'],
  },
  {
    version: '0.2.0',
    title: '自動接続とシンプルUI',
    changes: ['未接続時にChromeから自動取得', '接続前の取得・削除を安全に無効化', 'Windows版UIを整理'],
  },
  {
    version: '0.1.0',
    title: 'Windowsアプリ初版',
    changes: ['Electron版を追加', 'Windowsインストーラーに対応', '削除済みツイートのログ保存を廃止'],
  },
] as const;

function UpdateControls({ version, updateState, updateBlocked, onCheck, onDownload, onInstall }: Omit<Props, 'page'>) {
  return (
    <div className="update-box">
      <strong>現在のバージョン: v{version ?? '0.4.3'}</strong>
      {updateState?.status === 'checking' && <p>アップデートを確認しています…</p>}
      {updateState?.status === 'latest' && <p className="inline-msg inline-msg--ok">最新版です。</p>}
      {updateState?.status === 'available' && <p>v{updateState.version} を利用できます。</p>}
      {updateState?.status === 'downloading' && <p>ダウンロード中… {updateState.percent}%</p>}
      {updateState?.status === 'downloaded' && <p className="inline-msg inline-msg--ok">v{updateState.version} の準備ができました。</p>}
      {updateState?.status === 'installing' && <p className="inline-msg inline-msg--ok">v{updateState.version} をバックグラウンドでインストールしています。完了後に再起動します。</p>}
      {updateState?.status === 'error' && <p className="inline-msg inline-msg--error">{updateState.message}</p>}
      <div className="row row--tight">
        <button className="btn" onClick={onCheck} disabled={updateState?.status === 'checking' || updateState?.status === 'downloading'}>更新を確認</button>
        {updateState?.status === 'available' && <button className="btn btn--primary" onClick={onDownload} disabled={updateBlocked}>ダウンロードして自動更新</button>}
        {updateState?.status === 'downloaded' && <button className="btn btn--primary" onClick={onInstall} disabled={updateBlocked}>再起動して更新</button>}
      </div>
      {updateBlocked && <p className="hint">削除処理が終了してから更新できます。</p>}
      {(typeof window === 'undefined' || !window.twedelUpdates) && <p className="hint">ブラウザ版では更新機能を利用できません。</p>}
    </div>
  );
}

export function AppInfo({ page, version, updateState = { status: 'idle' }, updateBlocked = false, onCheck, onDownload, onInstall }: Props) {
  if (page === 'about') {
    return (
      <section className="panel info-page">
        <h2>バージョン情報</h2>
        <div className="about-mark" aria-hidden="true"><img src="/icon.png" alt="" /></div>
        <h3>twedel</h3>
        <p className="version-number">Version {version ?? '0.4.3'}</p>
        <p>Developer: ninjin</p>
        <p>自分のX投稿を取得・絞り込み・一括削除する、Windows向けローカルアプリです。</p>
        <p className="hint">認証情報と一時チェックポイントはこのPC内に保存されます。削除した投稿の履歴ログは保存しません。</p>
        <UpdateControls version={version} updateState={updateState} updateBlocked={updateBlocked} onCheck={onCheck} onDownload={onDownload} onInstall={onInstall} />
      </section>
    );
  }

  return (
    <section className="panel info-page">
      <h2>アップデート内容</h2>
      <div className="release-list">
        {RELEASES.map((release, index) => (
          <article className="release-card" key={release.version}>
            <div className="release-card__title">
              <strong>v{release.version}</strong>
              {index === 0 && <span className="pill pill--ok">現在のバージョン</span>}
            </div>
            <h3>{release.title}</h3>
            <ul>{release.changes.map((change) => <li key={change}>{change}</li>)}</ul>
          </article>
        ))}
      </div>
    </section>
  );
}
