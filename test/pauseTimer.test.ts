// The tray and the macOS dock arm this timer on a pause and clear Now Playing
// when it expires. cancel() and destroy() are separate for a reason: the
// playback path cancels, and teardown on will-quit destroys, because an expiry
// after teardown calls into a dock that no longer exists.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createPauseTimer, createPauseEdgeTimer } from '../src/pauseTimer';

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

describe('createPauseEdgeTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('arms on the playing-to-paused edge', () => {
    const onExpiry = vi.fn();
    const timer = createPauseEdgeTimer(1000, onExpiry);

    timer.report(true);
    timer.report(false);

    vi.advanceTimersByTime(1000);
    expect(onExpiry).toHaveBeenCalledOnce();
  });

  it('does not arm on a paused report that follows no playing report', () => {
    const onExpiry = vi.fn();
    const timer = createPauseEdgeTimer(1000, onExpiry);

    timer.report(false);

    vi.advanceTimersByTime(1000);
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it('does not re-arm on repeated paused reports', () => {
    const onExpiry = vi.fn();
    const timer = createPauseEdgeTimer(1000, onExpiry);

    timer.report(true);
    timer.report(false);
    // Each repeat would discard the run in progress and push the expiry a
    // further second away, so a paused player would never be cleared down.
    vi.advanceTimersByTime(800);
    timer.report(false);
    vi.advanceTimersByTime(200);

    expect(onExpiry).toHaveBeenCalledOnce();
  });

  it('cancels on a playing report', () => {
    const onExpiry = vi.fn();
    const timer = createPauseEdgeTimer(1000, onExpiry);

    timer.report(true);
    timer.report(false);
    vi.advanceTimersByTime(500);
    timer.report(true);

    vi.advanceTimersByTime(1000);
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it('re-arms on a later edge after a resume', () => {
    const onExpiry = vi.fn();
    const timer = createPauseEdgeTimer(1000, onExpiry);

    timer.report(true);
    timer.report(false);
    timer.report(true);
    timer.report(false);

    vi.advanceTimersByTime(1000);
    expect(onExpiry).toHaveBeenCalledOnce();
  });

  it('keeps the retained value per instance', () => {
    const onExpiryA = vi.fn();
    const onExpiryB = vi.fn();
    const timerA = createPauseEdgeTimer(1000, onExpiryA);
    const timerB = createPauseEdgeTimer(1000, onExpiryB);

    // B alone sees the playing state, so only B holds the edge. Shared state
    // would let A's paused report consume it.
    timerB.report(true);
    timerA.report(false);
    timerB.report(false);

    vi.advanceTimersByTime(1000);
    expect(onExpiryA).not.toHaveBeenCalled();
    expect(onExpiryB).toHaveBeenCalledOnce();
  });

  it('destroy clears a timer armed by an edge', () => {
    const onExpiry = vi.fn();
    const timer = createPauseEdgeTimer(1000, onExpiry);

    timer.report(true);
    timer.report(false);
    timer.destroy();

    vi.advanceTimersByTime(1000);
    expect(onExpiry).not.toHaveBeenCalled();
  });
});
