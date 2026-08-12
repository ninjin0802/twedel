import { describe, expect, it } from 'vitest';
import { credentialsSchema, harvestSchema } from './session.js';

/**
 * `POST /api/session` body validation, unit-tested against the schema itself.
 *
 * Driving these through the real route would mean letting `setCredentials`
 * actually launch Chrome for every playwright case - no test in this repo starts
 * a browser or touches the network, so the schema is exercised directly. The
 * HTTP wiring around it (400 shape, credential scrubbing) is covered in
 * `api.test.ts`.
 */
describe('credentialsSchema - cookie mode', () => {
  it('requires both cookies', () => {
    expect(credentialsSchema.safeParse({ mode: 'cookie', authToken: 'a', ct0: 'b' }).success).toBe(
      true,
    );

    const missingCt0 = credentialsSchema.safeParse({ mode: 'cookie', authToken: 'a' });
    expect(missingCt0.success).toBe(false);
    expect(missingCt0.error?.issues.some((i) => i.path[0] === 'ct0')).toBe(true);

    const blank = credentialsSchema.safeParse({ mode: 'cookie', authToken: '', ct0: '' });
    expect(blank.success).toBe(false);
    expect(blank.error?.issues.map((i) => i.path[0]).sort()).toEqual(['authToken', 'ct0']);
  });
});

describe('credentialsSchema - playwright mode', () => {
  it('accepts a body with no cookie fields at all', () => {
    const parsed = credentialsSchema.safeParse({ mode: 'playwright' });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.mode).toBe('playwright');
  });

  it('accepts empty cookie strings (the UI may still hold them in state)', () => {
    expect(credentialsSchema.safeParse({ mode: 'playwright', authToken: '', ct0: '' }).success).toBe(
      true,
    );
  });

  it('still accepts - and ignores - cookies that were sent anyway', () => {
    const parsed = credentialsSchema.safeParse({ mode: 'playwright', authToken: 'a', ct0: 'b' });
    expect(parsed.success).toBe(true);
  });

  it('still rejects a non-string cookie field', () => {
    expect(credentialsSchema.safeParse({ mode: 'playwright', authToken: 42 }).success).toBe(false);
  });
});

/**
 * `POST /api/session/harvest`.
 *
 * Same reason this is tested against the schema rather than over HTTP: driving
 * the real route would let `harvestSession` launch Chrome. The happy path lives
 * in `x/session.test.ts`, where the browser is a fake.
 */
describe('harvestSchema', () => {
  it('accepts an empty body - that is the normal request', () => {
    expect(harvestSchema.safeParse({}).success).toBe(true);
    expect(harvestSchema.safeParse({}).data?.timeoutMs).toBeUndefined();
  });

  it('accepts a login-gate timeout', () => {
    expect(harvestSchema.safeParse({ timeoutMs: 5_000 }).data?.timeoutMs).toBe(5_000);
  });

  it('rejects a timeout that is not a positive whole number of ms', () => {
    for (const timeoutMs of [0, -1, 1.5, '30s', null]) {
      const parsed = harvestSchema.safeParse({ timeoutMs });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.some((i) => i.path[0] === 'timeoutMs')).toBe(true);
    }
  });

  it('caps the wait, because the request BLOCKS for it', () => {
    // Node cuts a request off at its own `requestTimeout`; a gate longer than
    // that would strand the user watching a dead request with Chrome still open.
    expect(harvestSchema.safeParse({ timeoutMs: 600_000 }).success).toBe(true);
    expect(harvestSchema.safeParse({ timeoutMs: 600_001 }).success).toBe(false);
  });
});

describe('credentialsSchema - mode itself', () => {
  it('rejects an unknown or missing mode and blames the mode field', () => {
    for (const body of [{ authToken: 'a', ct0: 'b' }, { mode: 'telepathy', authToken: 'a', ct0: 'b' }]) {
      const parsed = credentialsSchema.safeParse(body);
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues.some((i) => i.path[0] === 'mode')).toBe(true);
    }
  });
});
