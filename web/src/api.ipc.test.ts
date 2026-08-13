import { afterEach, describe, expect, it, vi } from 'vitest';
import { getHealth, subscribe } from './api';

afterEach(() => Reflect.deleteProperty(globalThis, 'window'));

describe('packaged API IPC transport', () => {
  it('uses IPC for ordinary API requests', async () => {
    const request = vi.fn().mockResolvedValue({ status: 200, ok: true, body: '{"ok":true,"version":"0.12.0"}' });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { twedelApi: { request } } });
    await expect(getHealth()).resolves.toEqual({ ok: true, version: '0.12.0' });
    expect(request).toHaveBeenCalledWith('/api/health', {});
  });

  it('uses IPC for progress subscriptions', () => {
    const unsubscribe = vi.fn();
    const bridgeSubscribe = vi.fn((_path, listener) => { listener({ type: 'data', data: '{"done":true}' }); return unsubscribe; });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { twedelApi: { subscribe: bridgeSubscribe } } });
    const onEvent = vi.fn();
    expect(subscribe('/api/test/events', onEvent)).toBe(unsubscribe);
    expect(onEvent).toHaveBeenCalledWith({ done: true });
  });
});
