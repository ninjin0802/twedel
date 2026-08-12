import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  CookieFields,
  CredentialsPanel,
  DIAGNOSTICS_SAFE_NOTE,
  HARVEST_HINT,
  HARVEST_WAITING,
  HarvestBox,
  credentialsError,
  shouldAutoHarvest,
} from './CredentialsPanel';

/**
 * Rendered with `react-dom/server` rather than a DOM testing library: this repo
 * has no jsdom and no @testing-library, and adding a dependency is out of scope.
 * Static markup is enough for the question these tests ask - "is the user still
 * being asked for cookies in a mode that ignores them?".
 */
const noop = () => {};

function cookieFields(mode: 'cookie' | 'playwright'): string {
  return renderToStaticMarkup(
    <CookieFields mode={mode} authToken="" ct0="" onAuthToken={noop} onCt0={noop} />,
  );
}

describe('credentialsError', () => {
  it('requires both cookies in cookie mode', () => {
    expect(credentialsError('cookie', '', '')).toMatch(/auth_token/);
    expect(credentialsError('cookie', 'a', '')).toMatch(/ct0/);
    expect(credentialsError('cookie', '', 'b')).toMatch(/auth_token/);
    expect(credentialsError('cookie', 'a', 'b')).toBeNull();
  });

  it('never blocks playwright mode on the cookies, however empty they are', () => {
    expect(credentialsError('playwright', '', '')).toBeNull();
    expect(credentialsError('playwright', 'a', '')).toBeNull();
  });
});

describe('startup Chrome harvest', () => {
  it('runs once only when startup checking found no connected session', () => {
    expect(shouldAutoHarvest(true, false, false)).toBe(true);
    expect(shouldAutoHarvest(true, true, false)).toBe(false);
    expect(shouldAutoHarvest(true, false, true)).toBe(false);
    expect(shouldAutoHarvest(false, false, false)).toBe(false);
  });
});

describe('CookieFields', () => {
  it('renders the two password inputs in cookie mode', () => {
    const html = cookieFields('cookie');
    expect(html).toContain('auth_token');
    expect(html).toContain('ct0');
    expect(html.match(/<input/g)).toHaveLength(2);
  });

  it('renders no inputs in playwright mode, only the reason why', () => {
    const html = cookieFields('playwright');
    expect(html).not.toContain('<input');
    expect(html).toMatch(/playwright/);
    expect(html).toMatch(/pw-profile/);
  });
});

describe('CredentialsPanel', () => {
  it('still shows the cookie inputs in its default (cookie) mode', () => {
    const html = renderToStaticMarkup(<CredentialsPanel session={null} onSession={noop} showDetails />);
    expect(html).toContain('auth_token');
    expect(html).toContain('CSRF');
    // The mode picker offers both transports.
    expect(html).toContain('value="playwright"');
  });

  it('offers 診断情報 in the 上級者向け section', () => {
    const html = renderToStaticMarkup(<CredentialsPanel session={null} onSession={noop} showDetails />);

    expect(html).toContain('上級者向け');
    expect(html).toContain('診断情報');
    // The output area only appears once there is something to show.
    expect(html).not.toContain('class="diagnostics"');
    expect(html).not.toContain('コピー<');
  });

  /**
   * The user is being asked to paste a blob they did not write into a chat
   * window. Explaining that 404 is not "gone", and that the output is safe to
   * share, has to be on screen - not only in the README.
   */
  it('explains next to the button that a 404 from X does not mean "gone"', () => {
    const html = renderToStaticMarkup(<CredentialsPanel session={null} onSession={noop} showDetails />);
    expect(html).toMatch(/404/);
    expect(html).toMatch(/401/);
  });
});

/**
 * 「Chromeから取得」 is now the PRIMARY way credentials get in. What these
 * assert is the transition between its four states - because the waiting state
 * is the one that lasts minutes, and a user who is not told "log in in the
 * window that just opened" will conclude twedel has hung.
 */
describe('HarvestBox', () => {
  const box = (status: Parameters<typeof HarvestBox>[0]['status']): string =>
    renderToStaticMarkup(<HarvestBox status={status} onHarvest={noop} />);

  it('offers the button, and explains what it opens, when idle', () => {
    const html = box({ kind: 'idle' });
    expect(html).toContain('Chromeから取得');
    expect(html).toContain('専用の Chrome');
    // The reason it is worth pressing twice: the login is remembered.
    expect(HARVEST_HINT).toMatch(/次回からは/);
    expect(HARVEST_HINT).toMatch(/pw-profile/);
    // Nothing has happened yet, so nothing claims it has.
    expect(html).not.toContain('inline-msg');
  });

  it('tells the user to log in - and disables the button - while waiting', () => {
    const html = box({ kind: 'busy' });
    expect(html).toContain('ログインしてください');
    expect(html).toContain('disabled');
    expect(html).not.toContain('Chromeから取得');
    expect(HARVEST_WAITING).toMatch(/Chrome ウィンドウ/);
  });

  it('shows the connected account on success and the server message on failure', () => {
    expect(box({ kind: 'ok', text: '接続成功: @someone' })).toContain('接続成功: @someone');

    const failed = box({ kind: 'error', text: 'Timed out after 180s' });
    expect(failed).toContain('Timed out after 180s');
    expect(failed).toContain('inline-msg--error');
    // The button comes back, so a timeout is one click from a retry.
    expect(failed).toContain('Chromeから取得');
  });
});

describe('CredentialsPanel - harvest and the manual fallback', () => {
  it('leads with the Chrome button and keeps manual entry as a collapsed fallback', () => {
    const html = renderToStaticMarkup(<CredentialsPanel session={null} onSession={noop} showDetails />);

    expect(html).toContain('Chromeから取得');
    expect(html).toContain('手動で入力');
    // The fallback is a <details>, so the fields are present but out of the way.
    expect(html).toContain('<details');
    expect(html.indexOf('Chromeから取得')).toBeLessThan(html.indexOf('手動で入力'));
    expect(html).toContain('auth_token');
  });

  it('still keeps the DevTools steps, next to the fields they describe', () => {
    const html = renderToStaticMarkup(<CredentialsPanel session={null} onSession={noop} showDetails />);
    expect(html).toContain('DevTools');
    expect(html).toContain('Cookies');
  });
});

describe('DIAGNOSTICS_SAFE_NOTE', () => {
  it('names every credential class the report does not contain', () => {
    expect(DIAGNOSTICS_SAFE_NOTE).toContain('Cookie');
    expect(DIAGNOSTICS_SAFE_NOTE).toContain('ct0');
    expect(DIAGNOSTICS_SAFE_NOTE).toContain('bearer');
    expect(DIAGNOSTICS_SAFE_NOTE).toMatch(/共有/);
  });
});
