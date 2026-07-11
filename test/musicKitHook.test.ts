import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const hookScript = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'musicKitHook.js'),
  'utf-8',
);

describe('musicKitHook', () => {
  it('handles one player command after repeated injection before MusicKit loads', () => {
    const intervalCallbacks: Array<() => void> = [];
    const messageListeners: Array<(event: unknown) => void> = [];
    const skipToNextItem = vi.fn();
    const musicKit = {
      addEventListener: vi.fn(),
      currentPlaybackTime: 0,
      isPlaying: true,
      pause: vi.fn(),
      play: vi.fn(),
      queue: { length: 1 },
      repeatMode: 0,
      seekToTime: vi.fn(),
      setVolume: vi.fn(),
      shuffleMode: 0,
      skipToNextItem,
      skipToPreviousItem: vi.fn(),
      volume: 1,
    };
    const window = {
      AMWrapper: { ipcRenderer: { send: vi.fn() } },
      addEventListener: vi.fn((event: string, listener: (event: unknown) => void) => {
        if (event === 'message') messageListeners.push(listener);
      }),
    };
    const context = vm.createContext({
      clearInterval: vi.fn(),
      console,
      setInterval: vi.fn((callback: () => void) => {
        intervalCallbacks.push(callback);
        return intervalCallbacks.length;
      }),
      window,
    });

    vm.runInContext(hookScript, context);
    vm.runInContext(hookScript, context);

    const musicKitApi = {
      getInstance: () => musicKit,
      PlaybackStates: { playing: 2 },
    };
    Object.assign(context, { MusicKit: musicKitApi });
    Object.assign(window, { MusicKit: musicKitApi });
    for (const callback of intervalCallbacks.slice()) callback();

    const event = {
      data: { type: 'sidra:command', channel: 'player:next', args: [] },
      source: window,
    };
    for (const listener of messageListeners) listener(event);

    expect(skipToNextItem).toHaveBeenCalledTimes(1);
  });
});
