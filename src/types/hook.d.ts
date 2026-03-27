// Ambient type declarations for the renderer-injected hook scripts.
// assets/musicKitHook.js defines window.__sidra, window.__sidraHookedMk, and
// window.AMWrapper at runtime. These declarations formalise that contract so
// TypeScript can reference the shapes from preload and test code.

// ---------------------------------------------------------------------------
// IPC channel string literal types
// ---------------------------------------------------------------------------

/** Channels the renderer sends to the main process (renderer → main). */
type SendChannel =
  | 'playbackStateDidChange'
  | 'nowPlayingItemDidChange'
  | 'playbackTimeDidChange'
  | 'repeatModeDidChange'
  | 'shuffleModeDidChange'
  | 'volumeDidChange'
  | 'nav:back'
  | 'nav:forward'
  | 'nav:reload';

/** Channels the main process sends to the renderer (main → renderer). */
type ReceiveChannel =
  | 'player:play'
  | 'player:pause'
  | 'player:playPause'
  | 'player:next'
  | 'player:previous'
  | 'player:seek'
  | 'player:setVolume'
  | 'player:setRepeat'
  | 'player:setShuffle';

// ---------------------------------------------------------------------------
// Hook interfaces
// ---------------------------------------------------------------------------

/** Methods exposed on window.__sidra by assets/musicKitHook.js. */
interface SidraHook {
  play(): Promise<void>;
  pause(): Promise<void>;
  playPause(): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  seek(seconds: number): Promise<void>;
  setVolume(volume: number): void;
  setRepeat(mode: number): void;
  setShuffle(mode: number): void;
}

/** IPC bridge exposed on window.AMWrapper via contextBridge. */
interface AMWrapperBridge {
  ipcRenderer: {
    send(channel: string, data?: unknown): void;
  };
}

/** Payload shape for the window.postMessage bridge between preload and hook. */
interface SidraCommandMessage {
  type: 'sidra:command';
  channel: ReceiveChannel;
  args?: unknown[];
}

// ---------------------------------------------------------------------------
// Global window augmentation
// ---------------------------------------------------------------------------

interface Window {
  __sidra: SidraHook;
  __sidraHookedMk: unknown;
  AMWrapper: AMWrapperBridge;
}
