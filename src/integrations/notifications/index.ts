import { BrowserWindow, Notification } from 'electron';
import log from 'electron-log/main';
import { Player, NowPlayingPayload, IntegrationContext } from '../../player';
import { downloadArtwork } from '../../artwork';
import { getNotificationsEnabled } from '../../config';

const NOTIFICATION_DEBOUNCE_MS = 1500;

const notifLog = log.scope('notifications');

async function showNotification(
  payload: NowPlayingPayload | null,
  getMainWindow: () => BrowserWindow | null,
): Promise<void> {
  if (!payload?.name) {
    notifLog.debug('skipping notification: no track name');
    return;
  }

  const artworkPath = payload.artworkUrl ? await downloadArtwork(payload.artworkUrl) : null;

  const options: Electron.NotificationConstructorOptions = {
    title: payload.name,
    body: [payload.artistName, payload.albumName].filter(Boolean).join(' - '),
    silent: true,
  };

  if (artworkPath) {
    options.icon = artworkPath;
  }

  const notification = new Notification(options);

  notification.on('show', () => {
    notifLog.debug('notification displayed:', payload.name);
  });

  notification.on('failed', (_event, error) => {
    notifLog.error('notification failed:', payload.name, error);
  });

  notification.on('click', () => {
    const win = getMainWindow();
    if (win) {
      win.show();
      win.focus();
    }
  });

  notification.show();
  notifLog.debug('notification requested:', payload.name);
}

export function init(ctx: IntegrationContext): void {
  const { player, getMainWindow } = ctx;
  const getWin = getMainWindow ?? (() => null);

  notifLog.info('notification module initialised');
  notifLog.info('notifications enabled:', getNotificationsEnabled());

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  player.on('nowPlayingItemDidChange', (payload: NowPlayingPayload | null) => {
    if (!getNotificationsEnabled()) {
      return;
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      showNotification(payload, getWin);
    }, NOTIFICATION_DEBOUNCE_MS);
  });
}
