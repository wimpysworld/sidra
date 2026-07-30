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
  musicKitThrowsAtInjection = false,
  navigatorOverrides,
  repeatInjection = false,
}: {
  musicKitOverrides?: Record<string, unknown>;
  musicKitThrowsAtInjection?: boolean;
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

  // MusicKit can be present but mid-initialisation when the script is injected,
  // so getInstance() throws until it settles. Clearing the flag after the
  // injection run models it settling before the 500ms poll first fires.
  let getInstanceThrows = musicKitThrowsAtInjection;
  const musicKitApi = {
    getInstance: () => {
      if (getInstanceThrows) throw new Error('MusicKit is re-initialising');
      return musicKit;
    },
    PlaybackStates: { playing: 2 },
  };
  if (musicKitThrowsAtInjection) {
    Object.assign(context, { MusicKit: musicKitApi });
    Object.assign(window, { MusicKit: musicKitApi });
  }

  vm.runInContext(hookScript, context);
  if (repeatInjection) vm.runInContext(hookScript, context);

  getInstanceThrows = false;
  Object.assign(context, { MusicKit: musicKitApi });
  Object.assign(window, { MusicKit: musicKitApi });
  for (const callback of intervalCallbacks.slice()) callback();

  return {
    mediaSession,
    messageListeners,
    musicKit,
    musicKitListeners,
    navigator,
    // Runs the script again against the same window, then drains only the
    // timers that second run added. The message listener is installed inside
    // the waitForMK callback rather than the script body, so a re-run that
    // slipped past the injection guard would go unnoticed without the drain.
    reinject: () => {
      const alreadyRun = intervalCallbacks.length;
      vm.runInContext(hookScript, context);
      for (const callback of intervalCallbacks.slice(alreadyRun)) callback();
    },
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

  it('does not throw when MusicKit.getInstance() throws during injection', () => {
    expect(() => createHarness({ musicKitThrowsAtInjection: true })).not.toThrow();
  });

  it('still hooks MusicKit after a getInstance() that threw during injection', () => {
    const { musicKitListeners } = createHarness({ musicKitThrowsAtInjection: true });

    expect(musicKitListeners.has('playbackStateDidChange')).toBe(true);
  });

  it('installs no second message listener when the script is injected again', () => {
    const { messageListeners, reinject } = createHarness();

    expect(messageListeners).toHaveLength(1);

    reinject();

    expect(messageListeners).toHaveLength(1);
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
    'clears media session position state when duration is %s',
    (currentPlaybackDuration) => {
      const { mediaSession, musicKitListeners } = createHarness({
        musicKitOverrides: {
          currentPlaybackDuration,
          currentPlaybackTime: 42,
        },
      });

      expect(() => musicKitListeners.get('playbackTimeDidChange')?.()).not.toThrow();

      expect(mediaSession.setPositionState).toHaveBeenCalledWith();
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

  it('reports the item duration in seconds when the playback duration is unavailable', () => {
    const { mediaSession, musicKitListeners } = createHarness({
      musicKitOverrides: {
        currentPlaybackDuration: undefined,
        currentPlaybackTime: 42,
        nowPlayingItem: { attributes: { durationInMillis: 180_000 } },
      },
    });

    expect(() => musicKitListeners.get('playbackTimeDidChange')?.()).not.toThrow();

    expect(mediaSession.setPositionState).toHaveBeenCalledWith({
      duration: 180,
      playbackRate: 1,
      position: 42,
    });
  });

  it('prefers the playback duration over the item duration when both are usable', () => {
    const { mediaSession, musicKitListeners } = createHarness({
      musicKitOverrides: {
        currentPlaybackDuration: 180,
        currentPlaybackTime: 42,
        nowPlayingItem: { attributes: { durationInMillis: 999_000 } },
      },
    });

    expect(() => musicKitListeners.get('playbackTimeDidChange')?.()).not.toThrow();

    expect(mediaSession.setPositionState).toHaveBeenCalledWith({
      duration: 180,
      playbackRate: 1,
      position: 42,
    });
  });

  it('clamps a position that runs past the duration', () => {
    const { mediaSession, musicKitListeners } = createHarness({
      musicKitOverrides: {
        currentPlaybackDuration: 180,
        currentPlaybackTime: 200,
      },
    });

    expect(() => musicKitListeners.get('playbackTimeDidChange')?.()).not.toThrow();

    expect(mediaSession.setPositionState).toHaveBeenCalledWith({
      duration: 180,
      playbackRate: 1,
      position: 180,
    });
  });

  it('clears media session position state rather than reporting a negative position', () => {
    const { mediaSession, musicKitListeners } = createHarness({
      musicKitOverrides: {
        currentPlaybackDuration: 180,
        currentPlaybackTime: -5,
      },
    });

    expect(() => musicKitListeners.get('playbackTimeDidChange')?.()).not.toThrow();

    expect(mediaSession.setPositionState).toHaveBeenCalledWith();
    expect(mediaSession.setPositionState).not.toHaveBeenCalledWith(
      expect.objectContaining({ position: -5 }),
    );
  });

  it('clears media session position state for a radio stream with no duration', () => {
    const { mediaSession, musicKitListeners } = createHarness({
      musicKitOverrides: {
        currentPlaybackDuration: Number.POSITIVE_INFINITY,
        currentPlaybackTime: 42,
        nowPlayingItem: { attributes: {} },
      },
    });

    expect(() => musicKitListeners.get('playbackTimeDidChange')?.()).not.toThrow();

    expect(mediaSession.setPositionState).toHaveBeenCalledWith();
  });
});
