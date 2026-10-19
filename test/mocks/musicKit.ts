import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { vi } from "vitest";
import { allServices } from "../../src/musicService";

const hookScript = fs
  .readFileSync(
    path.join(__dirname, "..", "..", "assets", "musicKitHook.js"),
    "utf-8",
  )
  .replace("__SIDRA_DOCUMENT_GENERATION__", "1")
  .replace(
    "__SIDRA_SERVICE_HOSTS__",
    JSON.stringify(allServices().map((service) => service.host)),
  );

/** A listener registration made on a fake element. */
interface Registration {
  type: string;
  listener: (event: unknown) => void;
  options?: unknown;
}

/**
 * Model ancestor traversal and listener registration so the hook can find the volume control from a pointer target.
 */
interface FakeElement {
  tokens: string[];
  parent: FakeElement | null;
  registrations: Registration[];
  classList: { contains(token: string): boolean };
  addEventListener(
    type: string,
    listener: (event: unknown) => void,
    options?: unknown,
  ): void;
  removeEventListener(type: string, listener: (event: unknown) => void): void;
  closest(selector: string): FakeElement | null;
}

function element(classes: string, parent: FakeElement | null): FakeElement {
  const tokens = classes.split(" ");
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
      const wanted = selector.replace(/^\./, "");
      for (
        let current: FakeElement | null = node;
        current;
        current = current.parent
      ) {
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
export function volumeControl(target: FakeElement): FakeElement {
  const control = target.closest(".chrome-volume");
  if (!control) throw new Error("this chain carries no chrome-volume element");
  return control;
}

/** Every wheel registration on a chain, innermost first, as bubbling sees them. */
export function wheelRegistrations(target: FakeElement): Registration[] {
  const found: Registration[] = [];
  for (let node: FakeElement | null = target; node; node = node.parent) {
    found.push(...node.registrations.filter((entry) => entry.type === "wheel"));
  }
  return found;
}

// The two services differ in the element that carries the chrome-volume token:
// a div on music.apple.com, an amp-chrome-volume element on classical.
export const musicVolumeTarget = () =>
  chain("chrome-player", "chrome-volume", "chrome-volume__slider");
export const classicalVolumeTarget = () =>
  chain(
    "chrome-player__volume",
    "chrome-volume",
    "amp-volume-control",
    "chrome-volume__indicator",
  );
export const nonVolumeTarget = () => chain("chrome-player", "chrome-player__button");

/** A MusicKit stand-in, optionally with a volume getter that throws. */
function createMusicKit(
  overrides: Record<string, unknown> = {},
  volumeThrows = false,
) {
  const instance = {
    addEventListener: vi.fn(
      (_event: string, _listener: (...args: unknown[]) => void) => {},
    ),
    currentPlaybackDuration: undefined,
    currentPlaybackTime: 0,
    isPlaying: true,
    nowPlayingItem: undefined,
    pause: vi.fn(),
    changeToMediaAtIndex: vi.fn<(index: number) => Promise<void>>(() => Promise.resolve()),
    play: vi.fn(),
    queue: { length: 1 },
    repeatMode: 0,
    seekToTime: vi.fn(),
    setQueue: vi.fn(() => Promise.resolve()),
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
    Object.defineProperty(instance, "volume", {
      get() {
        throw new Error("volume unavailable during re-initialisation");
      },
      configurable: true,
    });
  }
  return instance;
}

export function createHarness({
  bridgeMissing = false,
  musicKitOverrides = {},
  musicKitThrowsAtFirstPoll = false,
  musicKitThrowsAtInjection = false,
  navigatorOverrides,
  repeatInjection = false,
  volumeThrows = false,
}: {
  bridgeMissing?: boolean;
  musicKitOverrides?: Record<string, unknown>;
  musicKitThrowsAtFirstPoll?: boolean;
  musicKitThrowsAtInjection?: boolean;
  navigatorOverrides?: Record<string, unknown>;
  repeatInjection?: boolean;
  volumeThrows?: boolean;
} = {}) {
  const intervals = new Map<number, { callback: () => void; delay: number }>();
  let nextIntervalId = 0;
  const timeouts = new Map<number, () => void>();
  let nextTimeoutId = 0;
  const messageListeners: Array<(event: unknown) => void> = [];
  const pointerOverListeners: Array<(event: unknown) => void> = [];
  // These are the registrations that assets/musicKitHook.js makes on window.
  // The wheel listener stays on the volume control to limit the non-fast-scrollable region.
  // A document registration throws because the VM context does not expose document.
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
  // bridgeMissing omits AMWrapper to exercise attachment without a preload bridge.
  interface HarnessWindow {
    AMWrapper?: { ipcRenderer: { send: ReturnType<typeof vi.fn> } };
    addEventListener: ReturnType<typeof vi.fn>;
    navigator: unknown;
    location: { hostname: string; origin: string };
    __sidraHookedMk?: unknown;
    __sidra?: Record<string, (...args: unknown[]) => unknown>;
  }
  const window: HarnessWindow = {
    addEventListener: vi.fn(
      (
        event: string,
        listener: (event: unknown) => void,
        options?: unknown,
      ) => {
        globalRegistrations.push({ type: event, listener, options });
        if (event === "message") messageListeners.push(listener);
        if (event === "pointerover") pointerOverListeners.push(listener);
      },
    ),
    navigator,
    location: {
      hostname: "music.apple.com",
      origin: "https://music.apple.com",
    },
  };
  if (!bridgeMissing) {
    window.AMWrapper = { ipcRenderer: { send: vi.fn() } };
  }
  const context = vm.createContext({
    URL,
    setTimeout: (callback: () => void) => {
      const id = ++nextTimeoutId;
      timeouts.set(id, callback);
      return id;
    },
    clearTimeout: (id: number) => {
      timeouts.delete(id);
    },
    clearInterval: (id: number) => {
      intervals.delete(id);
    },
    console,
    navigator,
    setInterval: vi.fn((callback: () => void, delay: number) => {
      const id = ++nextIntervalId;
      intervals.set(id, { callback, delay });
      return id;
    }),
    window,
  });

  // MusicKit can be present but mid-initialisation when the script is injected,
  // so getInstance() throws until it settles. Clearing the flag after the
  // injection run models it settling before the 500ms poll first fires, and
  // musicKitThrowsAtFirstPoll keeps it throwing through the first poll instead.
  let getInstanceThrows =
    musicKitThrowsAtInjection || musicKitThrowsAtFirstPoll;
  // Held in a variable so replaceInstance() can swap what getInstance() hands
  // back, which is what the 5-second monitor watches for.
  let liveInstance = musicKit;
  const musicKitApi = {
    getInstance: () => {
      if (getInstanceThrows) throw new Error("MusicKit is re-initialising");
      return liveInstance;
    },
    PlaybackStates: { playing: 2, paused: 3 },
  };
  if (musicKitThrowsAtInjection || musicKitThrowsAtFirstPoll) {
    Object.assign(context, { MusicKit: musicKitApi });
    Object.assign(window, { MusicKit: musicKitApi });
  }

  vm.runInContext(hookScript, context);
  if (repeatInjection) vm.runInContext(hookScript, context);

  // Fire the first 500ms poll while getInstance() still throws.
  // The hook must leave the poll running so a later poll can attach.
  if (musicKitThrowsAtFirstPoll) {
    for (const { callback } of [...intervals.values()]) callback();
  }

  getInstanceThrows = false;
  Object.assign(context, { MusicKit: musicKitApi });
  Object.assign(window, { MusicKit: musicKitApi });
  for (const { callback } of [...intervals.values()]) callback();

  return {
    // Non-optional handle on the bridge send mock. window.AMWrapper is optional
    // so bridgeMissing can drop it, and every assertion on IPC traffic comes
    // from a harness that has one.
    get bridgeSend() {
      if (!window.AMWrapper)
        throw new Error("this harness was built without an AMWrapper bridge");
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
    dispatchWheel: ({
      ctrlKey = false,
      deltaY,
      target,
    }: {
      ctrlKey?: boolean;
      deltaY: number;
      target: FakeElement;
    }) => {
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
      for (let cycle = 0; cycle < count; cycle++) {
        const monitors = [...intervals.values()].filter(
          ({ delay }) => delay === 5000,
        );
        for (const { callback } of monitors) callback();
      }
    },
    runVolumePoll: () => {
      for (const { callback } of [...intervals.values()].filter(
        ({ delay }) => delay === 250,
      ))
        callback();
    },
    runTimeouts: () => {
      for (const [id, callback] of timeouts) {
        timeouts.delete(id);
        callback();
      }
    },
    // Runs the script again against the same window, then drains only the
    // timers that second run added. The message listener is installed inside
    // the waitForMK callback rather than the script body, so a re-run that
    // slipped past the injection guard would go unnoticed without the drain.
    reinject: () => {
      const alreadyRun = nextIntervalId;
      vm.runInContext(hookScript, context);
      for (const [id, { callback }] of [...intervals]) {
        if (id > alreadyRun) callback();
      }
    },
    pointerOverListeners,
    window,
  };
}
