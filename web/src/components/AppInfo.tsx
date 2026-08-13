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
    version: '0.11.6',
    title: 'READMEバージョンバッジの更新ルールを追加',
    changes: ['READMEのversionバッジを各リリースで必ず更新するルールを追加', 'バッジ、アプリ、package.json、GitHub Releaseのバージョン一致確認を完了条件へ追加'],
  },
  {
    version: '0.11.5',
    title: '開発者のXプロフィールを追加',
    changes: ['READMEへ開発者のXアカウントを掲載', 'バージョン情報のプロフィールカードからXを標準ブラウザで開けるように変更', '固定リンク方式で任意URLの外部起動を防止'],
  },
  {
    version: '0.11.4',
    title: 'READMEを全面リニューアル',
    changes: ['初めての利用者がダウンロードと使い方へ迷わず進める構成へ変更', 'CI・最新版・Windows・64-bit・MIT Licenseのバッジを追加', '機能・動作環境・安全性を表と短い説明で整理', '支援案内と開発者プロフィールを見やすく再配置'],
  },
  {
    version: '0.11.3',
    title: '開発者プロフィールと支援案内を追加',
    changes: ['バージョン情報へ開発者ninjinのアイコンとプロフィールを追加', 'READMEへOFUSEの支援リンクを追加', '支援金の用途と、支援による機能差がないことを明記'],
  },
  {
    version: '0.11.2',
    title: 'OFUSEによる任意支援を追加',
    changes: ['バージョン情報ページへ「開発を支援する」を追加', '支援ページをOSの標準ブラウザで安全に表示', '支援の有無による機能差がないことを明記'],
  },
  {
    version: '0.11.1',
    title: '署名審査用ビルドを修正',
    changes: ['GitHub Actions上の暗黙的なRelease公開を無効化', '未署名成果物を正式Releaseへ誤公開せず、SignPath審査用artifactだけへ保存'],
  },
  {
    version: '0.11.0',
    title: 'コード署名の申請基盤を整備',
    changes: ['MIT Licenseでオープンソース方針を明確化', 'コード署名ポリシーとプライバシーポリシーを公開', 'GitHub-hosted runnerによるWindowsビルド証跡を追加', 'SignPath Foundation申請・承認後の連携手順を文書化'],
  },
  {
    version: '0.10.0',
    title: '残したいポストを保護',
    changes: ['ポストごとに削除対象から保護・解除', '保護設定をXアカウント別に端末内へ保存', '保護中のポストを一括選択と削除対象から常に除外', 'ライブ取得で判定できた固定ポストを自動保護'],
  },
  {
    version: '0.9.0',
    title: '動作とストレージを最適化',
    changes: ['ログイン情報を維持したまま専用Chromeの不要キャッシュを自動整理', '取得結果を受信後すぐジョブメモリから解放', '成功した取得経路をアカウント別に記憶', 'キーワード絞り込みの重複計算を削減'],
  },
  {
    version: '0.8.1',
    title: '複数アカウントの取得を修正',
    changes: ['切り替え時にCookieの本人IDをXへ再確認', '保存表示とCookieのアカウントが不一致なら安全に中止', '0件の取得経路から実データを返す経路へ自動切り替え'],
  },
  {
    version: '0.8.0',
    title: 'アカウント管理を強化',
    changes: ['保存済みアカウントをtwedelから個別に削除', 'すべての保存済みアカウント情報をリセット', 'X側のアカウントには影響しない確認画面と説明を追加'],
  },
  {
    version: '0.7.2',
    title: '取得処理の停止問題を修正',
    changes: ['データのないカーソルを無制限にたどる問題を修正', '古いリポストへ到達するための中間ページ探索は維持', '取得中の種類・ページ数を画面へ表示'],
  },
  {
    version: '0.7.1',
    title: '古いリポストの取得改善',
    changes: ['重複や埋め込みだけの中間ページを越えて取得を継続', '通常ポスト・返信・リポストのページ上限を個別化', '2018年前後を含む古いリポストの取得漏れを改善'],
  },
  {
    version: '0.7.0',
    title: 'アカウント切り替え',
    changes: ['複数のXアカウントを端末内へ安全に保存', 'アカウントカードからワンクリックで切り替え', '切り替え時に取得一覧と選択状態をリセットして誤操作を防止'],
  },
  {
    version: '0.6.0',
    title: 'ポストといいねの統合取得',
    changes: ['自分のポストといいねを一度の操作でまとめて取得', '絞り込みに「いいね」チェックボックスを追加', '取得画面と種類フィルターを新しい統合UIへ刷新'],
  },
  {
    version: '0.5.2',
    title: 'セキュリティ強化',
    changes: ['ローカルAPIを127.0.0.1へ強制固定', '不正なHostと外部Originからのアクセスを拒否', 'CSPなどのセキュリティヘッダーとElectron外部遷移防止を追加', 'セキュリティ方針と監査結果を文書化'],
  },
  {
    version: '0.5.1',
    title: 'リポストの初期選択を修正',
    changes: ['絞り込み画面の「リポスト」を初期状態でチェック済みに変更', '初回表示から通常ポスト・返信・リポストをすべて対象に設定', 'ヘッダーのローカル接続済み表示を削除'],
  },
  {
    version: '0.5.0',
    title: 'モダンUIへの全面刷新',
    changes: ['上品な濃紺と青緑を基調にデザインを刷新', 'デスクトップ向け左サイドバーとモバイル向けドロワーを追加', '接続から削除までを示す4段階ステッパーを追加', 'ライト・ダーク・OS連動テーマ切替を追加'],
  },
  {
    version: '0.4.9',
    title: 'ドキュメントの全面改善',
    changes: ['READMEを一般利用者向けに分かりやすく再構成', '動作環境と必要な依存ソフトを明記', '使い方・トラブル対処・開発情報を別ページへ整理'],
  },
  {
    version: '0.4.8',
    title: '更新内容の事前表示',
    changes: ['新しいバージョンの通知にGitHub Releaseの更新内容を表示', '更新内容を確認してからダウンロード可能に改善'],
  },
  {
    version: '0.4.7',
    title: 'リリース表示の修正',
    changes: ['GitHub Release本文の改行表示を修正', 'リリースノートをUTF-8 Markdownファイルで管理'],
  },
  {
    version: '0.4.6',
    title: '更新安定性と表記の改善',
    changes: ['更新後のキャッシュ削除がファイルロックで起動を妨げないよう修正', '画面上の名称を「ポスト」「返信」「リポスト」に統一'],
  },
  {
    version: '0.4.5',
    title: '更新ダウンロード表示の改善',
    changes: ['更新パッケージのダウンロード率をプログレスバーで表示', '進捗率をバー中央にパーセント表示', '一時的な進捗ストリーム切断メッセージを非表示化'],
  },
  {
    version: '0.4.4',
    title: '自動更新の完全サイレント化',
    changes: ['自動更新ボタンからのインストールではセットアップ操作を一切不要化', '更新完了後に更新済みアプリを自動で再起動'],
  },
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
    changes: ['Electron版を追加', 'Windowsインストーラーに対応', '削除済みポストのログ保存を廃止'],
  },
] as const;

function readableReleaseNotes(notes: string): string {
  return notes
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '・')
    .trim();
}

function UpdateControls({ version, updateState, updateBlocked, onCheck, onDownload, onInstall }: Omit<Props, 'page'>) {
  return (
    <div className="update-box">
      <strong>現在のバージョン: v{version ?? '0.11.6'}</strong>
      {updateState?.status === 'checking' && <p>アップデートを確認しています…</p>}
      {updateState?.status === 'latest' && <p className="inline-msg inline-msg--ok">最新版です。</p>}
      {updateState?.status === 'available' && <p>v{updateState.version} を利用できます。</p>}
      {updateState?.status === 'available' && updateState.releaseNotes && (
        <div className="update-notes">
          <strong>更新内容</strong>
          <div>{readableReleaseNotes(updateState.releaseNotes)}</div>
        </div>
      )}
      {updateState?.status === 'downloading' && (
        <div className="update-download">
          <p>更新パッケージをダウンロード中…</p>
          <div
            className="progress update-download__progress"
            role="progressbar"
            aria-label="更新パッケージのダウンロード進捗"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={updateState.percent}
          >
            <div className="progress__bar" style={{ width: `${updateState.percent}%` }} />
            <span className="progress__label">{updateState.percent}%</span>
          </div>
        </div>
      )}
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
        <p className="version-number">Version {version ?? '0.11.6'}</p>
        <button
          type="button"
          className="developer-profile"
          aria-label="開発者ninjinのXプロフィールを標準ブラウザで開く"
          onClick={() => void window.twedelExternal?.openDeveloperProfile()}
          disabled={typeof window === 'undefined' || !window.twedelExternal}
        >
          <img src="/developer-ninjin.jpg" alt="開発者 ninjinのアイコン" />
          <div>
            <span className="developer-profile__role">Developer</span>
            <span className="developer-profile__name">ninjin</span>
            <span className="developer-profile__description">twedelを個人開発しています。「自分でも安心して使える、シンプルで便利なツール」を目指して、改善とメンテナンスを続けています。</span>
            <span className="developer-profile__link">X: @_nin82 ↗</span>
          </div>
        </button>
        <p>自分のX投稿を取得・絞り込み・一括削除する、Windows向けローカルアプリです。</p>
        <p className="hint">認証情報と一時チェックポイントはこのPC内に保存されます。削除した投稿の履歴ログは保存しません。</p>
        <div className="support-card">
          <div>
            <strong>開発を支援する</strong>
            <p>支援は完全に任意です。支援の有無による機能差はありません。</p>
          </div>
          <button
            type="button"
            className="btn btn--support"
            onClick={() => void window.twedelExternal?.openSupportPage()}
            disabled={typeof window === 'undefined' || !window.twedelExternal}
            title="OFUSEを標準ブラウザで開きます"
          >OFUSEで支援する ↗</button>
          <small>外部サイト（ofuse.me）を標準ブラウザで開きます。</small>
        </div>
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
