# twedel

自分の X (Twitter) の投稿を一括削除するための、ローカル専用 Windows アプリです。
開発時は `npm run dev`、デスクトップ版の確認は `npm run desktop`、Windowsインストーラーの作成は `npm run dist:win` を使います。v0.2.0 以降は保存済みセッションがない場合、起動時に専用 Chrome を自動で開いて認証情報を取得します。
認証情報と中断時の一時チェックポイントはこのマシンだけに置かれ、外部に出る通信は x.com 宛てのものだけです。

## Windows版をダウンロード

[最新版のインストーラーをダウンロード](https://github.com/ninjin0802/twedel/releases/latest)

Releaseページの `twedel-Setup-*.exe` をダウンロードして実行してください。

---

## ⚠️ 先に読んでください

> **削除は取り消せません。** X 側に復元手段はありません。twedel は削除したツイートの本文や結果を履歴ログへ保存しないため、必要なら事前にXのアーカイブを取得してください。
>
> **このツールは X の内部 API (非公開 API) を使います。** これは X の利用規約に違反します。実際に、自動化と判定されてアカウントがロックされ、電話番号やメールアドレスによる再認証を求められた報告が多数あります (多くは一時的なロックですが、保証はありません)。**このリスクを受け入れられない場合は使わないでください。** 削除を実行する前に、アーカイブ (データエクスポート) を取得しておくことを強く勧めます。

---

## クイックスタート

Node 24 / Windows・macOS・Linux。

```bash
npm install
npm run dev
```

ブラウザで **http://127.0.0.1:5173** を開きます。

| script | 内容 |
|---|---|
| `npm run dev` | API (5174) と Vite dev server (5173) を同時起動 |
| `npm run dev:server` | API サーバーのみ (`tsx watch server/src/index.ts`) |
| `npm run dev:web` | UI のみ (`/api` は 5174 にプロキシ) |
| `npm run typecheck` | `tsc --noEmit` をサーバー用・Web 用の 2 つの tsconfig で実行 |
| `npm run test` | vitest (ネットワークに出るテストはありません) |
| `npm run build` | UI を `dist/` にビルド |

UI は 1〜4 のステップ (認証情報 → 読み込み → 絞り込み → 実行) に沿って進みます。サーバー未起動でも「サンプルデータを読み込む」で画面だけ確認できます。

---

## Cookie の入れ方 (cookie モード)

### A. 「Chromeから取得」 (推奨・F12 不要)

1. 「1 認証情報」の **「Chromeから取得」** を押す
2. twedel 専用の Chrome ウィンドウが開くので、そこで **X にログイン** する (すでにログイン済みならそのまま待つだけ)
3. ログインが完了すると twedel が `auth_token` と `ct0` をブラウザの Cookie jar から読み取り、**ウィンドウは自動で閉じます**
4. 以後は通常の cookie モードのセッションとして動作します (`@screen_name` が表示されます)

覚えておくこと:

- **押しっぱなしで待つのが正しい動作です。** ログインが終わるまで 1 本のリクエストがそのまま開いたままになります (既定 3 分で打ち切り、タイムアウト時はその旨が表示されます)。
- **ログインは 1 回だけです。** 使うのは playwright モードと同じ専用プロファイル (`data/pw-profile`。`.gitignore` 済み) なので、ログイン状態はそこに残ります。2 回目以降は押した瞬間に取得が終わります。普段使いの Chrome プロファイルは触りません (開いていても競合しません)。
- **取得したあとブラウザは残りません。** これが playwright モードとの違いです。取得した Cookie で高速な直接 HTTP (cookie モード) に切り替わるので、削除実行中にウィンドウを開いておく必要はありません。
- **Chrome のインストールが必要です** (`channel: 'chrome'`。`npx playwright install` は不要)。Chrome が無い場合・別の twedel ウィンドウがプロファイルを掴んでいる場合は、その旨がそのまま表示されます。
- Chrome の Cookie ファイルを直接復号する方式は**採っていません**。現在の Chrome は app-bound encryption で鍵を自身の実行体に結び付けており、外部プロセスからの復号は当てになりません。そのため「Chrome にセッションを持たせたまま、CDP 経由で Cookie を尋ねる」方式にしています (playwright モードと同じ経路)。

### B. 手動で貼る (フォールバック)

A が使えないとき (Chrome を入れたくない等) は、UI の **「手動で入力」** を開いて従来どおり貼り付けられます。

1. ログイン済みの **x.com** を開き、DevTools を開く (F12)
2. **Application** → Storage → **Cookies** → `https://x.com`
3. `auth_token` と `ct0` の **Value** をコピーし、「手動で入力」の欄に貼り付ける
4. 「接続テスト」を押す。成功すると `@screen_name` が表示されます

どちらの方法でも覚えておくこと:

- `ct0` は Cookie として送られると同時に **`x-csrf-token` ヘッダーにも同じ値が入ります** (double-submit 方式の CSRF 検証)。片方だけズレると理由の分からない 403 (code 353) になります。
- **2 つの値は同じセッションから取ること。** 古い `ct0` と新しい `auth_token` の組み合わせは、`auth_token` 自体が有効でも失敗します。
- **X からログアウトすると `auth_token` は無効化されます。** 削除の実行中はログアウトしないでください。
- `auth_token` はアカウントそのものです。他人に渡さないでください。twedel は貼り付けた値を `data/session.json` に保存し、**API から読み戻せないよう** に作ってあります (書き込み専用)。ログやエラーメッセージにも生値は出ません。

---

## 2 つの通信モード

| | `cookie` | `playwright` |
|---|---|---|
| やること | Node から直接 HTTPS リクエスト | 専用 Chrome プロファイル (`data/pw-profile`) を起動し、x.com のページ内から fetch |
| 準備 | 「Chromeから取得」を 1 回押す (初回のみログイン) か、値を 2 つ手で貼る | 初回に開いた Chrome で 1 回ログイン (以後は維持) |
| 速度 | 速い | 起動に時間がかかる。実行中はウィンドウを開いたままにする |
| Cookie の鮮度 | 貼った時点で固定。X が `ct0` を回転させると途中で 403 | **毎リクエスト** ライブの Cookie jar から `ct0` を読み直す |
| フィンガープリント | Node の HTTP クライアント (ただし `user-agent` / `referer` / `origin` は Chrome のものを名乗ります) | 本物の Chrome の TLS/HTTP2・User-Agent・`Sec-Fetch-*` / `Origin` / `Referer` |
| HTML ページの取得 | API ヘッダーを付けない専用の経路 (`getDocument`)。`abs.twimg.com` の JS には Cookie も bearer も送りません | 同左 (ページ内 fetch。Cookie はブラウザ自身が付けます) |
| レスポンスヘッダー | 全部読める | 全部読める (`api.x.com/...` を `x.com/i/api/...` に書き換えて same-origin にしているため `x-rate-limit-*` も読める) |
| 必要なもの | なし | インストール済みの Google Chrome (`channel: 'chrome'`。`npx playwright install` は不要) |

**playwright モードでも解決しないこと (重要)**

`x-client-transaction-id` は **X 自身のページ JavaScript が、X 自身の出すリクエストのために署名するヘッダー**です。`page.evaluate` の中から自分で `fetch` を呼んでも、`page.request` を使っても、彼らの署名ルーチンは twedel のリクエストに対して走りません。twedel は X 自身の通信に乗っている実 ID を見かけたら拾って使い回しますが、これは日和見的な手段であって解決策ではありません (実 ID は本来 method+path ごとに導出され、単回限りの可能性もあります)。

つまり playwright モードは **「明確に成功率の高い試み」であって、保証ではありません。** X が `DeleteTweet` に有効な署名済み transaction id を必須にした場合、このモードでも失敗します。その場合の正直な次の一手は DevTools からの手動貼り付け (下記) か、諦めることです。

> playwright モードでは `auth_token` / `ct0` は使われません (ブラウザプロファイル側が持っています)。そのため通信モードに playwright を選ぶと **UI から Cookie の入力欄自体が消え**、`POST /api/session` も 2 つの値を要求しません (`{"mode":"playwright"}` だけで受け付けます)。ダミー文字列を考える必要はありません。

---

## ツイートの取得元

### A. アーカイブ ZIP (推奨)

X 本体から自分のデータをエクスポートします。

1. X の **Settings → Your account → Download an archive of your data**
2. 本人確認のあとリクエスト。**生成までおよそ 24 時間〜数日**かかります
3. 届いた ZIP をダウンロードし、twedel の「アーカイブZIP」に **絶対パス** を入力 (ZIP のままでも、展開済みフォルダでも可)

twedel が読むのは `data/tweets.js` および分割ファイル (`data/tweets-part1.js`, `-part2.js`, …。古い形式の `tweet.js` / `tweet-part1.js` も可) だけです。数 GB のメディアはメモリに載せません。

> **アーカイブの `favorite_count` / `retweet_count` は信用できません。**
> X のエクスポートは実際の反応数に関係なく `"0"` / `"0.0"` を記録します。これで絞り込むと「反応が少ない投稿だけ消す」つもりが全件を消します。
> そのため、アーカイブ由来のデータを読み込むと `countsReliable: false` が付き、**UI の「いいね数 上限」「RT数 上限」は無効化されます** (サーバー側の `applyFilter` も、信用できない件数での絞り込みを無視します)。件数で絞りたい場合はライブ取得を使ってください。

### B. ライブ取得

接続済みのセッションで `UserTweetsAndReplies` を辿り、自分のツイートを直接取得します。件数は信用できます (`countsReliable: true`)。取得は 20 件/ページで、ページ間には後述のペーシング待ちが入り、`x-rate-limit-remaining` が 0 になったら先回りして待ちます。上限件数の指定も可能です。

タイムラインには会話の文脈として他人の投稿も混ざるので、**投稿者 id が自分と一致するものだけ**を採用します。

> **タイムラインの operation は 1 つではありません。** 2026-08-12 の実測では、バンドルから取得した最新の queryId を使っても `UserTweetsAndReplies` が 404 を返しました (同じセッションで `UserByScreenName` と `Viewer` は成功)。**バンドルに id があることは、サーバがその operation を今も受け付ける証拠にはなりません。** そのため twedel は候補を順に試します: `UserTweetsAndReplies` → `UserTweets` → `UserOriginalsTimeline` + `UserRepliesTimeline` + `UserRepostsTimeline` (3 つをマージ・重複除去・新しい順)。切り替えるのは **404 のときだけ**で、401/403 はセッションの問題として中断、429 は従来通り待機します。実際にどの operation が使われたかは進捗イベントと診断情報 (`GET /api/diagnostics`) に出ます。リツイート／引用の内側にある「元ツイート」には降りていきません (他人のツイートを削除対象にしないため)。

---

## リツイートは「削除」されません

リツイートは `DeleteTweet` では消せません。twedel は `tweet.isRetweet` を見て **`DeleteRetweet` (リツイートの取り消し)** に振り分けます。

> `UnretweetTweet` という operation は X には存在しません (2026-08-12 に x.com のバンドルから抽出した約 100 個の operation 名のどこにも出てきません)。実在するのは `DeleteRetweet` です。以前の twedel は存在しない operation に振り分けていたため、リツイートは 1 件も取り消せませんでした。変数は `{ source_tweet_id, dark_request }` のままです。

- あなたのタイムラインからは消えます
- **元の投稿者のツイートは残ります** (当然ですが、他人の投稿を消しているわけではありません)
- ログには `isRetweet: true` として記録されます
- アーカイブにはリツイート判定のフラグが無いので、`RT @` で始まる本文をリツイートとみなします。この判定は安全側に倒してあります (誤って原文をリツイート扱いした場合は無害な no-op になり、その逆＝リツイートを原文扱いして削除する方向には倒れません)

---

## 安全機構

| 機構 | 内容 |
|---|---|
| ドライラン | 削除前に必ず確認ダイアログ。件数・内訳・期間・先頭 5 件のプレビューを表示し、**対象件数を数字でそのまま入力するまで**実行ボタンが有効になりません |
| 事前ログ | 対象ツイート全件の **本文を含む `pending` 行を `data/deleted-log.ndjson` に書き終えてから**、最初の削除リクエストを送ります。途中で電源が落ちても本文は残ります。ログは追記専用で、結果は 2 行目として記録されます |
| チェックポイント | 1 件処理するごとに `data/checkpoint-<runId>.json` を更新 (残り id のリスト付き)。正常完了時のみ削除されます |
| レジューム | 中断・失敗したランはチェックポイントから再開できます (`GET /api/run/resumable` → UI 上部のバナー → `POST /api/run/:runId/resume`。破棄は `DELETE /api/run/:runId/checkpoint`) |
| 中断 | 「中断」は協調的です。**実行中のリクエストは絶対に中断しません** (レスポンスを読まずに捨てると、X 側で消えたのにログ上は `pending` のままという最悪の状態になるため)。バックオフ待機中も 500ms 刻みで中断要求を見ます。Ctrl-C も同じ経路を通り、実行中の 1 件を終えてから終了します |
| ペーシング | 削除の間に **800〜1500ms** のランダム待ち (等間隔はボットの署名です) |
| レート制限対応 | 429 は失敗ではなく待機として扱い、`x-rate-limit-reset` / `retry-after` の指す時刻まで待って同じツイートを再試行 (ヘッダーが読めなければ 60 秒)。1 件につき最大 5 回まで |
| リトライ | 本当の失敗は **5s → 10s → 15s** の 3 回まで再試行 |
| サーキットブレーカー | **5 回連続で失敗**したら 120 秒停止し、再開直後の 1 件がまた失敗したらランを `error` で打ち切ります (Cookie 失効・queryId 回転・アカウントロックなどが起きているのに走り続けても傷を広げるだけなので) |
| 既に消えている | 404 や「No status found」は失敗ではなく `already_gone` として別集計します (再開したランがエラーの山に見えないように) |

数値はすべて環境変数で変更できます (「設定」参照)。1 回のランだけ変えたい場合は `POST /api/run` の `options.minDelayMs` / `options.maxDelayMs` が使えます (現状 UI からは指定できません)。

---

## トラブルシューティング

### まず「診断情報」を見る (404 が出たときは特に)

**X の 404 は「そのエンドポイントは無くなった」という意味ではありません。** リクエストを X が「通さない」と判断したときも 404 が返ります。2026-08-12 に未認証で実測した結果:

| リクエスト | 結果 |
|---|---|
| `https://x.com` (ヘッダー無し) | 200 |
| `https://x.com` + bearer + `x-twitter-auth-type` | 200 |
| `https://x.com` + bearer、`x-twitter-auth-type` **無し** | **401** |
| `https://api.x.com/1.1/account/settings.json` + bearer | **404** |
| 同上 + `x-twitter-auth-type` | **401** |
| `https://x.com/i/api/1.1/account/settings.json` + bearer | **403** |

同じ URL がヘッダー 1 つで 404 と 401 の間を行き来し、403 (「存在するので認証しろ」) を返すのは `x.com/i/api` のほうだけです。つまり 404 を見て「エンドポイントが消えた」「レスポンスの形が変わった」と読むのは誤りで、実際に見るべきは **どの形のリクエストなら通るのか** です。

そのための画面が **「1 認証情報」→ 上級者向け → 診断情報** (`GET /api/diagnostics`) です。今の設定のまま、内容を少しずつ変えた同じリクエストを一通り投げ、返ってきた HTTP ステータスだけを並べます。

- `x.com` を **document として** 取得した行と **API ヘッダー付きで** 取得した行が並びます。前者が 200 で後者が違うなら、原因は Cookie ではなく **API ヘッダーを HTML ページに付けていたこと** です
- `settings.json` が `x.com/i/api` 経由と `api.x.com` 経由の 2 行あります。ホストの違いが効いているかどうかがそのまま見えます
- 出力に **認証情報は一切含まれません** (Cookie・`ct0`・bearer・レスポンス本文・リクエストヘッダーはどれも出ません)。ステータス、トップレベルのキー**名**、本文の文字数、X 自身が返したエラー文字列だけです。中身を読まずにそのまま貼り付けて共有できます

`curl` から直接見ることもできます:

```bash
curl -s http://127.0.0.1:5174/api/diagnostics
```

未接続の状態でも 200 を返し、各行が「セッションが無いので送っていない」と自己申告します。

### 削除が急に 403 になった

`x-client-transaction-id` の問題です。twedel は既定で「形だけ正しいランダム値」を送っています (何も送らないより自然なため)。X がこれを弾き始めると、全操作が 403 (しばしば code 353 / "Bad Request") になります。順に試してください。

1. **手動で本物を貼る** — x.com を開いて DevTools → **Network** → ツイートを読み込む操作をして `/i/api/` へのリクエストを 1 つ選び、リクエストヘッダーの `x-client-transaction-id` をコピー。twedel の「1 認証情報」→ **上級者向け** → `x-client-transaction-id (手動)` に貼って「保存」。本来は単回性のはずですが、実際にはしばらく通り続けます (ラン 1 本を終えるには十分なことが多い)。プロセスが生きている間ずっと固定され、「自動に戻す」で解除できます
2. **playwright モードに切り替える** — 本物の Cookie・本物のフィンガープリントで再挑戦します。ただし前述のとおり、このヘッダー自体は署名できません
3. それでも通らないなら、その API は現状こちらに閉じられていると考えるのが正直なところです

### 「queryId が解決できません」というエラー

X は GraphQL の `queryId` を 2〜4 週間ほどで差し替えます。twedel は **手動指定 → `data/queryids.json` のキャッシュ → x.com の JS バンドル走査 → ハードコード既定値** の順で解決します。読み取り系 (`UserByScreenName` / `UserTweetsAndReplies` / `Viewer`) は回転が速いので **既定値を意図的に持っていません** (古い値を持つと、分かりやすいエラーの代わりに謎の 404 になるため)。

手動で入れる方法: x.com で DevTools → **Network** → 操作名 (例: `UserTweetsAndReplies`) でフィルタ → リクエスト URL の

```
https://x.com/i/api/graphql/<この部分>/UserTweetsAndReplies
```

をコピーし、**上級者向け** の「操作名 (op)」に操作名、「queryId」に値を入れて「上書き」。

手動の上書きは**そのセッション限り**です。「切断・消去」(`DELETE /api/session`) で全操作分がまとめて解除されます (古い手動値が別アカウントでの再接続まで生き残ると、原因の分からない 404 になるため)。通信モードを切り替えただけでは解除されません — queryId は X 側の web クライアントに属する値で、アカウントにもモードにも依存しないからです。走査で得たキャッシュ (`data/queryids.json`) は切断しても残ります。

### 接続テストが「404」を並べて失敗する

```
settings.json → HTTP 404 ...; verify_credentials.json → HTTP 404 ...;
Viewer → ... Last scrape: https://x.com answered HTTP 404, 0 bundle URL(s) discovered
```

HTML ページまで 404 になっているのが特徴です。これは **エンドポイントが消えたのではなく、リクエストの形が受け付けられていない** 状態です。上の「まず『診断情報』を見る」の手順で、どの形なら通るのかを確認してください。

twedel 側ではすでに次の 2 点を直してあります。

- **HTML の取得を API リクエストと分けました。** queryId 走査のための `https://x.com` 取得は、ブラウザのページ遷移と同じヘッダー (`user-agent` / `accept: text/html` / Cookie) だけで行い、`authorization` や `x-twitter-auth-type` は付けません。`authorization` が付いた瞬間に X はその要求を API の認証系に流し、ページの取得として扱わなくなります
- **v1.1 の probe を `x.com/i/api` に向けました** (`api.x.com` ではなく)。実測どおり、前者だけが「存在するので認証しろ」と答えます

### ライブ取得が 0 件で終わる

セッションが通っているのに 0 件なら、**`queryId` / `features` が古い**か、**リクエストの形を X が受け付けていない**かのどちらかです (X がレスポンスの形を変えた可能性は、実際にはいちばん低い)。

- `features` が不足している場合、X は `The following features cannot be null: ...` と**足りないキー名を列挙して**返します。そのキーを `server/src/x/endpoints.ts` の `TIMELINE_FEATURES` に足せば直ります (この 1 行編集で済むよう、X 関連の定数はこのファイルに集約してあります)
- HTTP 200 なのにツイートが 0 件なら、`UserTweetsAndReplies` の `queryId` が古い可能性が高いので、上の手順で手動指定して再取得してください
- HTTP 404 で失敗する場合は、`queryId` の回転と「X がリクエストを通していない」の両方があり得ます。**404 だけでは区別できない**ので、先に「診断情報」を見てください
- 1 ページ目で新規 0 件だとページングを打ち切る作りなので、「途中まで取れて止まる」ではなく「いきなり 0 件」に見えます

### セッションが拒否される (401 / 403)

- Cookie が古い → x.com で再ログインし、**両方**取り直す
- 別アカウント／別セッションの `ct0` を混ぜている → 同じセッションから取り直す
- X からログアウトした → `auth_token` は無効化済み
- playwright モードでブラウザが**ログイン済みなのに**拒否される場合、これは Cookie の問題ではありません。リクエスト自体に対する自動化判定 (ほぼ `x-client-transaction-id`) です → 上の「403」の手順へ

---

## 設定 (環境変数)

すべて `server/src/config.ts` に定義されています。未設定・空文字は既定値になります。

| 変数 | 既定値 | 意味 |
|---|---|---|
| `TWEDEL_PORT` | `5174` | API サーバーのポート |
| `TWEDEL_HOST` | `127.0.0.1` | バインドアドレス。**ループバック固定が設計。`0.0.0.0` にしないこと** |
| `TWEDEL_DATA_DIR` | `<repo>/data` | セッション・ログ・チェックポイント・ブラウザプロファイルの置き場 (絶対パスに解決) |
| `TWEDEL_MIN_DELAY_MS` | `800` | 削除間のランダム待ちの下限 |
| `TWEDEL_MAX_DELAY_MS` | `1500` | 同上限 |
| `TWEDEL_RATE_LIMIT_FALLBACK_SEC` | `60` | 429 で `x-rate-limit-reset` が読めなかったときの待ち秒数 |
| `TWEDEL_RETRY_DELAYS_MS` | `5000,10000,15000` | 失敗時のバックオフ (カンマ区切り) |
| `TWEDEL_MAX_RETRIES` | `3` | 1 件あたりの再試行回数 |
| `TWEDEL_CONSECUTIVE_FAILURE_LIMIT` | `5` | この回数連続で失敗したらサーキットブレーカー作動 |
| `TWEDEL_CONSECUTIVE_FAILURE_PAUSE_MS` | `120000` | ブレーカー作動時の停止時間 (ミリ秒) |

`TWEDEL_PORT` を変えた場合、Vite の proxy 先 (`web/vite.config.ts` の `http://127.0.0.1:5174`) と UI 側のポート `5173` はハードコードなので、合わせて編集が必要です。

---

## セキュリティ

- **`data/` には生の認証情報が入ります。** `session.json` の `auth_token` はアカウントのセッションそのものです。`.gitignore` で `data/*` を除外済み。バックアップやクラウド同期の対象にも入れないでください (`session.json` は可能な OS では `0600` で書かれます)
- **サーバーは `127.0.0.1` にのみバインドします。** 認証機構は一切無いので、LAN に晒すと誰でもあなたのツイートを消せます。`TWEDEL_HOST` を変えないでください
- **API は認証情報を絶対に返しません。** `auth_token` / `ct0` はレスポンス・エラーメッセージ・ログのどこにも出ません。ログに出す必要があるものは `maskSecret()` (`ab…(len 40)` 形式) を通します
- **`endpoints.ts` の `WEB_BEARER` は秘密情報ではありません。** これは X が自社の公開 JS バンドルに埋めている web クライアント用の定数で、ログインの有無に関わらず全訪問者で同一です。「アプリ」を識別するだけで、ユーザー認証は `auth_token` + `ct0` が担っています。User-Agent 文字列と同じ扱いでよく、環境変数化もマスクも不要です
- 削除ログ (`deleted-log.ndjson`) には削除したツイートの全文が残ります。これは仕様 (唯一の控え) ですが、内容は相応に扱ってください

---

## 開発

```bash
npm run typecheck   # tsconfig.json (server/shared) + tsconfig.web.json (web) の 2 パス
npm run test        # vitest
npm run build       # UI を dist/ へ
```

- テストは実装ファイルの隣 (`server/src/**/*.test.ts`, `web/src/*.test.ts`)。対象は `vitest.config.ts` の `include` を参照
- **ネットワークに出るテストは 1 つもありません。** X との通信を伴う部分は [msw](https://mswjs.io/) でインターセプトし、Playwright は 6 メソッドだけの手書きインターフェース (`PwContext` / `PwPage`) 越しに注入されるため、テストがブラウザを起動することもありません
- HTTP 契約は `API.md` に凍結されています。ルートを追加・変更するときは先にそちらを更新してください
- 型は `shared/types.ts` が単一の出所。`@shared` エイリアスは 2 つの tsconfig・`web/vite.config.ts`・`vitest.config.ts` の 4 箇所に定義があります

---

## プロジェクト構成

```
twedel/
├─ API.md                       ローカル HTTP 契約 (凍結)
├─ package.json                 script 定義と依存
├─ tsconfig.json                server + shared 用
├─ tsconfig.web.json            web 用
├─ vitest.config.ts             テスト対象と @shared エイリアス
├─ shared/types.ts              Tweet / FilterCriteria / ProgressEvent など共有型の唯一の出所
├─ server/src/
│  ├─ index.ts                  Express 起動・127.0.0.1 バインド・SIGINT で実行中ランを安全停止
│  ├─ config.ts                 TWEDEL_* 環境変数と既定値、maskSecret()
│  ├─ store.ts                  読み込み済みツイートのインメモリ保持 (id → 本文 / RT 判定)
│  ├─ archive.ts                アーカイブ ZIP・展開フォルダの解析と正規化
│  ├─ filter.ts                 絞り込みと集計 (純関数・I/O なし)
│  ├─ log.ts                    追記専用 NDJSON ログと CSV 変換
│  ├─ deleteRunner.ts           削除ラン本体 (事前ログ→削除、チェックポイント、バックオフ、ブレーカー)
│  └─ routes/
│     ├─ health.ts              GET /api/health
│     ├─ diagnostics.ts         GET /api/diagnostics (認証情報を含まない probe 一覧)
│     ├─ session.ts             接続・切断・Chrome からの Cookie 取得 (POST /api/session/harvest)・
│     │                         transaction-id / queryId の手動上書き
│     ├─ tweets.ts              アーカイブ読み込みとライブ取得ジョブ (SSE)
│     ├─ run.ts                 ラン開始・進捗 (SSE)・停止・レジューム
│     ├─ log.ts                 GET /api/log, /api/log.csv (Excel 対応の BOM 付き)
│     ├─ sse.ts                 SSE チャネルの共通実装
│     └─ http.ts                zod 検証と、スタックを漏らさないエラーハンドラ
├─ server/src/x/
│  ├─ endpoints.ts              X 関連定数の唯一の置き場 (bearer / GraphQL base / 既定 queryId /
│  │                            features / UA / API ヘッダーと document ヘッダーの組み立て)
│  ├─ transport.ts              XTransport 抽象 + cookie トランスポート (認証情報の redact 込み)
│  ├─ diagnostics.ts            probe マトリクスの実行と、認証情報を出さない結果の記述
│  ├─ playwright.ts             実 Chrome プロファイル経由のトランスポート + 起動/ログイン待ちの共通実装
│  │                            (冒頭コメントに能力の正直な評価)
│  ├─ harvest.ts                「Chromeから取得」: 専用プロファイルの Cookie jar から auth_token /
│  │                            ct0 を読み取り、必ずブラウザを閉じる (playwright.ts の起動部を再利用)
│  ├─ session.ts                接続判定・session.json の永続化・モード切替
│  ├─ queryId.ts                queryId 解決 (手動→キャッシュ→バンドル走査→既定値)
│  ├─ transactionId.ts          x-client-transaction-id の生成と手動固定
│ │  ├─ fetchTweets.ts             ライブ取得 (候補チェーン・ページング・レート制限順守・自分の投稿だけ採用)            ライブ取得 (ページング・レート制限順守・自分の投稿だけ採用)
│  ├─ mutate.ts                 DeleteTweet / DeleteRetweet の振り分けと結果分類
│  ├─ paths.ts                  data/ 配下のパス (遅延解決)
│  └─ walk.ts                   レスポンス JSON の構造非依存な探索 (パス直書きの禁止)
├─ web/src/
│  ├─ App.tsx                   画面全体の状態と手順の組み立て
│  ├─ api.ts                    API.md に対応する型付きクライアント + SSE 購読
│  ├─ filter.ts                 クライアント側の絞り込みと入力検証
│  ├─ sample.ts                 サーバー無しで UI を確認するためのサンプル生成
│  └─ components/               CredentialsPanel / SourcePanel / FilterBar / TweetTable /
│                               DryRunDialog / ProgressPanel / LogViewer
└─ data/                        .gitignore 済み: session.json, queryids.json,
                                deleted-log.ndjson, checkpoint-<runId>.json, pw-profile/
```

---

## 既知の制限

- **playwright セッションはサーバー再起動で復元されません。** 「実行中のブラウザ」を復元できないためです。再起動後は接続をやり直してください。プロファイルはログイン済みのままなので、再ログインは不要です
- **`npm run build` の出力 (`dist/`) を配信するものがありません。** Express は `/api` しか持たず、静的配信をしていません。現状の利用方法は `npm run dev` (Vite dev server) です
- **削除ランは同時に 1 本だけです。** 実行中に別のランを開始すると 409 が返ります
- `UserByScreenName` / `UserTweetsAndReplies` / `Viewer` の `queryId` にはハードコード既定値がありません (回転が速く、古い値は分かりにくい 404 を生むため)。バンドル走査に失敗した場合は手動指定が必要です
