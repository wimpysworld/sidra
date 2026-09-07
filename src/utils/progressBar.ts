import { BrowserWindow } from 'electron';

// Microseconds-to-seconds divisor for playbackTimeDidChange payloads
const US_PER_SEC = 1_000_000;

/**
 * Shows clamped playback progress on the macOS dock, Windows taskbar or Linux Unity launcher.
 * Clears the bar when the duration is absent or non-positive, as for a radio stream.
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

/** Removes the progress bar with Electron's negative-value sentinel. */
export function clearProgressBar(win: BrowserWindow): void {
  win.setProgressBar(-1);
}
