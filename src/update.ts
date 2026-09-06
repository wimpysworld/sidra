import { app, net, Tray } from 'electron';
import log from 'electron-log/main';
import { getNotificationsEnabled } from './config';
import { getUpdateStrings } from './i18n';
import { createNotification } from './notify';
import { errorMessage } from './utils';
import { openExternalUrl } from './utils/openExternal';

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
 * Raise the "update available" notification both update paths share. The caller
 * supplies the click action, because this module opens the release page while
 * src/autoUpdate.ts installs the download it already has. The label names the
 * calling path, so one log scope still tells the two apart. Does nothing when
 * notifications are off or when createNotification() finds nothing to receive
 * one.
 */
export function showUpdateNotification(version: string, label: string, onClick: () => void): void {
  if (!getNotificationsEnabled()) return;

  const strings = getUpdateStrings();
  const notification = createNotification({
    title: strings.updateAvailable.replace('{version}', version),
    body: `${app.getName()} ${version}`,
    silent: true,
  });
  if (!notification) return;

  notification.on('click', onClick);
  notification.show();
  updateLog.debug(`${label} notification shown`);
}

/** A version part is a run of decimal digits and nothing else. */
const VERSION_PART = /^[0-9]+$/;

/**
 * Read the first three parts of a version as numbers. A part past the end of the
 * version counts as 0, so 1.0 reads as 1.0.0, and parts beyond the third are
 * ignored. Returns null when a part that is present is not a run of decimal
 * digits, which is how a malformed version is refused before anything is
 * compared. The two cases stay distinct: the padding happens because the index is
 * past the end of the array, never because a part read as zero, so 2..0 is
 * refused rather than filled in as 2.0.0.
 *
 * The test is the regular expression, not Number.isFinite(). Number() accepts far
 * more than a decimal integer and reads 0x10 as 16, 1e2 as 100, and both an empty
 * part and a whitespace one as 0, so every one of those parsed as a valid version.
 */
function versionParts(version: string): number[] | null {
  const split = version.split('.');
  const parts: number[] = [];
  for (let i = 0; i < SEMVER_PARTS; i++) {
    if (i >= split.length) {
      parts.push(0);
      continue;
    }
    if (!VERSION_PART.test(split[i])) return null;
    parts.push(Number(split[i]));
  }
  return parts;
}

/**
 * Compare two major.minor.patch versions numerically, so 0.10.0 beats 0.9.0
 * where a string compare would not. Sidra tags releases with exactly three
 * numeric parts, but neither side is guaranteed to carry three: a missing part
 * counts as 0, so 1.0 beats 0.3.0 and equals 1.0.0.
 *
 * A valid part is a run of decimal digits and nothing else. A version carrying
 * anything else in the first three is refused outright and the answer is "not
 * newer", so a malformed tag never offers an update. That refuses 0x10 and 1e2,
 * which Number() reads happily, along with a leading + and a negative part; none
 * is a valid Sidra release tag. A part with a decimal point is refused by the same
 * rule but cannot be reached, because the dot is what splits the parts. A leading
 * v is not this function's problem, because checkForUpdates() strips it. Both
 * sides are checked before any comparison runs: a remote Sidra cannot parse must
 * not be offered, and a local one leaves it unable to tell what is installed. The
 * whole version is refused rather than the single bad part, because a decision
 * reached before that part is read is no more trustworthy than one reached after
 * it; 0.4.x is therefore not newer than 0.3.0 even though the minor part alone
 * would say so. Testing NaN in the comparisons instead is not enough: NaN > x and
 * NaN < x are both false, so 0.x.99 fell through to the third part and offered an
 * update over 0.3.0.
 */
export function isNewer(remote: string, local: string): boolean {
  const r = versionParts(remote);
  const l = versionParts(local);
  if (!r || !l) return false;
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
        'User-Agent': `${app.getName()}/${localVersion}`,
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

      showUpdateNotification(cleanVersion, 'update', () => { openExternalUrl(releaseUrl, updateLog); });
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
