import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const hookScript = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'musicKitHook.js'),
  'utf-8',
);

function createHarness({
  musicKitOverrides = {},
  navigatorOverrides,
  repeatInjection = false,
}: {
  musicKitOverrides?: Record<string, unknown>;
  navigatorOverrides?: Record<string, unknown>;
  repeatInjection?: boolean;
} = {}) {
  const intervalCallbacks: Array<() => void> = [];
  const messageListeners: Array<(event: unknown) => void> = [];
  const musicKitListeners = new Map<string, (...args: unknown[]) => void>();
  const mediaSession = { setPositionState: vi.fn() };
  const navigator = navigatorOverrides ?? { mediaSession };
  const musicKit = {
    addEventListener: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      musicKitListeners.set(event, listener);
    }),
    currentPlaybackDuration: undefined,
    currentPlaybackTime: 0,
    isPlaying: true,
    nowPlayingItem: undefined,
    pause: vi.fn(),
    play: vi.fn(),
    queue: { length: 1 },
    repeatMode: 0,
    seekToTime: vi.fn(),
    setVolume: vi.fn(),
    shuffleMode: 0,
    skipToNextItem: vi.fn(),
    skipToPreviousItem: vi.fn(),
    volume: 1,
    ...musicKitOverrides,
  };
  const window = {
    AMWrapper: { ipcRenderer: { send: vi.fn() } },
    addEventListener: vi.fn((event: string, listener: (event: unknown) => void) => {
      if (event === 'message') messageListeners.push(listener);
    }),
    navigator,
  };
  const context = vm.createContext({
    clearInterval: vi.fn(),
    console,
    navigator,
    setInterval: vi.fn((callback: () => void) => {
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    }),
    window,
  });

  vm.runInContext(hookScript, context);
  if (repeatInjection) vm.runInContext(hookScript, context);

  const musicKitApi = {
    getInstance: () => musicKit,
    PlaybackStates: { playing: 2 },
  };
  Object.assign(context, { MusicKit: musicKitApi });
  Object.assign(window, { MusicKit: musicKitApi });
  for (const callback of intervalCallbacks.slice()) callback();

  return {
    mediaSession,
    messageListeners,
    musicKit,
    musicKitListeners,
    navigator,
    window,
  };
}

describe('musicKitHook', () => {
  it('handles one player command after repeated injection before MusicKit loads', () => {
    const skipToNextItem = vi.fn();
    const { messageListeners, musicKit, window } = createHarness({
      musicKitOverrides: { skipToNextItem },
      repeatInjection: true,
    });

    const event = {
      data: { type: 'sidra:command', channel: 'player:next', args: [] },
      source: window,
    };
    for (const listener of messageListeners) listener(event);

    expect(skipToNextItem).toHaveBeenCalledTimes(1);
  });

  it('reports explicit media session position state on playback time changes', () => {
    const { mediaSession, musicKitListeners } = createHarness({
      musicKitOverrides: {
        currentPlaybackDuration: 180,
        currentPlaybackTime: 42,
      },
    });

    expect(() => musicKitListeners.get('playbackTimeDidChange')?.()).not.toThrow();

    expect(mediaSession.setPositionState).toHaveBeenCalledWith({
      duration: 180,
      playbackRate: 1,
      position: 42,
    });
  });

  it('clears media session position state when the now-playing item becomes null', () => {
    const { mediaSession, musicKitListeners } = createHarness();

    expect(() => musicKitListeners.get('nowPlayingItemDidChange')?.({ item: null })).not.toThrow();

    expect(mediaSession.setPositionState).toHaveBeenCalledWith();
  });

  it.each([0, undefined])(
    'does not report media session position state when duration is %s',
    (currentPlaybackDuration) => {
      const { mediaSession, musicKitListeners } = createHarness({
        musicKitOverrides: {
          currentPlaybackDuration,
          currentPlaybackTime: 42,
        },
      });

      expect(() => musicKitListeners.get('playbackTimeDidChange')?.()).not.toThrow();

      expect(mediaSession.setPositionState).not.toHaveBeenCalled();
    },
  );

  it('does nothing when navigator.mediaSession is unavailable', () => {
    const { musicKitListeners } = createHarness({
      navigatorOverrides: {},
      musicKitOverrides: {
        currentPlaybackDuration: 180,
        currentPlaybackTime: 42,
      },
    });

    expect(() => musicKitListeners.get('playbackTimeDidChange')?.()).not.toThrow();
    expect(() => musicKitListeners.get('nowPlayingItemDidChange')?.({ item: null })).not.toThrow();
  });
});
