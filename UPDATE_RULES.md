# twedel 更新時の必須ルール

この文書は、twedel に対する今後のユーザー指示と更新作業すべてに適用する。

## 完了条件

ユーザーから変更指示を受けた場合、実装だけで完了にしてはならない。次の作業をすべて実施し、GitHub Releases からユーザーが更新パッケージをインストールできる状態になった時点で完了とする。

1. 指示された変更を実装する。
2. 関連するテスト、型チェック、ビルドを実施する。
3. Semantic Versioning に従ってアプリのバージョンを必ず更新する。
4. アプリ内のバージョン表示、更新履歴、`package.json`、`package-lock.json` などのバージョン情報を一致させる。
5. Windows インストーラーを `npm run dist:win` で作成する。
6. `latest.yml` に記載された名前と完全に一致する次のファイルを用意する。
   - `twedel-Setup-<version>.exe`
   - `twedel-Setup-<version>.exe.blockmap`
   - `latest.yml`
7. 変更を Git にコミットし、GitHub の `main` ブランチへ push する。
8. 対応するバージョンタグの GitHub Release を正式公開する。Draft や Pre-release のままにしない。
9. GitHub Release に上記3ファイルを添付し、ユーザーが `.exe` をダウンロードしてインストールできることを確認する。
10. Release のファイル名と `latest.yml` の参照先が一致し、自動アップデートでも取得できることを確認する。
11. GitHub Release の本文はUTF-8のMarkdownファイルを用意し、`gh release create/edit --notes-file <file>` で登録する。コマンド引数へ改行エスケープを直接記述しない。
12. 公開後にGitHub Releaseページを確認し、Markdownの見出し・箇条書き・改行が正しく表示され、`` `n `` などの制御文字が本文へ露出していないことを確認する。
13. SignPath Foundation承認後は、GitHub-hosted runnerで生成された成果物だけを署名要求へ提出する。
14. Authenticode署名が`Valid`でない成果物を、署名済みとして公開しない。
15. 署名後のexeに対してblockmapと`latest.yml`を再生成し、そのハッシュ・サイズ・ファイル名を照合する。
16. README冒頭の`version`バッジを新しいアプリバージョンへ毎回更新し、`package.json`、アプリ内表示、GitHub Releaseと一致させる。
17. 公開後にREADMEをGitHub上で確認し、`version`バッジが最新バージョンを表示し、最新Releaseへ正しくリンクすることを確認する。

## バージョン管理

- 公開済みバージョンの成果物を上書きしない。
- 不具合修正や小さな変更はパッチバージョンを上げる。
- 後方互換性のある機能追加はマイナーバージョンを上げる。
- 後方互換性のない変更はメジャーバージョンを上げる。
- 1つの更新に複数の指示が含まれる場合は、公開前にまとめて1つの新バージョンとして扱ってよい。

## リリース確認

作業報告には、少なくとも次を記載する。

- 公開したバージョン
- Git のコミットと push の結果
- GitHub Release のURL
- インストーラー、blockmap、`latest.yml` の公開確認
- Release本文のMarkdown表示確認
- READMEのversionバッジと公開バージョンの一致確認
- 実施したテストとビルドの結果
