// Ambient type declarations for the renderer-injected hook scripts.
// assets/musicKitHook.js defines window.__sidra, window.__sidraHookedMk, and
// window.AMWrapper at runtime. These declarations formalise that contract so
// TypeScript can reference the shapes from preload and test code.
//
// One of three artefacts that define the same contract, with the hook itself and
// src/preload.ts. The preload builds both allowlists from the unions below, so
// tsc holds those two together. The hook is plain JavaScript and is never type
// checked, so the contract tests read it off disk instead.

// ---------------------------------------------------------------------------
// IPC channel string literal types
// ---------------------------------------------------------------------------

/**
 * Channels the renderer sends to the main process (renderer → main). The preload
 * allowlist is a Record over this union, so a channel dropped or misspelled
 * there fails the type check rather than being silently discarded at runtime.
 */
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

/**
 * Channels the main process sends to the renderer (main → renderer). Every
 * sender is typed against this union, so a misspelled channel fails tsc instead
 * of reaching the preload allowlist, which would drop it without a trace.
 */
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

/**
 * Methods exposed on window.__sidra by assets/musicKitHook.js. Each key answers
 * one ReceiveChannel; the contract test reads the hook off disk and compares its
 * command table to this interface, which is the only thing tying the two.
 */
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

/**
 * IPC bridge exposed on window.AMWrapper via contextBridge. The preload object
 * carries `satisfies AMWrapperBridge`, because exposeInMainWorld() takes its
 * payload untyped and this declaration is otherwise checked against nothing.
 */
interface AMWrapperBridge {
  ipcRenderer: {
    send(channel: SendChannel, data?: unknown): void;
  };
}

/**
 * Payload shape for the window.postMessage bridge between preload and hook.
 * postMessage is what carries a command across the context isolation boundary,
 * since the hook runs in the main world and cannot see the preload directly.
 */
interface SidraCommandMessage {
  type: 'sidra:command';
  channel: ReceiveChannel;
  args?: unknown[];
}

// ---------------------------------------------------------------------------
// Global window augmentation
// ---------------------------------------------------------------------------

interface Window {
  /** The command surface, assigned last so a part-attached hook leaves it unset. */
  __sidra: SidraHook;
  /**
   * Set once at the top of the hook's IIFE and never cleared. It stops a second
   * injection installing a duplicate set of message and wheel listeners.
   */
  __sidraHookInjected: boolean;
  /**
   * The MusicKit instance the hook is attached to. A different marker from the
   * one above: the monitor compares it against the current singleton to catch a
   * replaced instance and re-attach.
   */
  __sidraHookedMk: unknown;
  AMWrapper: AMWrapperBridge;
}
