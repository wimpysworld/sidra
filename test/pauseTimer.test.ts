import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPauseTimer } from '../src/pauseTimer';

describe('createPauseTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onExpiry after the timeout', () => {
    const onExpiry = vi.fn();
    const timer = createPauseTimer(1000, onExpiry);

    timer.start();
    expect(onExpiry).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    expect(onExpiry).toHaveBeenCalledOnce();
  });

  it('does not call onExpiry if cancelled before timeout', () => {
    const onExpiry = vi.fn();
    const timer = createPauseTimer(1000, onExpiry);

    timer.start();
    vi.advanceTimersByTime(500);
    timer.cancel();

    vi.advanceTimersByTime(1000);
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it('restarts the timer when start is called while running', () => {
    const onExpiry = vi.fn();
    const timer = createPauseTimer(1000, onExpiry);

    timer.start();
    vi.advanceTimersByTime(800);
    expect(onExpiry).not.toHaveBeenCalled();

    // Restart resets the timeout
    timer.start();
    vi.advanceTimersByTime(800);
    expect(onExpiry).not.toHaveBeenCalled();

    vi.advanceTimersByTime(200);
    expect(onExpiry).toHaveBeenCalledOnce();
  });

  it('destroy clears any pending timer', () => {
    const onExpiry = vi.fn();
    const timer = createPauseTimer(1000, onExpiry);

    timer.start();
    vi.advanceTimersByTime(500);
    timer.destroy();

    vi.advanceTimersByTime(1000);
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it('cancel is safe to call when no timer is running', () => {
    const onExpiry = vi.fn();
    const timer = createPauseTimer(1000, onExpiry);

    // Should not throw
    timer.cancel();
    expect(onExpiry).not.toHaveBeenCalled();
  });
});
