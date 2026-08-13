import { createServer } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './index.js';

afterEach(() => delete process.env['TWEDEL_API_TOKEN']);

describe('packaged local API authentication', () => {
  it('rejects requests without the per-launch Electron token', async () => {
    process.env['TWEDEL_API_TOKEN'] = 'launch-secret';
    const server = createServer(createApp());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing test port');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      expect((await fetch(`${base}/api/health`)).status).toBe(403);
      const accepted = await fetch(`${base}/api/health`, {
        headers: { 'x-twedel-token': 'launch-secret' },
      });
      expect(accepted.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
