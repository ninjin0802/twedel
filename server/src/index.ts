import { mkdir } from 'node:fs/promises';
import express from 'express';
import type { Express } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { stopAllRuns, waitForRun } from './deleteRunner.js';
import { diagnosticsRouter } from './routes/diagnostics.js';
import { errorHandler } from './routes/http.js';
import { healthRouter } from './routes/health.js';
import { logRouter } from './routes/log.js';
import { runRouter } from './routes/run.js';
import { sessionRouter } from './routes/session.js';
import { tweetsRouter } from './routes/tweets.js';
import { getSession } from './x/session.js';

const LOOPBACK_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;

export function localOnly(req: Request, res: Response, next: NextFunction): void {
  const host = req.headers.host ?? '';
  if (!LOOPBACK_HOST.test(host)) {
    res.status(403).json({ error: 'Local access only.' });
    return;
  }
  const origin = req.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      if (!LOOPBACK_HOST.test(url.host) || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
        res.status(403).json({ error: 'Cross-origin access denied.' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Cross-origin access denied.' });
      return;
    }
  }
  next();
}

function securityHeaders(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  next();
}

/**
 * Build the Express app.
 *
 * Exported separately from `main()` so tests can mount the real routers on an
 * ephemeral port without booting a session or touching the real data dir.
 */
export function createApp(): Express {
  const app = express();

  app.disable('x-powered-by');
  app.use(localOnly);
  app.use(securityHeaders);

  // Archives can produce very large JSON bodies (an id list for a 100k-tweet
  // account is a few MB on its own).
  app.use(express.json({ limit: '64mb' }));

  app.use('/api', healthRouter);
  app.use('/api', sessionRouter);
  app.use('/api', diagnosticsRouter);
  app.use('/api', tweetsRouter);
  app.use('/api', runRouter);
  // Kept read-only for installations upgrading from a version that created a
  // deletion log. New runs never write entries and the desktop UI does not show it.
  app.use('/api', logRouter);

  const webDir = process.env['TWEDEL_WEB_DIR'];
  if (webDir && existsSync(webDir)) {
    app.use(express.static(webDir));
    app.get('/{*path}', (_req, res) => res.sendFile(resolve(webDir, 'index.html')));
  }

  // Last: turns thrown `HttpError`s into scrubbed JSON and keeps stack traces
  // out of the browser.
  app.use(errorHandler);

  return app;
}

export async function startServer(): Promise<void> {
  // data/ holds the local session + run logs; make sure it exists before we serve.
  await mkdir(config.dataDir, { recursive: true });

  // Rehydrate the session from disk NOW. `getTransport()` is synchronous and
  // throws unless `getSession()` has run at least once since process start, so
  // skipping this would make the first delete of every restart fail.
  const session = await getSession();
  console.log(
    session.connected
      ? `[twedel] session restored for @${session.screenName ?? '?'}`
      : '[twedel] no saved session - connect from the UI',
  );

  const app = createApp();

  // Bind the loopback interface explicitly: twedel is local-only and must never
  // be reachable from the network (no 0.0.0.0).
  const server = app.listen(config.port, config.host, () => {
    console.log(`[twedel] server listening on http://${config.host}:${config.port}`);
    console.log(`[twedel] data dir: ${config.dataDir}`);
  });

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) {
      // Second Ctrl-C: the user is insisting. Honour it, but they have been told
      // what they are interrupting.
      process.exit(130);
    }
    shuttingDown = true;

    const stopped = stopAllRuns();
    if (stopped.length > 0) {
      console.log(
        `[twedel] ${signal}: finishing the in-flight deletion before exiting ` +
          '(press Ctrl-C again to force). Nothing is abandoned mid-request.',
      );
    }

    void (async () => {
      // A cooperative stop lets the current delete finish and its outcome reach
      // the log; killing the process here is exactly how a tweet ends up deleted
      // on X and still `pending` in the log.
      await Promise.all(stopped.map((runId) => waitForRun(runId)));
      server.close(() => process.exit(0));
      // Do not wait forever on keep-alive/SSE sockets.
      setTimeout(() => process.exit(0), 2000).unref();
    })();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

// Only boot when executed directly; importing `createApp` in a test must not
// start listening on 5174.
const invokedDirectly =
  process.argv[1] !== undefined && /index\.[cm]?ts$/.test(process.argv[1].replace(/\\/g, '/'));

if (invokedDirectly) {
  startServer().catch((err: unknown) => {
    console.error('[twedel] fatal:', err);
    process.exit(1);
  });
}
