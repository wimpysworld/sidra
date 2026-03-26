import { app, BrowserWindow, Menu, ShareMenu } from 'electron';
import log from 'electron-log/main';
import { Player, PlaybackState, getShareUrl, type NowPlayingPayload, type IntegrationContext } from '../../player';
import { getTrayStrings } from '../../i18n';
import { truncateMenuLabel } from '../../tray';
import { createPauseTimer } from '../../pauseTimer';

const dockLog = log.scope('dock');

const DOCK_PAUSE_TIMEOUT_MS = 30_000;

// Microseconds-to-seconds divisor for playbackTimeDidChange payloads
const US_PER_SEC = 1_000_000;

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

function updateProgressBar(positionUs: number, durationMs: number | undefined): void {
  const win = getMainWindowCallback?.();
  if (!win) return;

  if (!durationMs || durationMs <= 0) {
    win.setProgressBar(-1);
    return;
  }

  const positionSec = positionUs / US_PER_SEC;
  const durationSec = durationMs / 1000;
  const progress = Math.min(Math.max(positionSec / durationSec, 0), 1);
  win.setProgressBar(progress);
}

function clearProgressBar(): void {
  const win = getMainWindowCallback?.();
  if (!win) return;
  win.setProgressBar(-1);
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
    clearProgressBar();
    rebuildDock(false);
  };

  const dockPauseTimer = createPauseTimer(DOCK_PAUSE_TIMEOUT_MS, clearNowPlaying);

  player.on('nowPlayingItemDidChange', (payload: NowPlayingPayload | null) => {
    dockPauseTimer.cancel();
    currentPayload = payload;
    if (!payload) {
      clearProgressBar();
      rebuildDock(false);
      return;
    }
    const { isPlaying } = player.playbackSnapshot();
    rebuildDock(isPlaying);
  });

  player.on('playbackStateDidChange', (statePayload) => {
    const state = statePayload?.state ?? 0;
    if (state === PlaybackState.None || state === PlaybackState.Stopped ||
        state === PlaybackState.Ended || state === PlaybackState.Completed) {
      dockPauseTimer.cancel();
      currentPayload = null;
      clearProgressBar();
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

    if (!isPlaying) {
      // Pause the progress bar (keep current value)
    }
    rebuildDock(isPlaying);
  });

  player.on('playbackTimeDidChange', (positionUs: number) => {
    updateProgressBar(positionUs, currentPayload?.durationInMillis);
  });

  // Initialise with empty dock menu
  rebuildDock(false);
  dockLog.info('dock menu initialised');
}
