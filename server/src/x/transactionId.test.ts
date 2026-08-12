import { afterEach, describe, expect, it } from 'vitest';
import {
  generateTransactionId,
  getManualTransactionId,
  getTransactionId,
  setManualTransactionId,
} from './transactionId.js';

afterEach(() => {
  setManualTransactionId(null);
});

describe('generateTransactionId', () => {
  it('matches the observed shape: 94 base64url-ish characters', () => {
    for (let i = 0; i < 20; i += 1) {
      const id = generateTransactionId();
      expect(id).toHaveLength(94);
      expect(id).toMatch(/^[A-Za-z0-9_-]{94}$/);
    }
  });

  it('produces a different value each call', () => {
    const seen = new Set(Array.from({ length: 50 }, () => generateTransactionId()));
    expect(seen.size).toBe(50);
  });
});

describe('manual override', () => {
  it('returns the pinned value from getTransactionId while set', () => {
    setManualTransactionId('pasted-from-devtools');
    expect(getTransactionId()).toBe('pasted-from-devtools');
    expect(getTransactionId()).toBe('pasted-from-devtools');
    expect(getManualTransactionId()).toBe('pasted-from-devtools');
  });

  it('goes back to generating when cleared', () => {
    setManualTransactionId('pinned');
    setManualTransactionId(null);
    expect(getManualTransactionId()).toBeNull();
    expect(getTransactionId()).not.toBe('pinned');
    expect(getTransactionId()).toMatch(/^[A-Za-z0-9_-]{94}$/);
  });

  it('treats a blank paste as "not set"', () => {
    setManualTransactionId('   ');
    expect(getManualTransactionId()).toBeNull();
  });

  it('trims a value pasted with stray whitespace', () => {
    setManualTransactionId('  real-id  ');
    expect(getTransactionId()).toBe('real-id');
  });
});
