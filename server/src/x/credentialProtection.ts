const PREFIX = 'dpapi:v1:';

export interface CredentialProtector {
  encrypt(value: string): string;
  decrypt(value: string): string;
}

let protector: CredentialProtector | null = null;

/** Configured by Electron after app.whenReady(), using safeStorage (DPAPI on Windows). */
export function configureCredentialProtection(next: CredentialProtector | null): void {
  protector = next;
}

export function protectCredential(value: string): string {
  if (!value || value.startsWith(PREFIX)) return value;
  if (!protector) return value; // CLI development mode; packaged Windows configures DPAPI.
  return `${PREFIX}${protector.encrypt(value)}`;
}

export function revealCredential(value: string): string {
  if (!value.startsWith(PREFIX)) return value; // legacy plaintext, migrated on the next write.
  if (!protector) throw new Error('保存済みの認証情報を復号できません。Windowsアプリから起動してください。');
  return protector.decrypt(value.slice(PREFIX.length));
}

export function isProtectedCredential(value: string): boolean {
  return value.startsWith(PREFIX);
}
