/**
 * A restartable one-shot timer for a pause that turns into a stop. The tray, the
 * macOS dock and Discord presence each hold one and clear their now-playing
 * state when it expires, so a paused player does not sit in the UI for ever.
 */
export interface PauseTimer {
  /** Arm the timer, discarding any run already in progress. */
  start(): void;
  /** Disarm without firing, for a resume or a track change. */
  cancel(): void;
  /**
   * Disarm for teardown. Named apart from cancel() so a will-quit handler reads
   * as teardown: an expiry after teardown calls back into a UI that has gone.
   */
  destroy(): void;
}

/** Build a timer that calls onExpiry once, timeoutMs after the last start(). */
export function createPauseTimer(timeoutMs: number, onExpiry: () => void): PauseTimer {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function start(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onExpiry();
    }, timeoutMs);
  }

  function cancel(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }

  return { start, cancel, destroy: cancel };
}

/** A pause timer that arms itself from the playback state the player reports. */
export interface PauseEdgeTimer extends PauseTimer {
  /**
   * Take one playback report: cancel while playing, arm on the move to paused.
   */
  report(isPlaying: boolean): void;
}

/**
 * Build a timer that arms on the playing-to-paused edge only. Paused states
 * repeat, and start() discards the run in progress, so arming on each report
 * would push the clear-down further away every time and a paused player would
 * keep its Now Playing entries for ever.
 *
 * Every caller builds its own, because the retained previous value belongs to
 * that surface. One value shared between the tray and the dock would let a
 * report to either consume the edge the other was waiting for.
 */
export function createPauseEdgeTimer(timeoutMs: number, onExpiry: () => void): PauseEdgeTimer {
  const timer = createPauseTimer(timeoutMs, onExpiry);
  let previousPlaying = false;

  function report(isPlaying: boolean): void {
    if (isPlaying) {
      timer.cancel();
    } else if (previousPlaying) {
      timer.start();
    }
    previousPlaying = isPlaying;
  }

  return { ...timer, report };
}
