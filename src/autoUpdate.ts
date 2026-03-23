import { app, dialog, Notification, Tray } from 'electron';
import log from 'electron-log/main';
import { getAutoUpdateEnabled, getNotificationsEnabled } from './config';
import { getAutoUpdateStrings, getUpdateStrings } from './i18n';
import { setUpdateReady } from './update';

const autoUpdateLog = log.scope('autoUpdate');

export function isAutoUpdateSupported(): boolean {
  if (process.env.SIDRA_DISABLE_AUTO_UPDATE === '1') {
    autoUpdateLog.info('auto-update disabled via SIDRA_DISABLE_AUTO_UPDATE');
    return false;
  }

  if (!getAutoUpdateEnabled()) {
    autoUpdateLog.info('auto-update disabled via config');
    return false;
  }

  // Linux AppImage: process.env.APPIMAGE is set only when running as an AppImage
  if (process.env.APPIMAGE) {
    autoUpdateLog.info('auto-update supported: AppImage detected');
    return true;
  }

  // Windows NSIS: packaged win32 app
  if (process.platform === 'win32' && app.isPackaged) {
    autoUpdateLog.info('auto-update supported: Windows NSIS detected');
    return true;
  }

  autoUpdateLog.info('auto-update not supported on this platform');
  return false;
}

export function quitAndInstall(): void {
  const { autoUpdater } = require('electron-updater');
  autoUpdater.quitAndInstall();
}

export async function initAutoUpdate(tray: Tray, rebuildMenu: (tray: Tray) => void): Promise<void> {
  const { autoUpdater } = require('electron-updater');

  autoUpdater.logger = autoUpdateLog;
  autoUpdater.autoDownload = true;

  if (process.platform === 'win32') {
    autoUpdater.autoDownload = true;
    autoUpdater.verifyUpdateCodeSignature = false;
  }

  autoUpdater.on('update-available', (info: { version: string }) => {
    autoUpdateLog.info('update available:', info.version);
  });

  autoUpdater.on('update-downloaded', async (info: { version: string }) => {
    autoUpdateLog.info('update downloaded:', info.version);
    setUpdateReady(info.version);
    rebuildMenu(tray);

    if (getNotificationsEnabled()) {
      const strings = getUpdateStrings();
      const notification = new Notification({
        title: strings.updateAvailable,
        body: `Sidra ${info.version}`,
        silent: true,
      });
      notification.on('click', () => {
        autoUpdater.quitAndInstall();
      });
      notification.show();
      autoUpdateLog.debug('update-downloaded notification shown');
    }

    const autoUpdateStrings = getAutoUpdateStrings();
    const result = await dialog.showMessageBox({
      type: 'info',
      title: autoUpdateStrings.ready,
      message: `Sidra ${info.version}`,
      detail: autoUpdateStrings.ready,
      buttons: ['Restart Now', 'Later'],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (error: Error) => {
    autoUpdateLog.error('update error:', error.message);
  });

  try {
    await autoUpdater.checkForUpdates();
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    autoUpdateLog.error('checkForUpdates failed:', message);
  }
}
