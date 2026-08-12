import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SavedAccount, SessionInfo, TransportMode } from '../../../shared/types.js';
import { maskSecret } from '../config.js';
import {
  OPERATIONS,
  TIMELINE_FEATURES,
  V11_BASE,
  V11_PROBE_PATHS,
  WEB_BEARER,
  X_ERROR_PAGE_DOES_NOT_EXIST,
  graphqlUrl,
} from './endpoints.js';
import { resetTimelineSource } from './fetchTweets.js';
import type { HarvestOptions } from './harvest.js';
import { harvestCookies } from './harvest.js';
import { accountsFile, sessionFile } from './paths.js';
import type { PlaywrightTransportOptions } from './playwright.js';
import { createPlaywrightTransport } from './playwright.js';
import {
  clearManualQueryIds,
  resolveQueryId,
  staleDefaultNote,
  usedDefaultQueryId,
} from './queryId.js';
import type { XResponse, XTransport } from './transport.js';
import { createCookieTransport } from './transport.js';
import { deepFindString, getString, isRecord } from './walk.js';

/**
 * The connected X session.
 *
 * `<dataDir>/session.json` holds the account's REAL cookies (`auth_token` is a
 * full session bearer for the account). It is gitignored, written 0600 where
 * the OS honours that, and its contents must NEVER be returned over HTTP or
 * written to a log. Only the derived `SessionInfo` - connected flag, mode,
 * screen name, user id - is safe to hand out.
 */

/**
 * `SessionInfo` (frozen contract) has nowhere to put "why did this fail", so
 * connection results widen it with an optional human-readable `message`.
 * Still a `SessionInfo`, so every consumer of the contract keeps working.
 */
export interface SessionResult extends SessionInfo {
  message?: string;
}

interface StoredSession {
  version: 1;
  mode: TransportMode;
  authToken: string;
  ct0: string;
  screenName?: string;
  userId?: string;
  savedAt: string;
}

interface StoredAccounts {
  version: 1;
  accounts: StoredSession[];
}

function accountId(account: Pick<StoredSession, 'userId' | 'screenName'>): string {
  return account.userId ? `id:${account.userId}` : `name:${(account.screenName ?? '').toLowerCase()}`;
}

async function readAccounts(): Promise<StoredSession[]> {
  try {
    const parsed = JSON.parse(await readFile(accountsFile(), 'utf8')) as Partial<StoredAccounts>;
    return Array.isArray(parsed.accounts)
      ? parsed.accounts.filter((item) => item?.mode === 'cookie' && item.authToken && item.ct0)
      : [];
  } catch {
    return [];
  }
}

async function writeAccounts(accounts: StoredSession[]): Promise<void> {
  const file = accountsFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify({ version: 1, accounts }, null, 2)}\n`, {
    encoding: 'utf8', mode: 0o600,
  });
}

async function saveAccount(account: StoredSession): Promise<void> {
  if (account.mode !== 'cookie' || !account.screenName) return;
  const accounts = await readAccounts();
  const id = accountId(account);
  await writeAccounts([...accounts.filter((item) => accountId(item) !== id), account]);
}

let transport: XTransport | null = null;
let current: SessionInfo | null = null;
/**
 * The live session's raw cookies, kept ONLY so `sessionRedactor()` can strip
 * them out of text on its way to the user. Never read for any other purpose,
 * never returned - `sessionRedactor` hands out a masking function, not the
 * values, so no caller can obtain them through this module.
 */
let secrets: { authToken: string; ct0: string } = { authToken: '', ct0: '' };

const STALE_COOKIE_MESSAGE =
  'X rejected these cookies (401/403). They are stale or wrong. Log in to x.com in your ' +
  'browser, open DevTools > Application > Cookies > https://x.com, and copy the CURRENT ' +
  'values of auth_token and ct0. Both must come from the same browser session - a ct0 from ' +
  'an older session will fail CSRF validation even if auth_token is valid.';

/**
 * Deliberately not a victory lap. Playwright mode removes a whole class of
 * problems (stale cookies, wrong fingerprint, wrong Sec-Fetch headers) and
 * removes none of the `x-client-transaction-id` problem, so the message says
 * both things.
 */
const PLAYWRIGHT_CONNECTED_MESSAGE =
  'Connected through a real Chrome window using twedel\'s own browser profile. Requests ' +
  'now carry genuine browser cookies, User-Agent, Origin and Sec-Fetch headers, and ct0 is ' +
  're-read from the live cookie jar on every request. Note what this does NOT do: it cannot ' +
  'make X sign an x-client-transaction-id for requests twedel issues, so if X hard-requires ' +
  'that header a delete can still be refused. Keep the window open while a run is in progress.';

const PLAYWRIGHT_REJECTED_MESSAGE =
  'The browser is logged in to X, but X still rejected the request (401/403). This is not a ' +
  'cookie problem - the cookies came straight out of the live browser session. It is X\'s ' +
  'anti-automation check on the request itself, most likely the missing/invalid ' +
  'x-client-transaction-id. Next thing to try: in the twedel browser window open DevTools > ' +
  'Network, click something that loads tweets, copy the x-client-transaction-id header off one ' +
  'of the /i/api/ requests, and paste it into twedel\'s advanced settings.';

const PLAYWRIGHT_IGNORES_COOKIES_NOTE =
  'auth_token and ct0 are not used in playwright mode - the browser profile supplies them.';

async function persist(stored: StoredSession): Promise<void> {
  const file = sessionFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(stored, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

async function readStored(): Promise<StoredSession | null> {
  try {
    const raw = await readFile(sessionFile(), 'utf8');
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    const mode: TransportMode = parsed?.mode === 'playwright' ? 'playwright' : 'cookie';
    // A playwright record legitimately has empty cookies: the credentials live
    // in the browser profile, not here. It is kept only so a restart can report
    // which mode was last used - it is never enough to reconnect with.
    const usable =
      mode === 'playwright' ||
      (typeof parsed?.authToken === 'string' &&
        parsed.authToken !== '' &&
        typeof parsed.ct0 === 'string' &&
        parsed.ct0 !== '');
    if (usable) {
      return {
        version: 1,
        mode,
        authToken: typeof parsed?.authToken === 'string' ? parsed.authToken : '',
        ct0: typeof parsed?.ct0 === 'string' ? parsed.ct0 : '',
        screenName: parsed.screenName,
        userId: parsed.userId,
        savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
      };
    }
  } catch {
    // Absent or unreadable - treat as "not connected", never as a hard error.
  }
  return null;
}

interface Identity {
  screenName: string;
  userId?: string;
}

/**
 * The outcome of one identity probe.
 *
 * This used to be `Identity | null | undefined`, where `undefined` meant "not
 * 401/403 and no top-level screen_name" - which silently collapsed a 404, a 429,
 * a 500 and a reshaped 200 into the same value. The user then saw the NEXT
 * probe's failure (a rotating-queryId error for `Viewer`) presented as the root
 * cause, which is a lie: settings.json had already failed for a completely
 * different, knowable reason. `inconclusive` therefore has to carry that reason.
 */
type Probe =
  | { kind: 'identity'; identity: Identity }
  /** X definitively rejected the credentials (401/403). */
  | { kind: 'rejected' }
  /** Something else happened; `reason` is a human-readable one-liner. */
  | { kind: 'inconclusive'; reason: string };

const SETTINGS_LABEL = 'settings.json';
const VERIFY_LABEL = 'verify_credentials.json';
const VIEWER_LABEL = 'Viewer';

/**
 * Describe a body WITHOUT quoting it: an error page or a rate-limit blob can
 * contain anything, including values echoed back from our own request headers.
 * Shape and size are all the user needs to tell "JSON we didn't understand"
 * from "an HTML interstitial".
 */
function describeBody(body: unknown): string {
  if (Array.isArray(body)) return 'a JSON array body';
  if (isRecord(body)) return 'a JSON object body';
  if (typeof body === 'string') {
    return body.trim() === '' ? 'an empty body' : `a non-JSON body (${body.length} chars of text)`;
  }
  return 'an empty body';
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Read an identity out of a 2xx v1.1 body.
 *
 * `screen_name` is read at the top level first and then ANYWHERE in the body:
 * X has wrapped these payloads before, and a nested screen_name is still the
 * right answer - it is certainly a better answer than falling through to a
 * GraphQL operation whose queryId we may not be able to resolve at all.
 */
function readIdentity(body: unknown, idKey: string): Identity | null {
  const screenName = getString(body, 'screen_name') ?? deepFindString(body, 'screen_name');
  if (!screenName) return null;
  const userId = deepFindString(body, idKey);
  return userId ? { screenName, userId } : { screenName };
}

/** Does the body carry X API error `code`? Tolerates any non-JSON payload. */
function hasErrorCode(body: unknown, code: number): boolean {
  if (!isRecord(body)) return false;
  const raw = body['errors'];
  if (!Array.isArray(raw)) return false;
  return raw.some((item) => {
    if (!isRecord(item)) return false;
    const extensions = item['extensions'];
    const value = item['code'] ?? (isRecord(extensions) ? extensions['code'] : undefined);
    return value === code;
  });
}

/**
 * The substring `shapeChangeMessage` looks for to know a cause was a retirement
 * rather than a mystery. Kept as one constant so the two cannot drift apart.
 */
export const RETIRED_ENDPOINT_PHRASE = 'has been retired by X';

/**
 * A 404 carrying error code 34 is X saying the endpoint is GONE.
 *
 * Measured 2026-08-12 with a live, connected session (`GET /api/diagnostics`):
 * `settings.json` and `verify_credentials.json` both answer 404 + code 34 on
 * both `x.com/i/api` and `api.x.com`, while GraphQL `Viewer` answers 200 for the
 * very same session. Reporting that as a plain "HTTP 404" made the chained
 * failure message read like a misconfiguration and sent people re-copying
 * cookies and editing endpoint constants over an endpoint that no longer exists.
 */
function retiredReason(label: string): string {
  return (
    `${label} → HTTP 404 with X API error ${X_ERROR_PAGE_DOES_NOT_EXIST} ` +
    `("Sorry, that page does not exist"): this v1.1 endpoint ${RETIRED_ENDPOINT_PHRASE}. ` +
    'Nothing is misconfigured - it answers the same way on every host, for any session, and ' +
    'twedel keeps it only as a cheap fallback probe'
  );
}

function classify(label: string, res: XResponse, idKey: string): Probe {
  if (res.status === 401 || res.status === 403) return { kind: 'rejected' };
  if (res.status >= 200 && res.status < 300) {
    const identity = readIdentity(res.body, idKey);
    if (identity) return { kind: 'identity', identity };
    return {
      kind: 'inconclusive',
      reason: `${label} → HTTP ${res.status} with ${describeBody(res.body)} but no screen_name anywhere in it`,
    };
  }
  return {
    kind: 'inconclusive',
    reason: `${label} → HTTP ${res.status} with ${describeBody(res.body)}`,
  };
}

/**
 * One queryId-free v1.1 probe. Never throws - a transport failure is a reason.
 *
 * Addressed against `V11_BASE` (`x.com/i/api`), not `api.x.com`: the former is
 * the route X's own web client uses and answers 403 ("exists, authenticate")
 * unauthenticated, while the latter answers 404/401 for the same path with the
 * same headers. See `endpoints.ts#V11_BASE` for the measurements.
 */
async function probeV11(t: XTransport, label: string, path: string): Promise<Probe> {
  let res: XResponse;
  try {
    res = await t.get(`${V11_BASE}${path}`);
  } catch (err: unknown) {
    return { kind: 'inconclusive', reason: `${label} → the request failed: ${errorText(err)}` };
  }
  // Checked before the generic classification: a 404 + code 34 from a v1.1 path
  // is a known, finished story, and reporting it as "HTTP 404 with a JSON object
  // body" invites the reader to go looking for a cause that does not exist.
  if (res.status === 404 && hasErrorCode(res.body, X_ERROR_PAGE_DOES_NOT_EXIST)) {
    return { kind: 'inconclusive', reason: retiredReason(label) };
  }
  return classify(label, res, 'id_str');
}

/**
 * Fallback probe: the v1.1 settings endpoint. Needs no queryId, which is its
 * entire value now - as of 2026-08-12 it is retired and answers 404 + code 34.
 */
function probeSettings(t: XTransport): Promise<Probe> {
  return probeV11(t, SETTINGS_LABEL, V11_PROBE_PATHS.settings);
}

/**
 * The other queryId-free fallback. `verify_credentials.json` returned
 * `screen_name` + `id_str` for well over a decade; as of 2026-08-12 it is
 * retired too, and answers exactly as settings.json does. Kept for the same
 * reason: it costs one request and it needs no rotating id, so on the day the
 * bundle scrape breaks it is worth ruling out.
 */
function probeVerifyCredentials(t: XTransport): Promise<Probe> {
  return probeV11(t, VERIFY_LABEL, V11_PROBE_PATHS.verifyCredentials);
}

/**
 * The PRIMARY probe: the `Viewer` GraphQL operation.
 *
 * It used to be last, on the theory that the queryId-free v1.1 endpoints were
 * cheaper and more stable. They are cheaper; they are not more stable - they are
 * gone (404 + code 34 on every host). Measured 2026-08-12 against a live
 * session, `Viewer` was the only identity probe that answered at all: HTTP 200
 * with a `data` payload. Trying two retired endpoints before the working one
 * bought nothing and made every failure message open with two dead ends.
 *
 * It costs a queryId, and a queryId can fail to resolve - which is why this
 * still returns `inconclusive` rather than throwing, so the v1.1 fallbacks
 * (which need no id at all) still get their turn.
 *
 * Parsed defensively - the viewer payload nests the user under different keys
 * depending on the feature flags in play.
 */
async function probeViewer(t: XTransport): Promise<Probe> {
  let queryId: string;
  try {
    queryId = await resolveQueryId(OPERATIONS.viewer, t);
  } catch (err: unknown) {
    // The actionable "paste it from DevTools" message, plus the scrape's own
    // diagnostics. It is a CAUSE among others here, never the headline.
    return { kind: 'inconclusive', reason: `${VIEWER_LABEL} → ${errorText(err)}` };
  }

  /** Say so when the id in play is a snapshot; see `queryId.ts`. */
  const withStaleNote = (probe: Probe): Probe =>
    probe.kind === 'inconclusive' && usedDefaultQueryId(OPERATIONS.viewer)
      ? { kind: 'inconclusive', reason: `${probe.reason}. ${staleDefaultNote(OPERATIONS.viewer)}` }
      : probe;

  const params = new URLSearchParams({
    variables: JSON.stringify({ withCommunitiesMemberships: true }),
    features: JSON.stringify(TIMELINE_FEATURES),
  });

  let res: XResponse;
  try {
    res = await t.get(`${graphqlUrl(queryId, OPERATIONS.viewer)}?${params.toString()}`);
  } catch (err: unknown) {
    return withStaleNote({
      kind: 'inconclusive',
      reason: `${VIEWER_LABEL} → the request failed: ${errorText(err)}`,
    });
  }
  return withStaleNote(classify(VIEWER_LABEL, res, 'rest_id'));
}

/**
 * Every probe, most likely to answer first, stopping at the first one that
 * answers definitively.
 *
 * `Viewer` leads because it is the only one that still works (see
 * `probeViewer`); the two v1.1 endpoints follow as fallbacks for the one case
 * `Viewer` cannot cover - a queryId that will not resolve - because they need no
 * queryId at all. A `Viewer` failure therefore FALLS THROUGH; it never aborts.
 *
 * When they all give up, the reasons are CHAINED in the order they were tried,
 * so the message reads `Viewer → ...; settings.json → ...;
 * verify_credentials.json → ...` instead of blaming whichever one happened to be
 * last.
 */
async function identify(t: XTransport): Promise<Probe> {
  const reasons: string[] = [];
  for (const probe of [probeViewer, probeSettings, probeVerifyCredentials]) {
    const outcome = await probe(t);
    if (outcome.kind !== 'inconclusive') return outcome;
    reasons.push(outcome.reason);
  }
  return { kind: 'inconclusive', reason: reasons.join('; ') };
}

/**
 * Belt-and-braces: no probe interpolates a body or a header into its reason, but
 * a future one might, and a `fetch` failure can stringify request details. Every
 * message this module returns in cookie mode goes through here first.
 */
function redactCredentials(text: string, ...values: string[]): string {
  let out = text;
  for (const secret of values) {
    if (secret && secret.length >= 4) out = out.split(secret).join(maskSecret(secret));
  }
  return out;
}

/**
 * A masking function for the CURRENTLY configured session.
 *
 * `/api/diagnostics` builds a payload out of statuses, key names and X's own
 * error strings, none of which should ever contain a credential - and then runs
 * every string in it through this anyway, because "should never" is not a
 * guarantee and the whole selling point of that route is that its output is
 * safe to paste into a chat window.
 *
 * `WEB_BEARER` is included even though it is public (see `endpoints.ts`),
 * because API.md promises the API returns no bearer and a promise with an
 * asterisk on it is worse than no promise.
 */
export function sessionRedactor(): (text: string) => string {
  const { authToken, ct0 } = secrets;
  return (text: string) => redactCredentials(text, authToken, ct0, WEB_BEARER);
}

/**
 * Note what this deliberately does NOT say any more: "X may have changed the
 * response shape".
 *
 * These probes fail overwhelmingly with 404, and a 404 from X does not mean the
 * endpoint is gone. Measured on 2026-08-12, one header decides it: the same
 * `settings.json` URL with the same bearer answers 404 without
 * `x-twitter-auth-type` and 401 with it. X returns 404 for requests it refuses
 * to route just as readily as for things that do not exist, so telling the user
 * "the shape changed" sent them off editing endpoint constants when the real
 * problem was the request. `/api/diagnostics` runs the whole matrix and shows
 * which spellings of the same request X accepts.
 *
 * ...and where X DOES say an endpoint is gone - error code 34, which both v1.1
 * probes now return on every host - the message says exactly that instead, so a
 * retirement never reads as something the user could fix.
 */
function shapeChangeMessage(prefix: string, reason: string): string {
  // A chained cause can end in a full stop of its own (the queryId error does).
  const tidy = reason.replace(/\s*\.\s*$/, '');
  const diagnostics =
    'Open 上級者向け → 診断情報 (GET /api/diagnostics) to see which requests X still ' +
    'accepts; the output carries no credentials and is safe to paste.';
  // When a cause is a RETIREMENT, the 404 caveat below is not just unnecessary,
  // it is misleading: it invites the reader to hunt for a header or a host that
  // would make a dead endpoint answer.
  const tail = reason.includes(RETIRED_ENDPOINT_PHRASE)
    ? 'The retired rows above are expected to fail and are not the thing to fix - X removed ' +
      'them, and no header, host or cookie brings them back. What has to work is the GraphQL ' +
      `probe: ${diagnostics}`
    : 'A 404 here does not mean the endpoint was removed - X also answers 404 for a request ' +
      'it will not route (a single header can flip the same URL between 404 and 401). ' +
      diagnostics;
  return `${prefix} Tried: ${tidy}. ${tail}`;
}

/**
 * Connect by driving a real Chrome window instead of pasted cookies.
 *
 * Read `playwright.ts`'s header for what this does and does not fix. In short:
 * real cookies, real fingerprint, same-origin requests - but no signed
 * `x-client-transaction-id`. Every failure path here returns a message that
 * names the actual next action.
 */
async function connectPlaywright(opts?: PlaywrightTransportOptions): Promise<SessionResult> {
  // Tear the previous transport down BEFORE launching. A live playwright
  // transport owns a chrome.exe holding the profile lock, so launching first
  // would fail on that lock - and a leaked browser process is the worst kind of
  // bug to leave behind: invisible to the app, visible in Task Manager.
  if (transport) await transport.close();
  transport = null;
  current = null;
  secrets = { authToken: '', ct0: '' };

  let candidate: XTransport;
  try {
    candidate = await createPlaywrightTransport(opts);
  } catch (err: unknown) {
    // Chrome missing / profile locked / login never happened. `playwright.ts`
    // already phrased these for a human.
    return {
      connected: false,
      mode: 'playwright',
      message: err instanceof Error ? err.message : 'Could not start the twedel browser.',
    };
  }

  let outcome: Probe;
  try {
    outcome = await identify(candidate);
  } catch (err: unknown) {
    await candidate.close();
    return {
      connected: false,
      mode: 'playwright',
      message: err instanceof Error ? err.message : 'Unknown error contacting X.',
    };
  }

  if (outcome.kind === 'rejected') {
    await candidate.close();
    return { connected: false, mode: 'playwright', message: PLAYWRIGHT_REJECTED_MESSAGE };
  }

  if (outcome.kind === 'inconclusive') {
    await candidate.close();
    return {
      connected: false,
      mode: 'playwright',
      message: shapeChangeMessage(
        'The browser session reached X, but no probe returned an account screen name.',
        outcome.reason,
      ),
    };
  }

  const identity = outcome.identity;
  transport = candidate;
  current = {
    connected: true,
    mode: 'playwright',
    screenName: identity.screenName,
    userId: identity.userId,
  };

  // Written so a restart can report which mode was last used. There are no
  // cookies to save: they live in the browser profile directory, which is
  // exactly why this mode does not go stale.
  const stored: StoredSession = {
    version: 1,
    mode: 'playwright',
    authToken: '',
    ct0: '',
    screenName: identity.screenName,
    userId: identity.userId,
    savedAt: new Date().toISOString(),
  };
  await persist(stored);
  await saveAccount(stored);

  return { ...current, message: `${PLAYWRIGHT_CONNECTED_MESSAGE} ${PLAYWRIGHT_IGNORES_COOKIES_NOTE}` };
}

/**
 * Connect to X.
 *
 * In cookie mode: validate the pasted cookies with exactly one authenticated
 * request (up to three, if the earlier probes are inconclusive - see
 * `identify`), then persist them.
 * In playwright mode: `authToken`/`ct0` are ignored entirely - pass empty
 * strings - and the browser profile provides the session.
 *
 * Never throws for an authentication problem - a bad login is a normal outcome
 * and comes back as `connected: false` plus a message the user can act on.
 */
export async function setCredentials(
  authToken: string,
  ct0: string,
  mode: TransportMode,
  playwrightOptions?: PlaywrightTransportOptions,
): Promise<SessionResult> {
  if (mode === 'playwright') {
    return connectPlaywright(playwrightOptions);
  }

  const token = authToken.trim();
  const csrf = ct0.trim();

  if (token === '' || csrf === '') {
    return {
      connected: false,
      mode,
      message: 'Both auth_token and ct0 are required. Copy them from x.com cookies in DevTools.',
    };
  }

  const candidate = createCookieTransport({ authToken: token, ct0: csrf });
  const safe = (text: string): string => redactCredentials(text, token, csrf);

  let outcome: Probe;
  try {
    outcome = await identify(candidate);
  } catch (err: unknown) {
    await candidate.close();
    // Transport errors are already redacted by transport.ts; redact again anyway
    // so nothing depends on that being true of a future error source.
    return {
      connected: false,
      mode,
      message: safe(err instanceof Error ? err.message : 'Unknown error contacting X.'),
    };
  }

  if (outcome.kind === 'rejected') {
    await candidate.close();
    return { connected: false, mode, message: safe(STALE_COOKIE_MESSAGE) };
  }

  if (outcome.kind === 'inconclusive') {
    await candidate.close();
    return {
      connected: false,
      mode,
      message: safe(
        shapeChangeMessage(
          'Connected to X but could not read the account screen name from any probe.',
          outcome.reason,
        ),
      ),
    };
  }

  const identity = outcome.identity;

  // Closes a playwright transport too, so switching cookie <- playwright never
  // leaves a chrome.exe behind.
  if (transport) await transport.close();
  transport = candidate;
  secrets = { authToken: token, ct0: csrf };
  current = {
    connected: true,
    mode,
    screenName: identity.screenName,
    userId: identity.userId,
  };

  const stored: StoredSession = {
    version: 1,
    mode,
    authToken: token,
    ct0: csrf,
    screenName: identity.screenName,
    userId: identity.userId,
    savedAt: new Date().toISOString(),
  };
  await persist(stored);
  await saveAccount(stored);

  return { ...current };
}

/**
 * Said on a successful harvest, because two things are surprising about it and
 * both matter: the Chrome window is gone (that is deliberate), and the session
 * that remains is an ordinary cookie session with all of cookie mode's
 * properties - including that it can go stale.
 */
export const HARVEST_CONNECTED_MESSAGE =
  'Read auth_token and ct0 out of the twedel Chrome profile and connected in cookie mode. The ' +
  'browser window has been closed on purpose: twedel now talks to X directly, which is the fast ' +
  'path. These cookies age like any others - if X starts rejecting them, harvest again. The ' +
  'profile stays logged in, so you will not have to log in a second time.';

const HARVEST_FAILED_FALLBACK =
  '[twedel] Could not read the cookies out of the twedel browser. Try again, or paste auth_token ' +
  'and ct0 by hand.';

/**
 * "Chromeから取得": harvest the cookies out of the twedel Chrome profile and
 * connect with them as a NORMAL COOKIE SESSION.
 *
 * The browser is a means, not the transport: `harvestCookies` closes it before
 * returning, and everything after this line is byte-for-byte the cookie-mode
 * path (`setCredentials(..., 'cookie')`) - same probe chain, same
 * `session.json`, same fast direct requests. A harvested session is therefore
 * indistinguishable from a hand-pasted one, which is the point: nothing
 * downstream has to learn a third mode.
 *
 * Never throws for a user-fixable problem; a locked profile, a missing Chrome,
 * a login that never happened and a cookie X rejects all come back as
 * `connected: false` plus a message naming the next action.
 */
export async function harvestSession(opts: HarvestOptions = {}): Promise<SessionResult> {
  // A live playwright transport owns a chrome.exe holding the very profile we
  // are about to launch, so it has to go first - otherwise the harvest fails on
  // the profile lock and reports it as if the user had a stray window open.
  if (transport?.mode === 'playwright') {
    await transport.close();
    transport = null;
    current = null;
    secrets = { authToken: '', ct0: '' };
  }

  let harvested: { authToken: string; ct0: string };
  try {
    harvested = await harvestCookies(opts);
  } catch (err: unknown) {
    // Already phrased for a human by `harvest.ts` / `playwright.ts`, and
    // carrying no cookie values by construction.
    return {
      connected: false,
      mode: 'cookie',
      message: err instanceof Error ? err.message : HARVEST_FAILED_FALLBACK,
    };
  }

  const result = await setCredentials(harvested.authToken, harvested.ct0, 'cookie');
  // A failure here is about the cookies themselves and already says so; only
  // the success case needs to explain where they came from.
  return result.connected ? { ...result, message: HARVEST_CONNECTED_MESSAGE } : result;
}

/**
 * The current session, rehydrating from disk on the first call after a restart.
 *
 * Rehydration does NOT re-validate against X: that would cost a request on
 * every page load and the cookies are just as likely to be fine. A stale
 * session surfaces as a 401 on the first real operation instead.
 *
 * A playwright session cannot be rehydrated at all: it is a running browser,
 * and this function is on the synchronous-ish read path. It reports
 * `connected: false, mode: 'playwright'` so the UI preselects the right mode;
 * one click reconnects, and because the profile is still logged in there is no
 * second login.
 */
export async function getSession(): Promise<SessionInfo> {
  if (current) return { ...current };

  const stored = await readStored();
  if (!stored || stored.mode !== 'cookie') {
    return { connected: false, mode: stored?.mode ?? 'cookie' };
  }

  transport = createCookieTransport({ authToken: stored.authToken, ct0: stored.ct0 });
  secrets = { authToken: stored.authToken, ct0: stored.ct0 };
  current = {
    connected: true,
    mode: stored.mode,
    screenName: stored.screenName,
    userId: stored.userId,
  };
  return { ...current };
}

/** List saved identities without ever exposing their credentials. */
export async function getSavedAccounts(): Promise<SavedAccount[]> {
  const stored = await readStored();
  if (stored?.mode === 'cookie' && stored.screenName) await saveAccount(stored);
  const accounts = await readAccounts();
  const activeId = current?.connected
    ? accountId({ userId: current.userId, screenName: current.screenName })
    : stored?.screenName ? accountId(stored) : null;
  return accounts.map((account) => ({
    id: accountId(account),
    screenName: account.screenName ?? '?',
    ...(account.userId ? { userId: account.userId } : {}),
    active: accountId(account) === activeId,
    savedAt: account.savedAt,
  }));
}

/** Activate a previously saved cookie session without sending secrets to the UI. */
export async function switchSavedAccount(id: string): Promise<SessionResult | null> {
  const account = (await readAccounts()).find((item) => accountId(item) === id);
  if (!account) return null;
  if (transport) await transport.close();
  transport = createCookieTransport({ authToken: account.authToken, ct0: account.ct0 });
  secrets = { authToken: account.authToken, ct0: account.ct0 };
  current = { connected: true, mode: 'cookie', screenName: account.screenName, userId: account.userId };
  clearManualQueryIds();
  resetTimelineSource();
  await persist({ ...account, savedAt: new Date().toISOString() });
  return { ...current };
}

export async function removeSavedAccount(id: string): Promise<boolean> {
  const accounts = await readAccounts();
  const found = accounts.some((item) => accountId(item) === id);
  if (!found) return false;
  const active = current?.connected && accountId({ userId: current.userId, screenName: current.screenName }) === id;
  await writeAccounts(accounts.filter((item) => accountId(item) !== id));
  if (active) await clearSession();
  return true;
}

/**
 * The live transport.
 *
 * Synchronous by design so call sites in the delete runner stay simple; that
 * means `getSession()` must have run at least once since process start. Throws
 * rather than returning null so a missing session can never be mistaken for a
 * transport that silently does nothing.
 *
 * Launching a browser is async, so playwright mode does its launching in
 * `setCredentials` and stores the result in the same `transport` slot this
 * returns - the runner never learns which mode it is driving.
 */
export function getTransport(): XTransport {
  if (!transport) {
    throw new Error('[twedel] Not connected to X. Enter your auth_token and ct0 cookies first.');
  }
  return transport;
}

/**
 * Forget the session in memory and on disk.
 *
 * `transport.close()` is what shuts the playwright browser down, so this is
 * also "disconnect and close that Chrome window". It is safe to call twice.
 *
 * Manual queryId overrides go with it: they are a session-scoped intervention by
 * the user, and one silently surviving a disconnect/reconnect (possibly as a
 * different account) is exactly the kind of stale state that shows up later as
 * an unexplained 404. The SCRAPED queryId cache is kept - it describes X's
 * deployed web client rather than this session, and it is disk-backed anyway.
 * See `queryId.ts#clearManualQueryIds`.
 */
export async function clearSession(): Promise<void> {
  if (transport) await transport.close();
  transport = null;
  current = null;
  secrets = { authToken: '', ct0: '' };
  clearManualQueryIds();
  // Which timeline operation X routes is a property of the ACCOUNT, not of the
  // deployed web client, so it must not follow a disconnect into the next
  // session the way the scraped queryId cache legitimately does.
  resetTimelineSource();
  try {
    await unlink(sessionFile());
  } catch {
    // Already gone.
  }
}
