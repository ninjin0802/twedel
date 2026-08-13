# Code signing policy

## 提供者

Free code signing provided by [SignPath.io](https://signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

この表記はSignPath Foundationの承認後に発行される署名へ適用されます。承認前のGitHub Release成果物は未署名です。

## 対象

- プロジェクト: twedel
- ソース: <https://github.com/ninjin0802/twedel>
- 署名対象: GitHub Actionsがこのリポジトリのタグ付きコミットから生成したWindows実行ファイルとインストーラー
- ライセンス: MIT License

ローカルで作成したバイナリや、GitHub Actions外からアップロードされたバイナリはSignPath Foundationの署名対象にしません。署名済み成果物へ後から変更を加えません。

## チームの役割

- Committer / Reviewer: [ninjin0802](https://github.com/ninjin0802)
- Approver: [ninjin0802](https://github.com/ninjin0802)

外部からの変更は、署名前にメンテナーがソース、ビルドスクリプト、依存関係への影響を確認します。署名要求はApproverがリリースごとに確認します。リポジトリおよびSignPathへのアクセスでは多要素認証を使用します。

## ビルドと検証

Windows成果物はGitHub-hosted Windows runner上で、`package-lock.json`に固定された依存関係を`npm ci`で復元して生成します。ワークフローは型チェック、テスト、依存関係監査、ビルドを実行し、失敗時には成果物を作成しません。

署名連携の承認後は、署名済みファイルに対してAuthenticode署名を検証し、署名後のハッシュに一致するblockmapと`latest.yml`だけをGitHub Releaseへ公開します。未署名成果物を正式Releaseへ自動公開しません。

## プライバシー

[プライバシーポリシー](PRIVACY.md)を参照してください。このプログラムは、利用者またはアプリをインストール・操作する人が明示的に要求した場合を除き、ネットワーク上の他のシステムへ情報を転送しません。

## 報告

署名済み成果物の不正利用やセキュリティ問題は、公開Issueへ機密情報を書かず、[SECURITY.md](SECURITY.md)の手順で報告してください。
