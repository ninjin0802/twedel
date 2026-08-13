# SignPath Foundation申請ガイド

## 申請前チェック

- [x] 公開GitHubリポジトリ
- [x] OSI承認のMIT License
- [x] 全ての自作コードを同じOSSライセンスで公開
- [x] アプリをリリース済み
- [x] 機能、ダウンロード、アンインストール方法を文書化
- [x] Code signing policyを公開
- [x] プライバシーポリシーを公開
- [x] GitHub-hosted runnerによる検証可能なWindowsビルド
- [ ] GitHubアカウント`ninjin0802`で二要素認証を有効化
- [ ] SignPathアカウントを作成して多要素認証を有効化
- [ ] SignPath GitHub Appへ`ninjin0802/twedel`の読み取りを許可
- [ ] SignPath Foundationへ申請を送信

## 申請内容

- Project name: `twedel`
- Repository: `https://github.com/ninjin0802/twedel`
- Download page: `https://github.com/ninjin0802/twedel/releases/latest`
- License: `MIT`
- Primary platform: `Windows 10/11 x64`
- Artifact: `NSIS .exe installer and installed twedel.exe`
- Maintainer: `ninjin0802`
- Code signing policy: `https://github.com/ninjin0802/twedel/blob/main/CODE_SIGNING_POLICY.md`
- Privacy policy: `https://github.com/ninjin0802/twedel/blob/main/PRIVACY.md`

### 英文プロジェクト説明

> twedel is an open-source Windows desktop application that lets users retrieve and selectively remove their own posts, replies, reposts, and likes from X. Authentication data remains on the user's computer. The project does not operate a telemetry or account-data server. Releases are built from the public GitHub repository using GitHub-hosted Windows runners.

## 承認後に必要な値

SignPathで次を確認する。

- Organization ID
- Project slug
- Signing policy slug
- Artifact configuration slug
- CI user API token

API tokenだけをGitHub Actions secret `SIGNPATH_API_TOKEN`へ登録する。IDとslugは機密ではないためGitHub Actions Variablesへ登録してよい。秘密情報をリポジトリ、Issue、ログへ貼らない。

## 署名連携の完成条件

承認後、公式の`signpath/github-action-submit-signing-request@v2`を用いてGitHub Actions artifactを提出する。署名対象にはインストーラーだけでなくインストール後の`twedel.exe`も含める。署名後にblockmapと`latest.yml`を再生成し、次を全て確認してからReleaseへ公開する。

1. `Get-AuthenticodeSignature`が`Valid`を返す
2. 発行者がSignPath Foundationである
3. RFC 3161タイムスタンプが付いている
4. `latest.yml`のサイズ・SHA-512・ファイル名が署名済みexeと一致する
5. GitHub Releaseのexe、blockmap、`latest.yml`が同じバージョンである

未署名artifactは申請時のビルド証跡であり、正式な署名済みReleaseとして公開しない。
