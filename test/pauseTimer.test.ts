// The tray and the macOS dock arm this timer on a pause and clear Now Playing
// when it expires. cancel() and destroy() are separate for a reason: the
// playback path cancels, and teardown on will-quit destroys, because an expiry
// after teardown calls into a dock that no longer exists.
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

    // The bare call is the subject: the playback path cancels on every state
    // change, most of which armed no timer.
    timer.cancel();
    expect(onExpiry).not.toHaveBeenCalled();
  });
});
