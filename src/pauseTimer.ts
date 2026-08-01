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
