import { Router } from 'express';
import { z } from 'zod';
import type { SessionInfo } from '../../../shared/types.js';
import { setManualQueryId } from '../x/queryId.js';
import { getManualTransactionId, setManualTransactionId } from '../x/transactionId.js';
import { clearSession, getSession, harvestSession, setCredentials } from '../x/session.js';
import { HttpError, parseBody } from './http.js';

export const sessionRouter = Router();

/**
 * Session routes.
 *
 * `auth_token` / `ct0` are write-only across this whole API: they go in through
 * `POST /api/session` and are never readable back. Every response here is built
 * field-by-field from `SessionInfo` rather than by spreading whatever the
 * session module returned, so a future field added upstream cannot leak by
 * accident.
 */
function publicSession(info: SessionInfo & { message?: string }): SessionInfo {
  return {
    connected: info.connected === true,
    mode: info.mode,
    ...(info.screenName ? { screenName: info.screenName } : {}),
    ...(info.userId ? { userId: info.userId } : {}),
    ...(info.message ? { message: info.message } : {}),
  };
}

/**
 * The cookies are required per MODE, not unconditionally.
 *
 * In `playwright` mode the pasted values are ignored outright - the browser
 * profile carries the session (see `x/session.ts`). Demanding them there forced
 * the user to invent dummy strings to reach the fallback mode, which is the mode
 * they reach for precisely when cookie mode has already failed. A discriminated
 * union keeps `cookie` mode exactly as strict as it was while letting the
 * playwright body omit them (or send empty strings, which the UI may still hold
 * in state).
 */
export const credentialsSchema = z.discriminatedUnion('mode', [
  z.object({
    mode: z.literal('cookie'),
    authToken: z.string().min(1, 'auth_token is required (copy it from x.com cookies)'),
    ct0: z.string().min(1, 'ct0 is required (copy it from x.com cookies)'),
  }),
  z.object({
    mode: z.literal('playwright'),
    authToken: z.string().optional(),
    ct0: z.string().optional(),
  }),
]);

/**
 * The harvest body is entirely optional - `{}` is the normal request.
 *
 * `timeoutMs` exists so a caller can shorten the login gate (the UI does not,
 * but a smoke test wants to be told "timed out" in seconds rather than three
 * minutes). Capped at 10 minutes: the request BLOCKS for this long, and Node's
 * own `requestTimeout` would cut a longer one off mid-flight, which would leave
 * the user staring at a dead request while Chrome was still open.
 */
export const harvestSchema = z.object({
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});

const transactionIdSchema = z.object({
  value: z.string().nullable(),
});

const queryIdSchema = z.object({
  op: z.string().min(1, 'the GraphQL operation name is required'),
  id: z.string().nullable(),
});

sessionRouter.get('/session', async (_req, res) => {
  res.json(publicSession(await getSession()));
});

/**
 * Rejected cookies answer 200 with `connected: false` and a `message`, not a
 * 4xx: a stale cookie is a normal, expected state the UI renders inline, and a
 * 401 here would be indistinguishable from twedel's own auth failing.
 */
sessionRouter.post('/session', async (req, res) => {
  const body = parseBody(credentialsSchema, req);
  // `?? ''` only ever applies in playwright mode, where setCredentials ignores
  // both arguments; cookie mode is guaranteed non-empty by the schema above.
  const result = await setCredentials(body.authToken ?? '', body.ct0 ?? '', body.mode);
  res.status(200).json(publicSession(result));
});

/**
 * Open the twedel Chrome profile, read `auth_token` + `ct0` out of it, and store
 * the result as an ordinary COOKIE-mode session. The browser is closed again
 * before this responds.
 *
 * ONE BLOCKING REQUEST, deliberately: the wait is already bounded by the login
 * gate inside `harvestSession`, so a job id + status stream would add a second
 * lifecycle (and a way to lose track of a running Chrome) to buy nothing. It
 * answers 200 with `connected: false` + `message` on every user-fixable failure
 * - no Chrome, locked profile, login never happened, cookies rejected - exactly
 * like `POST /api/session`. It never returns the cookie values.
 */
sessionRouter.post('/session/harvest', async (req, res) => {
  const body = parseBody(harvestSchema, req);
  const result = await harvestSession(
    body.timeoutMs === undefined ? {} : { loginTimeoutMs: body.timeoutMs },
  );
  res.status(200).json(publicSession(result));
});

sessionRouter.delete('/session', async (_req, res) => {
  await clearSession();
  res.json({ ok: true });
});

sessionRouter.post('/session/transaction-id', (req, res) => {
  const body = parseBody(transactionIdSchema, req);
  setManualTransactionId(body.value);
  res.json({ ok: true, manual: getManualTransactionId() !== null });
});

sessionRouter.post('/session/query-id', (req, res) => {
  const body = parseBody(queryIdSchema, req);
  if (body.id !== null && body.id.trim() === '') {
    throw new HttpError(400, 'Pass null to clear a manual queryId, not an empty string.');
  }
  setManualQueryId(body.op, body.id);
  res.json({ ok: true });
});
