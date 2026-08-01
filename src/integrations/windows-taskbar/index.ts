import { app, BrowserWindow, nativeImage, nativeTheme } from 'electron';
import path from 'path';
import log from 'electron-log/main';
import { PlaybackState, type NowPlayingPayload, type PlaybackStatePayload, type IntegrationContext } from '../../player';
import { getAssetPath } from '../../paths';
import { getTrayStrings } from '../../i18n';
import { updateProgressBar, clearProgressBar } from '../../utils/progressBar';

const taskbarLog = log.scope('taskbar');

const iconsDir = getAssetPath('assets', 'icons');
const menuIconsDir = path.join(iconsDir, 'tray', 'menu');

// Transient playback states where overlay should be left unchanged
const TRANSIENT_STATES: ReadonlySet<number> = new Set([
  PlaybackState.Loading,
  PlaybackState.Seeking,
  PlaybackState.Waiting,
  PlaybackState.Stalled,
]);

let sendCommandCallback: ((channel: string, ...args: unknown[]) => void) | null = null;

export function setTaskbarSendCommandCallback(callback: (channel: string, ...args: unknown[]) => void): void {
  sendCommandCallback = callback;
}

function loadIcon(baseName: string): Electron.NativeImage | null {
  // The thumbar and the overlay badge are painted on the taskbar, which follows
  // the Windows system colour mode. shouldUseDarkColors reports the app colour
  // mode, a separate setting, and a light app with a dark taskbar is the
  // default on a fresh install.
  const variant = nativeTheme.shouldUseDarkColorsForSystemIntegratedUI ? 'dark' : 'light';
  const iconPath = path.join(menuIconsDir, variant, `${baseName}.png`);
  const img = nativeImage.createFromPath(iconPath);
  if (img.isEmpty()) {
    taskbarLog.warn(`Taskbar icon unreadable: ${iconPath}`);
    return null;
  }
  return img;
}

function setThumbarButtons(win: BrowserWindow, isPlaying: boolean): void {
  const sendCommand = sendCommandCallback;
  const strings = getTrayStrings();

  const entries = [
    { tooltip: strings.previous, icon: loadIcon('backward-step'), channel: 'player:previous' },
    {
      tooltip: isPlaying ? strings.pause : strings.play,
      icon: isPlaying ? loadIcon('pause') : loadIcon('play'),
      channel: 'player:playPause',
    },
    { tooltip: strings.next, icon: loadIcon('forward-step'), channel: 'player:next' },
  ];

  const buttons: Electron.ThumbarButton[] = [];
  for (const { tooltip, icon, channel } of entries) {
    if (!icon) continue;
    buttons.push({
      tooltip,
      icon,
      click: () => { if (sendCommand) sendCommand(channel); },
    });
  }

  win.setThumbarButtons(buttons);
}

function setOverlayIcon(win: BrowserWindow, state: number): void {
  const strings = getTrayStrings();
  const overlay =
    state === PlaybackState.Playing
      ? { icon: loadIcon('play'), description: strings.play }
      : state === PlaybackState.Paused
        ? { icon: loadIcon('pause'), description: strings.pause }
        : null;

  if (overlay?.icon) {
    win.setOverlayIcon(overlay.icon, overlay.description);
  } else {
    win.setOverlayIcon(null, '');
  }
}

export function init(ctx: IntegrationContext): void {
  if (process.platform !== 'win32') return;

  const { player, getMainWindow } = ctx;

  let currentPayload: NowPlayingPayload | null = null;

  // Replay current state to the thumbnail toolbar once the window is visible.
  // setThumbarButtons is silently dropped by Windows when called on a hidden window.
  const win = getMainWindow?.();
  if (win) {
    win.once('show', () => {
      const { isPlaying, state } = player.playbackSnapshot();
      if (currentPayload) {
        setThumbarButtons(win, isPlaying);
        setOverlayIcon(win, state);
      }
    });
  }

  // Named listener references for removeListener in will-quit
  const onThemeUpdated = (): void => {
    const win = getMainWindow?.();
    if (!win) return;
    const { isPlaying, state } = player.playbackSnapshot();
    if (currentPayload) {
      setThumbarButtons(win, isPlaying);
    }
    // Always update overlay to reflect current theme, even with no track loaded
    setOverlayIcon(win, state);
  };

  const onNowPlayingItemDidChange = (payload: NowPlayingPayload | null): void => {
    const win = getMainWindow?.();
    if (!win) return;

    currentPayload = payload;
    if (!payload) {
      win.setThumbarButtons([]);
      win.setOverlayIcon(null, '');
      clearProgressBar(win);
      return;
    }
    const { isPlaying } = player.playbackSnapshot();
    setThumbarButtons(win, isPlaying);
  };

  const onPlaybackStateDidChange = (statePayload: PlaybackStatePayload): void => {
    const win = getMainWindow?.();
    if (!win) return;

    const state = statePayload?.state ?? 0;
    if (state === PlaybackState.None || state === PlaybackState.Stopped ||
        state === PlaybackState.Ended || state === PlaybackState.Completed) {
      currentPayload = null;
      win.setThumbarButtons([]);
      win.setOverlayIcon(null, '');
      clearProgressBar(win);
      return;
    }

    const { isPlaying } = player.playbackSnapshot();
    setThumbarButtons(win, isPlaying);

    // Skip overlay update for transient states to avoid flicker
    if (!TRANSIENT_STATES.has(state)) {
      setOverlayIcon(win, state);
    }
  };

  const onPlaybackTimeDidChange = (positionUs: number): void => {
    const win = getMainWindow?.();
    if (!win) return;
    updateProgressBar(win, positionUs, currentPayload?.durationInMillis);
  };

  nativeTheme.on('updated', onThemeUpdated);
  player.on('nowPlayingItemDidChange', onNowPlayingItemDidChange);
  player.on('playbackStateDidChange', onPlaybackStateDidChange);
  player.on('playbackTimeDidChange', onPlaybackTimeDidChange);

  app.on('will-quit', () => {
    nativeTheme.removeListener('updated', onThemeUpdated);
    player.removeListener('nowPlayingItemDidChange', onNowPlayingItemDidChange);
    player.removeListener('playbackStateDidChange', onPlaybackStateDidChange);
    player.removeListener('playbackTimeDidChange', onPlaybackTimeDidChange);
  });

  taskbarLog.info('Windows taskbar integration initialised');
}
