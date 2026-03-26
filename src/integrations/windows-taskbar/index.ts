import { app, BrowserWindow, nativeImage, nativeTheme } from 'electron';
import path from 'path';
import log from 'electron-log/main';
import { Player, PlaybackState, type NowPlayingPayload, type PlaybackStatePayload, type IntegrationContext } from '../../player';
import { getAssetPath } from '../../paths';
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

function loadIcon(baseName: string): Electron.NativeImage {
  const variant = nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
  const iconPath = path.join(menuIconsDir, variant, `${baseName}.png`);
  return nativeImage.createFromPath(iconPath);
}

function setThumbarButtons(win: BrowserWindow, isPlaying: boolean): void {
  const sendCommand = sendCommandCallback;
  const previousIcon = loadIcon('backward-step');
  const playPauseIcon = isPlaying ? loadIcon('pause') : loadIcon('play');
  const nextIcon = loadIcon('forward-step');

  win.setThumbarButtons([
    {
      tooltip: 'Previous',
      icon: previousIcon,
      click: () => { if (sendCommand) sendCommand('player:previous'); },
    },
    {
      tooltip: isPlaying ? 'Pause' : 'Play',
      icon: playPauseIcon,
      click: () => { if (sendCommand) sendCommand('player:playPause'); },
    },
    {
      tooltip: 'Next',
      icon: nextIcon,
      click: () => { if (sendCommand) sendCommand('player:next'); },
    },
  ]);
}

function setOverlayIcon(win: BrowserWindow, state: number): void {
  if (state === PlaybackState.Playing) {
    const icon = loadIcon('play');
    win.setOverlayIcon(icon, 'Playing');
  } else if (state === PlaybackState.Paused) {
    const icon = loadIcon('pause');
    win.setOverlayIcon(icon, 'Paused');
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
