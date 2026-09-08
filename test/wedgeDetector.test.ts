import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserWindow } from 'electron';
import type electronLog from 'electron-log/main';

import { Player, PlaybackState } from '../src/player';
import type { IntegrationContext } from '../src/player';

type WedgeDetector = typeof import('../src/wedgeDetector');
type ScopedLog = ReturnType<typeof electronLog.scope>;

// init() refuses repeat calls and keeps module-level state, so each test needs a fresh module.
async function loadWedgeDetector(): Promise<WedgeDetector> {
  vi.resetModules();
  return import('../src/wedgeDetector');
}

describe('wedgeDetector', () => {
  let player: Player;
  let mockWin: {
    isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
    webContents: { send: ReturnType<typeof vi.fn>; isDestroyed: ReturnType<typeof vi.fn<() => boolean>> };
  };
  let mainWindow: BrowserWindow | null;
  let getMainWindow: () => BrowserWindow | null;
  let wedgeDetector: WedgeDetector;
  let wedgeLog: ScopedLog;

  beforeEach(async () => {
    vi.useFakeTimers();
    player = new Player();
    mockWin = {
      isDestroyed: vi.fn(() => false),
      webContents: {
        send: vi.fn(),
        isDestroyed: vi.fn(() => false),
      },
    };
    mainWindow = mockWin as unknown as BrowserWindow;
    getMainWindow = () => mainWindow;

    wedgeDetector = await loadWedgeDetector();
    wedgeLog = (await import('electron-log/main')).default.scope('wedge');
    const ctx: IntegrationContext = { player, getMainWindow };
    wedgeDetector.init(ctx);
    vi.clearAllMocks();
  });

  afterEach(() => {
    wedgeDetector.reset();
    vi.useRealTimers();
  });

  it('fires skip after STALL_THRESHOLD_MS of stalled playback', () => {
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });

    // The check runs on a 1000ms interval and proceeds once the elapsed time is
    // no longer below the 5000ms threshold, so the 5000ms tick fires the skip.
    // Advance past it to keep the test off the boundary.
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

  it('logs sent command provenance when stalled playback is skipped', () => {
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });

    vi.advanceTimersByTime(6000);

    expect(wedgeLog.warn).toHaveBeenCalledWith(
      'source=wedge channel=player:next reason=playback-stalled attempt=1/3 result=sent',
    );
  });

  it('logs dropped command provenance when the main window is missing', () => {
    mainWindow = null;
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });

    vi.advanceTimersByTime(6000);

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
    expect(wedgeLog.warn).toHaveBeenCalledWith(
      'source=wedge channel=player:next reason=playback-stalled attempt=1/3 result=dropped',
    );
  });

  it('does not fire skip when position advances', () => {
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });

    for (let i = 1; i <= 8; i++) {
      vi.advanceTimersByTime(1000);
      player.handlePlaybackTimeDidChange(i * 1000);
    }

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  it('respects MAX_SKIP_ATTEMPTS (3)', () => {
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });

    // Each skip resets lastAdvanceTime, so the next attempt needs another full stall interval.
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

    // Keep the timer active without reaching the stall threshold.
    vi.advanceTimersByTime(3000);

    wedgeDetector.reset();

    // reset() stops the timer, so elapsed time alone cannot trigger another skip.
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
    // Count registrations because timer reuse and idempotent state writes hide duplicate listeners from playback assertions.
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
