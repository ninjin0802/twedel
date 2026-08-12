# twedel local API contract (frozen)

All routes are served by the Express server on `http://127.0.0.1:5174` and proxied to the
Vite dev server at `/api`. Types referenced here come from `shared/types.ts` verbatim.

**Security rule that applies to every route:** the server never returns `auth_token` or `ct0`
in any response body, never echoes them in an error message, and never writes them to a log.

## Health

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/health` | — | `{ ok: true, version: string }` |

## Session

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/session` | — | `SessionInfo` |
| POST | `/api/session` | `{ mode: TransportMode }` + `{ authToken: string, ct0: string }` **when `mode: "cookie"`** | `SessionInfo` (200 even when `connected:false`; include `message`) |
| POST | `/api/session/harvest` | `{ timeoutMs?: number }` (optional; `{}` is the normal request) | `SessionInfo` (200 even when `connected:false`; include `message`) |
| DELETE | `/api/session` | — | `{ ok: true }` |
| POST | `/api/session/transaction-id` | `{ value: string \| null }` | `{ ok: true, manual: boolean }` |
| POST | `/api/session/query-id` | `{ op: string, id: string \| null }` | `{ ok: true }` |

`POST /api/session` responds with `{ connected: false, message }` rather than an HTTP error when the
cookies are rejected — the UI shows `message` inline. `message` is part of `SessionInfo`.

`authToken` / `ct0` are **required and non-empty only for `mode: "cookie"`**. In `mode: "playwright"`
they may be omitted (or empty): the browser profile carries the session and the server ignores
whatever is sent. A `playwright` body with no cookie fields is valid and must not be answered 400.

### `POST /api/session/harvest` — read the cookies out of Chrome

Opens twedel's dedicated Chrome profile (`data/pw-profile` — the same one `mode: "playwright"` uses,
gitignored), waits for it to be logged in to X, reads `auth_token` + `ct0` out of the browser's own
cookie jar, **closes the browser**, and stores the result as an ordinary **`mode: "cookie"`** session.
The response is the resulting `SessionInfo`; a success carries `screenName` from the same probe chain
`POST /api/session` uses.

- **It BLOCKS.** One request, resolving when the login lands or when the login gate expires (default
  **180 s**, overridable per request with `timeoutMs`, capped at 600 000). There is no job id and no
  status stream: the wait is already bounded, and a second lifecycle would only add a way to lose
  track of a running Chrome. Clients must not impose a shorter timeout of their own.
- **200 on every user-fixable failure**, with `connected: false` + `message`, exactly like
  `POST /api/session`: Chrome not installed, profile locked by another twedel window, login never
  happened (`message` names the timeout in seconds), `ct0` never appeared, or X rejecting the
  harvested cookies. `mode` is `"cookie"` in all of them — the fallback being offered is the manual
  paste, not a different transport.
- **400** only for a malformed body (`timeoutMs` must be a positive integer ≤ 600 000).
- The cookie **values are never in the response**, not even masked, and never in a `message`: the
  only thing a failure says about a cookie is whether it was present.
- A live `playwright` transport is closed first — it holds the lock on the very profile the harvest
  needs. The harvested session then replaces it, in cookie mode.

`DELETE /api/session` also drops every manual `queryId` override — a pin is scoped to the session it
was made in. The scraped `queryid` cache (`data/queryids.json`) is account-independent and survives.

## Diagnostics

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/diagnostics` | — | `DiagnosticsPayload` |

Runs a **fixed matrix of probes with the currently configured session** and reports what X answered.
It answers `200` in every case: with no session configured every probe comes back `skipped` with a
reason, and a probe whose request throws becomes a row carrying `error` rather than failing the
route. It never triggers a bundle scrape (the `Viewer` probe uses only an already-known queryId).

```ts
interface DiagnosticsProbe {
  label: string;
  method: 'GET' | 'POST';
  url: string;
  headerSet: 'document' | 'api';   // which header set was used
  status: number | null;           // null when the probe did not produce a response
  jsonBody: boolean;               // did the body parse as JSON
  bodyKeys: string[];              // TOP-LEVEL KEY NAMES ONLY — never values
  bodyLength: number;              // chars of text, or of the re-serialised JSON
  errors?: { message: string; code: number | null }[];  // errors[] from the body
  error?: string;                  // set when the request threw
  skipped?: string;                // set when the probe was not run, saying why
}

interface DiagnosticsPayload {
  note: string;                    // the safety promise, restated in the payload
  generatedAt: string;             // ISO
  transport: { mode: TransportMode; connected: boolean; screenName?: string };
  transactionId: { manualPinned: boolean };   // the VALUE is never reported
  queryIds: {
    known: Record<string, string>;   // merged
    manual: Record<string, string>;  // pinned by hand this session
    cached: Record<string, string>;  // from queryids.json / the bundle scrape
    defaultsUsed: string[];          // ops running on a hardcoded SNAPSHOT id
    lastScrape: ScrapeReport | null;
  };
  timelineSource: string | null;   // the timeline candidate that last worked
  probes: DiagnosticsProbe[];
}
```

The matrix, in order:

| # | Label | URL | headerSet |
|---|---|---|---|
| 1 | `x.com (document fetch)` | `https://x.com` | `document` |
| 2 | `x.com (API headers)` | `https://x.com` | `api` |
| 3 | `v1.1 settings.json via x.com/i/api` | `https://x.com/i/api/1.1/account/settings.json` | `api` |
| 4 | `v1.1 settings.json via api.x.com` | `https://api.x.com/1.1/account/settings.json` | `api` |
| 5 | `v1.1 verify_credentials.json via x.com/i/api` | `https://x.com/i/api/1.1/account/verify_credentials.json` | `api` |
| 6 | `GraphQL Viewer` | `https://x.com/i/api/graphql/<queryId>/Viewer?…` | `api` |
| 7–11 | `timeline <Operation>` | `https://x.com/i/api/graphql/<queryId>/<Operation>?…` | `api` |

Rows 7–11 are one per **timeline candidate operation** (`UserTweetsAndReplies`, `UserTweets`,
`UserOriginalsTimeline`, `UserRepliesTimeline`, `UserRepostsTimeline`). X routes some subset of them
per account — measured 2026-08-12, `UserTweetsAndReplies` answered 404 for a session that
`UserByScreenName` and `Viewer` both answered — so "which timeline operation does this account
actually get" has to be answerable in one request. Like the `Viewer` row, they use only ids that are
already pinned or cached: **this route never triggers a bundle scrape**, and a row with no id (or no
account id yet) comes back `skipped` with the reason.

Rows 1 and 2 are the **same URL fetched two ways**, which is the point of the route: if the document
fetch succeeds and the API-header fetch does not, the API header set is what breaks the HTML scrape.
Rows 3 and 4 are the same path on two hosts, for the same reason.

**Security rule, restated because this route is the one that could break it:** the response contains
no cookie value, no `ct0`, no bearer token, no request headers and no raw response body — statuses,
key *names*, lengths and X's own error strings only, and the whole payload is passed through the
session redactor as the last step. The response is meant to be pasteable into a chat window unread,
and `note` says so in the payload itself.

**A bare 404 from X is not "gone".** X answers 404 both for things that do not exist and for requests
it declines to route — measured 2026-08-12, `GET api.x.com/1.1/account/settings.json` with the web
bearer answers 404 without `x-twitter-auth-type` and 401 with it, on the same URL. No error message
in this API may claim a bare 404 means an endpoint was removed; point at this route instead.

**A 404 carrying X error code 34 *is* "gone".** Measured the same day through a live, connected
session: `x.com/i/api/1.1/account/settings.json`, `api.x.com/1.1/account/settings.json` and
`x.com/i/api/1.1/account/verify_credentials.json` all answered `404 {"errors":[{"code":34}]}` while
GraphQL `Viewer` answered 200 for the same session. Those v1.1 endpoints are **retired**; twedel
reports them as retired rather than as an unexplained 404, and `Viewer` is now the first identity
probe, with the v1.1 pair kept only as queryId-free fallbacks.

**A bundle listing a queryId is not evidence the server still routes the operation.** Same session,
same day: `UserTweetsAndReplies` 404'd with a queryId freshly scraped from X's own bundles, while
`UserByScreenName` — resolved from the same scrape — worked. The live fetch therefore treats the
timeline as a **candidate chain** (`server/src/x/fetchTweets.ts#TIMELINE_CANDIDATES`) and falls
through on 404 only; a 401/403 still aborts and a 429 still backs off. No error message may blame a
rotated queryId for a timeline 404.

## Tweet sources

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/tweets/archive` | `{ path: string, source?: 'tweets' \| 'likes' }` (absolute path to a `.zip` or an extracted folder) | `{ tweets: Tweet[], filesRead: string[], skipped: {file,reason}[], kind: 'tweets' \| 'likes' }` |
| POST | `/api/tweets/live` | `{ max?: number, source?: 'tweets' \| 'likes' }` | `202 { jobId: string }` |
| GET | `/api/tweets/live/:jobId/events` | — | SSE, `event: progress`, data `{ fetched: number, cursorPage: number, done: boolean, operation?: string, error?: string }` |
| GET | `/api/tweets/live/:jobId/result` | — | `{ tweets: Tweet[] }`, or `409` while still running |

`source` defaults to `'tweets'` on both routes, which is the frozen prior behaviour — omitting it
is byte-for-byte the old request. `source: 'likes'` reads the account's LIKES instead: live it pages
the `Likes` timeline (its rows are authored by other people, so the "author is the target user"
filter that the tweet timelines apply is deliberately NOT applied); archive it reads `data/like.js`
(and `like-part1.js`…). Every like row comes back with `isLike: true`, `isReply/isRetweet: false`,
and `id` set to the LIKED tweet's id — which is what `UnfavoriteTweet` takes as `tweet_id`. The
archive echoes which family it loaded as `kind`.

Archive-derived tweets always come back with `countsReliable: false`. The UI **must** disable the
like/retweet threshold inputs and show the reason whenever the loaded set is archive-derived.
Archive LIKES additionally carry no `created_at` (`createdAt: ''`); a date-range filter never
excludes a dateless row rather than silently dropping every like the moment a bound is set.

`POST /api/run` is unchanged: the store already holds full `Tweet`s including `isLike`, so a run
that includes likes un-favorites them via `UnfavoriteTweet` (variables `{ tweet_id }`) while
tweets/retweets take `DeleteTweet`/`DeleteRetweet`. Dispatch precedence is like → retweet → tweet.

## Deletion run

| Method | Path | Request | Response |
|---|---|---|---|
| POST | `/api/run` | `{ ids: string[], options?: { minDelayMs?: number, maxDelayMs?: number } }` | `202 { runId: string }` |
| GET | `/api/run/resumable` | — | `{ runs: ResumableRun[] }` |
| GET | `/api/run/:runId` | — | `ProgressEvent` (snapshot, for reconnect) |
| GET | `/api/run/:runId/events` | — | SSE, `event: progress`, data `ProgressEvent` |
| POST | `/api/run/:runId/stop` | — | `{ ok: true }` |
| POST | `/api/run/:runId/resume` | — | `202 { runId: string }` |
| DELETE | `/api/run/:runId/checkpoint` | — | `{ ok: true }` |

`POST /api/run` requires the tweets to already be known to the server (loaded via one of the source
routes) so it can write their text to the log before deleting.

The server MUST set `ProgressEvent.startedAt` so the UI's elapsed-time counter survives a page
reload, and MUST close the SSE response after emitting a terminal state (`done` / `stopped` /
`error`) — otherwise `EventSource` auto-reconnects and the client reports a dropped stream.

### Resuming an interrupted run

A run paced at ~1 deletion/second over a few thousand tweets takes hours, so being interrupted is
normal. The runner writes `data/checkpoint-<runId>.json` after every item and keeps it when the run
ends `stopped` or `error`; a clean `done` deletes it.

```ts
interface ResumableRun {
  runId: string;
  startedAt: string;   // ISO, the ORIGINAL start — a resume does not restart the clock
  remaining: number;   // tweets still to attempt
  total: number;       // size of the original target set
  ok: number;
  alreadyGone: number;
  failed: number;
}
```

`GET /api/run/resumable` lists every checkpoint on disk that is not currently being executed,
newest first, and answers `{ runs: [] }` when `data/` does not exist yet.

`POST /api/run/:runId/resume` answers `202 { runId }` with the **same** runId — a resumed run is the
same run, continuing: `startedAt` and the counters carry over, so the progress bar and ETA stay
continuous. It answers `404` when there is no usable checkpoint (never written, already discarded,
or refused — see below) and `409` when another run is in flight. It does **not** need the tweets to
be loaded on the server: the checkpoint carries each pending tweet's `text` and `isRetweet` itself,
which is what makes a resume possible after a process restart (`store.ts` is in-memory). Tweets the
log already records as `deleted` / `already_gone` for that runId are never sent to X again, and
tweets that already have a `pending` line are not logged a second time.

Checkpoints carry a `version` field. A file whose version or shape this server does not recognise is
renamed to `checkpoint-<runId>.json.unsupported` and reported as if absent, rather than resumed on
data that might be wrong — deletion is irreversible, so a refused resume is always the better error.

`DELETE /api/run/:runId/checkpoint` discards the checkpoint and always answers `{ ok: true }`,
whether or not one existed. It never touches `data/deleted-log.ndjson`: the log is the only copy of
what was already deleted.

## Deletion log

| Method | Path | Request | Response |
|---|---|---|---|
| GET | `/api/log` | `?runId=&q=&status=` (all optional) | `{ entries: DeleteLogEntry[] }` |
| GET | `/api/log.csv` | same query params | `text/csv` attachment |

The log is append-only NDJSON at `data/deleted-log.ndjson`. Every targeted tweet is written with
`status: "pending"` **before** any delete request is issued, then a second line records the outcome.
`GET /api/log` collapses duplicate ids to their latest status.
