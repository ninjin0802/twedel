# 開発ガイド

[READMEへ戻る](../README.md)

## 必要な環境

- Windows 10／11
- Node.js 24
- Google Chrome

ここに記載するNode.jsとnpmは、ソースコードから開発・ビルドする場合だけ必要です。GitHub ReleasesのWindows版を利用する一般ユーザーには不要です。

## セットアップ

```powershell
npm install
npm run dev
```

開発画面は`http://127.0.0.1:5173`、APIは`http://127.0.0.1:5174`で起動します。

## 主なコマンド

| コマンド | 内容 |
|---|---|
| `npm run dev` | Web UIとAPIを同時起動 |
| `npm run desktop` | Electron版を起動 |
| `npm run typecheck` | TypeScriptの型チェック |
| `npm test` | Vitestのテストを実行 |
| `npm run build` | Web UIとAPIをビルド |
| `npm run dist:win` | Windowsインストーラーを作成 |

## ディレクトリ

| パス | 内容 |
|---|---|
| `desktop/` | Electronメインプロセスとpreload |
| `web/src/` | React UI |
| `server/src/` | Express APIとX通信処理 |
| `shared/` | Webとサーバーで共有する型 |
| `docs/` | 利用者・開発者向け文書とリリースノート |

## セキュリティ上の注意

- サーバーは`127.0.0.1`だけで待ち受けます。LANへ公開しないでください。
- Cookieや認証トークンをログ、テストデータ、Issueへ含めないでください。
- Xの内部APIは変更されるため、固定値やレスポンス形式を過信しないでください。
- 削除処理は取り消せないため、関連変更には十分なテストを追加してください。

## リリース

すべての更新作業は[更新時の必須ルール](../UPDATE_RULES.md)に従います。
