import { contextBridge, ipcRenderer } from 'electron';

import type {
  ControllerAction,
  ControllerActionChannel,
  ControllerResetChannel,
} from './controller';

const CONTROLLER_ACTION_CHANNEL = 'controller:action' satisfies ControllerActionChannel;
const CONTROLLER_RESET_CHANNEL = 'controller:reset' satisfies ControllerResetChannel;

const ACTION_BUTTONS: readonly [ControllerAction, number][] = [
  ['up', 12],
  ['down', 13],
  ['left', 14],
  ['right', 15],
  ['select', 0],
  ['back', 1],
];

const DIRECTION_ACTIONS = new Set<ControllerAction>(['up', 'down', 'left', 'right']);
const INITIAL_REPEAT_DELAY_MS = 400;
const REPEAT_INTERVAL_MS = 100;
const FRAME_GAP_RESET_MS = 1000;

interface ButtonState {
  pressed: boolean;
  suppressUntilRelease: boolean;
  nextRepeatAt: number | null;
}

type PadState = Record<ControllerAction, ButtonState>;

function createButtonState(): ButtonState {
  return { pressed: false, suppressUntilRelease: false, nextRepeatAt: null };
}

function createPadState(): PadState {
  return {
    up: createButtonState(),
    down: createButtonState(),
    left: createButtonState(),
    right: createButtonState(),
    select: createButtonState(),
    back: createButtonState(),
  };
}

class ControllerState {
  private readonly pads = new Map<number, PadState>();
  private lastFrameAt: number | null = null;
  private resetPending = true;

  update(gamepads: readonly (Gamepad | null)[], now: number): ControllerAction[] {
    if (this.lastFrameAt !== null && now - this.lastFrameAt > FRAME_GAP_RESET_MS) {
      this.suppressHeldButtons();
      this.resetPending = true;
    }
    this.lastFrameAt = now;

    const activeIndexes = new Set<number>();
    const actions: ControllerAction[] = [];

    for (const gamepad of gamepads) {
      if (!gamepad?.connected || gamepad.mapping !== 'standard') continue;
      activeIndexes.add(gamepad.index);

      const state = this.pads.get(gamepad.index) ?? createPadState();
      this.pads.set(gamepad.index, state);

      for (const [action, buttonIndex] of ACTION_BUTTONS) {
        const button = state[action];
        const pressed = gamepad.buttons[buttonIndex]?.pressed ?? false;

        if (this.resetPending && pressed) button.suppressUntilRelease = true;

        if (!pressed) {
          button.pressed = false;
          button.suppressUntilRelease = false;
          button.nextRepeatAt = null;
          continue;
        }

        if (button.suppressUntilRelease) {
          button.pressed = true;
          button.nextRepeatAt = null;
          continue;
        }

        if (!button.pressed) {
          actions.push(action);
          button.pressed = true;
          button.nextRepeatAt = DIRECTION_ACTIONS.has(action)
            ? now + INITIAL_REPEAT_DELAY_MS
            : null;
          continue;
        }

        if (button.nextRepeatAt !== null && now >= button.nextRepeatAt) {
          actions.push(action);
          button.nextRepeatAt = now + REPEAT_INTERVAL_MS;
        }
      }
    }

    for (const index of this.pads.keys()) {
      if (!activeIndexes.has(index)) this.pads.delete(index);
    }

    this.resetPending = false;
    return actions;
  }

  remove(index: number): void {
    this.pads.delete(index);
  }

  reset(): void {
    this.suppressHeldButtons();
    this.resetPending = true;
    this.lastFrameAt = null;
  }

  private suppressHeldButtons(): void {
    for (const pad of this.pads.values()) {
      for (const [action] of ACTION_BUTTONS) {
        const button = pad[action];
        button.suppressUntilRelease = button.pressed;
        button.nextRepeatAt = null;
      }
    }
  }
}

/**
 * Builds a channel allowlist from a record keyed by the channel union, so the
 * allowlist and the union cannot drift: a missing key and an unknown key are
 * both compile errors. Object.keys() is typed string[], so the cast lives here
 * rather than at the two call sites. allows() takes a string because the value
 * it checks arrives from the main world, where nothing is typed; the predicate
 * narrows it to C for the caller.
 */
function channelSet<C extends string>(
  channels: Record<C, true>,
): { all: readonly C[]; allows(value: string): value is C } {
  const all = Object.keys(channels) as C[];
  const set = new Set<string>(all);
  return { all, allows: (value: string): value is C => set.has(value) };
}

// Channels the renderer is allowed to send to the main process.
// Extend this list and SendChannel in src/types/hook.d.ts together.
const SEND_CHANNELS = channelSet<SendChannel>({
  playbackStateDidChange: true,
  nowPlayingItemDidChange: true,
  playbackTimeDidChange: true,
  repeatModeDidChange: true,
  shuffleModeDidChange: true,
  volumeDidChange: true,
  'nav:back': true,
  'nav:forward': true,
  'nav:reload': true,
});

// Channels the main process is allowed to send to the renderer.
// Each channel maps to a window.__sidra method dispatched via ipcRenderer.on().
// The command allowlist in assets/musicKitHook.js must stay in sync.
const RECEIVE_CHANNELS = channelSet<ReceiveChannel>({
  'player:play': true,
  'player:pause': true,
  'player:playPause': true,
  'player:next': true,
  'player:previous': true,
  'player:seek': true,
  'player:setVolume': true,
  'player:setRepeat': true,
  'player:setShuffle': true,
});

const controllerState = new ControllerState();
let controllerFrame: number | null = null;
let pageIsActive = true;
let windowIsFocused = document.hasFocus();

function gamepads(): readonly (Gamepad | null)[] {
  return navigator.getGamepads();
}

function hasStandardController(pads: readonly (Gamepad | null)[]): boolean {
  return pads.some((pad) => pad?.connected === true && pad.mapping === 'standard');
}

function canPollController(): boolean {
  return pageIsActive && windowIsFocused && document.visibilityState === 'visible';
}

function pollController(now: number): void {
  controllerFrame = null;
  const pads = gamepads();

  for (const action of controllerState.update(pads, now)) {
    ipcRenderer.send(CONTROLLER_ACTION_CHANNEL, action);
  }

  if (canPollController() && hasStandardController(pads)) {
    controllerFrame = requestAnimationFrame(pollController);
  }
}

function startControllerPolling(connectedPad?: Gamepad): void {
  if (controllerFrame !== null || !canPollController()) return;
  if (!hasStandardController(gamepads()) &&
      !(connectedPad?.connected === true && connectedPad.mapping === 'standard')) return;

  controllerFrame = requestAnimationFrame(pollController);
}

function stopControllerPolling(): void {
  if (controllerFrame !== null) cancelAnimationFrame(controllerFrame);
  controllerFrame = null;
  controllerState.reset();
}

function handleControllerReset(): void {
  controllerState.reset();
}

function handleWindowBlur(): void {
  windowIsFocused = false;
  stopControllerPolling();
}

function handleWindowFocus(): void {
  windowIsFocused = true;
  startControllerPolling();
}

function handleVisibilityChange(): void {
  if (document.visibilityState === 'hidden') {
    stopControllerPolling();
    return;
  }
  startControllerPolling();
}

function handlePageHide(): void {
  pageIsActive = false;
  stopControllerPolling();
}

function handlePageShow(): void {
  pageIsActive = true;
  startControllerPolling();
}

function handleGamepadConnected(event: GamepadEvent): void {
  if (!event.isTrusted) return;
  startControllerPolling(event.gamepad);
}

function handleGamepadDisconnected(event: GamepadEvent): void {
  if (!event.isTrusted) return;
  controllerState.remove(event.gamepad.index);
  if (controllerFrame === null && canPollController()) {
    controllerFrame = requestAnimationFrame(pollController);
  }
}

ipcRenderer.on(CONTROLLER_RESET_CHANNEL, handleControllerReset);
window.addEventListener('blur', handleWindowBlur);
window.addEventListener('focus', handleWindowFocus);
window.addEventListener('gamepadconnected', handleGamepadConnected);
window.addEventListener('gamepaddisconnected', handleGamepadDisconnected);
window.addEventListener('pagehide', handlePageHide);
window.addEventListener('pageshow', handlePageShow);
document.addEventListener('visibilitychange', handleVisibilityChange);
startControllerPolling();

// The preload runs in the isolated world (contextIsolation: true), so it cannot
// call window.__sidra directly - that object lives in the main world, set up by
// musicKitHook.js. window.postMessage() crosses the isolation boundary, and the
// hook dispatches each sidra:command message to the matching __sidra method.
// The target origin is window.location.origin, so the bridge works on either
// service host without naming one.
for (const channel of RECEIVE_CHANNELS.all) {
  ipcRenderer.on(channel, (_event, ...args: unknown[]) => {
    window.postMessage({ type: 'sidra:command', channel, args }, window.location.origin);
  });
}

/**
 * The renderer-to-main half of the bridge, exposed as window.AMWrapper and used
 * by sendToMain() in assets/musicKitHook.js. Sending is the only capability the
 * renderer gets, and an unlisted channel is dropped with a warning rather than
 * forwarded. The satisfies clause is what type-checks the payload at all:
 * exposeInMainWorld() takes it untyped, so the declaration in
 * src/types/hook.d.ts would otherwise be checked against nothing.
 */
contextBridge.exposeInMainWorld('AMWrapper', {
  ipcRenderer: {
    send: (channel: string, data: unknown) => {
      if (!SEND_CHANNELS.allows(channel)) {
        console.warn(`AMWrapper: blocked send on unlisted channel "${channel}"`);
        return;
      }
      ipcRenderer.send(channel, data);
    },
  },
} satisfies AMWrapperBridge);
