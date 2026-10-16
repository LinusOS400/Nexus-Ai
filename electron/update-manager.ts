import { app, ipcMain, type BrowserWindow } from 'electron';
import { autoUpdater } from 'electron-updater';
import type { UpdateInfo } from 'electron-updater';
import type { UpdateStatus } from '../shared/types';

let currentStatus: UpdateStatus = { state: 'idle', currentVersion: '0.0.0' };
let getWindow: () => BrowserWindow | null = () => null;

function snapshot() {
  return { ...currentStatus, currentVersion: app.getVersion() };
}

function publish(next: Omit<UpdateStatus, 'currentVersion'>) {
  currentStatus = { ...next, currentVersion: app.getVersion() };
  const window = getWindow();
  if (window && !window.isDestroyed()) window.webContents.send('updates:status', snapshot());
  return snapshot();
}

function notesFrom(info: UpdateInfo) {
  const notes = info.releaseNotes;
  if (typeof notes === 'string') return notes.slice(0, 12_000);
  if (Array.isArray(notes)) return notes.map((entry) => typeof entry === 'string' ? entry : entry.note || '').filter(Boolean).join('\n\n').slice(0, 12_000);
  return '';
}

function supportMessage() {
  if (!app.isPackaged) return 'Update checks are available in the installed desktop build.';
  if (process.env.PORTABLE_EXECUTABLE_FILE) return 'Portable builds cannot install updates in place. Install the NSIS Setup version to enable one-click updates.';
  if (process.platform !== 'win32') return 'In-app updates are currently enabled for the Windows installer.';
  return '';
}

function asErrorMessage(error: unknown) {
  const message = error instanceof Error ? error.message : String(error || 'Unknown update error.');
  return message.replace(/[\r\n\t]+/g, ' ').slice(0, 600);
}

export function initializeUpdateManager(getMainWindow: () => BrowserWindow | null) {
  getWindow = getMainWindow;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;

  autoUpdater.on('checking-for-update', () => publish({ state: 'checking', message: 'Checking GitHub Releases…' }));
  autoUpdater.on('update-available', (info) => publish({ state: 'available', version: info.version, releaseNotes: notesFrom(info), message: 'A new version is ready to download.' }));
  autoUpdater.on('update-not-available', (info) => publish({ state: 'not-available', version: info.version, message: 'You are up to date.' }));
  autoUpdater.on('download-progress', (progress) => publish({
    state: 'downloading',
    version: currentStatus.version,
    releaseNotes: currentStatus.releaseNotes,
    percent: Math.max(0, Math.min(100, Math.round(progress.percent))),
    transferred: progress.transferred,
    total: progress.total,
    bytesPerSecond: progress.bytesPerSecond,
    message: 'Downloading update…',
  }));
  autoUpdater.on('update-downloaded', (info) => publish({ state: 'downloaded', version: info.version, releaseNotes: notesFrom(info), percent: 100, message: 'Update downloaded. Restart Nexus to install it.' }));
  autoUpdater.on('update-cancelled', (info) => publish({ state: 'available', version: info.version, releaseNotes: notesFrom(info), message: 'Download cancelled. You can try again.' }));
  autoUpdater.on('error', (error) => publish({ state: 'error', message: asErrorMessage(error) }));

  ipcMain.handle('updates:get-status', () => snapshot());
  ipcMain.handle('updates:check', async () => {
    const unsupported = supportMessage();
    if (unsupported) return publish({ state: 'unavailable', message: unsupported });
    publish({ state: 'checking', message: 'Checking GitHub Releases…' });
    try {
      const result = await autoUpdater.checkForUpdates();
      if (result && currentStatus.state === 'checking') {
        const info = result.updateInfo;
        if (result.isUpdateAvailable) publish({ state: 'available', version: info.version, releaseNotes: notesFrom(info), message: 'A new version is ready to download.' });
        else publish({ state: 'not-available', version: info.version, message: 'You are up to date.' });
      }
    } catch (error) {
      publish({ state: 'error', message: asErrorMessage(error) });
    }
    return snapshot();
  });

  ipcMain.handle('updates:download', async () => {
    const unsupported = supportMessage();
    if (unsupported) return publish({ state: 'unavailable', message: unsupported });
    if (currentStatus.state !== 'available') return publish({ state: 'error', message: 'Check for an update before downloading.' });
    publish({ state: 'downloading', version: currentStatus.version, releaseNotes: currentStatus.releaseNotes, percent: 0, message: 'Starting download…' });
    try {
      await autoUpdater.downloadUpdate();
      const finalStatus = snapshot();
      if (finalStatus.state !== 'downloaded') publish({ state: 'downloaded', version: currentStatus.version, releaseNotes: currentStatus.releaseNotes, percent: 100, message: 'Update downloaded. Restart Nexus to install it.' });
    } catch (error) {
      publish({ state: 'error', message: asErrorMessage(error) });
    }
    return snapshot();
  });

  ipcMain.handle('updates:install', () => {
    const unsupported = supportMessage();
    if (unsupported) return publish({ state: 'unavailable', message: unsupported });
    if (currentStatus.state !== 'downloaded') throw new Error('Download the update before installing it.');
    autoUpdater.quitAndInstall(false, true);
  });
}
