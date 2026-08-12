import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** <repo>/server/src -> <repo> */
const thisDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(thisDir, '..', '..');

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : fallback;
}

function envIntList(name: string, fallback: number[]): number[] {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parts = raw
    .split(',')
    .map((p) => Number.parseInt(p.trim(), 10))
    .filter((n) => Number.isFinite(n));
  return parts.length > 0 ? parts : fallback;
}

export const config = {
  /** TWEDEL_PORT */
  port: envInt('TWEDEL_PORT', 5174),
  /** Fixed loopback binding: credentials and destructive routes must never reach the LAN. */
  host: '127.0.0.1',
  /** TWEDEL_DATA_DIR - absolute; holds session cookies + run logs */
  dataDir: resolve(process.env['TWEDEL_DATA_DIR']?.trim() || resolve(repoRoot, 'data')),

  /** Pacing: random human-ish delay between deletions. */
  minDelayMs: envInt('TWEDEL_MIN_DELAY_MS', 800),
  maxDelayMs: envInt('TWEDEL_MAX_DELAY_MS', 1500),

  /** Used when a 429 gives us no usable x-rate-limit-reset header. */
  rateLimitFallbackSec: envInt('TWEDEL_RATE_LIMIT_FALLBACK_SEC', 60),

  /**
   * Hard ceiling on a single HTTP request. Node's global `fetch` has NO default
   * timeout, so a socket that connects and then never answers hangs the awaiting
   * caller forever - and in the sequential delete runner that freezes the whole
   * run on one tweet with no error and no retry. This turns that hang into a
   * normal failed attempt the runner can retry and, eventually, count.
   */
  requestTimeoutMs: envInt('TWEDEL_REQUEST_TIMEOUT_MS', 30000),

  /** Backoff schedule for retryable failures. */
  retryDelaysMs: envIntList('TWEDEL_RETRY_DELAYS_MS', [5000, 10000, 15000]),
  maxRetries: envInt('TWEDEL_MAX_RETRIES', 3),

  /** Circuit breaker: pause after this many consecutive failures. */
  consecutiveFailureLimit: envInt('TWEDEL_CONSECUTIVE_FAILURE_LIMIT', 5),
  consecutiveFailurePauseMs: envInt('TWEDEL_CONSECUTIVE_FAILURE_PAUSE_MS', 120000),
} as const;

export type Config = typeof config;

/**
 * Mask a credential-ish value for logging: `ab…(len 40)`.
 *
 * Every cookie value, bearer token, csrf token or similar MUST go through this
 * before it reaches a log line, an error message, or an API response.
 * Full credential values are never logged anywhere in twedel.
 */
export function maskSecret(s: string): string {
  if (typeof s !== 'string' || s.length === 0) return '(empty)';
  const head = s.slice(0, 2);
  return `${head}…(len ${s.length})`;
}
