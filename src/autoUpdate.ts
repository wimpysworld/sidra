import { app, dialog, Tray } from 'electron';
import log from 'electron-log/main';
import { getAutoUpdateEnabled } from './config';
import { getAutoUpdateStrings } from './i18n';
import { setUpdateReady, showUpdateNotification } from './update';

const autoUpdateLog = log.scope('autoUpdate');

/**
 * The single load point for electron-updater. It is required here and never
 * imported at module level, so it never loads on a platform that does not
 * support it. The return annotation is a type-only reference that tsc erases,
 * so the emitted JavaScript carries no top-level require of its own and the
 * whole updater surface is still checked against the published types.
 */
function loadAutoUpdater(): typeof import('electron-updater') {
  return require('electron-updater');
}

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
  loadAutoUpdater().autoUpdater.quitAndInstall();
}

type AutoUpdaterModule = Pick<typeof import('electron-updater'), 'autoUpdater' | 'NsisUpdater'>;

/**
 * Check for an update and download it. Call only when isAutoUpdateSupported()
 * is true. A finished download rebuilds the tray menu, raises a notification,
 * and offers a restart.
 */
export async function configureAutoUpdate(
  { autoUpdater, NsisUpdater }: AutoUpdaterModule,
  tray: Tray,
  rebuildMenu: (tray: Tray) => void,
): Promise<void> {

  // electron-updater's own logger is off; this module logs under its own scope,
  // which is what makes an updater load on deb, rpm or Nix visible in the log
  autoUpdater.logger = null;
  autoUpdater.autoDownload = true;

  // Windows builds are unsigned, so the signature check would reject every
  // update Sidra publishes. The property takes a verifier function, and its
  // setter ignores any falsy value, so the check is turned off by supplying one
  // that always passes rather than by assigning false. The instanceof narrows
  // to the only updater that carries the property, and electron-updater builds
  // an NsisUpdater on win32 and nowhere else.
  // This is only correct while the builds stay unsigned. Signing Windows makes
  // electron-builder write publisherName into app-update.yml, and the default
  // verifier then runs instead of returning early. Remove this override at that
  // point, or the signature check never returns a rejection.
  if (autoUpdater instanceof NsisUpdater) {
    autoUpdater.verifyUpdateCodeSignature = () => Promise.resolve(null);
  }

  autoUpdater.on('update-available', (info) => {
    autoUpdateLog.info('update available:', info.version);
  });

  autoUpdater.on('update-downloaded', async (info) => {
    autoUpdateLog.info('update downloaded:', info.version);
    setUpdateReady(info.version);
    rebuildMenu(tray);

    showUpdateNotification(info.version, 'update-downloaded', () => {
      autoUpdater.quitAndInstall();
    });

    const autoUpdateStrings = getAutoUpdateStrings();
    const result = await dialog.showMessageBox({
      type: 'info',
      title: autoUpdateStrings.ready,
      message: `${app.getName()} ${info.version}`,
      buttons: [autoUpdateStrings.restartNow, autoUpdateStrings.later],
      defaultId: 0,
      cancelId: 1,
    });

    if (result.response === 0) {
      autoUpdater.quitAndInstall();
    }
  });

  autoUpdater.on('error', (error) => {
    // A repository with no release yet is a normal state, not a fault
    if (error.message.includes('No published versions')) {
      autoUpdateLog.info('no published releases found; skipping update check');
    } else {
      autoUpdateLog.error('update error:', error.message);
    }
  });

  await autoUpdater.checkForUpdates().catch(() => {});
}

export async function initAutoUpdate(tray: Tray, rebuildMenu: (tray: Tray) => void): Promise<void> {
  try {
    await configureAutoUpdate(loadAutoUpdater(), tray, rebuildMenu);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    autoUpdateLog.error('auto-update initialisation failed:', message);
  }
}
