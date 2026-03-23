import { app, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { Player } from './player';

const wedgeLog = log.scope('wedge');

const STALL_THRESHOLD_MS = 5000;
const END_SAFETY_MARGIN_MS = 10000;
const CHECK_INTERVAL_MS = 1000;
const MAX_SKIP_ATTEMPTS = 3;

let isPlaying = false;
let lastPositionUs = 0;
let lastAdvanceTime = 0;
let durationMs = 0;
let checkTimer: ReturnType<typeof setInterval> | null = null;
let skipAttempts = 0;

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
  if (!isPlaying) return;
  if (Date.now() - lastAdvanceTime < STALL_THRESHOLD_MS) return;
  if (durationMs > 0 && (durationMs - lastPositionUs / 1000) < END_SAFETY_MARGIN_MS) return;
  if (skipAttempts >= MAX_SKIP_ATTEMPTS) return;

  skipAttempts++;
  lastAdvanceTime = Date.now();
  wedgeLog.warn(`playback stalled, skipping forward (attempt ${skipAttempts}/${MAX_SKIP_ATTEMPTS})`);

  getWin()?.webContents.executeJavaScript('window.__sidra.next()').catch((err: unknown) => {
    wedgeLog.warn('skip forward failed:', err);
  });
}

export function init(player: Player, getWin: () => BrowserWindow | null): void {
  player.on('playbackStateDidChange', (payload: unknown) => {
    const p = payload as { state: number } | null;
    isPlaying = p?.state === 2;
    lastAdvanceTime = Date.now();
    skipAttempts = 0;

    if (isPlaying) {
      startTimer(getWin);
    } else {
      stopTimer();
    }
  });

  player.on('nowPlayingItemDidChange', (payload: unknown) => {
    const p = payload as { durationInMillis?: number } | null;
    durationMs = p?.durationInMillis ?? 0;
    lastPositionUs = 0;
    lastAdvanceTime = Date.now();
    skipAttempts = 0;
  });

  player.on('playbackTimeDidChange', (payload: unknown) => {
    if (typeof payload === 'number' && payload !== lastPositionUs) {
      lastPositionUs = payload;
      lastAdvanceTime = Date.now();
    }
  });

  app.on('will-quit', () => stopTimer());

  wedgeLog.info('wedge detector initialised');
}
