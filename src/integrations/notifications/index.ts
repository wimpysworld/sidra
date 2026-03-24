import { app, BrowserWindow, Notification } from 'electron';
import https from 'https';
import fs from 'fs';
import path from 'path';
import log from 'electron-log/main';
import { Player } from '../../player';
import { getNotificationsEnabled } from '../../config';

const NOTIFICATION_DEBOUNCE_MS = 1500;
const ARTWORK_DOWNLOAD_TIMEOUT_MS = 5000;

const notifLog = log.scope('notifications');

// 'cache' is a valid Electron runtime path but absent from CastLabs type definitions
const ARTWORK_PATH = path.join((app.getPath as (name: string) => string)('cache'), 'sidra-artwork.jpg');
let lastArtworkUrl: string | null = null;

async function downloadArtwork(url: string | undefined): Promise<string | null> {
  if (!url) return null;
  if (url === lastArtworkUrl && fs.existsSync(ARTWORK_PATH)) {
    return ARTWORK_PATH;
  }

  fs.mkdirSync(path.dirname(ARTWORK_PATH), { recursive: true });

  return new Promise((resolve) => {
    const file = fs.createWriteStream(ARTWORK_PATH);
    const request = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        file.close();
        notifLog.warn('artwork download failed, status:', response.statusCode);
        resolve(null);
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        lastArtworkUrl = url;
        resolve(ARTWORK_PATH);
      });
    });
    request.on('error', (err) => {
      file.close();
      notifLog.warn('artwork download error:', err.message);
      resolve(null);
    });
    request.setTimeout(ARTWORK_DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy();
      notifLog.warn('artwork download timed out');
      resolve(null);
    });
  });
}

async function showNotification(
  payload: unknown,
  getMainWindow: () => BrowserWindow | null,
): Promise<void> {
  const p = payload as {
    name?: string;
    artistName?: string;
    albumName?: string;
    artworkUrl?: string;
  } | null;

  if (!p?.name) {
    notifLog.debug('skipping notification: no track name');
    return;
  }

  const artworkPath = await downloadArtwork(p.artworkUrl);

  const options: Electron.NotificationConstructorOptions = {
    title: p.name,
    body: [p.artistName, p.albumName].filter(Boolean).join(' - '),
    silent: true,
  };

  if (artworkPath) {
    options.icon = artworkPath;
  }

  const notification = new Notification(options);

  notification.on('show', () => {
    notifLog.debug('notification displayed:', p.name);
  });

  notification.on('failed', (_event, error) => {
    notifLog.error('notification failed:', p.name, error);
  });

  notification.on('click', () => {
    const win = getMainWindow();
    if (win) {
      win.show();
      win.focus();
    }
  });

  notification.show();
  notifLog.debug('notification requested:', p.name);
}

export function init(
  player: Player,
  getMainWindow: () => BrowserWindow | null,
): void {
  notifLog.info('notification module initialised');
  notifLog.info('notifications enabled:', getNotificationsEnabled());

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  player.on('nowPlayingItemDidChange', (payload: unknown) => {
    if (!getNotificationsEnabled()) {
      return;
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      showNotification(payload, getMainWindow);
    }, NOTIFICATION_DEBOUNCE_MS);
  });
}
