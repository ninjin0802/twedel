import type {
  DeleteLogEntry,
  DeleteStatus,
  ProgressEvent,
  SessionInfo,
  TransportMode,
  Tweet,
} from '@shared/types';

/**
 * Typed wrappers over the frozen contract in API.md.
 * Credentials are write-only: nothing here ever reads auth_token / ct0 back from the server.
 */

/** POST /api/session answers 200 with connected:false + message when the cookies are rejected. */
export type SessionResult = SessionInfo & { message?: string };

/** What a source route fetches: the account's own tweets, or its likes. */
export type FetchSource = 'tweets' | 'likes' | 'all';

export interface ArchiveResult {
  tweets: Tweet[];
  filesRead: string[];
  skipped: { file: string; reason: string }[];
  /** Which family was read, echoed by the server. Absent on older servers. */
  kind?: FetchSource;
}

export interface LiveProgress {
  fetched: number;
  cursorPage: number;
  done: boolean;
  /** Which timeline operation X is actually serving this account. */
  operation?: string;
  error?: string;
}

export interface RunOptions {
  minDelayMs?: number;
  maxDelayMs?: number;
}

export interface LogQuery {
  runId?: string;
  q?: string;
  status?: DeleteStatus | '';
}

export class ApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      ...init,
      headers: init?.body ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
    });
  } catch {
    throw new ApiError('サーバーに接続できません (http://127.0.0.1:5174 が起動していません)', 0);
  }

  const raw = await res.text();
  let body: unknown = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
  }

  if (!res.ok) {
    const message =
      body && typeof body === 'object' && typeof (body as { message?: unknown }).message === 'string'
        ? (body as { message: string }).message
        : `HTTP ${res.status}`;
    throw new ApiError(message, res.status);
  }

  return body as T;
}

function qs(params: Record<string, string | number | undefined | null>): string {
  const sp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === '') continue;
    sp.set(key, String(value));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

/* ---------------------------------------------------------------- health */

export function getHealth(): Promise<{ ok: boolean; version: string }> {
  return request('/api/health');
}

/* --------------------------------------------------------------- session */

export function getSession(): Promise<SessionInfo> {
  return request('/api/session');
}

/**
 * `authToken` / `ct0` are optional because they are meaningless in playwright
 * mode - the browser profile holds the session - and the server's schema only
 * requires them for `mode: 'cookie'`.
 */
export function postSession(input: {
  authToken?: string;
  ct0?: string;
  mode: TransportMode;
}): Promise<SessionResult> {
  return request('/api/session', { method: 'POST', body: JSON.stringify(input) });
}

/**
 * 「Chromeから取得」: open the twedel Chrome profile, read `auth_token` + `ct0`
 * out of it, and connect in COOKIE mode with them.
 *
 * One long request on purpose - it resolves when the user has logged in in the
 * window that opened, or when the server's login gate times out (default 3
 * minutes). Answers 200 with `connected: false` + `message` on every
 * user-fixable failure, exactly like `postSession`. No credential comes back.
 */
export function harvestSession(input: { timeoutMs?: number } = {}): Promise<SessionResult> {
  return request('/api/session/harvest', { method: 'POST', body: JSON.stringify(input) });
}

export function deleteSession(): Promise<{ ok: true }> {
  return request('/api/session', { method: 'DELETE' });
}

export function setTransactionId(value: string | null): Promise<{ ok: true; manual: boolean }> {
  return request('/api/session/transaction-id', {
    method: 'POST',
    body: JSON.stringify({ value }),
  });
}

export function setQueryId(op: string, id: string | null): Promise<{ ok: true }> {
  return request('/api/session/query-id', { method: 'POST', body: JSON.stringify({ op, id }) });
}

/* ----------------------------------------------------------- diagnostics */

/** One row of the probe matrix. Statuses and key NAMES only - never values. */
export interface DiagnosticsProbe {
  label: string;
  method: 'GET' | 'POST';
  url: string;
  headerSet: 'document' | 'api';
  status: number | null;
  jsonBody: boolean;
  bodyKeys: string[];
  bodyLength: number;
  errors?: { message: string; code: number | null }[];
  error?: string;
  skipped?: string;
}

export interface DiagnosticsPayload {
  note: string;
  generatedAt: string;
  transport: { mode: TransportMode; connected: boolean; screenName?: string };
  transactionId: { manualPinned: boolean };
  queryIds: {
    known: Record<string, string>;
    manual: Record<string, string>;
    cached: Record<string, string>;
    /** Operations running on a hardcoded snapshot id because nothing resolved. */
    defaultsUsed: string[];
    lastScrape: Record<string, unknown> | null;
  };
  /** The timeline operation that last worked, or null if none has yet. */
  timelineSource: string | null;
  probes: DiagnosticsProbe[];
}

/**
 * What X actually answered, probe by probe.
 *
 * Contains no credentials by construction (see `server/src/x/diagnostics.ts`),
 * which is the entire point: the user is meant to be able to paste it.
 */
export function getDiagnostics(): Promise<DiagnosticsPayload> {
  return request('/api/diagnostics');
}

/* --------------------------------------------------------------- sources */

/**
 * `source` defaults to `'tweets'` (the account's own posts). Pass `'likes'` to
 * read `data/like.js` instead; omitting it keeps the frozen contract unchanged.
 */
export function loadArchive(path: string, source: FetchSource = 'tweets'): Promise<ArchiveResult> {
  return request('/api/tweets/archive', {
    method: 'POST',
    body: JSON.stringify(source === 'tweets' ? { path } : { path, source }),
  });
}

/** `source` defaults to `'tweets'`; pass `'likes'` to fetch the Likes timeline. */
export function startLiveFetch(max?: number, source: FetchSource = 'tweets'): Promise<{ jobId: string }> {
  const body: { max?: number; source?: FetchSource } = {};
  if (max) body.max = max;
  if (source !== 'tweets') body.source = source;
  return request('/api/tweets/live', { method: 'POST', body: JSON.stringify(body) });
}

export function liveEventsUrl(jobId: string): string {
  return `/api/tweets/live/${encodeURIComponent(jobId)}/events`;
}

export function getLiveResult(jobId: string): Promise<{ tweets: Tweet[] }> {
  return request(`/api/tweets/live/${encodeURIComponent(jobId)}/result`);
}

/* ------------------------------------------------------------------- run */

export function startRun(ids: string[], options?: RunOptions): Promise<{ runId: string }> {
  return request('/api/run', {
    method: 'POST',
    body: JSON.stringify(options ? { ids, options } : { ids }),
  });
}

export function getRunSnapshot(runId: string): Promise<ProgressEvent> {
  return request(`/api/run/${encodeURIComponent(runId)}`);
}

export function runEventsUrl(runId: string): string {
  return `/api/run/${encodeURIComponent(runId)}/events`;
}

export function stopRun(runId: string): Promise<{ ok: true }> {
  return request(`/api/run/${encodeURIComponent(runId)}/stop`, { method: 'POST' });
}

/* ---------------------------------------------------------------- resuming */

/** One interrupted run that still has a checkpoint on the server. */
export interface ResumableRun {
  runId: string;
  /** ISO. The ORIGINAL start; resuming continues that run rather than starting one. */
  startedAt: string;
  remaining: number;
  total: number;
  ok: number;
  alreadyGone: number;
  failed: number;
}

export function getResumableRuns(): Promise<{ runs: ResumableRun[] }> {
  return request('/api/run/resumable');
}

/**
 * Continue an interrupted run. Answers the SAME runId, so the caller mounts the
 * ordinary progress panel with it; the counters and elapsed time carry over.
 */
export function resumeRun(runId: string): Promise<{ runId: string }> {
  return request(`/api/run/${encodeURIComponent(runId)}/resume`, { method: 'POST' });
}

/** Throw the checkpoint away. Irreversible: the rest of that run can never be finished. */
export function discardCheckpoint(runId: string): Promise<{ ok: true }> {
  return request(`/api/run/${encodeURIComponent(runId)}/checkpoint`, { method: 'DELETE' });
}

/* ------------------------------------------------------------------- log */

export function getLog(query: LogQuery = {}): Promise<{ entries: DeleteLogEntry[] }> {
  return request(`/api/log${qs({ runId: query.runId, q: query.q, status: query.status })}`);
}

export function logCsvUrl(query: LogQuery = {}): string {
  return `/api/log.csv${qs({ runId: query.runId, q: query.q, status: query.status })}`;
}

/* ------------------------------------------------------------------- SSE */

/**
 * Subscribe to a server-sent-event stream. Handles both the named `progress` event
 * used by this API and unnamed `message` frames. Returns an unsubscribe function.
 */
export function subscribe<T>(
  url: string,
  onEvent: (data: T) => void,
  onError?: (error: Error) => void,
): () => void {
  let closed = false;
  let source: EventSource;

  try {
    source = new EventSource(url);
  } catch (err) {
    onError?.(err instanceof Error ? err : new Error(String(err)));
    return () => undefined;
  }

  const handle = (event: MessageEvent<string>) => {
    if (closed) return;
    try {
      onEvent(JSON.parse(event.data) as T);
    } catch {
      onError?.(new Error('SSE データを解析できませんでした'));
    }
  };

  source.addEventListener('progress', handle as EventListener);
  source.onmessage = handle;
  source.onerror = () => {
    if (closed) return;
    // EventSource reconnects automatically. A brief transport interruption is
    // expected and should not be presented as an application error.
  };

  return () => {
    closed = true;
    source.removeEventListener('progress', handle as EventListener);
    source.close();
  };
}
