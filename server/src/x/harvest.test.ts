import { describe, expect, it, vi } from 'vitest';
import type { HarvestOptions } from './harvest.js';
import { browserCachePaths, harvestCookies } from './harvest.js';
import type { PlaywrightDeps, PwContext, PwCookie, PwPage } from './playwright.js';

/**
 * Everything here runs against a FAKE Playwright context.
 *
 * No chrome.exe is ever started and nothing touches the network: `deps` is
 * injected on every call, so `realLauncher` (the only code that imports
 * `playwright`) is unreachable from this file. If a test in here ever spawns a
 * browser, it is because someone dropped the `deps` argument.
 *
 * The two properties worth more than all the others: the browser is CLOSED on
 * every path (a leaked chrome.exe is invisible in the app and holds the profile
 * lock against the next harvest), and no cookie VALUE ever reaches a message.
 */

/** Values that must never appear in a message, an error, or a status line. */
const AUTH = 'HARVEST-SECRET-AUTH-TOKEN';
const CT0 = 'HARVEST-SECRET-CT0-VALUE';

describe('browser cache cleanup targets', () => {
  it('includes caches but never login-bearing cookie or Network paths', () => {
    const paths = browserCachePaths('C:/profile').join('|');
    expect(paths).toMatch(/CacheStorage/);
    expect(paths).toMatch(/Code Cache/);
    expect(paths).not.toMatch(/Cookies|Network|Login Data/);
  });
});

class FakePage implements PwPage {
  gotoCalls: string[] = [];
  async goto(url: string): Promise<void> {
    this.gotoCalls.push(url);
  }
  async evaluate(): Promise<never> {
    throw new Error('the harvest must never issue an in-page request');
  }
}

class FakeContext implements PwContext {
  page = new FakePage();
  closed = 0;
  browserClosed = 0;
  cookieCalls = 0;
  /** Replaced per test; called for every `context.cookies()`. */
  jar: () => PwCookie[] = () => [
    { name: 'auth_token', value: AUTH },
    { name: 'ct0', value: CT0 },
  ];

  async cookies(): Promise<PwCookie[]> {
    this.cookieCalls += 1;
    return this.jar();
  }
  pages(): PwPage[] {
    return [this.page];
  }
  async newPage(): Promise<PwPage> {
    return this.page;
  }
  on(): void {
    /* the harvest registers no listeners */
  }
  async close(): Promise<void> {
    this.closed += 1;
  }
  browser(): { close(): Promise<void> } | null {
    return {
      close: async () => {
        this.browserClosed += 1;
      },
    };
  }
}

interface Harness {
  ctx: FakeContext;
  deps: PlaywrightDeps;
  launches: number;
  launchDirs: string[];
  /** Virtual clock: advanced only by `sleep`, so a timeout costs no real time. */
  clock: number;
  status: string[];
}

function harness(overrides: Partial<PlaywrightDeps> = {}): Harness {
  const ctx = new FakeContext();
  const h: Harness = {
    ctx,
    launches: 0,
    launchDirs: [],
    clock: 0,
    status: [],
    deps: {} as PlaywrightDeps,
  };
  h.deps = {
    launchPersistentContext: async (dir: string) => {
      h.launches += 1;
      h.launchDirs.push(dir);
      return ctx;
    },
    fetchAsset: () => Promise.reject(new Error('the harvest fetches no assets')),
    sleep: async (ms: number) => {
      h.clock += ms;
    },
    now: () => h.clock,
    ...overrides,
  };
  return h;
}

function harvest(h: Harness, opts: HarvestOptions = {}) {
  return harvestCookies({
    userDataDir: 'C:\\nope\\pw-profile',
    loginTimeoutMs: 10_000,
    pollIntervalMs: 1_000,
    onStatus: (m) => h.status.push(m),
    deps: h.deps,
    ...opts,
  });
}

/* -------------------------------------------------------------------------- */

describe('harvestCookies - happy path', () => {
  it('reads both cookies out of a jar that already has them', async () => {
    const h = harness();
    await expect(harvest(h)).resolves.toEqual({ authToken: AUTH, ct0: CT0 });
  });

  it('returns immediately for a returning user, without polling for a login', async () => {
    // The profile persists, so the second harvest must not make the user wait -
    // the login gate has to see auth_token on its very first look.
    const h = harness();
    await harvest(h);
    expect(h.clock).toBe(0);
    expect(h.status.some((m) => /log in to x/i.test(m))).toBe(false);
  });

  it('launches the same dedicated profile playwright mode uses, headed, real Chrome', async () => {
    const seen: { headless: boolean; channel: string }[] = [];
    const h = harness();
    const base = h.deps.launchPersistentContext;
    h.deps.launchPersistentContext = async (dir, options) => {
      seen.push({ headless: options.headless, channel: options.channel });
      return base(dir, options);
    };

    await harvest(h);

    expect(h.launchDirs).toEqual(['C:\\nope\\pw-profile']);
    expect(seen).toEqual([{ headless: false, channel: 'chrome' }]);
    expect(h.ctx.page.gotoCalls).toEqual(['https://x.com/home']);
  });

  it('closes the browser on the happy path too - harvest is one-shot', async () => {
    // Unlike playwright TRANSPORT mode, nothing is kept open: the harvested
    // cookies drive the fast direct transport from here on.
    const h = harness();
    await harvest(h);
    expect(h.ctx.closed).toBe(1);
    expect(h.ctx.browserClosed).toBe(1);
  });
});

describe('harvestCookies - ct0 lag', () => {
  it('forces a page load when ct0 is missing, then re-reads and succeeds', async () => {
    const h = harness();
    // ct0 appears only after the extra navigation - the real lag this handles.
    h.ctx.jar = () =>
      h.ctx.page.gotoCalls.length > 1
        ? [
            { name: 'auth_token', value: AUTH },
            { name: 'ct0', value: CT0 },
          ]
        : [{ name: 'auth_token', value: AUTH }];

    await expect(harvest(h)).resolves.toEqual({ authToken: AUTH, ct0: CT0 });

    // One navigation for the login gate, a second to make X set ct0.
    expect(h.ctx.page.gotoCalls).toEqual(['https://x.com/home', 'https://x.com/home']);
    expect(h.ctx.closed).toBe(1);
  });

  it('does not navigate a second time when ct0 was already there', async () => {
    const h = harness();
    await harvest(h);
    expect(h.ctx.page.gotoCalls).toHaveLength(1);
  });

  it('gives up with an actionable error when ct0 never turns up', async () => {
    const h = harness();
    h.ctx.jar = () => [{ name: 'auth_token', value: AUTH }];

    await expect(harvest(h)).rejects.toThrow(/ct0: missing/);
    await expect(harvest(h)).rejects.toThrow(/pasting auth_token and ct0 by hand/);
    // Bounded, and the browser is gone regardless.
    expect(h.ctx.closed).toBe(2);
    expect(h.ctx.browserClosed).toBe(2);
  });

  it('still succeeds when the navigation that forces ct0 fails outright', async () => {
    const h = harness();
    let gotos = 0;
    h.ctx.page.goto = async () => {
      gotos += 1;
      if (gotos > 1) throw new Error('net::ERR_TIMED_OUT');
    };
    h.ctx.jar = () =>
      gotos > 1
        ? [
            { name: 'auth_token', value: AUTH },
            { name: 'ct0', value: CT0 },
          ]
        : [{ name: 'auth_token', value: AUTH }];

    await expect(harvest(h)).resolves.toEqual({ authToken: AUTH, ct0: CT0 });
  });
});

describe('harvestCookies - failure paths', () => {
  it('errors, and still closes, when BOTH cookies are gone after the gate', async () => {
    // The gate saw auth_token; the jar was cleared underneath us (a logout in
    // the window, a profile wipe). Half a credential pair is not a session.
    const h = harness();
    let reads = 0;
    h.ctx.jar = () => {
      reads += 1;
      return reads === 1 ? [{ name: 'auth_token', value: AUTH }] : [];
    };

    await expect(harvest(h)).rejects.toThrow(/auth_token: missing.*ct0: missing/s);
    expect(h.ctx.closed).toBe(1);
    expect(h.ctx.browserClosed).toBe(1);
  });

  it('closes the browser when an unexpected error is thrown mid-harvest', async () => {
    const h = harness();
    vi.spyOn(h.ctx, 'cookies').mockRejectedValueOnce(new Error('CDP connection lost'));
    // The gate's own first read is the one that throws.
    await expect(harvest(h)).rejects.toThrow(/CDP connection lost/);
    expect(h.ctx.closed).toBe(1);
    expect(h.ctx.browserClosed).toBe(1);
  });

  it('reports a login that never happens as a timeout, with no browser left running', async () => {
    const h = harness();
    h.ctx.jar = () => [];

    await expect(harvest(h)).rejects.toThrow(/Timed out after 10s/);
    await expect(harvest(h)).rejects.toThrow(/Log in to X in the Chrome window/i);
    expect(h.ctx.closed).toBe(2);
    expect(h.ctx.browserClosed).toBe(2);
    // It polled rather than giving up instantly, and it stopped rather than hanging.
    expect(h.clock).toBeGreaterThanOrEqual(10_000);
  });

  it('turns a missing Chrome into an install instruction, and starts nothing', async () => {
    const h = harness({
      launchPersistentContext: () =>
        Promise.reject(new Error("Executable doesn't exist at C:\\Program Files\\...")),
    });
    await expect(harvest(h)).rejects.toThrow(/Install Chrome/i);
    expect(h.ctx.closed).toBe(0);
  });

  it('explains a profile that is already locked by another twedel window', async () => {
    const h = harness({
      launchPersistentContext: () => Promise.reject(new Error('ProcessSingleton lock held')),
    });
    await expect(harvest(h)).rejects.toThrow(/already in use/i);
  });
});

describe('harvestCookies - secrecy', () => {
  it('never puts a cookie value in an error message', async () => {
    const h = harness();
    h.ctx.jar = () => [{ name: 'auth_token', value: AUTH }];

    let message = '';
    try {
      await harvest(h);
    } catch (err: unknown) {
      message = (err as Error).message;
    }

    expect(message).not.toContain(AUTH);
    expect(message).not.toContain(CT0);
    // ...but it still says which cookie was there, in the repo's masked form.
    expect(message).toMatch(/auth_token: present \(HA…\(len 25\)\)/);
  });

  it('never puts a cookie value in a status line', async () => {
    const h = harness();
    await harvest(h);

    expect(h.status.length).toBeGreaterThan(0);
    for (const line of h.status) {
      expect(line).not.toContain(AUTH);
      expect(line).not.toContain(CT0);
    }
  });

  it('keeps the values out of the timeout message too', async () => {
    const h = harness();
    h.ctx.jar = () => [];
    let message = '';
    try {
      await harvest(h);
    } catch (err: unknown) {
      message = (err as Error).message;
    }
    expect(message).not.toContain(AUTH);
    expect(message).not.toContain(CT0);
  });
});
