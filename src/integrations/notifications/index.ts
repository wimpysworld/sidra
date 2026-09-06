import { app, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { NowPlayingPayload, IntegrationContext } from '../../player';
import { downloadArtwork } from '../../artwork';
import { getNotificationsEnabled } from '../../config';
import { createNotification, notificationsAvailable } from '../../notify';
import { errorMessage } from '../../utils';
import { getTrayStrings } from '../../i18n';
import { sendCommand } from '../../commandBridge';
import type { createLinuxNotifications } from '../../linuxNotifications';

const NOTIFICATION_DEBOUNCE_MS = 1500;
const ARTWORK_RACE_TIMEOUT_MS = 500;

const notifLog = log.scope('notifications');

async function showNotification(
  payload: NowPlayingPayload | null,
  getMainWindow: () => BrowserWindow | null,
  isCurrent: () => boolean,
  getLinuxNotifications: () => Promise<ReturnType<typeof createLinuxNotifications>>,
  activeNotifications: Set<Electron.Notification>,
): Promise<void> {
  if (!payload?.name) {
    notifLog.debug('skipping notification: no track name');
    return;
  }

  // Checked before the artwork download so a daemon-less session does no
  // network and disk work per track
  if (!notificationsAvailable()) {
    notifLog.debug('skipping notification: no notification daemon');
    return;
  }

  // A slow artwork fetch must not hold the notification past the track it
  // announces, so the download races a timeout and loses its icon on expiry
  const artworkPath = payload.artworkUrl
    ? await Promise.race([
        downloadArtwork(payload.artworkUrl).catch((error: unknown) => {
          notifLog.warn('artwork download error:', errorMessage(error));
          return null;
        }),
        new Promise<null>((resolve) => setTimeout(resolve, ARTWORK_RACE_TIMEOUT_MS, null)),
      ])
    : null;

  if (!isCurrent()) return;
  const strings = getTrayStrings();
  const onAction = (action: 'previous' | 'next' | 'default'): void => {
    if (action === 'previous') sendCommand('player:previous');
    else if (action === 'next') sendCommand('player:next');
    else {
      const win = getMainWindow();
      if (win) {
        win.show();
        win.focus();
      }
    }
  };

  if (process.platform === 'linux') {
    const linux = await getLinuxNotifications();
    await linux.show({
      title: payload.name,
      body: [payload.artistName, payload.albumName].filter(Boolean).join(' - '),
      icon: artworkPath ?? undefined,
      previous: strings.previous,
      next: strings.next,
      onAction,
    }, isCurrent);
    return;
  }

  const options: Electron.NotificationConstructorOptions = {
    title: payload.name,
    body: [payload.artistName, payload.albumName].filter(Boolean).join(' - '),
    silent: true,
    actions: [
      { type: 'button', text: strings.previous },
      { type: 'button', text: strings.next },
    ],
  };

  if (artworkPath) {
    options.icon = artworkPath;
  }

  const notification = createNotification(options);

  if (!notification) {
    return;
  }

  activeNotifications.add(notification);
  notification.on('close', () => activeNotifications.delete(notification));

  notification.on('show', () => {
    notifLog.debug('notification displayed:', payload.name);
  });

  notification.on('failed', (_event, error) => {
    notifLog.error('notification failed:', payload.name, error);
  });

  notification.on('action', (event) => {
    if (event.actionIndex === 0) onAction('previous');
    else if (event.actionIndex === 1) onAction('next');
  });
  notification.on('click', () => onAction('default'));

  notification.show();
  notifLog.debug('notification requested:', payload.name);
}

/**
 * Announces each new track as a desktop notification. The debounce keeps a
 * queue jump or a burst of metadata updates to a single notification.
 */
export function init(ctx: IntegrationContext): void {
  const { player, getMainWindow } = ctx;
  const getWin = getMainWindow ?? (() => null);

  notifLog.info('notification module initialised');
  notifLog.info('notifications enabled:', getNotificationsEnabled());

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let stopped = false;
  const activeNotifications = new Set<Electron.Notification>();
  let linux: Promise<ReturnType<typeof createLinuxNotifications>> | null = null;
  const getLinuxNotifications = () => linux ??= import('../../linuxNotifications')
    .then(({ createLinuxNotifications }) => createLinuxNotifications());

  const onNowPlayingItemDidChange = (payload: NowPlayingPayload | null): void => {
    const currentGeneration = ++generation;
    if (!getNotificationsEnabled()) {
      return;
    }

    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const isCurrent = () => !stopped && generation === currentGeneration
        && getNotificationsEnabled() && notificationsAvailable();
      if (!isCurrent()) return;
      showNotification(payload, getWin, isCurrent, getLinuxNotifications, activeNotifications).catch((error: unknown) =>
        notifLog.warn('notification error:', errorMessage(error)),
      );
    }, NOTIFICATION_DEBOUNCE_MS);
  };

  player.on('nowPlayingItemDidChange', onNowPlayingItemDidChange);

  app.on('will-quit', () => {
    stopped = true;
    if (linux) void linux.then((adapter) => adapter.dispose()).catch(() => {});
    for (const notification of activeNotifications) {
      notification.removeAllListeners();
      notification.close();
    }
    activeNotifications.clear();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    player.removeListener('nowPlayingItemDidChange', onNowPlayingItemDidChange);
  });
}
