const { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } = require('electron');
const { autoUpdater } = require('electron-updater');
const { readFile, rm, writeFile } = require('node:fs/promises');
const { randomBytes } = require('node:crypto');
const { basename, dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

let mainWindow;
let backendModule;
let updateState = { status: 'idle' };
let localApiToken = '';
const apiStreams = new Map();
const SUPPORT_URL = 'https://ofuse.me/ninjin';
const DEVELOPER_PROFILE_URL = 'https://x.com/_nin82';

function cleanupMarkerFile() {
  return join(app.getPath('userData'), 'update-cleanup.json');
}

async function rememberDownloadedUpdate(info) {
  if (!info.downloadedFile) return;
  await writeFile(cleanupMarkerFile(), JSON.stringify({
    targetVersion: info.version,
    downloadedFile: resolve(info.downloadedFile),
  }), 'utf8');
}

async function cleanupInstalledUpdate() {
  let marker;
  try {
    marker = JSON.parse(await readFile(cleanupMarkerFile(), 'utf8'));
  } catch {
    return;
  }
  if (marker?.targetVersion !== app.getVersion() || typeof marker.downloadedFile !== 'string') return;

  // The marker is local state, but still constrain deletion to electron-updater's
  // own `<app>-updater/pending` directory before removing anything recursively.
  const pendingDir = dirname(resolve(marker.downloadedFile));
  const updaterDir = dirname(pendingDir);
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) return;
  const expectedUpdaterDir = resolve(localAppData, 'twedel-updater');
  if (basename(pendingDir).toLowerCase() !== 'pending' || updaterDir.toLowerCase() !== expectedUpdaterDir.toLowerCase()) return;

  await rm(pendingDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 1000 });
  await rm(cleanupMarkerFile(), { force: true });
}

function publishUpdateState(next) {
  updateState = next;
  mainWindow?.webContents.send('update:state', next);
}

function releaseNotesText(releaseNotes) {
  if (typeof releaseNotes === 'string') return releaseNotes.trim();
  if (Array.isArray(releaseNotes)) {
    return releaseNotes
      .map((entry) => typeof entry?.note === 'string' ? entry.note.trim() : '')
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

function configureUpdater() {
  autoUpdater.autoDownload = false;
  // Installation is started explicitly with silent=true after download.
  // Disable the generic app-quit path so it cannot open the interactive NSIS UI.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.on('checking-for-update', () => publishUpdateState({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => publishUpdateState({
    status: 'available',
    version: info.version,
    releaseNotes: releaseNotesText(info.releaseNotes),
  }));
  autoUpdater.on('update-not-available', () => publishUpdateState({ status: 'latest' }));
  autoUpdater.on('download-progress', (p) => publishUpdateState({ status: 'downloading', percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', async (info) => {
    try {
      await rememberDownloadedUpdate(info);
      publishUpdateState({ status: 'installing', version: info.version });
      // Run NSIS silently in the background, then relaunch the updated app.
      setImmediate(() => autoUpdater.quitAndInstall(true, true));
    } catch (error) {
      publishUpdateState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  });
  autoUpdater.on('error', (error) => publishUpdateState({ status: 'error', message: error.message }));
  ipcMain.handle('update:get-state', () => updateState);
  ipcMain.handle('update:check', async () => {
    if (!app.isPackaged) return publishUpdateState({ status: 'error', message: '開発版では更新を確認できません。' });
    await autoUpdater.checkForUpdates();
    return updateState;
  });
  ipcMain.handle('update:download', async () => { await autoUpdater.downloadUpdate(); return updateState; });
  ipcMain.handle('update:install', () => autoUpdater.quitAndInstall(true, true));
}

function configureExternalLinks() {
  // The renderer cannot provide an arbitrary URL. Keeping the destination in
  // the main process prevents a compromised page from opening phishing links.
  ipcMain.handle('external:open-support', () => shell.openExternal(SUPPORT_URL));
  ipcMain.handle('external:open-developer-profile', () => shell.openExternal(DEVELOPER_PROFILE_URL));
}

function configureCredentialBridge() {
  ipcMain.handle('credentials:set', async (_event, input) => {
    if (!backendModule) throw new Error('バックエンドの準備が完了していません。');
    if (!input || (input.mode !== 'cookie' && input.mode !== 'playwright')) {
      throw new Error('認証方式が正しくありません。');
    }
    const authToken = typeof input.authToken === 'string' ? input.authToken : '';
    const ct0 = typeof input.ct0 === 'string' ? input.ct0 : '';
    if (authToken.length > 4096 || ct0.length > 4096) throw new Error('認証情報が長すぎます。');
    if (input.mode === 'cookie' && (!authToken || !ct0)) {
      throw new Error('auth_token と ct0 の両方が必要です。');
    }
    return backendModule.setCredentials(authToken, ct0, input.mode);
  });
}

function safeApiPath(value) {
  if (typeof value !== 'string' || !value.startsWith('/api/')) throw new Error('APIパスが正しくありません。');
  const url = new URL(value, 'http://127.0.0.1:5174');
  if (url.origin !== 'http://127.0.0.1:5174') throw new Error('外部APIには接続できません。');
  return url;
}

function configureApiBridge() {
  ipcMain.handle('api:request', async (_event, payload) => {
    const url = safeApiPath(payload?.path);
    const init = payload?.init && typeof payload.init === 'object' ? payload.init : {};
    const response = await fetch(url, {
      method: typeof init.method === 'string' ? init.method : 'GET',
      headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), 'x-twedel-token': localApiToken },
      ...(typeof init.body === 'string' ? { body: init.body } : {}),
    });
    return { status: response.status, ok: response.ok, body: await response.text() };
  });
  ipcMain.handle('api:subscribe', async (event, payload) => {
    const url = safeApiPath(payload?.path);
    const id = String(payload?.id ?? '');
    if (!id) throw new Error('購読IDが正しくありません。');
    const controller = new AbortController();
    apiStreams.set(id, controller);
    const sender = event.sender;
    void (async () => {
      try {
        const response = await fetch(url, { headers: { 'x-twedel-token': localApiToken }, signal: controller.signal });
        if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
        const decoder = new TextDecoder();
        let buffer = '';
        for await (const chunk of response.body) {
          buffer += decoder.decode(chunk, { stream: true }).replace(/\r/g, '');
          let split;
          while ((split = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, split); buffer = buffer.slice(split + 2);
            const data = frame.split('\n').filter((line) => line.startsWith('data:')).map((line) => line.slice(5).trim()).join('\n');
            if (data && !sender.isDestroyed()) sender.send(`api:event:${id}`, { type: 'data', data });
          }
        }
      } catch (error) {
        if (!controller.signal.aborted && !sender.isDestroyed()) sender.send(`api:event:${id}`, { type: 'error', message: error instanceof Error ? error.message : String(error) });
      } finally { apiStreams.delete(id); }
    })();
    return { ok: true };
  });
  ipcMain.handle('api:unsubscribe', (_event, id) => {
    apiStreams.get(String(id))?.abort(); apiStreams.delete(String(id)); return { ok: true };
  });
}

async function startBackend() {
  const root = app.getAppPath();
  process.env.TWEDEL_DATA_DIR = join(app.getPath('userData'), 'data');
  process.env.TWEDEL_WEB_DIR = join(root, 'dist');
  localApiToken = randomBytes(32).toString('base64url');
  process.env.TWEDEL_API_TOKEN = localApiToken;
  const serverModule = await import(pathToFileURL(join(root, 'dist-server', 'index.js')).href);
  backendModule = serverModule;
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Windowsの認証情報暗号化（DPAPI）を利用できないため、安全のため起動を中止しました。');
  }
  serverModule.configureCredentialProtection({
    encrypt: (value) => safeStorage.encryptString(value).toString('base64'),
    decrypt: (value) => safeStorage.decryptString(Buffer.from(value, 'base64')),
  });
  await serverModule.startServer();
}

async function createWindow() {
  const win = new BrowserWindow({
    width: 1240,
    height: 820,
    minWidth: 900,
    minHeight: 650,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: join(__dirname, 'preload.cjs'),
    },
  });
  mainWindow = win;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('http://127.0.0.1:5174/')) event.preventDefault();
  });

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:5174/api/health', {
        headers: { 'x-twedel-token': localApiToken },
      });
      if (response.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await win.loadURL('http://127.0.0.1:5174');
}

app.whenReady().then(async () => {
  try {
    session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
    session.defaultSession.webRequest.onBeforeSendHeaders(
      { urls: ['http://127.0.0.1:5174/api/*'] },
      (details, callback) => callback({
        requestHeaders: { ...details.requestHeaders, 'x-twedel-token': localApiToken },
      }),
    );
    configureUpdater();
    configureExternalLinks();
    configureCredentialBridge();
    configureApiBridge();
    await startBackend();
    await createWindow();
    // The NSIS process can still hold the downloaded installer immediately
    // after relaunch. Clean it later and never let a locked cache block startup.
    setTimeout(() => void cleanupInstalledUpdate().catch(() => undefined), 15000);
    if (app.isPackaged) setTimeout(() => void autoUpdater.checkForUpdates(), 3000);
  } catch (error) {
    dialog.showErrorBox('twedel', error instanceof Error ? error.message : String(error));
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
