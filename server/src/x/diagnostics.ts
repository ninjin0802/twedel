import type { SessionInfo, TransportMode } from '../../../shared/types.js';
import {
  API_BASE,
  HOME,
  OPERATIONS,
  TIMELINE_FEATURES,
  V11_BASE,
  V11_PROBE_PATHS,
  graphqlUrl,
} from './endpoints.js';
import { TIMELINE_CANDIDATES, likesTimelineVariables, timelineSourceInUse } from './fetchTweets.js';
import {
  cachedQueryIds,
  defaultQueryIdsUsed,
  knownQueryIds,
  lastScrapeReport,
  manualQueryIds,
} from './queryId.js';
import type { ScrapeReport } from './queryId.js';
import { getManualTransactionId } from './transactionId.js';
import type { XResponse, XTransport } from './transport.js';
import { isRecord } from './walk.js';

/**
 * The evidence-gathering route.
 *
 * The failure this exists for looked like this to the user:
 *
 *   settings.json → HTTP 404 with a JSON object body;
 *   verify_credentials.json → HTTP 404 with a JSON object body;
 *   Viewer → ... https://x.com answered HTTP 404, 0 bundle URL(s) discovered
 *
 * Everything 404s, including the plain HTML page - so every message twedel
 * could produce was a guess, and the guesses it produced ("X may have changed
 * the response shape", "the queryId is probably stale") were wrong. A 404 from
 * X routinely means "I will not route this request": the SAME url with the same
 * bearer answers 404 without `x-twitter-auth-type` and 401 with it.
 *
 * So instead of guessing, run a fixed matrix of deliberately-varied requests
 * with the session that is actually configured, and report what came back. The
 * matrix is chosen so the interesting comparisons are adjacent:
 *
 *   x.com as a DOCUMENT vs x.com with API headers
 *       -> is it the auth headers that break the HTML fetch?
 *   x.com/i/api/1.1/... vs api.x.com/1.1/...
 *       -> is it the host that breaks the v1.1 probes?
 *
 * WHAT MAY NEVER APPEAR IN THE OUTPUT: cookie values, `ct0`, the bearer, any
 * raw response body, any request header. The point of the route is that the
 * user can paste it into a chat window without reading it first, and that is
 * only true if it is true unconditionally. Statuses, top-level key NAMES,
 * lengths and X's own error strings - nothing else - and even those go through
 * the caller's redactor on the way out.
 */

/** Never let one hostile/verbose error string dominate the payload. */
const MAX_ERROR_CHARS = 300;

/** Enough key names to characterise a body; a pathological one cannot flood it. */
const MAX_KEYS = 40;

export interface DiagnosticsError {
  message: string;
  code: number | null;
}

export interface DiagnosticsProbe {
  /** Stable, human-readable name for the row. */
  label: string;
  method: 'GET' | 'POST';
  url: string;
  /** Which header set was used: the browser-navigation one or the API one. */
  headerSet: 'document' | 'api';
  /** HTTP status, or `null` when the probe did not produce a response. */
  status: number | null;
  /** Did the body parse as JSON (as opposed to arriving as text)? */
  jsonBody: boolean;
  /** TOP-LEVEL KEY NAMES ONLY. Never values. Empty for arrays and text. */
  bodyKeys: string[];
  /** Characters of body: text length, or the length of the re-serialised JSON. */
  bodyLength: number;
  /** `errors[].message` / `errors[].code`, when the body carries any. */
  errors?: DiagnosticsError[];
  /** Set when the request threw rather than answering. */
  error?: string;
  /** Set when the probe was not run at all, saying why. */
  skipped?: string;
}

export interface DiagnosticsPayload {
  /** The safety promise, restated in the payload itself. */
  note: string;
  generatedAt: string;
  transport: {
    mode: TransportMode;
    connected: boolean;
    /** Present only when a probe or the session already established it. */
    screenName?: string;
  };
  transactionId: {
    /** Whether a manual id is pinned. The VALUE is never reported. */
    manualPinned: boolean;
  };
  queryIds: {
    /** operation -> id, merged. Neither is a secret: they ship in X's own JS. */
    known: Record<string, string>;
    /** operation -> id for the ids the user pinned by hand this session. */
    manual: Record<string, string>;
    /** operation -> id learned from the disk cache / bundle scrape. */
    cached: Record<string, string>;
    /**
     * Operations currently running on a HARDCODED SNAPSHOT because nothing
     * authoritative resolved (see `endpoints.ts#DEFAULT_QUERY_IDS`). Non-empty
     * here means "these ids are as old as twedel's last release" - the first
     * thing to suspect behind an unexplained 404.
     */
    defaultsUsed: string[];
    lastScrape: ScrapeReport | null;
  };
  /**
   * The timeline candidate that last worked in this process, or `null` if none
   * has yet. X routes some subset of its timeline operations per account, so
   * "which one is this install actually using" is worth stating outright.
   */
  timelineSource: string | null;
  probes: DiagnosticsProbe[];
}

export const DIAGNOSTICS_NOTE =
  'This report contains NO credentials: no cookies, no ct0, no bearer token and no raw ' +
  'response bodies - only HTTP statuses, top-level key names, body lengths and error ' +
  'strings returned by X. It is safe to paste into a chat or an issue. Note that a bare 404 ' +
  'from X does not mean an endpoint was removed: it also answers 404 for requests it ' +
  'declines to route, which is exactly what these rows are here to tell apart. A 404 ' +
  'carrying error code 34 IS a removal - which is what both v1.1 rows have returned, on ' +
  'both hosts, since 2026-08-12. The GraphQL Viewer row is the one that still answers.';

/* -------------------------------------------------------------------------- */
/* Body description (never quotes the body)                                    */
/* -------------------------------------------------------------------------- */

function topLevelKeys(body: unknown): string[] {
  if (!isRecord(body)) return [];
  return Object.keys(body).slice(0, MAX_KEYS);
}

function bodyLengthOf(body: unknown): number {
  if (typeof body === 'string') return body.length;
  try {
    return JSON.stringify(body ?? null).length;
  } catch {
    // A body with a cycle in it cannot come off the wire, but a future
    // transport could synthesise one and a diagnostics route must not throw.
    return -1;
  }
}

/**
 * `errors[]` out of any body, GraphQL or v1.1 REST - both use the same shape,
 * and the v1.1 error text ("Sorry, that page does not exist." / code 34) is
 * exactly as diagnostic as a GraphQL one.
 */
function readErrors(body: unknown): DiagnosticsError[] {
  if (!isRecord(body)) return [];
  const raw = body['errors'];
  if (!Array.isArray(raw)) return [];

  const out: DiagnosticsError[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const message = typeof item['message'] === 'string' ? item['message'] : '';
    const extensions = item['extensions'];
    const codeRaw = item['code'] ?? (isRecord(extensions) ? extensions['code'] : undefined);
    out.push({
      message: message.slice(0, MAX_ERROR_CHARS),
      code: typeof codeRaw === 'number' ? codeRaw : null,
    });
  }
  return out;
}

function describe(res: XResponse): Omit<DiagnosticsProbe, 'label' | 'method' | 'url' | 'headerSet'> {
  const errors = readErrors(res.body);
  const probe: Omit<DiagnosticsProbe, 'label' | 'method' | 'url' | 'headerSet'> = {
    status: res.status,
    jsonBody: typeof res.body !== 'string',
    bodyKeys: topLevelKeys(res.body),
    bodyLength: bodyLengthOf(res.body),
  };
  if (errors.length > 0) probe.errors = errors;
  return probe;
}

/* -------------------------------------------------------------------------- */
/* The matrix                                                                  */
/* -------------------------------------------------------------------------- */

interface ProbeSpec {
  label: string;
  url: string;
  headerSet: 'document' | 'api';
}

/**
 * The fixed probe matrix, in the order that makes the comparisons readable.
 *
 * Rows 1 and 2 are the SAME URL fetched two ways - that pair is the whole
 * reason this route exists. Rows 3 and 4 are the same path on two hosts.
 *
 * Exported so the test can pin the exact URLs rather than re-deriving them from
 * the same constants the implementation uses.
 */
export function probeMatrix(): ProbeSpec[] {
  return [
    // The comparison. If the document row is 200 and the API-headers row is
    // not, the API header set is what was breaking the queryId scrape.
    { label: 'x.com (document fetch)', url: HOME, headerSet: 'document' },
    { label: 'x.com (API headers)', url: HOME, headerSet: 'api' },
    // The other comparison: same path, the route X's client uses vs the one it
    // does not.
    {
      label: 'v1.1 settings.json via x.com/i/api',
      url: `${V11_BASE}${V11_PROBE_PATHS.settings}`,
      headerSet: 'api',
    },
    {
      label: 'v1.1 settings.json via api.x.com',
      url: `${API_BASE}${V11_PROBE_PATHS.settings}`,
      headerSet: 'api',
    },
    {
      label: 'v1.1 verify_credentials.json via x.com/i/api',
      url: `${V11_BASE}${V11_PROBE_PATHS.verifyCredentials}`,
      headerSet: 'api',
    },
  ];
}

/**
 * One row per TIMELINE candidate operation.
 *
 * This exists because of a failure nothing else in the app could answer: the
 * live fetch died with a 404 for `UserTweetsAndReplies` while `UserByScreenName`
 * (same session, same scrape) resolved fine and `Viewer` answered 200. X ships
 * ids for a whole family of timeline operations and routes some subset of them,
 * per account. "Which timeline operation does THIS account actually get" has to
 * be answerable in one request, without running a delete.
 *
 * Same rules as the rest of the matrix: no scrape is triggered (only ids already
 * pinned or cached are used), and nothing but statuses and X's own error strings
 * comes back.
 */
export interface TimelineProbeRow {
  label: string;
  operation: string;
  /** `null` when no id is known without scraping. */
  queryId: string | null;
  /** `null` when the row cannot be built (no id, or no account id yet). */
  url: string | null;
}

export function timelineProbeRows(userId?: string): TimelineProbeRow[] {
  const known = knownQueryIds();
  const rows: TimelineProbeRow[] = [];
  for (const candidate of TIMELINE_CANDIDATES) {
    for (const spec of candidate.ops) {
      const queryId = known[spec.operation] ?? null;
      const url =
        queryId === null || userId === undefined
          ? null
          : `${graphqlUrl(queryId, spec.operation)}?${new URLSearchParams({
              variables: JSON.stringify(spec.variables({ userId, cursor: null, count: 1 })),
              features: JSON.stringify(spec.features),
            }).toString()}`;
      rows.push({ label: `timeline ${spec.operation}`, operation: spec.operation, queryId, url });
    }
  }
  return rows;
}

/**
 * The `Likes` GraphQL URL for `userId`, or `null` when no queryId is known (same
 * no-scrape rule as the Viewer/timeline probes) or no account id is resolved yet.
 *
 * A GET, so it is safe to fire here: it reads the likes timeline, it never
 * removes a like. The un-like itself (`UnfavoriteTweet`) is a WRITE and is
 * deliberately never probed - see the note row in `runDiagnostics`.
 */
export function likesProbeUrl(userId?: string): string | null {
  const queryId = knownQueryIds()[OPERATIONS.likes];
  if (!queryId || userId === undefined) return null;
  const params = new URLSearchParams({
    variables: JSON.stringify(likesTimelineVariables({ userId, cursor: null, count: 1 })),
    features: JSON.stringify(TIMELINE_FEATURES),
  });
  return `${graphqlUrl(queryId, OPERATIONS.likes)}?${params.toString()}`;
}

/** The `Viewer` GraphQL URL, or `null` when no queryId is known for it. */
export function viewerProbeUrl(): string | null {
  const queryId = knownQueryIds()[OPERATIONS.viewer];
  if (!queryId) return null;
  const params = new URLSearchParams({
    variables: JSON.stringify({ withCommunitiesMemberships: true }),
    features: JSON.stringify(TIMELINE_FEATURES),
  });
  return `${graphqlUrl(queryId, OPERATIONS.viewer)}?${params.toString()}`;
}

/**
 * The Viewer probe is deliberately NOT allowed to trigger a bundle scrape.
 *
 * `resolveQueryId` would happily go and fetch 40 chunks off abs.twimg.com; a
 * diagnostics route that quietly does a minute of network I/O and mutates the
 * on-disk queryId cache is not a diagnostic, it is a side effect. Only an id
 * that is ALREADY known (pinned or cached) is used.
 */
const VIEWER_SKIPPED =
  'no queryId is known for Viewer (pinned or cached), and this route deliberately does not ' +
  'trigger a bundle scrape - connect once, or pin one under 上級者向け, then re-run.';

const NO_SESSION_SKIPPED =
  'no session is configured, so there is nothing to send - connect first, then re-run.';

const LIKES_NO_ID_SKIPPED =
  'no queryId is known for Likes (pinned or cached), and this route deliberately does not ' +
  'trigger a bundle scrape - connect once, then re-run.';

const LIKES_NO_USER_SKIPPED =
  'the account id is not known yet, and the likes read needs one - connect first, then re-run.';

/**
 * `UnfavoriteTweet` is a WRITE: probing it would un-like a real tweet. It is
 * therefore NEVER fired - this row only reports whether an id for it is resolvable
 * without scraping, so the user can see the un-like path is wired up.
 */
function unfavoriteReachabilityNote(): string {
  const known = knownQueryIds()[OPERATIONS.unfavoriteTweet];
  return known
    ? 'UnfavoriteTweet is a write (it removes a like), so it is never probed here; a queryId ' +
        'for it IS known, so the un-like path can resolve its endpoint.'
    : 'UnfavoriteTweet is a write (it removes a like), so it is never probed here; no queryId ' +
        'is pinned or cached for it yet, so it would fall back to the built-in snapshot at run time.';
}

const TIMELINE_NO_USER_SKIPPED =
  'the account id is not known yet, and a timeline request needs one - connect first, then re-run.';

/** Same no-scrape rule as the Viewer probe: an unknown id is a skipped row. */
function timelineNoIdSkipped(operation: string): string {
  return (
    `no queryId is known for ${operation} (pinned or cached), and this route deliberately ` +
    'does not trigger a bundle scrape - connect once, then re-run.'
  );
}

/* -------------------------------------------------------------------------- */

export interface DiagnosticsInput {
  /** `null` when nothing is connected: every probe is then skipped, not failed. */
  transport: XTransport | null;
  session: SessionInfo;
  /**
   * Masks the live credentials in any string. Applied to the WHOLE payload as
   * the last step, so nothing in here has to be individually trusted.
   */
  redact?: (text: string) => string;
}

/** Deep-map every string in a JSON-ish value. */
function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as unknown as T;
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, fn)) as unknown as T;
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    // Keys are masked too: a key name is attacker-influenced when the body came
    // from X, and this costs nothing.
    for (const [k, v] of Object.entries(value)) out[fn(k)] = mapStrings(v, fn);
    return out as unknown as T;
  }
  return value;
}

async function runProbe(transport: XTransport, spec: ProbeSpec): Promise<DiagnosticsProbe> {
  const base: DiagnosticsProbe = {
    label: spec.label,
    method: 'GET',
    url: spec.url,
    headerSet: spec.headerSet,
    status: null,
    jsonBody: false,
    bodyKeys: [],
    bodyLength: 0,
  };

  try {
    const res =
      spec.headerSet === 'document'
        ? await transport.getDocument(spec.url)
        : await transport.get(spec.url);
    return { ...base, ...describe(res) };
  } catch (err: unknown) {
    // A probe that throws is a RESULT, not a failure of the route: half the
    // matrix existing to be compared against the other half is worthless if one
    // bad row takes the response down with it.
    const detail = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return { ...base, error: detail.slice(0, MAX_ERROR_CHARS) };
  }
}

/**
 * Run the matrix and describe what happened. Never throws.
 */
export async function runDiagnostics(input: DiagnosticsInput): Promise<DiagnosticsPayload> {
  const { transport, session } = input;

  const specs = probeMatrix();
  const viewerUrl = viewerProbeUrl();

  const probes: DiagnosticsProbe[] = [];

  for (const spec of specs) {
    if (transport === null) {
      probes.push({
        label: spec.label,
        method: 'GET',
        url: spec.url,
        headerSet: spec.headerSet,
        status: null,
        jsonBody: false,
        bodyKeys: [],
        bodyLength: 0,
        skipped: NO_SESSION_SKIPPED,
      });
      continue;
    }
    probes.push(await runProbe(transport, spec));
  }

  const viewerSpec: ProbeSpec = {
    label: 'GraphQL Viewer',
    url: viewerUrl ?? `${graphqlUrl('<unknown queryId>', OPERATIONS.viewer)}`,
    headerSet: 'api',
  };
  if (transport !== null && viewerUrl !== null) {
    probes.push(await runProbe(transport, viewerSpec));
  } else {
    probes.push({
      label: viewerSpec.label,
      method: 'GET',
      url: viewerSpec.url,
      headerSet: 'api',
      status: null,
      jsonBody: false,
      bodyKeys: [],
      bodyLength: 0,
      skipped: transport === null ? NO_SESSION_SKIPPED : VIEWER_SKIPPED,
    });
  }

  // One row per timeline operation: which of them X routes for THIS account is
  // the question the live fetch could not answer for itself.
  for (const row of timelineProbeRows(session.userId)) {
    const spec: ProbeSpec = {
      label: row.label,
      url: row.url ?? graphqlUrl(row.queryId ?? '<unknown queryId>', row.operation),
      headerSet: 'api',
    };
    if (transport !== null && row.url !== null) {
      probes.push(await runProbe(transport, spec));
      continue;
    }
    const skipped =
      transport === null
        ? NO_SESSION_SKIPPED
        : row.queryId === null
          ? timelineNoIdSkipped(row.operation)
          : TIMELINE_NO_USER_SKIPPED;
    probes.push({
      label: spec.label,
      method: 'GET',
      url: spec.url,
      headerSet: 'api',
      status: null,
      jsonBody: false,
      bodyKeys: [],
      bodyLength: 0,
      skipped,
    });
  }

  // The LIKES read: does the Likes timeline route for THIS session? A GET, so
  // safe to fire; skipped (never scraping) when its id or the account id is
  // missing - which is every existing no-Likes-pin scenario.
  const likesUrl = likesProbeUrl(session.userId);
  const likesSpec: ProbeSpec = {
    label: 'Likes timeline',
    url: likesUrl ?? graphqlUrl(knownQueryIds()[OPERATIONS.likes] ?? '<unknown queryId>', OPERATIONS.likes),
    headerSet: 'api',
  };
  if (transport !== null && likesUrl !== null) {
    probes.push(await runProbe(transport, likesSpec));
  } else {
    probes.push({
      label: likesSpec.label,
      method: 'GET',
      url: likesSpec.url,
      headerSet: 'api',
      status: null,
      jsonBody: false,
      bodyKeys: [],
      bodyLength: 0,
      skipped:
        transport === null
          ? NO_SESSION_SKIPPED
          : knownQueryIds()[OPERATIONS.likes] === undefined
            ? LIKES_NO_ID_SKIPPED
            : LIKES_NO_USER_SKIPPED,
    });
  }

  // The un-like WRITE. Never fired - only a reachability note (see the helper).
  probes.push({
    label: 'UnfavoriteTweet (write - not probed)',
    method: 'POST',
    url: graphqlUrl(
      knownQueryIds()[OPERATIONS.unfavoriteTweet] ?? '<unknown queryId>',
      OPERATIONS.unfavoriteTweet,
    ),
    headerSet: 'api',
    status: null,
    jsonBody: false,
    bodyKeys: [],
    bodyLength: 0,
    skipped: transport === null ? NO_SESSION_SKIPPED : unfavoriteReachabilityNote(),
  });

  const payload: DiagnosticsPayload = {
    note: DIAGNOSTICS_NOTE,
    generatedAt: new Date().toISOString(),
    transport: {
      mode: transport?.mode ?? session.mode,
      connected: session.connected === true,
      ...(session.screenName ? { screenName: session.screenName } : {}),
    },
    transactionId: { manualPinned: getManualTransactionId() !== null },
    queryIds: {
      known: knownQueryIds(),
      manual: manualQueryIds(),
      cached: cachedQueryIds(),
      defaultsUsed: defaultQueryIdsUsed(),
      lastScrape: lastScrapeReport(),
    },
    timelineSource: timelineSourceInUse(),
    probes,
  };

  const redact = input.redact;
  return redact ? mapStrings(payload, redact) : payload;
}
