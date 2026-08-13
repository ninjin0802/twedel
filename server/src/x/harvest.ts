import { maskSecret } from '../config.js';
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { PlaywrightTransportOptions } from './playwright.js';
import { HOME_URL, X_ORIGIN, openLoggedInContext, readCookie } from './playwright.js';

/**
 * Read `auth_token` + `ct0` straight out of the twedel Chrome profile's own
 * cookie jar, so nobody has to press F12 and copy two strings by hand.
 *
 * WHY IT IS DONE THIS WAY. The obvious alternative - decrypt Chrome's
 * `Network\Cookies` SQLite file - does not work any more: since the
 * app-bound-encryption rollout the cookie key is sealed to Chrome's own
 * executable identity, and an external process cannot reliably unseal it. So we
 * do not fight Chrome for the jar; we let Chrome hold the session and ask it for
 * the cookies over CDP, which is exactly the channel `playwright.ts` already
 * uses. Same launcher, same dedicated profile, same bounded login gate.
 *
 * WHAT IT IS NOT. This is a ONE-SHOT operation, not a transport. The browser is
 * closed before this function returns, on every path including thrown errors -
 * the harvested cookies then drive the ordinary, fast cookie transport. A
 * leaked chrome.exe would be invisible in the app and hold the profile lock
 * against the next harvest, so the teardown is a `finally`, never a happy-path
 * statement.
 *
 * Cookie VALUES never appear in a status line, an error message or a log: the
 * only thing this module ever says about a value is whether it was there, plus
 * `maskSecret`'s `ab…(len 40)` form.
 */

export type HarvestOptions = PlaywrightTransportOptions;

/** What the browser profile gave us. Never logged, never returned over HTTP. */
export interface HarvestedCookies {
  authToken: string;
  ct0: string;
}

/**
 * Cache-only paths safe to remove after Chrome has closed.
 * Cookie/Network/Login Data are deliberately absent: they carry the login.
 */
export function browserCachePaths(profileDir: string): string[] {
  const base = join(profileDir, 'Default');
  return [
    join(base, 'Cache'),
    join(base, 'Code Cache'),
    join(base, 'GPUCache'),
    join(base, 'DawnGraphiteCache'),
    join(base, 'DawnWebGPUCache'),
    join(base, 'Service Worker', 'CacheStorage'),
    join(base, 'Service Worker', 'ScriptCache'),
    join(profileDir, 'GrShaderCache'),
    join(profileDir, 'ShaderCache'),
  ];
}

/** Best-effort cleanup; a locked cache must never turn a successful login into a failure. */
export async function cleanupBrowserCaches(profileDir: string): Promise<void> {
  await Promise.all(browserCachePaths(profileDir).map((path) =>
    rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined),
  ));
  try {
    const names = await readdir(join(profileDir, 'BrowserMetrics'));
    await Promise.all(names.map((name) =>
      rm(join(profileDir, 'BrowserMetrics', name), { force: true }).catch(() => undefined),
    ));
  } catch {
    // Directory absent or still locked.
  }
}

/**
 * How many times to re-read the jar after forcing a page load.
 *
 * `ct0` is set by X's own client, and on a jar that has just been logged in it
 * can lag `auth_token` by a moment. Bounded, because "poll forever" with a
 * browser window open is the failure mode the login gate exists to prevent.
 */
const CT0_REREADS = 3;

/**
 * Describe a cookie WITHOUT revealing it. `maskSecret` is the repo-wide masking
 * form, so a message about a present cookie still carries no usable value.
 */
function describeCookie(value: string): string {
  return value === '' ? 'missing' : `present (${maskSecret(value)})`;
}

function missingCookiesMessage(authToken: string, ct0: string): string {
  return (
    '[twedel] The twedel Chrome profile is logged in to X, but twedel could not read both ' +
    `cookies out of it (auth_token: ${describeCookie(authToken)}, ct0: ${describeCookie(ct0)}). ` +
    'ct0 is normally set by X\'s own page code on the first authenticated request, so this ' +
    'usually means x.com never finished loading in the twedel window. Try again; if it keeps ' +
    'failing, open the twedel Chrome window, load https://x.com/home, confirm you are logged in ' +
    'as the right account, and harvest again - or fall back to pasting auth_token and ct0 by hand.'
  );
}

/**
 * Open the twedel Chrome profile, wait for it to be logged in to X, and take
 * the two cookies cookie mode needs.
 *
 * Resolves immediately for a returning user (the profile persists, so the
 * `auth_token` is usually already in the jar); otherwise the caller's
 * `onStatus` gets the "log in in the window we just opened" prompt and the
 * bounded gate polls until the login lands or `loginTimeoutMs` expires.
 *
 * Throws - never returns a half-result - when Chrome cannot start, the profile
 * is locked, the login never happens, or either cookie is still absent. Every
 * one of those messages names the next thing the user can do.
 */
export async function harvestCookies(opts: HarvestOptions = {}): Promise<HarvestedCookies> {
  const status = opts.onStatus ?? (() => {});

  // Launch + login gate. Throws with an actionable message, and closes the
  // browser itself on the paths that fail before it hands one back.
  const browser = await openLoggedInContext(opts);

  try {
    let cookies = await browser.context.cookies(X_ORIGIN);
    let authToken = readCookie(cookies, 'auth_token');
    let ct0 = readCookie(cookies, 'ct0');

    if (ct0 === '') {
      // Nothing retired to call here (the v1.1 endpoints are gone - see
      // `session.ts#retiredReason`), and issuing an API request ourselves would
      // need the very ct0 we are missing. Loading the logged-in home shell makes
      // X's own client set it, which is the only thing that reliably does.
      status('Loading x.com to let X set the ct0 cookie…');
      try {
        await browser.page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      } catch {
        // The re-reads below are the real check; a slow shell is not fatal.
      }
      for (let attempt = 0; attempt < CT0_REREADS && ct0 === ''; attempt += 1) {
        await browser.deps.sleep(browser.pollIntervalMs);
        cookies = await browser.context.cookies(X_ORIGIN);
        ct0 = readCookie(cookies, 'ct0');
        // The jar can rotate under us; take the freshest auth_token with it so
        // the pair always comes from the same read.
        const refreshed = readCookie(cookies, 'auth_token');
        if (refreshed !== '') authToken = refreshed;
      }
    }

    if (authToken === '' || ct0 === '') {
      throw new Error(missingCookiesMessage(authToken, ct0));
    }

    status('Read auth_token and ct0 from the twedel Chrome profile.');
    return { authToken, ct0 };
  } finally {
    // The whole point of harvesting: the browser does not stay open. `finally`
    // rather than a happy-path call, so a throw above cannot leak a chrome.exe.
    await browser.close();
    await cleanupBrowserCaches(browser.userDataDir);
  }
}
