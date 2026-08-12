import { Router } from 'express';
import type { DiagnosticsPayload } from '../x/diagnostics.js';
import { runDiagnostics } from '../x/diagnostics.js';
import { getSession, getTransport, sessionRedactor } from '../x/session.js';
import type { XTransport } from '../x/transport.js';

export const diagnosticsRouter = Router();

/**
 * `GET /api/diagnostics` - what actually happens when twedel talks to X.
 *
 * Every other route answers "did it work". This one answers "what did X say",
 * because the failure it exists for (everything 404s, including the plain HTML
 * page) makes every "did it work" answer identical and every explanation a
 * guess. See `x/diagnostics.ts` for the matrix and why those specific probes.
 *
 * Two properties this route MUST keep:
 *  - it never returns a credential, a raw body or a request header, so its
 *    output can be pasted into a chat unread. `sessionRedactor()` is the last
 *    line of that defence, applied to the whole payload;
 *  - it never fails. A probe that throws becomes a row that says so. A user
 *    reaching for diagnostics is already having a bad time; a 500 here would
 *    be the least useful possible response.
 */
diagnosticsRouter.get('/diagnostics', async (_req, res) => {
  const session = await getSession();

  // `getTransport()` throws when nothing is connected - which is a perfectly
  // ordinary state for this route to be called in, and one the matrix reports
  // as "skipped" rather than treating as an error.
  let transport: XTransport | null = null;
  try {
    transport = getTransport();
  } catch {
    transport = null;
  }

  const payload: DiagnosticsPayload = await runDiagnostics({
    transport,
    session,
    redact: sessionRedactor(),
  });

  res.json(payload);
});
