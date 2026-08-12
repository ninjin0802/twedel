import { resolve } from 'node:path';
import { config } from '../config.js';

/**
 * The data directory, resolved LAZILY.
 *
 * `config.dataDir` is captured once at module load. That is right for the
 * server process, but it means a test cannot redirect writes at a temp dir
 * without controlling module import order. Everything in `server/src/x/` that
 * touches disk goes through here instead, which re-reads `TWEDEL_DATA_DIR` at
 * call time with identical semantics to `config.dataDir` (absolute-resolved,
 * blank treated as unset).
 *
 * Consequence worth knowing: changing `TWEDEL_DATA_DIR` at runtime changes
 * where the session and queryId cache are read from on the *next* call.
 */
export function dataDir(): string {
  const raw = process.env['TWEDEL_DATA_DIR'];
  if (raw !== undefined && raw.trim() !== '') return resolve(raw);
  return config.dataDir;
}

/** `<dataDir>/session.json` - holds live cookies. Gitignored, never served. */
export function sessionFile(): string {
  return resolve(dataDir(), 'session.json');
}

/** `<dataDir>/accounts.json` - private saved account cookies (mode 0600 where supported). */
export function accountsFile(): string {
  return resolve(dataDir(), 'accounts.json');
}

/** `<dataDir>/queryids.json` - scraped GraphQL queryIds. Not sensitive. */
export function queryIdsFile(): string {
  return resolve(dataDir(), 'queryids.json');
}
