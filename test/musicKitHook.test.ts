import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const hookScript = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'musicKitHook.js'),
  'utf-8',
);

/** An event target in a composed path, carrying the classes given. */
function element(classes: string) {
  const tokens = classes.split(' ');
  return { classList: { contains: (token: string) => tokens.includes(token) } };
}

/**
 * A composed path built from the outermost-first class lists, ordered as the
 * DOM delivers it and terminated by the window, which carries no classList.
 */
function composedPath(...classes: string[]) {
  return [...classes.map(element), {}];
}

// The two services differ in the element that carries the chrome-volume token:
// a div on music.apple.com, an amp-chrome-volume element on classical.
const MUSIC_VOLUME_PATH = composedPath(
  'chrome-volume__slider', 'chrome-volume', 'chrome-player',
);
const CLASSICAL_VOLUME_PATH = composedPath(
  'chrome-volume__indicator', 'amp-volume-control', 'chrome-volume',
  'chrome-player__volume',
);
const NON_VOLUME_PATH = composedPath('chrome-player__button', 'chrome-player');

/** A MusicKit stand-in, optionally with a volume getter that throws. */
function createMusicKit(
  overrides: Record<string, unknown> = {},
  volumeThrows = false,
) {
  const instance = {
    addEventListener: vi.fn((_event: string, _listener: (...args: unknown[]) => void) => {}),
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
    ...overrides,
  };
  if (volumeThrows) {
    // Models a getter throwing while MusicKit re-initialises. This is the read
    // that sits above the marker assignment in the original code.
    Object.defineProperty(instance, 'volume', {
      get() { throw new Error('volume unavailable during re-initialisation'); },
      configurable: true,
    });
  }
  return instance;
}

function createHarness({
  bridgeMissing = false,
  musicKitOverrides = {},
  musicKitThrowsAtInjection = false,
  navigatorOverrides,
  repeatInjection = false,
  volumeThrows = false,
}: {
  bridgeMissing?: boolean;
  musicKitOverrides?: Record<string, unknown>;
  musicKitThrowsAtInjection?: boolean;
  navigatorOverrides?: Record<string, unknown>;
  repeatInjection?: boolean;
  volumeThrows?: boolean;
} = {}) {
  const intervals: Array<{ callback: () => void; delay: number }> = [];
  const intervalCallbacks: Array<() => void> = [];
  const messageListeners: Array<(event: unknown) => void> = [];
  const wheelListeners: Array<{
    listener: (event: unknown) => void;
    options: unknown;
  }> = [];
  const musicKitListeners = new Map<string, (...args: unknown[]) => void>();
  const mediaSession = { setPositionState: vi.fn() };
  const navigator = navigatorOverrides ?? { mediaSession };
  const musicKit = createMusicKit(musicKitOverrides, volumeThrows);
  musicKit.addEventListener.mockImplementation(
    (event: string, listener: (...args: unknown[]) => void) => {
      musicKitListeners.set(event, listener);
    },
  );
  // AMWrapper is optional because bridgeMissing models the preload bridge not
  // being installed, which is one of the ways the attach used to throw.
  interface HarnessWindow {
    AMWrapper?: { ipcRenderer: { send: ReturnType<typeof vi.fn> } };
    addEventListener: ReturnType<typeof vi.fn>;
    navigator: unknown;
    __sidraHookedMk?: unknown;
    __sidra?: Record<string, (...args: unknown[]) => unknown>;
  }
  const window: HarnessWindow = {
    addEventListener: vi.fn((
      event: string,
      listener: (event: unknown) => void,
      options?: unknown,
    ) => {
      if (event === 'message') messageListeners.push(listener);
      if (event === 'wheel') wheelListeners.push({ listener, options });
    }),
    navigator,
  };
  if (!bridgeMissing) {
    window.AMWrapper = { ipcRenderer: { send: vi.fn() } };
  }
  const context = vm.createContext({
    clearInterval: vi.fn(),
    console,
    navigator,
    setInterval: vi.fn((callback: () => void, delay: number) => {
      intervals.push({ callback, delay });
      intervalCallbacks.push(callback);
      return intervalCallbacks.length;
    }),
    window,
  });

  // MusicKit can be present but mid-initialisation when the script is injected,
  // so getInstance() throws until it settles. Clearing the flag after the
  // injection run models it settling before the 500ms poll first fires.
  let getInstanceThrows = musicKitThrowsAtInjection;
  // Held in a variable so replaceInstance() can swap what getInstance() hands
  // back, which is what the 5-second monitor watches for.
  let liveInstance = musicKit;
  const musicKitApi = {
    getInstance: () => {
      if (getInstanceThrows) throw new Error('MusicKit is re-initialising');
      return liveInstance;
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
    // Non-optional handle on the bridge send mock. window.AMWrapper is optional
    // so bridgeMissing can drop it, and every assertion on IPC traffic comes
    // from a harness that has one.
    get bridgeSend() {
      if (!window.AMWrapper) throw new Error('this harness was built without an AMWrapper bridge');
      return window.AMWrapper.ipcRenderer.send;
    },
    // Sends one wheel event to every registered listener and hands the event
    // back, so a test can read the preventDefault mock off it.
    dispatchWheel: (
      { ctrlKey = false, deltaY, path }:
        { ctrlKey?: boolean; deltaY: number; path: unknown[] },
    ) => {
      const event = {
        composedPath: () => path,
        ctrlKey,
        deltaY,
        preventDefault: vi.fn(),
      };
      for (const { listener } of wheelListeners) listener(event);
      return event;
    },
    mediaSession,
    messageListeners,
    musicKit,
    musicKitListeners,
    navigator,
    // Swaps the singleton MusicKit.getInstance() returns, as Apple Music does
    // when it rebuilds the player, and hands back the replacement.
    replaceInstance: () => {
      const replacement = createMusicKit(musicKitOverrides, volumeThrows);
      liveInstance = replacement;
      return replacement;
    },
    // Fires only the 5-second instance monitor. The 250ms volume poll and the
    // 500ms waitForMK share the same mock, so they are filtered out by delay.
    runMonitorCycles: (count: number) => {
      const monitors = intervals.filter(({ delay }) => delay === 5000);
      for (let cycle = 0; cycle < count; cycle++) {
        for (const { callback } of monitors) callback();
      }
    },
    // Runs the script again against the same window, then drains only the
    // timers that second run added. The message listener is installed inside
    // the waitForMK callback rather than the script body, so a re-run that
    // slipped past the injection guard would go unnoticed without the drain.
    reinject: () => {
      const alreadyRun = intervalCallbacks.length;
      vm.runInContext(hookScript, context);
      for (const callback of intervalCallbacks.slice(alreadyRun)) callback();
    },
    wheelListeners,
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

  // The 5-second monitor re-attaches whenever __sidraHookedMk does not match
  // the live instance. The marker used to be assigned last, so anything that
  // threw inside attachToInstance left it stale and every cycle added another
  // full set of listeners: the #153 / #154 failure, reached by a different
  // route. These three pin the marker being claimed first.
  it('attaches each MusicKit listener once when the IPC bridge is missing', () => {
    const { musicKit, runMonitorCycles } = createHarness({ bridgeMissing: true });

    const afterInjection = musicKit.addEventListener.mock.calls.length;
    runMonitorCycles(3);

    expect(musicKit.addEventListener.mock.calls.length).toBe(afterInjection);
  });

  it('attaches each MusicKit listener once when a volume read throws', () => {
    const { musicKit, runMonitorCycles } = createHarness({ volumeThrows: true });

    const afterInjection = musicKit.addEventListener.mock.calls.length;
    runMonitorCycles(3);

    expect(musicKit.addEventListener.mock.calls.length).toBe(afterInjection);
  });

  it('marks the instance as hooked even when the attach throws part way', () => {
    const { musicKit, window } = createHarness({ volumeThrows: true });

    expect(window.__sidraHookedMk).toBe(musicKit);
  });

  it('drops a player command quietly when the initial attach threw', () => {
    // attachSafely() contains the failure and installs the message listener
    // anyway, so the listener is live with no window.__sidra behind it. An
    // unguarded index on undefined throws a TypeError out of the listener.
    const { messageListeners, window } = createHarness({ volumeThrows: true });

    expect(window.__sidra).toBeUndefined();

    const event = {
      data: { type: 'sidra:command', channel: 'player:next', args: [] },
      source: window,
    };

    expect(() => {
      for (const listener of messageListeners) listener(event);
    }).not.toThrow();
  });

  it('re-attaches once when MusicKit replaces its instance', () => {
    const { musicKit, replaceInstance, runMonitorCycles } = createHarness();

    const before = musicKit.addEventListener.mock.calls.length;
    const replacement = replaceInstance();
    runMonitorCycles(3);

    // The replacement takes one full set of listeners, and the old instance
    // gains none. Three further cycles add nothing, because the marker matches.
    expect(replacement.addEventListener.mock.calls.length).toBe(before);
    expect(musicKit.addEventListener.mock.calls.length).toBe(before);
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

  it('still forwards playback events over IPC when navigator.mediaSession is unavailable', () => {
    // Position state is a bonus for OS media controls; the IPC forwarding is
    // the hook's actual job. A guard that swallowed the whole listener would
    // leave MPRIS and every integration blind, so assert the sends, not that
    // the listener merely survived.
    const { bridgeSend, musicKitListeners } = createHarness({
      navigatorOverrides: {},
      musicKitOverrides: {
        currentPlaybackDuration: 180,
        currentPlaybackTime: 42,
      },
    });

    musicKitListeners.get('playbackTimeDidChange')?.();
    musicKitListeners.get('nowPlayingItemDidChange')?.({ item: null });

    expect(bridgeSend).toHaveBeenCalledWith(
      'playbackTimeDidChange',
      42 * 1_000_000,
    );
    expect(bridgeSend).toHaveBeenCalledWith(
      'nowPlayingItemDidChange',
      null,
    );
  });

  it('still forwards playback events over IPC when setPositionState is missing', () => {
    // Safari exposes navigator.mediaSession without setPositionState, which is
    // the arm the object-presence check alone would let through. Both calls sit
    // in a try/catch, so an unguarded call would not surface as a throw - the
    // IPC sends are the only observable proof the listeners ran to completion.
    const { bridgeSend, musicKitListeners } = createHarness({
      navigatorOverrides: { mediaSession: {} },
      musicKitOverrides: {
        currentPlaybackDuration: 180,
        currentPlaybackTime: 42,
      },
    });

    musicKitListeners.get('playbackTimeDidChange')?.();
    musicKitListeners.get('nowPlayingItemDidChange')?.({ item: null });

    expect(bridgeSend).toHaveBeenCalledWith(
      'playbackTimeDidChange',
      42 * 1_000_000,
    );
    expect(bridgeSend).toHaveBeenCalledWith(
      'nowPlayingItemDidChange',
      null,
    );
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

  it('forwards a MusicKit volume change over the volumeDidChange IPC channel', () => {
    // The attach-time send already carries the mock's initial volume of 1, so
    // a listener bound to an event MusicKit never fires would still leave a
    // ('volumeDidChange', 1) call behind. Moving the volume first is what makes
    // the assertion prove the listener ran.
    const { bridgeSend, musicKit, musicKitListeners } = createHarness();

    musicKit.volume = 0.42;
    musicKitListeners.get('playbackVolumeDidChange')?.();

    expect(bridgeSend).toHaveBeenCalledWith('volumeDidChange', 0.42);
  });

  it.each([
    ['music', MUSIC_VOLUME_PATH],
    ['classical', CLASSICAL_VOLUME_PATH],
  ])('lowers the volume a step when the wheel turns down over the %s volume control', (
    _service,
    path,
  ) => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.5 },
    });

    const event = dispatchWheel({ deltaY: 100, path });

    expect(musicKit.volume).toBe(0.45);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('raises the volume a step when the wheel turns up over the volume control', () => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.5 },
    });

    dispatchWheel({ deltaY: -100, path: MUSIC_VOLUME_PATH });

    expect(musicKit.volume).toBe(0.55);
  });

  it('leaves the volume and the page scroll alone away from the volume control', () => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.5 },
    });

    const event = dispatchWheel({ deltaY: 100, path: NON_VOLUME_PATH });

    expect(musicKit.volume).toBe(0.5);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('leaves a Ctrl+wheel zoom over the volume control alone', () => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.5 },
    });

    const event = dispatchWheel({ ctrlKey: true, deltaY: 100, path: MUSIC_VOLUME_PATH });

    expect(musicKit.volume).toBe(0.5);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('clamps the volume at 0 when the wheel turns down past silence', () => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.02 },
    });

    dispatchWheel({ deltaY: 100, path: MUSIC_VOLUME_PATH });

    expect(musicKit.volume).toBe(0);
  });

  it('clamps the volume at 1 when the wheel turns up past full', () => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.98 },
    });

    dispatchWheel({ deltaY: -100, path: MUSIC_VOLUME_PATH });

    expect(musicKit.volume).toBe(1);
  });

  it('rounds away the binary floating point artefact of a step', () => {
    // 0.7 - 0.05 is 0.6499999999999999, which a volume readout would show as
    // 64% and MPRIS would report unrounded.
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.7 },
    });

    dispatchWheel({ deltaY: 100, path: MUSIC_VOLUME_PATH });

    expect(musicKit.volume).toBe(0.65);
  });

  it('accumulates two half-notch wheel events into one volume step', () => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.5 },
    });

    dispatchWheel({ deltaY: 50, path: MUSIC_VOLUME_PATH });

    expect(musicKit.volume).toBe(0.5);

    dispatchWheel({ deltaY: 50, path: MUSIC_VOLUME_PATH });

    expect(musicKit.volume).toBe(0.45);
  });

  it('steps immediately when the wheel direction reverses mid-accumulation', () => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.5 },
    });

    dispatchWheel({ deltaY: -50, path: MUSIC_VOLUME_PATH });
    dispatchWheel({ deltaY: 100, path: MUSIC_VOLUME_PATH });

    expect(musicKit.volume).toBe(0.45);
  });

  it('registers the wheel listener as non-passive so preventDefault works', () => {
    const { wheelListeners } = createHarness();

    expect(wheelListeners).toHaveLength(1);
    expect(wheelListeners[0].options).toEqual({ passive: false });
  });

  it('installs no second wheel listener when the script is injected again', () => {
    const { reinject, wheelListeners } = createHarness();

    reinject();

    expect(wheelListeners).toHaveLength(1);
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
