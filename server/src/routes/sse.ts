import type { Request, Response } from 'express';

/**
 * Server-sent events, done the way `EventSource` actually needs.
 *
 * Three details here are not decoration:
 *  - `X-Accel-Buffering: no` and `flushHeaders()` stop a proxy (and Node's own
 *    buffering) from holding the first frame until the response ends, which for
 *    a long run means the UI shows nothing at all.
 *  - The heartbeat comment keeps intermediaries from reaping an idle connection
 *    during a two-minute circuit-breaker pause.
 *  - Closing the response on a terminal state is mandatory: `EventSource`
 *    reconnects automatically when the server closes, so a stream we leave open
 *    forever and a stream we close without a terminal event both look like "the
 *    connection dropped" to the client.
 */

/** How often to send `: ping`. Comfortably under the usual 60s idle timeouts. */
const HEARTBEAT_MS = 15_000;

export interface SseChannel {
  /** Send one named event. No-op once the response is closed. */
  send: (event: string, data: unknown) => void;
  /** Stop the heartbeat and end the response. Idempotent. */
  close: () => void;
  /** True once the client disconnected or `close()` ran. */
  isClosed: () => boolean;
  /** Run `fn` when the client disconnects. */
  onClose: (fn: () => void) => void;
}

export function openSse(req: Request, res: Response): SseChannel {
  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  let closed = false;
  const closeHandlers: (() => void)[] = [];

  // `unref` so an open SSE stream never keeps the process (or a test run) alive.
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, HEARTBEAT_MS);
  heartbeat.unref?.();

  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    for (const fn of closeHandlers.splice(0)) fn();
  };

  req.on('close', cleanup);

  return {
    send(event: string, data: unknown): void {
      if (closed) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    close(): void {
      if (closed) return;
      cleanup();
      res.end();
    },
    isClosed: () => closed,
    onClose(fn: () => void): void {
      if (closed) fn();
      else closeHandlers.push(fn);
    },
  };
}
