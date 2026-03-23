import { app, net, Notification, shell, Tray } from 'electron';
import log from 'electron-log/main';
import { getNotificationsEnabled } from './config';
import { getUpdateStrings } from './i18n';

const updateLog = log.scope('update');

const GITHUB_API_URL = 'https://api.github.com/repos/wimpysworld/sidra/releases/latest';

export interface UpdateInfo {
  version: string;
  url: string;
}

let updateInfo: UpdateInfo | null = null;

export function getUpdateInfo(): UpdateInfo | null {
  return updateInfo;
}

function isNewer(remote: string, local: string): boolean {
  const r = remote.split('.').map(Number);
  const l = local.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (r[i] > l[i]) return true;
    if (r[i] < l[i]) return false;
  }
  return false;
}

export async function checkForUpdates(tray: Tray, rebuildMenu: (tray: Tray) => void): Promise<void> {
  const localVersion = app.getVersion();
  updateLog.debug('checking for updates, current version:', localVersion);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

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

    if (isNewer(remoteVersion, localVersion)) {
      updateLog.info(`update available: ${remoteVersion} (current: ${localVersion})`);
      updateInfo = { version: remoteVersion, url: releaseUrl };
      rebuildMenu(tray);

      if (getNotificationsEnabled()) {
        const strings = getUpdateStrings();
        const notification = new Notification({
          title: strings.updateAvailable,
          body: `Sidra ${remoteVersion}`,
          silent: true,
        });
        notification.on('click', () => {
          shell.openExternal(releaseUrl);
        });
        notification.show();
        updateLog.debug('update notification shown');
      }
    } else {
      updateLog.debug('up to date:', localVersion);
      rebuildMenu(tray);
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    updateLog.debug('update check failed:', message);
  } finally {
    clearTimeout(timeout);
  }
}
