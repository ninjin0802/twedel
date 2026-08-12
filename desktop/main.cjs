const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const { readFile, rm, writeFile } = require('node:fs/promises');
const { basename, dirname, join, resolve } = require('node:path');
const { pathToFileURL } = require('node:url');

let mainWindow;
let updateState = { status: 'idle' };

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

  await rm(pendingDir, { recursive: true, force: true });
  await rm(cleanupMarkerFile(), { force: true });
}

function publishUpdateState(next) {
  updateState = next;
  mainWindow?.webContents.send('update:state', next);
}

function configureUpdater() {
  autoUpdater.autoDownload = false;
  // Installation is started explicitly with silent=true after download.
  // Disable the generic app-quit path so it cannot open the interactive NSIS UI.
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.on('checking-for-update', () => publishUpdateState({ status: 'checking' }));
  autoUpdater.on('update-available', (info) => publishUpdateState({ status: 'available', version: info.version }));
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

async function startBackend() {
  const root = app.getAppPath();
  process.env.TWEDEL_DATA_DIR = join(app.getPath('userData'), 'data');
  process.env.TWEDEL_WEB_DIR = join(root, 'dist');
  const serverModule = await import(pathToFileURL(join(root, 'dist-server', 'index.js')).href);
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

  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch('http://127.0.0.1:5174/api/health');
      if (response.ok) break;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await win.loadURL('http://127.0.0.1:5174');
}

app.whenReady().then(async () => {
  try {
    await cleanupInstalledUpdate();
    configureUpdater();
    await startBackend();
    await createWindow();
    if (app.isPackaged) setTimeout(() => void autoUpdater.checkForUpdates(), 3000);
  } catch (error) {
    dialog.showErrorBox('twedel', error instanceof Error ? error.message : String(error));
    app.quit();
  }
});

app.on('window-all-closed', () => app.quit());
