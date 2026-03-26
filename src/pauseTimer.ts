export interface PauseTimer {
  start(): void;
  cancel(): void;
  destroy(): void;
}

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
