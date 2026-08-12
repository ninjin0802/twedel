import { EventEmitter } from 'node:events';
import type { Request, Response } from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openSse } from './sse.js';

/**
 * `openSse` is exercised against a stub response so the heartbeat can be tested
 * with fake timers - a real 15-second wait per assertion is not a test suite.
 */
interface Stub {
  req: Request;
  res: Response;
  written: string[];
  headers: Record<string, string>;
  ended: boolean;
}

function stub(): Stub {
  const emitter = new EventEmitter();
  const written: string[] = [];
  const headers: Record<string, string> = {};
  const state = { ended: false };

  const res = {
    status: () => res,
    setHeader: (k: string, v: string) => {
      headers[k.toLowerCase()] = v;
    },
    flushHeaders: () => undefined,
    write: (chunk: string) => {
      written.push(chunk);
      return true;
    },
    end: () => {
      state.ended = true;
    },
  };

  return {
    req: emitter as unknown as Request,
    res: res as unknown as Response,
    written,
    headers,
    get ended() {
      return state.ended;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('openSse', () => {
  it('sets every header EventSource and reverse proxies need', () => {
    const s = stub();
    openSse(s.req, s.res);

    expect(s.headers['content-type']).toContain('text/event-stream');
    expect(s.headers['cache-control']).toContain('no-cache');
    expect(s.headers['connection']).toBe('keep-alive');
    expect(s.headers['x-accel-buffering']).toBe('no');
  });

  it('frames a named event with JSON data', () => {
    const s = stub();
    const channel = openSse(s.req, s.res);
    channel.send('progress', { state: 'running', done: 1 });

    expect(s.written).toEqual(['event: progress\ndata: {"state":"running","done":1}\n\n']);
  });

  it('sends a heartbeat comment about every 15 seconds', () => {
    const s = stub();
    openSse(s.req, s.res);

    vi.advanceTimersByTime(46_000);
    expect(s.written.filter((w) => w === ': ping\n\n')).toHaveLength(3);
  });

  it('stops the heartbeat and ends the response on close()', () => {
    const s = stub();
    const channel = openSse(s.req, s.res);

    channel.close();
    expect(s.ended).toBe(true);
    expect(channel.isClosed()).toBe(true);

    vi.advanceTimersByTime(60_000);
    expect(s.written).toHaveLength(0);
  });

  it('ignores sends after close instead of writing to a dead socket', () => {
    const s = stub();
    const channel = openSse(s.req, s.res);
    channel.close();
    channel.send('progress', { state: 'done' });

    expect(s.written).toHaveLength(0);
  });

  it('runs onClose handlers when the client disconnects', () => {
    const s = stub();
    const channel = openSse(s.req, s.res);
    const unsubscribe = vi.fn();
    channel.onClose(unsubscribe);

    (s.req as unknown as EventEmitter).emit('close');

    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(channel.isClosed()).toBe(true);
    // The client already went away; ending again would be a no-op at best.
    expect(s.ended).toBe(false);
  });

  it('runs an onClose handler registered after the fact immediately', () => {
    const s = stub();
    const channel = openSse(s.req, s.res);
    channel.close();

    const late = vi.fn();
    channel.onClose(late);
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('is idempotent', () => {
    const s = stub();
    const channel = openSse(s.req, s.res);
    const unsubscribe = vi.fn();
    channel.onClose(unsubscribe);

    channel.close();
    channel.close();
    (s.req as unknown as EventEmitter).emit('close');

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
