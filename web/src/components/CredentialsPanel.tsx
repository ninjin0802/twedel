import { useState } from 'react';
import type { SessionInfo, TransportMode } from '@shared/types';
import * as api from '../api';

interface Props {
  session: SessionInfo | null;
  onSession: (session: SessionInfo | null) => void;
}

export type Status =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'ok'; text: string }
  | { kind: 'error'; text: string };

/**
 * Repeated next to the output every time, not just in the docs. The user is
 * being asked to paste a blob they did not write into a chat window; "it is
 * safe" has to be on screen at the moment they do it.
 */
export const DIAGNOSTICS_SAFE_NOTE =
  'この内容に認証情報は含まれません (Cookie・ct0・bearer・レスポンス本文はすべて出ません)。' +
  'そのまま貼り付けて共有できます。';

const PLAYWRIGHT_COOKIE_NOTE =
  'playwright モードでは auth_token / ct0 は使いません。専用 Chrome プロファイル ' +
  '(data/pw-profile) のログイン済みセッションがそのまま認証情報になります。';

/**
 * Whether the pasted cookies are required at all.
 *
 * Only cookie mode needs them. In playwright mode the browser profile carries
 * the session and the server ignores whatever is sent (see `x/session.ts`), so
 * blocking the button here just forced the user to type dummy values to reach
 * the fallback mode.
 */
export function credentialsError(mode: TransportMode, authToken: string, ct0: string): string | null {
  if (mode === 'playwright') return null;
  if (!authToken || !ct0) return 'auth_token と ct0 の両方を入力してください。';
  return null;
}

/* -------------------------------------------------------------------------- */
/* Chrome から取得 (harvest)                                                    */
/* -------------------------------------------------------------------------- */

/** One line, next to the button, about what pressing it actually does. */
export const HARVEST_HINT =
  'twedel 専用の Chrome ウィンドウが開きます。そこで X にログインすると auth_token と ct0 を ' +
  'twedel が読み取り、ウィンドウは自動で閉じます (以後は高速な cookie モードで動作)。' +
  'ログイン状態は専用プロファイル (data/pw-profile) に残るので、次回からは押すだけで取得できます。';

/**
 * Shown for as long as the request is in flight - which can be minutes, because
 * the server is waiting for the user to finish logging in. Saying "処理中…" here
 * would be a lie by omission: the thing that has to happen next is theirs.
 */
export const HARVEST_WAITING =
  'Chrome ウィンドウで X にログインしてください… ' +
  '(ログイン済みならそのままお待ちください。最大 3 分で打ち切ります)';

interface HarvestBoxProps {
  status: Status;
  onHarvest: () => void;
}

/**
 * The primary way in: no DevTools, no copy-paste.
 *
 * Rendered only in cookie mode - playwright mode keeps the browser itself as
 * the transport and has nothing to harvest into.
 */
export function HarvestBox({ status, onHarvest }: HarvestBoxProps) {
  return (
    <div className="harvest">
      <div className="field field--actions">
        <button
          type="button"
          className="btn btn--primary"
          onClick={onHarvest}
          disabled={status.kind === 'busy'}
        >
          {status.kind === 'busy' ? 'Chrome を待機中…' : 'Chromeから取得'}
        </button>
      </div>
      <p className="hint">{HARVEST_HINT}</p>
      {status.kind === 'busy' && (
        <p className="inline-msg inline-msg--waiting">{HARVEST_WAITING}</p>
      )}
      {status.kind === 'ok' && <p className="inline-msg inline-msg--ok">{status.text}</p>}
      {status.kind === 'error' && <p className="inline-msg inline-msg--error">{status.text}</p>}
    </div>
  );
}

interface CookieFieldsProps {
  mode: TransportMode;
  authToken: string;
  ct0: string;
  onAuthToken: (value: string) => void;
  onCt0: (value: string) => void;
}

/** The two cookie inputs - replaced by one line of explanation in playwright mode. */
export function CookieFields({ mode, authToken, ct0, onAuthToken, onCt0 }: CookieFieldsProps) {
  if (mode === 'playwright') {
    return <p className="hint hint--span2">{PLAYWRIGHT_COOKIE_NOTE}</p>;
  }
  return (
    <>
      <label className="field">
        <span className="field__label">auth_token</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={authToken}
          onChange={(e) => onAuthToken(e.target.value)}
          placeholder="40 文字前後の 16 進文字列"
        />
      </label>
      <label className="field">
        <span className="field__label">ct0</span>
        <input
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={ct0}
          onChange={(e) => onCt0(e.target.value)}
          placeholder="CSRF トークン"
        />
      </label>
    </>
  );
}

export function CredentialsPanel({ session, onSession }: Props) {
  // Write-only: these live here and are never re-populated from a server response.
  const [authToken, setAuthToken] = useState('');
  const [ct0, setCt0] = useState('');
  const [mode, setMode] = useState<TransportMode>('cookie');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });
  const [harvest, setHarvest] = useState<Status>({ kind: 'idle' });

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [txId, setTxId] = useState('');
  const [txStatus, setTxStatus] = useState<Status>({ kind: 'idle' });
  const [queryOp, setQueryOp] = useState('');
  const [queryId, setQueryId] = useState('');
  const [queryStatus, setQueryStatus] = useState<Status>({ kind: 'idle' });
  const [diagText, setDiagText] = useState('');
  const [diagStatus, setDiagStatus] = useState<Status>({ kind: 'idle' });

  async function test() {
    const invalid = credentialsError(mode, authToken, ct0);
    if (invalid) {
      setStatus({ kind: 'error', text: invalid });
      return;
    }
    setStatus({ kind: 'busy' });
    try {
      // Playwright mode sends no cookies at all: the server ignores them and
      // there is no reason to put a credential on the wire that nothing reads.
      const result = await api.postSession(
        mode === 'playwright' ? { mode } : { authToken, ct0, mode },
      );
      onSession(result);
      if (result.connected) {
        setStatus({ kind: 'ok', text: `接続成功: @${result.screenName ?? '(不明)'}` });
      } else {
        setStatus({ kind: 'error', text: result.message ?? '接続できませんでした。' });
      }
    } catch (err) {
      onSession(null);
      setStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * One request that can take minutes: the server holds it open while the user
   * logs in inside the Chrome window it opened. There is nothing to poll - it
   * resolves on login or on the server's own timeout, and either way the answer
   * is a `SessionInfo`, so a failure is `connected: false` + `message` rather
   * than a thrown error.
   */
  async function harvestFromChrome() {
    setHarvest({ kind: 'busy' });
    setStatus({ kind: 'idle' });
    try {
      const result = await api.harvestSession();
      onSession(result);
      if (result.connected) {
        // The manual fields are now both empty and unnecessary; they collapse
        // out of the way rather than sitting there implying work left to do.
        setAuthToken('');
        setCt0('');
        setHarvest({
          kind: 'ok',
          text: `接続成功: @${result.screenName ?? '(不明)'} — Cookie を Chrome から取得しました。`,
        });
      } else {
        setHarvest({
          kind: 'error',
          text: result.message ?? 'Chrome から Cookie を取得できませんでした。',
        });
      }
    } catch (err) {
      onSession(null);
      setHarvest({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function disconnect() {
    try {
      await api.deleteSession();
    } catch {
      /* clearing locally is still the right outcome */
    }
    setAuthToken('');
    setCt0('');
    onSession(null);
    setStatus({ kind: 'idle' });
    // The harvested session is gone with everything else, so the button has to
    // come back - leaving the success line up would be a stale claim.
    setHarvest({ kind: 'idle' });
  }

  async function saveTransactionId(value: string | null) {
    setTxStatus({ kind: 'busy' });
    try {
      const res = await api.setTransactionId(value);
      setTxStatus({ kind: 'ok', text: res.manual ? '手動値を使用します。' : '自動生成に戻しました。' });
    } catch (err) {
      setTxStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function saveQueryId(clear: boolean) {
    if (!queryOp.trim()) {
      setQueryStatus({ kind: 'error', text: '操作名 (op) を入力してください。' });
      return;
    }
    setQueryStatus({ kind: 'busy' });
    try {
      await api.setQueryId(queryOp.trim(), clear ? null : queryId.trim());
      setQueryStatus({ kind: 'ok', text: clear ? '上書きを解除しました。' : '上書きを保存しました。' });
    } catch (err) {
      setQueryStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }

  /**
   * Fetch the probe matrix and show it verbatim.
   *
   * Rendered as raw JSON rather than a prettified table on purpose: the user is
   * meant to select it and paste it somewhere, and every summarising layer is
   * another chance to hide the one field that explains the failure.
   */
  async function loadDiagnostics() {
    setDiagStatus({ kind: 'busy' });
    try {
      const payload = await api.getDiagnostics();
      setDiagText(JSON.stringify(payload, null, 2));
      setDiagStatus({ kind: 'ok', text: DIAGNOSTICS_SAFE_NOTE });
    } catch (err) {
      setDiagText('');
      setDiagStatus({ kind: 'error', text: err instanceof Error ? err.message : String(err) });
    }
  }

  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(diagText);
      setDiagStatus({ kind: 'ok', text: `コピーしました。${DIAGNOSTICS_SAFE_NOTE}` });
    } catch {
      // Clipboard access can be refused; the text is selectable either way.
      setDiagStatus({ kind: 'error', text: '自動コピーできませんでした。下の内容を選択してコピーしてください。' });
    }
  }

  return (
    <section className="panel">
      <header className="panel__head">
        <h2>
          <span className="step-badge">1</span> 認証情報
        </h2>
        {session?.connected ? (
          <span className="pill pill--ok">接続済み @{session.screenName ?? '?'}</span>
        ) : (
          <span className="pill">未接続</span>
        )}
      </header>

      {/* The primary path in cookie mode. Manual entry stays, one click away. */}
      {mode === 'cookie' ? (
        <>
          <HarvestBox status={harvest} onHarvest={harvestFromChrome} />
          {harvest.kind !== 'ok' && (
            <details className="disclosure">
              <summary>手動で入力 (DevTools から貼り付け)</summary>
              <div className="grid grid--2">
                <CookieFields
                  mode="cookie"
                  authToken={authToken}
                  ct0={ct0}
                  onAuthToken={setAuthToken}
                  onCt0={setCt0}
                />
              </div>
              <p className="hint">
                入力した値はこの画面から送信するだけで、サーバーから読み戻すことはありません (書き込み専用)。
                貼り付けたあとは「接続テスト」を押してください。
              </p>
              <ol className="hint hint--list">
                <li>ログイン済みの x.com を開き、DevTools (F12) を表示します。</li>
                <li>Application → Storage → Cookies → https://x.com を選択します。</li>
                <li><code>auth_token</code> と <code>ct0</code> の Value をコピーして上の欄に貼り付けます。</li>
                <li>この 2 つはアカウントそのものです。他人に共有しないでください。</li>
              </ol>
            </details>
          )}
        </>
      ) : (
        <div className="grid grid--2">
          <CookieFields
            mode={mode}
            authToken={authToken}
            ct0={ct0}
            onAuthToken={setAuthToken}
            onCt0={setCt0}
          />
        </div>
      )}

      <div className="grid grid--2">
        <label className="field">
          <span className="field__label">通信モード</span>
          <select value={mode} onChange={(e) => setMode(e.target.value as TransportMode)}>
            <option value="cookie">cookie (直接 HTTP・高速)</option>
            <option value="playwright">playwright (実ブラウザ・確実)</option>
          </select>
        </label>
        <div className="field field--actions">
          <button
            type="button"
            className={mode === 'playwright' ? 'btn btn--primary' : 'btn'}
            onClick={test}
            disabled={status.kind === 'busy'}
          >
            {status.kind === 'busy' ? '接続テスト中…' : '接続テスト'}
          </button>
          <button type="button" className="btn" onClick={disconnect}>
            切断・消去
          </button>
        </div>
      </div>

      {status.kind === 'ok' && <p className="inline-msg inline-msg--ok">{status.text}</p>}
      {status.kind === 'error' && <p className="inline-msg inline-msg--error">{status.text}</p>}

      <details
        className="disclosure"
        open={advancedOpen}
        onToggle={(e) => setAdvancedOpen((e.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>上級者向け</summary>
        <p className="hint">
          X は GraphQL の queryId を不定期に差し替え、さらに自動化対策のヘッダー
          <code> x-client-transaction-id </code>
          を要求します。自動取得が失敗したときに手動で上書きするための逃げ道です。
        </p>

        <div className="grid grid--2">
          <label className="field">
            <span className="field__label">x-client-transaction-id (手動)</span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={txId}
              onChange={(e) => setTxId(e.target.value)}
              placeholder="ブラウザの実リクエストからコピー"
            />
          </label>
          <div className="field field--actions">
            <button type="button" className="btn" onClick={() => saveTransactionId(txId.trim() || null)}>
              保存
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setTxId('');
                void saveTransactionId(null);
              }}
            >
              自動に戻す
            </button>
          </div>
        </div>
        {txStatus.kind === 'ok' && <p className="inline-msg inline-msg--ok">{txStatus.text}</p>}
        {txStatus.kind === 'error' && <p className="inline-msg inline-msg--error">{txStatus.text}</p>}

        <div className="grid grid--3">
          <label className="field">
            <span className="field__label">操作名 (op)</span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={queryOp}
              onChange={(e) => setQueryOp(e.target.value)}
              placeholder="DeleteTweet / UserTweets など"
            />
          </label>
          <label className="field">
            <span className="field__label">queryId</span>
            <input
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={queryId}
              onChange={(e) => setQueryId(e.target.value)}
              placeholder="VaenaVgh5q5ih7kvyVjgtg"
            />
          </label>
          <div className="field field--actions">
            <button type="button" className="btn" onClick={() => saveQueryId(false)}>
              上書き
            </button>
            <button type="button" className="btn" onClick={() => saveQueryId(true)}>
              解除
            </button>
          </div>
        </div>
        {queryStatus.kind === 'ok' && <p className="inline-msg inline-msg--ok">{queryStatus.text}</p>}
        {queryStatus.kind === 'error' && <p className="inline-msg inline-msg--error">{queryStatus.text}</p>}

        <hr className="rule" />

        <p className="hint">
          接続がうまくいかないときは <strong>診断情報</strong> を押してください。今の設定のまま
          x.com へ同じ内容のリクエストをヘッダーを変えて何通りか投げ、返ってきた HTTP
          ステータスだけを並べます。
          <strong> X の 404 は「もう無い」という意味ではありません</strong>
          — ヘッダーが 1 つ違うだけで同じ URL が 404 と 401 の間で入れ替わります。どの形なら
          通るのかが、この一覧で分かります。
        </p>
        <div className="field field--actions">
          <button
            type="button"
            className="btn"
            onClick={loadDiagnostics}
            disabled={diagStatus.kind === 'busy'}
          >
            {diagStatus.kind === 'busy' ? '診断中…' : '診断情報'}
          </button>
          {diagText !== '' && (
            <button type="button" className="btn" onClick={copyDiagnostics}>
              コピー
            </button>
          )}
        </div>
        {diagStatus.kind === 'ok' && <p className="inline-msg inline-msg--ok">{diagStatus.text}</p>}
        {diagStatus.kind === 'error' && (
          <p className="inline-msg inline-msg--error">{diagStatus.text}</p>
        )}
        {diagText !== '' && (
          <pre className="diagnostics" aria-label="診断情報">
            {diagText}
          </pre>
        )}
      </details>
    </section>
  );
}
