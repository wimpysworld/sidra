import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const hookScript = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'musicKitHook.js'),
  'utf-8',
);

/** A listener registration made on a fake element. */
interface Registration {
  type: string;
  listener: (event: unknown) => void;
  options?: unknown;
}

/**
 * An element in a fake ancestor chain. It carries only what the hook uses:
 * class tokens, addEventListener/removeEventListener, and closest(), which is
 * how the hook finds the volume control from the pointer's target.
 */
interface FakeElement {
  tokens: string[];
  parent: FakeElement | null;
  registrations: Registration[];
  classList: { contains(token: string): boolean };
  addEventListener(type: string, listener: (event: unknown) => void, options?: unknown): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  closest(selector: string): FakeElement | null;
}

function element(classes: string, parent: FakeElement | null): FakeElement {
  const tokens = classes.split(' ');
  const node: FakeElement = {
    tokens,
    parent,
    registrations: [],
    classList: { contains: (token: string) => tokens.includes(token) },
    addEventListener(type, listener, options) {
      node.registrations.push({ type, listener, options });
    },
    removeEventListener(type, listener) {
      const index = node.registrations.findIndex(
        (entry) => entry.type === type && entry.listener === listener,
      );
      if (index !== -1) node.registrations.splice(index, 1);
    },
    // Only class selectors are supported, which is all the hook asks for.
    closest(selector) {
      const wanted = selector.replace(/^\./, '');
      for (let current: FakeElement | null = node; current; current = current.parent) {
        if (current.tokens.includes(wanted)) return current;
      }
      return null;
    },
  };
  return node;
}

/**
 * Builds an ancestor chain from the outermost-first class lists and hands back
 * the innermost element, which is what a pointer or wheel event targets.
 */
function chain(outermost: string, ...rest: string[]): FakeElement {
  let node = element(outermost, null);
  for (const entry of rest) node = element(entry, node);
  return node;
}

/** The volume control in a chain, for a test that asserts against it directly. */
function volumeControl(target: FakeElement): FakeElement {
  const control = target.closest('.chrome-volume');
  if (!control) throw new Error('this chain carries no chrome-volume element');
  return control;
}

/** Every wheel registration on a chain, innermost first, as bubbling sees them. */
function wheelRegistrations(target: FakeElement): Registration[] {
  const found: Registration[] = [];
  for (let node: FakeElement | null = target; node; node = node.parent) {
    found.push(...node.registrations.filter((entry) => entry.type === 'wheel'));
  }
  return found;
}

// The two services differ in the element that carries the chrome-volume token:
// a div on music.apple.com, an amp-chrome-volume element on classical.
const musicVolumeTarget = () => chain(
  'chrome-player', 'chrome-volume', 'chrome-volume__slider',
);
const classicalVolumeTarget = () => chain(
  'chrome-player__volume', 'chrome-volume', 'amp-volume-control',
  'chrome-volume__indicator',
);
const nonVolumeTarget = () => chain('chrome-player', 'chrome-player__button');

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
    // Models a getter throwing while MusicKit re-initialises. The eager volume
    // read inside attachToInstance() is the most likely thrower, so this drives
    // the part-attached path the marker and attachSafely() exist to contain.
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
  const pointerOverListeners: Array<(event: unknown) => void> = [];
  // Registrations the hook made on window. The wheel listener must never appear
  // here: see the non-fast-scrollable region note in the hook. A registration on
  // document is caught differently - document is not in the vm context, so
  // reaching for it throws where the hook runs.
  const globalRegistrations: Registration[] = [];
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
      globalRegistrations.push({ type: event, listener, options });
      if (event === 'message') messageListeners.push(listener);
      if (event === 'pointerover') pointerOverListeners.push(listener);
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
    // Moves the pointer onto `target`, as the browser does before any wheel
    // event reaches it. This is what resolves the hook's lazy binding.
    hoverOver: (target: FakeElement) => {
      for (const listener of pointerOverListeners) listener({ target });
    },
    // Moves the pointer onto `target`, then sends one wheel event up its
    // ancestor chain, as bubbling delivers it. The event is handed back so a
    // test can read the preventDefault mock off it.
    dispatchWheel: (
      { ctrlKey = false, deltaY, target }:
        { ctrlKey?: boolean; deltaY: number; target: FakeElement },
    ) => {
      for (const listener of pointerOverListeners) listener({ target });
      const event = { ctrlKey, deltaY, preventDefault: vi.fn(), target };
      for (const { listener } of wheelRegistrations(target)) listener(event);
      return event;
    },
    globalRegistrations,
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
    pointerOverListeners,
    window,
  };
}

describe('musicKitHook', () => {
  it('handles one player command after repeated injection before MusicKit loads', () => {
    const skipToNextItem = vi.fn();
    const { messageListeners, window } = createHarness({
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
  // the live instance, so attachToInstance() must claim the marker as its first
  // statement. Claimed last, anything that throws in between leaves it stale and
  // every cycle adds another full set of MusicKit listeners. These three pin the
  // marker being claimed first.
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
    ['music', musicVolumeTarget],
    ['classical', classicalVolumeTarget],
  ])('lowers the volume a step when the wheel turns down over the %s volume control', (
    _service,
    makeTarget,
  ) => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.5 },
    });

    const event = dispatchWheel({ deltaY: 100, target: makeTarget() });

    expect(musicKit.volume).toBe(0.45);
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it('raises the volume a step when the wheel turns up over the volume control', () => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.5 },
    });

    dispatchWheel({ deltaY: -100, target: musicVolumeTarget() });

    expect(musicKit.volume).toBe(0.55);
  });

  it('leaves the volume and the page scroll alone away from the volume control', () => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.5 },
    });

    const event = dispatchWheel({ deltaY: 100, target: nonVolumeTarget() });

    expect(musicKit.volume).toBe(0.5);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('leaves a Ctrl+wheel zoom over the volume control alone', () => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.5 },
    });

    const event = dispatchWheel({ ctrlKey: true, deltaY: 100, target: musicVolumeTarget() });

    expect(musicKit.volume).toBe(0.5);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });

  it('clamps the volume at 0 when the wheel turns down past silence', () => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.02 },
    });

    dispatchWheel({ deltaY: 100, target: musicVolumeTarget() });

    expect(musicKit.volume).toBe(0);
  });

  it('clamps the volume at 1 when the wheel turns up past full', () => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.98 },
    });

    dispatchWheel({ deltaY: -100, target: musicVolumeTarget() });

    expect(musicKit.volume).toBe(1);
  });

  it('rounds away the binary floating point artefact of a step', () => {
    // 0.7 - 0.05 is 0.6499999999999999, which a volume readout would show as
    // 64% and MPRIS would report unrounded.
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.7 },
    });

    dispatchWheel({ deltaY: 100, target: musicVolumeTarget() });

    expect(musicKit.volume).toBe(0.65);
  });

  it('accumulates two half-notch wheel events into one volume step', () => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.5 },
    });
    const target = musicVolumeTarget();

    dispatchWheel({ deltaY: 50, target });

    expect(musicKit.volume).toBe(0.5);

    dispatchWheel({ deltaY: 50, target });

    expect(musicKit.volume).toBe(0.45);
  });

  it('steps immediately when the wheel direction reverses mid-accumulation', () => {
    const { dispatchWheel, musicKit } = createHarness({
      musicKitOverrides: { volume: 0.5 },
    });

    const target = musicVolumeTarget();

    dispatchWheel({ deltaY: -50, target });
    dispatchWheel({ deltaY: 100, target });

    expect(musicKit.volume).toBe(0.45);
  });

  // The listener has to be non-passive to call preventDefault, and that is
  // exactly why it must sit on the control. A non-passive wheel listener on
  // window or document marks the whole document a non-fast-scrollable region,
  // so Chromium stops scrolling on the compositor thread and every wheel tick
  // waits behind Apple Music's main thread. Nothing else in the suite notices
  // that, because the handler still behaves correctly while doing it.
  it('registers no wheel listener on window', () => {
    const { globalRegistrations } = createHarness();

    expect(globalRegistrations.filter((entry) => entry.type === 'wheel')).toEqual([]);
  });

  it('registers the wheel listener on the volume control, non-passive', () => {
    const { hoverOver } = createHarness();
    const target = musicVolumeTarget();

    hoverOver(target);

    const registrations = wheelRegistrations(target);
    expect(registrations).toHaveLength(1);
    expect(registrations[0].options).toEqual({ passive: false });
    // On the control itself, so the non-fast-scrollable region is its own box.
    expect(volumeControl(target).registrations).toHaveLength(1);
  });

  it('registers the pointerover listener as passive so scrolling is unaffected', () => {
    const { globalRegistrations } = createHarness();

    const pointerOver = globalRegistrations.filter((entry) => entry.type === 'pointerover');
    expect(pointerOver).toHaveLength(1);
    expect(pointerOver[0].options).toEqual({ passive: true });
  });

  it('binds nothing until the pointer reaches the control', () => {
    const { globalRegistrations } = createHarness();
    const target = musicVolumeTarget();

    expect(wheelRegistrations(target)).toEqual([]);
    expect(globalRegistrations.some((entry) => entry.type === 'pointerover')).toBe(true);
  });

  it('leaves the pointer over a non-volume element unbound', () => {
    const { hoverOver } = createHarness();
    const target = nonVolumeTarget();

    hoverOver(target);

    expect(wheelRegistrations(target)).toEqual([]);
  });

  it('binds once however often the pointer re-enters the same control', () => {
    const { hoverOver } = createHarness();
    const target = musicVolumeTarget();

    hoverOver(target);
    hoverOver(target);
    hoverOver(target);

    expect(wheelRegistrations(target)).toHaveLength(1);
  });

  // Apple Music replaces the player bar on navigation and on a service switch,
  // so the binding has to move rather than accumulate on dead elements.
  it('moves the listener to a replacement control and releases the old one', () => {
    const { hoverOver } = createHarness();
    const first = musicVolumeTarget();
    const second = musicVolumeTarget();

    hoverOver(first);
    hoverOver(second);

    expect(wheelRegistrations(first)).toEqual([]);
    expect(wheelRegistrations(second)).toHaveLength(1);
  });

  it('installs no second pointerover listener when the script is injected again', () => {
    const { reinject, pointerOverListeners } = createHarness();

    reinject();

    expect(pointerOverListeners).toHaveLength(1);
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
