import { afterEach, describe, expect, it } from 'vitest';
import {
  configureCredentialProtection,
  isProtectedCredential,
  protectCredential,
  revealCredential,
} from './credentialProtection.js';

afterEach(() => configureCredentialProtection(null));

describe('credential protection', () => {
  it('round-trips credentials through the configured platform protector', () => {
    configureCredentialProtection({
      encrypt: (value) => Buffer.from(value, 'utf8').toString('base64'),
      decrypt: (value) => Buffer.from(value, 'base64').toString('utf8'),
    });
    const stored = protectCredential('secret-cookie');
    expect(isProtectedCredential(stored)).toBe(true);
    expect(stored).not.toContain('secret-cookie');
    expect(revealCredential(stored)).toBe('secret-cookie');
  });

  it('keeps legacy plaintext readable for migration', () => {
    expect(revealCredential('legacy-cookie')).toBe('legacy-cookie');
  });

  it('refuses to read encrypted credentials without the platform protector', () => {
    expect(() => revealCredential('dpapi:v1:ciphertext')).toThrow(/Windows/);
  });
});
