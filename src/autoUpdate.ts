import { app, dialog, Tray } from 'electron';
import log from 'electron-log/main';
import { getAutoUpdateEnabled, getNotificationsEnabled } from './config';
import { getAutoUpdateStrings, getUpdateStrings } from './i18n';
import { createNotification } from './notify';
import { setUpdateReady } from './update';

const autoUpdateLog = log.scope('autoUpdate');

/**
 * True only where Sidra owns the install: an AppImage or a packaged Windows
 * NSIS build. Every other target is updated by its package manager, so the
 * updater must stay out of the way there and src/update.ts notifies instead.
 * app-update.yml ships in every packaged build, so this runtime check is what
 * keeps electron-updater from starting on deb, rpm and Nix.
 */
export function isAutoUpdateSupported(): boolean {
  if (process.env.SIDRA_DISABLE_AUTO_UPDATE === '1') {
    autoUpdateLog.info('auto-update disabled via SIDRA_DISABLE_AUTO_UPDATE');
    return false;
  }

  if (!getAutoUpdateEnabled()) {
    autoUpdateLog.info('auto-update disabled via config');
    return false;
  }

  // Linux snap: snapd handles refresh, so electron-updater must stay disabled
  if (process.env.SNAP) {
    autoUpdateLog.info('auto-update not supported: snap detected (snapd handles refresh)');
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

/** Install a downloaded update and restart. Only reachable once one is ready. */
export function quitAndInstall(): void {
  // electron-updater is lazy-required, never imported at module level, so it
  // never loads on a platform that does not support it
  const { autoUpdater } = require('electron-updater');
  autoUpdater.quitAndInstall();
}

/**
 * Check for an update and download it. Call only when isAutoUpdateSupported()
 * is true. A finished download rebuilds the tray menu, raises a notification,
 * and offers a restart.
 */
export async function initAutoUpdate(tray: Tray, rebuildMenu: (tray: Tray) => void): Promise<void> {
  // electron-updater is lazy-required, never imported at module level, so it
  // never loads on a platform that does not support it
  const { autoUpdater } = require('electron-updater');

  // electron-updater's own logger is off; this module logs under its own scope,
  // which is what makes an updater load on deb, rpm or Nix visible in the log
  autoUpdater.logger = null;
  autoUpdater.autoDownload = true;

  // Windows builds are unsigned, so the signature check would reject every
  // update Sidra publishes
  if (process.platform === 'win32') {
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
      const notification = createNotification({
        title: strings.updateAvailable.replace('{version}', info.version),
        body: `Sidra ${info.version}`,
        silent: true,
      });
      if (notification) {
        notification.on('click', () => {
          autoUpdater.quitAndInstall();
        });
        notification.show();
        autoUpdateLog.debug('update-downloaded notification shown');
      }
    }

    const autoUpdateStrings = getAutoUpdateStrings();
    const result = await dialog.showMessageBox({
      type: 'info',
      title: autoUpdateStrings.ready,
      message: `Sidra ${info.version}`,
      buttons: [autoUpdateStrings.restartNow, autoUpdateStrings.later],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (error: Error) => {
    // A repository with no release yet is a normal state, not a fault
    if (error.message.includes('No published versions')) {
      autoUpdateLog.info('no published releases found; skipping update check');
    } else {
      autoUpdateLog.error('update error:', error.message);
    }
  });

  await autoUpdater.checkForUpdates().catch(() => {});
}
