import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserWindow } from 'electron';

import { Player, PlaybackState } from '../src/player';
import type { IntegrationContext } from '../src/player';

type WedgeDetector = typeof import('../src/wedgeDetector');

// Every listener and counter in the module is module-scoped, and init() now
// refuses a second call, so a shared instance cannot be re-initialised between
// tests. Each test takes its own copy instead.
async function loadWedgeDetector(): Promise<WedgeDetector> {
  vi.resetModules();
  return import('../src/wedgeDetector');
}

describe('wedgeDetector', () => {
  let player: Player;
  let mockWin: { webContents: { send: ReturnType<typeof vi.fn> } };
  let getMainWindow: () => BrowserWindow | null;
  let wedgeDetector: WedgeDetector;

  beforeEach(async () => {
    vi.useFakeTimers();
    player = new Player();
    mockWin = {
      webContents: {
        send: vi.fn(),
      },
    };
    getMainWindow = () => mockWin as unknown as BrowserWindow;

    wedgeDetector = await loadWedgeDetector();
    const ctx: IntegrationContext = { player, getMainWindow };
    wedgeDetector.init(ctx);
  });

  afterEach(() => {
    wedgeDetector.reset();
    vi.useRealTimers();
  });

  it('fires skip after STALL_THRESHOLD_MS of stalled playback', () => {
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });

    // The stall threshold is 5000ms and the check runs on a 1000ms interval, so
    // the first check that can see the stall lands at 6000ms.
    vi.advanceTimersByTime(6000);

    expect(mockWin.webContents.send).toHaveBeenCalledWith(
      'player:next'
    );
  });

  it('does not fire skip before stall threshold', () => {
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });

    // Advance less than the stall threshold
    vi.advanceTimersByTime(4000);

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  it('does not fire skip when position advances', () => {
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });

    // Simulate position advancing every second
    for (let i = 1; i <= 8; i++) {
      vi.advanceTimersByTime(1000);
      player.handlePlaybackTimeDidChange(i * 1000);
    }

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  it('respects MAX_SKIP_ATTEMPTS (3)', () => {
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });

    // Each skip resets lastAdvanceTime, so the stall has to build up again and
    // every attempt costs another 6000ms.
    vi.advanceTimersByTime(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(3);

    // The cap is what stops a queue that will not play being skipped end to end.
    vi.advanceTimersByTime(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(3);
  });

  it('reset() clears state and stops timer', () => {
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });

    // Advance a bit but not past threshold
    vi.advanceTimersByTime(3000);

    wedgeDetector.reset();

    // Advance well past threshold - should not fire because reset stopped timer
    vi.advanceTimersByTime(10000);

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  it('track change resets skip counter', () => {
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });

    vi.advanceTimersByTime(6000);
    vi.advanceTimersByTime(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(2);

    // A new track is a fresh recovery budget: the cap bounds the attempts spent
    // on one track, not on the session.
    player.handleNowPlayingItemDidChange({ name: 'New Track', durationInMillis: 180000 });

    vi.advanceTimersByTime(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(3);

    vi.advanceTimersByTime(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(4);
  });

  it('does not fire skip when playback is paused', () => {
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });
    vi.advanceTimersByTime(2000);

    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Paused });

    vi.advanceTimersByTime(10000);

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  it('does not fire skip near end of track (within END_SAFETY_MARGIN_MS)', () => {
    player.handleNowPlayingItemDidChange({ name: 'Track', durationInMillis: 200000 });
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });

    // A track about to finish reports the same still playhead as a stall, so the
    // last END_SAFETY_MARGIN_MS of it are out of scope. The detector compares
    // durationMs against the position in microseconds: with a 200s track and a
    // 10s margin, anything past 190,000,000 is inside it.
    player.handlePlaybackTimeDidChange(191000000);

    vi.advanceTimersByTime(10000);

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  it('requires getMainWindow in context', () => {
    const playerOnly: IntegrationContext = { player: new Player() };
    expect(() => wedgeDetector.init(playerOnly)).toThrow('wedgeDetector requires getMainWindow');
  });

  it('ignores a second init so each listener is attached once', () => {
    // Asserted on the emitter rather than through behaviour. The visible
    // symptoms of a duplicate init are masked: startTimer() returns early when
    // a timer already exists, and the duplicated writes to lastAdvanceTime and
    // skipAttempts are idempotent. Counting registrations is what actually
    // distinguishes one init from two.
    const events = [
      'playbackStateDidChange',
      'nowPlayingItemDidChange',
      'playbackTimeDidChange',
    ] as const;
    const before = events.map(event => player.listenerCount(event));

    wedgeDetector.init({ player, getMainWindow });

    expect(events.map(event => player.listenerCount(event))).toEqual(before);
    expect(before.every(count => count === 1)).toBe(true);
  });
});
