import { BrowserWindow } from 'electron';

// Microseconds-to-seconds divisor for playbackTimeDidChange payloads
const US_PER_SEC = 1_000_000;

/**
 * Show playback position on the taskbar or dock progress bar: the macOS dock,
 * the Windows taskbar and the Linux Unity launcher. Media with no known
 * duration, such as a radio stream, clears the bar rather than showing an empty
 * one, and the fraction is clamped so a position past the reported duration
 * cannot overfill it.
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
 * Remove the progress bar. A negative value is how Electron expresses "no
 * progress" on every platform.
 */
export function clearProgressBar(win: BrowserWindow): void {
  win.setProgressBar(-1);
}
