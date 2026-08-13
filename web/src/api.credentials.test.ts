import { afterEach, describe, expect, it, vi } from 'vitest';
import { postSession } from './api';

afterEach(() => {
  Reflect.deleteProperty(globalThis, 'window');
});

describe('credential transport', () => {
  it('uses Electron IPC instead of HTTP when the packaged bridge exists', async () => {
    const set = vi.fn().mockResolvedValue({ connected: true, mode: 'cookie' });
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { twedelCredentials: { set } },
    });
    const input = { mode: 'cookie' as const, authToken: 'secret-auth', ct0: 'secret-ct0' };
    await expect(postSession(input)).resolves.toMatchObject({ connected: true });
    expect(set).toHaveBeenCalledWith(input);
  });
});
