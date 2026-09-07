import { app, BrowserWindow, Notification } from 'electron';
import log from 'electron-log/main';
import { randomBytes } from 'node:crypto';
import { NowPlayingPayload, TimedMetadataPayload, IntegrationContext, PlaybackState, PlaybackSnapshot } from '../../player';
import { downloadArtwork } from '../../artwork';
import { getNotificationsEnabled } from '../../config';
import { createNotification, notificationsAvailable } from '../../notify';
import { errorMessage } from '../../utils';
import { getTrayStrings } from '../../i18n';
import { sendCommand } from '../../commandBridge';
import type { createLinuxNotifications } from '../../linuxNotifications';

const NOTIFICATION_DEBOUNCE_MS = 1500;
const ARTWORK_RACE_TIMEOUT_MS = 500;
const PLAYBACK_NOTIFICATION_GROUP = 'playback';

const notifLog = log.scope('notifications');

function clearPlaybackHistory(): void {
  if (process.platform !== 'darwin') return;
  try {
    Notification.removeGroup(PLAYBACK_NOTIFICATION_GROUP);
  } catch {
    notifLog.warn('playback notification cleanup unavailable');
  }
}

function closeNotifications(notifications: Set<Electron.Notification>, pending: Set<Electron.Notification>): void {
  for (const notification of notifications) {
    notification.removeAllListeners('action');
    notification.removeAllListeners('click');
    notification.removeAllListeners('close');
    // close() detaches Electron's delegate without cancelling pending artwork.
    // Keep the delegate until show or failed can retire the pending object.
    if (!pending.has(notification)) {
      notification.removeAllListeners();
      notification.close();
    }
  }
  notifications.clear();
}

async function showNotification(
  payload: NowPlayingPayload | null,
  getMainWindow: () => BrowserWindow | null,
  isCurrent: () => boolean,
  getLinuxNotifications: () => Promise<ReturnType<typeof createLinuxNotifications>>,
  activeNotifications: Set<Electron.Notification>,
  pendingNotifications: Set<Electron.Notification>,
  getPlaybackSnapshot: () => PlaybackSnapshot,
): Promise<(() => void) | undefined> {
  if (!payload?.name) {
    notifLog.debug('skipping notification: no track name');
    return;
  }
  const title = payload.name;

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
  const isPlaying = () => getPlaybackSnapshot().isPlaying;
  let lastKnownPlaying = isPlaying();
  const playbackAction = (): 'play' | 'pause' => {
    const { state } = getPlaybackSnapshot();
    if (state === PlaybackState.Playing) lastKnownPlaying = true;
    else if (state === PlaybackState.Paused || state === PlaybackState.Stopped || state === PlaybackState.None
      || state === PlaybackState.Ended || state === PlaybackState.Completed) lastKnownPlaying = false;
    return lastKnownPlaying ? 'pause' : 'play';
  };
  const onAction = (action: 'previous' | 'next' | 'default' | 'play' | 'pause'): void => {
    if (!isCurrent()) return;
    if (action === 'previous') sendCommand('player:previous');
    else if (action === 'next') sendCommand('player:next');
    else if (action === 'play') { if (playbackAction() === 'play') sendCommand('player:play'); }
    else if (action === 'pause') { if (playbackAction() === 'pause') sendCommand('player:pause'); }
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
    let lastAction = playbackAction();
    const deliver = (refreshOnly: boolean) => linux.show({
      title,
      body: [payload.artistName, payload.albumName].filter(Boolean).join(' - '),
      icon: artworkPath ?? undefined,
      previous: strings.previous,
      next: strings.next,
      playbackAction: lastAction,
      playbackLabel: strings[lastAction],
      onAction,
    }, isCurrent, refreshOnly);
    await deliver(false);
    return () => {
      const action = playbackAction();
      if (!isCurrent() || action === lastAction) return;
      lastAction = action;
      void deliver(true).catch(() => notifLog.warn('playback notification refresh unavailable'));
    };
  }

  let currentNotification: Electron.Notification | null = null;
  let pending = false;
  let dismissed = false;
  let lastAction = playbackAction();
  const refresh = (): void => {
    const action = playbackAction();
    if (!isCurrent() || pending || dismissed || lastAction === action) return;
    try {
      deliver();
    } catch {
      notifLog.warn('playback notification refresh unavailable');
    }
  };
  const deliver = (): void => {
    lastAction = playbackAction();
    const displayedAction = lastAction;
    const options: Electron.NotificationConstructorOptions = {
      id: randomBytes(8).toString('hex'),
      groupId: PLAYBACK_NOTIFICATION_GROUP,
      title,
      body: [payload.artistName, payload.albumName].filter(Boolean).join(' - '),
      silent: true,
      actions: [
        { type: 'button', text: strings[displayedAction] },
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

    closeNotifications(activeNotifications, pendingNotifications);
    currentNotification = notification;
    pending = true;
    dismissed = false;
    // A closed Windows banner can remain in Action Center. Keep its object for
    // actions and explicit removal until the next track or quit.
    activeNotifications.add(notification);
    pendingNotifications.add(notification);

    notification.on('show', () => {
      pendingNotifications.delete(notification);
      if (!isCurrent() || !activeNotifications.has(notification)) {
        notification.removeAllListeners();
        notification.close();
        activeNotifications.delete(notification);
        return;
      }
      pending = false;
      notifLog.debug('notification displayed:', payload.name);
      refresh();
    });

    notification.on('close', () => {
      if (currentNotification === notification) dismissed = true;
    });

    notification.on('failed', (_event, error) => {
      pendingNotifications.delete(notification);
      activeNotifications.delete(notification);
      notification.removeAllListeners();
      if (currentNotification === notification) dismissed = true;
      notifLog.error('notification failed:', payload.name, error);
    });

    notification.on('action', (event) => {
      if (event.actionIndex === 0) onAction(displayedAction);
      else if (event.actionIndex === 1) onAction('previous');
      else if (event.actionIndex === 2) onAction('next');
    });
    notification.on('click', () => onAction('default'));

    notification.show();
    notifLog.debug('notification requested:', payload.name);
  };
  deliver();
  return refresh;
}

/**
 * Announces each new track as a desktop notification. The debounce keeps a
 * queue jump or a burst of metadata updates to a single notification.
 */
export function init(ctx: IntegrationContext): void {
  const { player, getMainWindow } = ctx;
  const getWin = getMainWindow ?? (() => null);
  clearPlaybackHistory();

  notifLog.info('notification module initialised');
  notifLog.info('notifications enabled:', getNotificationsEnabled());

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  let generation = 0;
  let stopped = false;
  let refreshPlayback: (() => void) | undefined;
  let radioStation: NowPlayingPayload | null = null;
  let timedDisplayKey: string | null = null;
  const activeNotifications = new Set<Electron.Notification>();
  const pendingNotifications = new Set<Electron.Notification>();
  let linux: Promise<ReturnType<typeof createLinuxNotifications>> | null = null;
  const getLinuxNotifications = () => linux ??= import('../../linuxNotifications')
    .then(({ createLinuxNotifications }) => createLinuxNotifications());

  const scheduleNotification = (payload: NowPlayingPayload | null): void => {
    refreshPlayback = undefined;
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
      showNotification(payload, getWin, isCurrent, getLinuxNotifications, activeNotifications, pendingNotifications,
        () => player.playbackSnapshot()).then((refresh) => {
        if (!isCurrent()) return;
        refreshPlayback = refresh;
        refreshPlayback?.();
      }).catch((error: unknown) =>
        notifLog.warn('notification error:', errorMessage(error)),
      );
    }, NOTIFICATION_DEBOUNCE_MS);
  };

  const onPlaybackStateDidChange = (): void => {
    const { state } = player.playbackSnapshot();
    if (state === PlaybackState.None) refreshPlayback = undefined;
    else if (state === PlaybackState.Playing || state === PlaybackState.Paused || state === PlaybackState.Stopped
      || state === PlaybackState.Ended || state === PlaybackState.Completed) refreshPlayback?.();
  };

  const onNowPlayingItemDidChange = (payload: NowPlayingPayload | null): void => {
    radioStation = payload?.playParams?.kind === 'radioStation' ? payload : null;
    timedDisplayKey = null;
    scheduleNotification(payload);
  };

  const onTimedMetadataDidChange = (payload: TimedMetadataPayload): void => {
    if (!radioStation) return;
    const displayKey = JSON.stringify([payload.name, payload.artistName, payload.albumName ?? '']);
    if (displayKey === timedDisplayKey) return;
    timedDisplayKey = displayKey;
    scheduleNotification({
      name: payload.name,
      artistName: payload.artistName,
      albumName: payload.albumName,
      artworkUrl: radioStation.artworkUrl,
    });
  };

  player.on('nowPlayingItemDidChange', onNowPlayingItemDidChange);
  player.on('timedMetadataDidChange', onTimedMetadataDidChange);
  player.on('playbackStateDidChange', onPlaybackStateDidChange);

  app.on('will-quit', () => {
    if (stopped) return;
    stopped = true;
    if (linux) void linux.then((adapter) => adapter.dispose()).catch(() => {});
    closeNotifications(new Set([...activeNotifications, ...pendingNotifications]), pendingNotifications);
    activeNotifications.clear();
    clearPlaybackHistory();
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    player.removeListener('nowPlayingItemDidChange', onNowPlayingItemDidChange);
    player.removeListener('timedMetadataDidChange', onTimedMetadataDidChange);
    player.removeListener('playbackStateDidChange', onPlaybackStateDidChange);
  });
}
