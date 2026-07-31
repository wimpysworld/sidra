import { app, BrowserWindow, Menu, ShareMenu } from 'electron';
import log from 'electron-log/main';
import { PlaybackState, getShareUrl, type NowPlayingPayload, type PlaybackStatePayload, type IntegrationContext } from '../../player';
import { getTrayStrings } from '../../i18n';
import { truncateMenuLabel } from '../../tray';
import { createPauseTimer } from '../../pauseTimer';
import { updateProgressBar, clearProgressBar } from '../../utils/progressBar';

const dockLog = log.scope('dock');

const DOCK_PAUSE_TIMEOUT_MS = 30_000;

let sendCommandCallback: ((channel: string, ...args: unknown[]) => void) | null = null;
let getMainWindowCallback: (() => BrowserWindow | null) | null = null;

export function setDockSendCommandCallback(callback: (channel: string, ...args: unknown[]) => void): void {
  sendCommandCallback = callback;
}

function buildDockMenu(
  payload: NowPlayingPayload | null,
  isPlaying: boolean,
): Menu {
  const strings = getTrayStrings();
  const sendCommand = sendCommandCallback;

  const items: Electron.MenuItemConstructorOptions[] = [];

  if (payload?.name) {
    const trackLabel = truncateMenuLabel(payload.name);
    const artistLabel = payload.artistName ? truncateMenuLabel(payload.artistName) : null;
    const nowPlayingText = artistLabel ? `${trackLabel} - ${artistLabel}` : trackLabel;
    items.push({ label: nowPlayingText, enabled: false });
    items.push({ type: 'separator' });

    // Share item using ShareMenu
    const shareUrl = getShareUrl(payload);
    if (shareUrl) {
      items.push({
        label: strings.share,
        click: () => {
          const shareMenu = new ShareMenu({ urls: [shareUrl] });
          shareMenu.popup();
        },
      });
      items.push({ type: 'separator' });
    }
  } else {
    items.push({ label: strings.pause, enabled: false });
    items.push({ type: 'separator' });
  }

  const playPauseLabel = isPlaying ? strings.pause : strings.play;
  items.push({
    label: playPauseLabel,
    click: () => { if (sendCommand) sendCommand('player:playPause'); },
  });
  items.push({
    label: strings.next,
    click: () => { if (sendCommand) sendCommand('player:next'); },
  });
  items.push({
    label: strings.previous,
    click: () => { if (sendCommand) sendCommand('player:previous'); },
  });

  return Menu.buildFromTemplate(items);
}

function updateDockProgressBar(positionUs: number, durationMs: number | undefined): void {
  const win = getMainWindowCallback?.();
  if (!win) return;
  updateProgressBar(win, positionUs, durationMs);
}

function clearDockProgressBar(): void {
  const win = getMainWindowCallback?.();
  if (!win) return;
  clearProgressBar(win);
}

export function init(ctx: IntegrationContext): void {
  if (process.platform !== 'darwin') return;

  const { player, getMainWindow } = ctx;
  getMainWindowCallback = getMainWindow ?? null;

  let currentPayload: NowPlayingPayload | null = null;
  let previousPlaying = false;

  const rebuildDock = (isPlaying: boolean): void => {
    if (app.dock) app.dock.setMenu(buildDockMenu(currentPayload, isPlaying));
  };

  const clearNowPlaying = (): void => {
    dockLog.debug('dock pause timeout reached, clearing Now Playing');
    currentPayload = null;
    clearDockProgressBar();
    rebuildDock(false);
  };

  const dockPauseTimer = createPauseTimer(DOCK_PAUSE_TIMEOUT_MS, clearNowPlaying);

  // Named listener references for removeListener in will-quit
  const onNowPlayingItemDidChange = (payload: NowPlayingPayload | null): void => {
    dockPauseTimer.cancel();
    currentPayload = payload;
    if (!payload) {
      clearDockProgressBar();
      rebuildDock(false);
      return;
    }
    const { isPlaying } = player.playbackSnapshot();
    rebuildDock(isPlaying);
  };

  const onPlaybackStateDidChange = (statePayload: PlaybackStatePayload): void => {
    const state = statePayload?.state ?? 0;
    if (state === PlaybackState.None || state === PlaybackState.Stopped ||
        state === PlaybackState.Ended || state === PlaybackState.Completed) {
      dockPauseTimer.cancel();
      currentPayload = null;
      clearDockProgressBar();
      rebuildDock(false);
      return;
    }

    const { isPlaying } = player.playbackSnapshot();

    if (isPlaying) {
      dockPauseTimer.cancel();
    }
    if (!isPlaying && previousPlaying) {
      dockPauseTimer.start();
    }
    previousPlaying = isPlaying;

    rebuildDock(isPlaying);
  };

  const onPlaybackTimeDidChange = (positionUs: number): void => {
    updateDockProgressBar(positionUs, currentPayload?.durationInMillis);
  };

  player.on('nowPlayingItemDidChange', onNowPlayingItemDidChange);
  player.on('playbackStateDidChange', onPlaybackStateDidChange);
  player.on('playbackTimeDidChange', onPlaybackTimeDidChange);

  app.on('will-quit', () => {
    player.removeListener('nowPlayingItemDidChange', onNowPlayingItemDidChange);
    player.removeListener('playbackStateDidChange', onPlaybackStateDidChange);
    player.removeListener('playbackTimeDidChange', onPlaybackTimeDidChange);
    // The 30 second timer outlives the listeners, and clearNowPlaying() calls
    // app.dock.setMenu(), so a pending one fires into a torn-down dock.
    dockPauseTimer.destroy();
  });

  // Initialise with empty dock menu
  rebuildDock(false);
  dockLog.info('dock menu initialised');
}
