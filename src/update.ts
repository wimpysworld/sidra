import { app, net, shell, Tray } from 'electron';
import log from 'electron-log/main';
import { getNotificationsEnabled } from './config';
import { getUpdateStrings } from './i18n';
import { createNotification } from './notify';
import { errorMessage } from './utils';

// Update state shared with the tray, plus the notify-only check used where
// isAutoUpdateSupported() is false. Those builds are updated by a package
// manager, so the check reports a new release and links to it rather than
// downloading anything; src/autoUpdate.ts owns the AppImage and NSIS path and
// reports back here through setUpdateReady().

const SEMVER_PARTS = 3;
const UPDATE_CHECK_TIMEOUT_MS = 10000;

const updateLog = log.scope('update');

const GITHUB_API_URL = 'https://api.github.com/repos/wimpysworld/sidra/releases/latest';

export interface UpdateInfo {
  version: string;
  /** Release page to open. Empty when the update is already downloaded. */
  url: string;
  /** True once the update is downloaded and a restart would install it. */
  ready: boolean;
}

let updateInfo: UpdateInfo | null = null;

/** The newest update seen this session, or null when none has been found. */
export function getUpdateInfo(): UpdateInfo | null {
  return updateInfo;
}

/** Record a downloaded update, so the tray offers a restart rather than a link. */
export function setUpdateReady(version: string): void {
  updateInfo = { version, url: '', ready: true };
  updateLog.info('update ready to install:', version);
}

/**
 * Compare two major.minor.patch versions numerically, so 0.10.0 beats 0.9.0
 * where a string compare would not. Sidra tags releases with exactly three
 * numeric parts; any other form yields NaN, every comparison is then false and
 * the result is "not newer", so a malformed tag never offers an update.
 */
export function isNewer(remote: string, local: string): boolean {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < SEMVER_PARTS; i++) {
    if (r[i] > l[i]) return true;
    if (r[i] < l[i]) return false;
  }
  return false;
}

/**
 * Ask GitHub for the latest release and record it when it is newer. The menu is
 * rebuilt on both answers, because the tray shows the up-to-date state too. A
 * failed check is logged at debug and never surfaced: the user did not ask for
 * it, and no network is a normal condition.
 */
export async function checkForUpdates(tray: Tray, rebuildMenu: (tray: Tray) => void): Promise<void> {
  const localVersion = app.getVersion();
  updateLog.debug('checking for updates, current version:', localVersion);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), UPDATE_CHECK_TIMEOUT_MS);

  try {
    const response = await net.fetch(GITHUB_API_URL, {
      headers: {
        'User-Agent': `Sidra/${localVersion}`,
        'Accept': 'application/vnd.github.v3+json',
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      updateLog.debug('GitHub API returned status:', response.status);
      return;
    }

    const data = await response.json() as { tag_name?: string; html_url?: string };
    const remoteVersion = data.tag_name;
    const releaseUrl = data.html_url;

    if (!remoteVersion || !releaseUrl) {
      updateLog.debug('unexpected API response: missing tag_name or html_url');
      return;
    }

    const cleanVersion = remoteVersion.replace(/^v/, '');

    if (isNewer(cleanVersion, localVersion)) {
      updateLog.info(`update available: ${cleanVersion} (current: ${localVersion})`);
      updateInfo = { version: cleanVersion, url: releaseUrl, ready: false };
      rebuildMenu(tray);

      if (getNotificationsEnabled()) {
        const strings = getUpdateStrings();
        const notification = createNotification({
          title: strings.updateAvailable.replace('{version}', cleanVersion),
          body: `Sidra ${cleanVersion}`,
          silent: true,
        });
        if (notification) {
          notification.on('click', () => {
            try {
              const parsed = new URL(releaseUrl);
              if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
                shell.openExternal(releaseUrl);
              }
            } catch { /* ignore malformed URL */ }
          });
          notification.show();
          updateLog.debug('update notification shown');
        }
      }
    } else {
      updateLog.debug('up to date:', localVersion);
      rebuildMenu(tray);
    }
  } catch (error: unknown) {
    updateLog.debug('update check failed:', errorMessage(error));
  } finally {
    clearTimeout(timeout);
  }
}
