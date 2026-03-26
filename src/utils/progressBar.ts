import { BrowserWindow } from 'electron';

// Microseconds-to-seconds divisor for playbackTimeDidChange payloads
const US_PER_SEC = 1_000_000;

/**
 * Update the taskbar/dock progress bar based on playback position.
 * Works on macOS (dock), Windows (taskbar), and Linux (Unity launcher).
 */
export function updateProgressBar(win: BrowserWindow, positionUs: number, durationMs: number | undefined): void {
  if (!durationMs || durationMs <= 0) {
    win.setProgressBar(-1);
    return;
  }

  const positionSec = positionUs / US_PER_SEC;
  const durationSec = durationMs / 1000;
  const progress = Math.min(Math.max(positionSec / durationSec, 0), 1);
  win.setProgressBar(progress);
}

/**
 * Clear the taskbar/dock progress bar.
 */
export function clearProgressBar(win: BrowserWindow): void {
  win.setProgressBar(-1);
}
