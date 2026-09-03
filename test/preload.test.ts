import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { IpcRendererEvent } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONTROLLER_ACTION_CHANNEL,
  CONTROLLER_RESET_CHANNEL,
} from '../src/controller';

type IpcListener = (event: IpcRendererEvent, ...args: unknown[]) => void;

function gamepad(
  index: number,
  pressed: number[] = [],
  options: { connected?: boolean; mapping?: GamepadMappingType; buttonCount?: number } = {},
): Gamepad {
  const buttons = Array.from({ length: options.buttonCount ?? 16 }, (_, buttonIndex): GamepadButton => ({
    pressed: pressed.includes(buttonIndex),
    touched: pressed.includes(buttonIndex),
    value: pressed.includes(buttonIndex) ? 1 : 0,
  }));

  return {
    axes: [],
    buttons,
    connected: options.connected ?? true,
    id: `pad-${index}`,
    index,
    mapping: options.mapping ?? 'standard',
    timestamp: 0,
    vibrationActuator: {
      playEffect: () => Promise.resolve('complete'),
      reset: () => Promise.resolve('complete'),
    },
  };
}

async function loadPreload(initialPads: readonly (Gamepad | null)[] = []) {
  vi.resetModules();

  let pads = initialPads;
  let focused = true;
  let visibilityState: DocumentVisibilityState = 'visible';
  let nextFrameId = 0;
  const frames = new Map<number, FrameRequestCallback>();
  const ipcListeners = new Map<string, IpcListener>();
  const windowTarget = Object.assign(new EventTarget(), {
    location: { origin: 'https://music.apple.com' },
    postMessage: vi.fn(),
  });
  const windowListeners = new Map<string, EventListenerOrEventListenerObject>();
  const addWindowEventListener = windowTarget.addEventListener.bind(windowTarget);
  windowTarget.addEventListener = (type, callback, options) => {
    if (callback !== null) windowListeners.set(type, callback);
    addWindowEventListener(type, callback, options);
  };
  const documentTarget = new EventTarget();

  Object.defineProperties(documentTarget, {
    hasFocus: { value: () => focused },
    visibilityState: { get: () => visibilityState },
  });

  const getGamepads = vi.fn(() => pads);
  const requestFrame = vi.fn((callback: FrameRequestCallback) => {
    const id = ++nextFrameId;
    frames.set(id, callback);
    return id;
  });
  const cancelFrame = vi.fn((id: number) => {
    frames.delete(id);
  });

  vi.stubGlobal('window', windowTarget);
  vi.stubGlobal('document', documentTarget);
  vi.stubGlobal('navigator', { getGamepads });
  vi.stubGlobal('requestAnimationFrame', requestFrame);
  vi.stubGlobal('cancelAnimationFrame', cancelFrame);

  const { contextBridge, ipcRenderer } = await import('electron');
  Object.assign(ipcRenderer, { on: vi.fn() });
  vi.mocked(ipcRenderer.on).mockImplementation((channel, listener) => {
    ipcListeners.set(channel, listener);
    return ipcRenderer;
  });
  vi.mocked(ipcRenderer.send).mockClear();
  vi.mocked(contextBridge.exposeInMainWorld).mockClear();

  await import('../src/preload');

  function dispatchWindow(type: string, pad?: Gamepad): void {
    const event = new Event(type);
    if (pad) Object.defineProperty(event, 'gamepad', { value: pad });
    windowTarget.dispatchEvent(event);
  }

  function dispatchTrustedGamepad(
    type: 'gamepadconnected' | 'gamepaddisconnected',
    pad: Gamepad,
  ): void {
    const listener = windowListeners.get(type);
    if (!listener) throw new Error(`Expected a ${type} listener`);
    const event = { gamepad: pad, isTrusted: true } as GamepadEvent;
    if (typeof listener === 'function') listener(event);
    else listener.handleEvent(event);
  }

  function dispatchVisibility(state: DocumentVisibilityState): void {
    visibilityState = state;
    documentTarget.dispatchEvent(new Event('visibilitychange'));
  }

  function runFrame(now: number): void {
    const entry = frames.entries().next().value;
    if (!entry) throw new Error('Expected a pending animation frame');
    const [id, callback] = entry;
    frames.delete(id);
    callback(now);
  }

  return {
    cancelFrame,
    contextBridge,
    dispatchTrustedGamepad,
    dispatchVisibility,
    dispatchWindow,
    frames,
    getGamepads,
    ipcListeners,
    ipcRenderer,
    requestFrame,
    runFrame,
    setFocused(value: boolean) {
      focused = value;
    },
    setPads(value: readonly (Gamepad | null)[]) {
      pads = value;
    },
    windowTarget,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('controller polling in the preload', () => {
  it('compiles without a relative runtime require', () => {
    const outputDirectory = mkdtempSync(join(tmpdir(), 'sidra-preload-'));
    try {
      execFileSync(process.execPath, [
        'node_modules/typescript/lib/tsc.js',
        '-p',
        'tsconfig.json',
        '--outDir',
        outputDirectory,
        '--sourceMap',
        'false',
      ]);
      const compiled = readFileSync(join(outputDirectory, 'preload.js'), 'utf8');
      const requires = [...compiled.matchAll(/\brequire\((["'])([^"']+)\1\)/g)]
        .map((match) => match[2]);

      expect(requires).toEqual(['electron']);
    } finally {
      rmSync(outputDirectory, { recursive: true, force: true });
    }
  });

  it('does not poll until a standard controller connects', async () => {
    const harness = await loadPreload();

    expect(harness.frames.size).toBe(0);
    harness.dispatchTrustedGamepad('gamepadconnected', gamepad(1, [], { mapping: '' }));
    expect(harness.frames.size).toBe(0);

    const pad = gamepad(1);
    harness.dispatchTrustedGamepad('gamepadconnected', pad);
    harness.dispatchTrustedGamepad('gamepadconnected', pad);
    expect(harness.frames.size).toBe(1);
  });

  it('ignores untrusted controller connections', async () => {
    const harness = await loadPreload();

    harness.dispatchWindow('gamepadconnected', gamepad(0));

    expect(harness.frames.size).toBe(0);
  });

  it('polls fresh values through one frame loop and sends actions privately', async () => {
    const harness = await loadPreload([gamepad(0)]);

    expect(harness.frames.size).toBe(1);
    harness.runFrame(0);
    harness.setPads([gamepad(0, [12])]);
    harness.runFrame(10);

    expect(harness.getGamepads).toHaveBeenCalledTimes(3);
    expect(harness.ipcRenderer.send).toHaveBeenCalledWith(CONTROLLER_ACTION_CHANNEL, 'up');
    expect(harness.frames.size).toBe(1);
  });

  it('stops on blur, resets held input, and resumes once on focus', async () => {
    const harness = await loadPreload([gamepad(0, [12])]);
    harness.runFrame(0);
    vi.mocked(harness.ipcRenderer.send).mockClear();

    harness.setFocused(false);
    harness.dispatchWindow('blur');
    expect(harness.cancelFrame).toHaveBeenCalledOnce();
    expect(harness.frames.size).toBe(0);

    harness.dispatchVisibility('visible');
    expect(harness.frames.size).toBe(0);

    harness.setFocused(true);
    harness.dispatchWindow('focus');
    harness.dispatchWindow('focus');
    expect(harness.frames.size).toBe(1);
    harness.runFrame(10);
    expect(harness.ipcRenderer.send).not.toHaveBeenCalled();

    harness.setPads([gamepad(0)]);
    harness.runFrame(20);
    harness.setPads([gamepad(0, [12])]);
    harness.runFrame(30);
    expect(harness.ipcRenderer.send).toHaveBeenCalledWith(CONTROLLER_ACTION_CHANNEL, 'up');
  });

  it.each([
    ['visibility', 'visibilitychange'],
    ['page lifecycle', 'pagehide'],
  ] as const)('stops and resumes for the %s', async (_name, event) => {
    const harness = await loadPreload([gamepad(0)]);

    if (event === 'visibilitychange') harness.dispatchVisibility('hidden');
    else harness.dispatchWindow('pagehide');
    expect(harness.frames.size).toBe(0);

    if (event === 'visibilitychange') harness.dispatchVisibility('visible');
    else harness.dispatchWindow('pageshow');
    expect(harness.frames.size).toBe(1);
  });

  it('samples a disconnect, removes stale state, and stops the loop', async () => {
    const harness = await loadPreload([gamepad(0)]);
    harness.runFrame(0);
    harness.setPads([gamepad(0, [14])]);
    harness.runFrame(10);
    vi.mocked(harness.ipcRenderer.send).mockClear();

    harness.setPads([]);
    harness.dispatchTrustedGamepad(
      'gamepaddisconnected',
      gamepad(0, [], { connected: false }),
    );
    expect(harness.frames.size).toBe(1);

    const reconnected = gamepad(0, [14]);
    harness.setPads([reconnected]);
    harness.dispatchTrustedGamepad('gamepadconnected', reconnected);
    harness.runFrame(20);
    expect(harness.ipcRenderer.send).toHaveBeenCalledWith(CONTROLLER_ACTION_CHANNEL, 'left');
  });

  it('ignores an untrusted disconnect while a button stays held', async () => {
    const harness = await loadPreload([gamepad(0)]);
    harness.runFrame(0);
    harness.setPads([gamepad(0, [12])]);
    harness.runFrame(10);
    vi.mocked(harness.ipcRenderer.send).mockClear();

    harness.dispatchWindow(
      'gamepaddisconnected',
      gamepad(0, [], { connected: false }),
    );
    harness.runFrame(20);

    expect(harness.ipcRenderer.send).not.toHaveBeenCalled();
  });

  it('does not restart for a disconnect while the page is hidden', async () => {
    const harness = await loadPreload([gamepad(0)]);
    harness.dispatchVisibility('hidden');

    harness.setPads([]);
    harness.dispatchTrustedGamepad(
      'gamepaddisconnected',
      gamepad(0, [], { connected: false }),
    );
    expect(harness.frames.size).toBe(0);
  });

  it('handles reset IPC in the isolated preload', async () => {
    const harness = await loadPreload([gamepad(0)]);
    harness.runFrame(0);
    harness.setPads([gamepad(0, [0])]);
    harness.runFrame(10);
    vi.mocked(harness.ipcRenderer.send).mockClear();

    const reset = harness.ipcListeners.get(CONTROLLER_RESET_CHANNEL);
    expect(reset).toBeDefined();
    reset?.({} as IpcRendererEvent);
    harness.runFrame(20);

    expect(harness.ipcRenderer.send).not.toHaveBeenCalled();
    expect(harness.windowTarget.postMessage).not.toHaveBeenCalled();
  });

  it('keeps controller actions out of the public bridge', async () => {
    const harness = await loadPreload();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exposed = vi.mocked(harness.contextBridge.exposeInMainWorld).mock.calls
      .find(([key]) => key === 'AMWrapper')?.[1] as {
        ipcRenderer: { send(channel: string, data?: unknown): void };
      };

    exposed.ipcRenderer.send(CONTROLLER_ACTION_CHANNEL, 'up');
    expect(harness.ipcRenderer.send).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      'AMWrapper: blocked send on unlisted channel "controller:action"',
    );

    exposed.ipcRenderer.send('playbackStateDidChange', true);
    expect(harness.ipcRenderer.send).toHaveBeenCalledWith('playbackStateDidChange', true);
  });

  it('installs one polling loop for each isolated preload setup', async () => {
    const first = await loadPreload([gamepad(0)]);
    expect(first.requestFrame).toHaveBeenCalledOnce();

    const second = await loadPreload([gamepad(0)]);
    expect(second.requestFrame).toHaveBeenCalledOnce();
    expect(second.frames.size).toBe(1);
  });

  it.each([
    [12, 'up'],
    [13, 'down'],
    [14, 'left'],
    [15, 'right'],
    [0, 'select'],
    [1, 'back'],
  ] as const)('maps button %i to %s', async (button, action) => {
    const harness = await loadPreload([gamepad(0)]);
    harness.runFrame(0);
    harness.setPads([gamepad(0, [button])]);
    harness.runFrame(1);

    expect(harness.ipcRenderer.send).toHaveBeenCalledWith(CONTROLLER_ACTION_CHANNEL, action);
  });

  it('suppresses buttons held when a new document preload starts', async () => {
    const harness = await loadPreload([gamepad(0, [12])]);
    harness.runFrame(0);
    harness.runFrame(500);
    expect(harness.ipcRenderer.send).not.toHaveBeenCalled();

    harness.setPads([gamepad(0)]);
    harness.runFrame(600);
    harness.setPads([gamepad(0, [12])]);
    harness.runFrame(700);
    expect(harness.ipcRenderer.send).toHaveBeenCalledWith(CONTROLLER_ACTION_CHANNEL, 'up');
  });

  it('emits pressed edges and repeats only directions at fixed boundaries', async () => {
    const harness = await loadPreload([gamepad(0)]);
    harness.runFrame(0);
    harness.setPads([gamepad(0, [12, 0, 1])]);
    harness.runFrame(10);
    harness.runFrame(409);
    harness.runFrame(410);
    harness.runFrame(509);
    harness.runFrame(510);

    const actions = vi.mocked(harness.ipcRenderer.send).mock.calls.map(([, action]) => action);
    expect(actions).toEqual(['up', 'select', 'back', 'up', 'up']);

    harness.setPads([gamepad(0)]);
    harness.runFrame(520);
    harness.setPads([gamepad(0, [0])]);
    harness.runFrame(530);
    expect(vi.mocked(harness.ipcRenderer.send).mock.calls.at(-1)?.[1]).toBe('select');
  });

  it('starts a fresh repeat interval after a delayed frame', async () => {
    const harness = await loadPreload([gamepad(0)]);
    harness.runFrame(0);
    harness.setPads([gamepad(0, [12])]);
    harness.runFrame(10);
    harness.runFrame(910);
    harness.runFrame(1009);
    harness.runFrame(1010);

    const actions = vi.mocked(harness.ipcRenderer.send).mock.calls.map(([, action]) => action);
    expect(actions).toEqual(['up', 'up', 'up']);
  });

  it('treats missing buttons as released', async () => {
    const harness = await loadPreload([gamepad(0)]);
    harness.runFrame(0);
    harness.setPads([gamepad(0, [15])]);
    harness.runFrame(10);
    harness.setPads([gamepad(0, [], { buttonCount: 2 })]);
    harness.runFrame(20);
    harness.setPads([gamepad(0, [15])]);
    harness.runFrame(30);

    const actions = vi.mocked(harness.ipcRenderer.send).mock.calls.map(([, action]) => action);
    expect(actions).toEqual(['right', 'right']);
  });

  it('removes state for absent, disconnected, and non-standard pads', async () => {
    const harness = await loadPreload([gamepad(0)]);
    harness.runFrame(0);
    harness.setPads([gamepad(0, [12]), gamepad(1, [15])]);
    harness.runFrame(10);
    vi.mocked(harness.ipcRenderer.send).mockClear();

    harness.setPads([
      null,
      gamepad(0, [12], { connected: false }),
      gamepad(1, [15], { mapping: '' }),
    ]);
    harness.runFrame(20);
    expect(harness.frames.size).toBe(0);

    const first = gamepad(0, [12]);
    const second = gamepad(1, [15]);
    harness.setPads([first, second]);
    harness.dispatchTrustedGamepad('gamepadconnected', first);
    harness.runFrame(30);
    const actions = vi.mocked(harness.ipcRenderer.send).mock.calls.map(([, action]) => action);
    expect(actions).toEqual(['up', 'right']);
  });

  it('suppresses held input after a frame gap above 1000 ms', async () => {
    const harness = await loadPreload([gamepad(0)]);
    harness.runFrame(0);
    harness.setPads([gamepad(0, [13])]);
    harness.runFrame(10);
    harness.runFrame(1010);
    harness.runFrame(2011);

    const actions = vi.mocked(harness.ipcRenderer.send).mock.calls.map(([, action]) => action);
    expect(actions).toEqual(['down', 'down']);

    harness.setPads([gamepad(0)]);
    harness.runFrame(2020);
    harness.setPads([gamepad(0, [13])]);
    harness.runFrame(2030);
    expect(vi.mocked(harness.ipcRenderer.send).mock.calls.at(-1)?.[1]).toBe('down');
  });

  it('keeps input state independent for two pads', async () => {
    const harness = await loadPreload([gamepad(0), gamepad(1)]);
    harness.runFrame(0);
    harness.setPads([gamepad(0, [14]), gamepad(1, [0])]);
    harness.runFrame(10);
    harness.setPads([gamepad(0, [14]), gamepad(1)]);
    harness.runFrame(410);
    harness.setPads([gamepad(0), gamepad(1, [0])]);
    harness.runFrame(510);

    const actions = vi.mocked(harness.ipcRenderer.send).mock.calls.map(([, action]) => action);
    expect(actions).toEqual(['left', 'select', 'left', 'select']);
  });
});
