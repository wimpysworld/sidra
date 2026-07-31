import { app, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { Player, PlaybackState, PlaybackStatePayload, NowPlayingPayload, IntegrationContext } from './player';

const wedgeLog = log.scope('wedge');

const STALL_THRESHOLD_MS = 5000;
const END_SAFETY_MARGIN_MS = 10000;
const CHECK_INTERVAL_MS = 1000;
const MAX_SKIP_ATTEMPTS = 3;

let playerRef: Player | null = null;
let lastAdvanceTime = 0;
let durationMs = 0;
let checkTimer: ReturnType<typeof setInterval> | null = null;
let skipAttempts = 0;
let initialised = false;

function startTimer(getWin: () => BrowserWindow | null): void {
  if (checkTimer) return;
  checkTimer = setInterval(() => checkForWedge(getWin), CHECK_INTERVAL_MS);
}

function stopTimer(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

function checkForWedge(getWin: () => BrowserWindow | null): void {
  if (!playerRef?.playbackSnapshot().isPlaying) return;
  if (Date.now() - lastAdvanceTime < STALL_THRESHOLD_MS) return;
  const positionUs = playerRef.playbackSnapshot().positionUs;
  if (durationMs > 0 && (durationMs - positionUs / 1000) < END_SAFETY_MARGIN_MS) return;
  if (skipAttempts >= MAX_SKIP_ATTEMPTS) return;

  skipAttempts++;
  lastAdvanceTime = Date.now();
  wedgeLog.warn(`playback stalled, skipping forward (attempt ${skipAttempts}/${MAX_SKIP_ATTEMPTS})`);

  getWin()?.webContents.send('player:next');
}

export function reset(): void {
  skipAttempts = 0;
  stopTimer();
}

export function init(ctx: IntegrationContext): void {
  const { player, getMainWindow: getWin } = ctx;
  if (!getWin) throw new Error('wedgeDetector requires getMainWindow');

  // All state here is module-scoped, so a second init() attaches a second copy
  // of all three listeners and a second will-quit handler. The skip path
  // survives that by luck rather than design: startTimer() returns early when a
  // timer already exists, and the duplicated writes to lastAdvanceTime and
  // skipAttempts happen to be idempotent. The caller guards its own re-entry;
  // this guard means the module does not depend on it.
  if (initialised) {
    wedgeLog.warn('wedge detector already initialised, ignoring repeat init');
    return;
  }
  initialised = true;

  playerRef = player;

  let lastSeenPositionUs = 0;

  // Named listener references for removeListener in will-quit
  const onPlaybackStateDidChange = (payload: PlaybackStatePayload): void => {
    const nowPlaying = payload?.state === PlaybackState.Playing;
    lastAdvanceTime = Date.now();
    skipAttempts = 0;

    if (nowPlaying) {
      startTimer(getWin);
    } else {
      stopTimer();
    }
  };

  const onNowPlayingItemDidChange = (payload: NowPlayingPayload | null): void => {
    durationMs = payload?.durationInMillis ?? 0;
    lastAdvanceTime = Date.now();
    skipAttempts = 0;
  };

  const onPlaybackTimeDidChange = (payload: number): void => {
    if (payload !== lastSeenPositionUs) {
      lastSeenPositionUs = payload;
      lastAdvanceTime = Date.now();
    }
  };

  player.on('playbackStateDidChange', onPlaybackStateDidChange);
  player.on('nowPlayingItemDidChange', onNowPlayingItemDidChange);
  player.on('playbackTimeDidChange', onPlaybackTimeDidChange);

  app.on('will-quit', () => {
    stopTimer();
    player.removeListener('playbackStateDidChange', onPlaybackStateDidChange);
    player.removeListener('nowPlayingItemDidChange', onNowPlayingItemDidChange);
    player.removeListener('playbackTimeDidChange', onPlaybackTimeDidChange);
  });

  wedgeLog.info('wedge detector initialised');
}
