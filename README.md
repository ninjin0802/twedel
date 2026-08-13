<div align="center">

<img src="web/public/icon.png" width="112" alt="twedelのアイコン">

# twedel

**自分のX（旧Twitter）のポストを、安全に整理するWindowsアプリ**

通常ポスト・返信・リポスト・いいねをまとめて取得し、日付や種類で絞り込んで整理できます。難しい初期設定や開発ツールは必要ありません。

[**Windows版をダウンロード**](https://github.com/ninjin0802/twedel/releases/latest) ・ [使い方](docs/USER_GUIDE.md) ・ [困ったとき](docs/TROUBLESHOOTING.md) ・ [開発を応援](https://ofuse.me/ninjin)

[![CI](https://img.shields.io/github/actions/workflow/status/ninjin0802/twedel/windows-build.yml?branch=main&label=CI)](https://github.com/ninjin0802/twedel/actions/workflows/windows-build.yml)
[![Version](https://img.shields.io/badge/version-0.12.0-7c5cff)](https://github.com/ninjin0802/twedel/releases/latest)
![Platform](https://img.shields.io/badge/platform-Windows%2010%20%2F%2011-0078D4?logo=windows)
![Architecture](https://img.shields.io/badge/arch-x86__64-555555)
[![License](https://img.shields.io/badge/license-MIT-2ea44f)](LICENSE)

</div>

> [!CAUTION]
> **twedelはX公式APIではなく、XのWebクライアント向け非公開（内部）APIを使用します。**
> Xの利用規約に抵触すると判断される可能性があり、仕様変更による停止、アクセス制限、アカウントの一時ロック・凍結などのリスクがあります。利用はご自身の判断と責任で行ってください。開発者はアカウント制限やデータ損失を保証できません。
>
> 初回起動時には、このリスクを確認して同意しない限りアプリを操作できません。Windowsアプリ版では、保存する `auth_token` と `ct0` をWindows DPAPI（Electron `safeStorage`）で暗号化します。暗号化された認証情報は、原則として保存したWindowsユーザーでのみ復号できます。
> また、Windowsアプリ版の画面からバックエンドへの操作と進捗通知はElectron IPCを通ります。認証Cookieはlocalhost HTTPへ送信しません。Electronメインプロセス内の既存処理が利用する内部APIは `127.0.0.1` のみに限定し、起動ごとの秘密トークンで認証します。認証CookieがX以外の外部サーバーへ送信されることはありません。
>
> 削除したポストは元に戻せません。必要なデータは、事前にXの「データのアーカイブをダウンロード」から保存してください。

## まずはここから

1. [最新のReleaseページ](https://github.com/ninjin0802/twedel/releases/latest)を開きます。
2. 「Assets」から`twedel-Setup-バージョン.exe`をダウンロードします。
3. インストーラーを実行し、twedelを起動します。
4. 専用ChromeでXへログインし、対象のポストを取得します。

> Node.js、npm、Gitは不要です。必要な実行環境はインストーラーに含まれています。

## 主な機能

| 取得・管理 | 絞り込み・安全性 | アプリ機能 |
|---|---|---|
| 通常ポスト・返信・リポスト・いいねを一括取得 | 日付・キーワード・種類・反応数で絞り込み | 複数のXアカウントを保存・切り替え |
| XのアーカイブZIPから古いポストを読込 | 削除前に件数・内訳・内容を確認 | 中断した処理を続きから再開 |
| 削除完了後に対象を一覧から自動除去 | 残したいポストをアカウント別に保護 | アプリ内から自動アップデート |
| 固定ポストをライブ取得時に自動保護 | 削除した本文・結果を履歴へ保存しない | 専用Chromeの不要キャッシュを自動整理 |

## 基本的な使い方

```text
Xへ接続 → ポストといいねを取得 → 条件で絞り込み → 対象を選択 → 内容を確認 → 削除
```

1. 起動時に開く専用ChromeでXへログインします。
2. アカウントカードを確認して「取得」を押します。
3. 日付、キーワード、種類などで表示内容を絞り込みます。
4. 残したいポストは一覧右端の鍵ボタンで保護します。
5. 削除対象を選択し、確認画面の件数と内訳を確認します。
6. 問題がなければ削除を実行します。

[詳しい使い方ガイドを見る](docs/USER_GUIDE.md)

## 動作環境

| 項目 | 必要条件 |
|---|---|
| OS | Windows 10／11（64ビット） |
| CPU | IntelまたはAMDの64ビットCPU |
| メモリ | 4GB以上（8GB以上を推奨） |
| 空き容量 | 500MB以上 |
| ブラウザ | Google Chrome最新版 |
| ネット接続 | Xへの接続とアプリの更新に必要 |
| アカウント | 整理対象となるXアカウント |

Google ChromeはXへのログインと認証情報の取得に使用します。twedel専用プロフィールで動作するため、普段のChromeプロフィールには影響しません。Microsoft EdgeやFirefoxだけの環境では自動取得を利用できません。

## 安全性とプライバシー

- Xの認証情報、アカウント情報、保護対象ポストIDは利用中のPC内だけに保存します。
- 認証情報を開発者へ送信する機能はありません。
- ローカルAPIは`127.0.0.1`だけで動作し、同じネットワークの別端末から接続できません。
- Electronのsandboxとcontext isolationを有効にし、外部サイトからのAPI操作や不正な画面遷移を拒否します。
- 削除したポストの本文や削除結果は履歴ログへ保存しません。
- 中断から再開する一時データは、処理完了後に削除します。
- アカウント切り替え時は一覧と選択状態をリセットし、別アカウントへの誤操作を防ぎます。
- ChromeのログインCookieは維持し、HTTP・Service Worker・GPUキャッシュだけを整理します。

[プライバシーポリシー](PRIVACY.md) ・ [セキュリティポリシー](SECURITY.md)

## 自動アップデート

新しいバージョンがある場合は、アプリ内にバージョン番号と更新内容を表示します。「ダウンロードして自動更新」を押すと進捗が表示され、完了後はバックグラウンドで更新してアプリを再起動します。

## コード署名について

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

現在はSignPath Foundationの承認待ちです。署名が有効になるまで、Release本文にインストーラーが未署名であることを明記します。ビルド元・署名対象・承認手順は[Code signing policy](CODE_SIGNING_POLICY.md)で公開しています。

## 困ったとき

次の問題は[トラブルシューティング](docs/TROUBLESHOOTING.md)を確認してください。

- Chromeからログイン情報を取得できない
- ポスト取得が進まない、または0件になる
- 401、403、404などのエラーが表示される
- 自動更新に失敗する
- 古いポストやリポストがライブ取得に表示されない

Xがライブのタイムラインへ返さない古いデータは、XからダウンロードしたアーカイブZIPを「その他の取得方法」から読み込めます。

不具合は[GitHub Issues](https://github.com/ninjin0802/twedel/issues)へ報告してください。認証情報やCookieは絶対に貼り付けないでください。

## ☕ 開発を応援する

twedelは、これからもすべての機能を無料で利用できるオープンソースアプリです。

「面倒だったポスト整理が少し楽になった」「今後の改善も楽しみ」と感じてもらえたら、コーヒー1杯分から応援していただけるとうれしいです。支援は動作検証、継続的なメンテナンス、新機能の開発に役立てます。

### [OFUSEでtwedelの開発を応援する](https://ofuse.me/ninjin)

支援は完全に任意です。支援の有無によって、機能やアップデートに違いはありません。

## 開発者

<table>
<tr>
<td width="96"><img src="web/public/developer-ninjin.jpg" width="80" alt="開発者ninjinのアイコン"></td>
<td><strong>ninjin</strong> — <a href="https://x.com/_nin82">X: @_nin82</a><br>twedelを個人開発しています。「自分でも安心して使える、シンプルで便利なツール」を目指して、改善とメンテナンスを続けています。</td>
</tr>
</table>

- License: [MIT License](LICENSE)
- ソースからの起動・テスト・構成: [開発ガイド](docs/DEVELOPMENT.md)
- SignPath申請状況と連携手順: [申請ガイド](docs/SIGNPATH_APPLICATION.md)
- リリースの必須手順: [更新ルール](UPDATE_RULES.md)

## アンインストール

Windowsの「設定」→「アプリ」→「インストールされているアプリ」から`twedel`を選び、「アンインストール」を実行してください。

端末内の保存済み認証情報も削除する場合は、アンインストール前にアプリの「アカウント設定をリセット」を実行してください。
