import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { BrowserWindow } from 'electron';

import { Player, PlaybackState } from '../src/player';
import type { IntegrationContext } from '../src/player';
import * as wedgeDetector from '../src/wedgeDetector';

describe('wedgeDetector', () => {
  let player: Player;
  let mockWin: { webContents: { send: ReturnType<typeof vi.fn> } };
  let getMainWindow: () => BrowserWindow | null;

  beforeEach(() => {
    vi.useFakeTimers();
    player = new Player();
    mockWin = {
      webContents: {
        send: vi.fn(),
      },
    };
    getMainWindow = () => mockWin as unknown as BrowserWindow;

    const ctx: IntegrationContext = { player, getMainWindow };
    wedgeDetector.init(ctx);
  });

  afterEach(() => {
    wedgeDetector.reset();
    vi.useRealTimers();
  });

  it('fires skip after STALL_THRESHOLD_MS of stalled playback', () => {
    // Start playing
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });

    // Advance past the stall threshold (5000ms) plus one check interval (1000ms)
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

    // Each skip resets lastAdvanceTime, so we need 5s + check intervals per skip.
    // After each skip, the detector resets lastAdvanceTime = Date.now().
    // Skip 1
    vi.advanceTimersByTime(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(1);

    // Skip 2
    vi.advanceTimersByTime(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(2);

    // Skip 3
    vi.advanceTimersByTime(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(3);

    // Skip 4 should not happen - max reached
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

    // Trigger 2 skips
    vi.advanceTimersByTime(6000);
    vi.advanceTimersByTime(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(2);

    // Track changes - resets skip counter
    player.handleNowPlayingItemDidChange({ name: 'New Track', durationInMillis: 180000 });

    // Should be able to skip again (counter reset to 0)
    vi.advanceTimersByTime(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(3);

    // And again
    vi.advanceTimersByTime(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(4);
  });

  it('does not fire skip when playback is paused', () => {
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });
    vi.advanceTimersByTime(2000);

    // Pause
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Paused });

    vi.advanceTimersByTime(10000);

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  it('does not fire skip near end of track (within END_SAFETY_MARGIN_MS)', () => {
    // Set a track with known duration
    player.handleNowPlayingItemDidChange({ name: 'Track', durationInMillis: 200000 });
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });

    // Position near the end of the track (within 10s safety margin)
    // durationMs = 200000, END_SAFETY_MARGIN_MS = 10000
    // Condition: (durationMs - lastPositionUs / 1000) < END_SAFETY_MARGIN_MS
    // lastPositionUs is in microseconds based on variable name, but looking at the code
    // it receives the playbackTimeDidChange payload directly.
    // The check is: (200000 - payload / 1000) < 10000 => payload > 190000000
    player.handlePlaybackTimeDidChange(191000000);

    vi.advanceTimersByTime(10000);

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  it('requires getMainWindow in context', () => {
    const playerOnly: IntegrationContext = { player: new Player() };
    expect(() => wedgeDetector.init(playerOnly)).toThrow('wedgeDetector requires getMainWindow');
  });
});
