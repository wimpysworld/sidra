// Shared contract for assets/musicKitHook.js and src/preload.ts. The hook defines
// window.__sidra and window.__sidraHookedMk, and the preload exposes window.AMWrapper.
// TypeScript checks the preload allowlists against these unions. Contract tests
// read the plain JavaScript hook because TypeScript does not check that file.

// ---------------------------------------------------------------------------
// IPC channel string literal types
// ---------------------------------------------------------------------------

/**
 * Channels the renderer sends to the main process (renderer → main). The preload
 * allowlist is a Record over this union, so a channel dropped or misspelled
 * there fails the type check rather than being silently discarded at runtime.
 */
type SendChannel =
  | 'hookReady'
  | 'playbackCapabilitiesDidChange'
  | 'playbackStopped'
  | 'playbackStateDidChange'
  | 'nowPlayingItemDidChange'
  | 'timedMetadataDidChange'
  | 'playbackTimeDidChange'
  | 'repeatModeDidChange'
  | 'shuffleModeDidChange'
  | 'volumeDidChange'
  | 'nav:back'
  | 'nav:forward'
  | 'nav:reload'
  | 'nav:settings';

/**
 * Channels the main process sends to the renderer (main → renderer). Every
 * sender is typed against this union, so a misspelled channel fails tsc instead
 * of reaching the preload allowlist, which would drop it without a trace.
 */
type ReceiveChannel =
  | 'player:openUri'
  | 'player:play'
  | 'player:pause'
  | 'player:stop'
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
 * Commands exposed on window.__sidra by assets/musicKitHook.js.
 * Contract tests compare the hook command table with this interface.
 */
interface SidraHook {
  /** Replaces the queue with the supplied URL and starts playback. */
  openUri(uri: string): Promise<void>;
  /** Starts or resumes playback. */
  play(): Promise<void>;
  /** Pauses playback without clearing the queue. */
  pause(): Promise<void>;
  /** Stops playback and reports completion with the supplied request ID. */
  stop(requestId: number): Promise<void>;
  /** Toggles between playing and paused. */
  playPause(): Promise<void>;
  /** Advances to the next queue item. */
  next(): Promise<void>;
  /** Returns to the previous queue item. */
  previous(): Promise<void>;
  /** Moves the playhead to an absolute position in seconds. */
  seek(seconds: number): Promise<void>;
  /** Sets MusicKit software volume between zero and one. */
  setVolume(volume: number): void;
  /** Sets the MusicKit repeat mode. */
  setRepeat(mode: number): void;
  /** Sets the MusicKit shuffle mode. */
  setShuffle(mode: number): void;
}

/**
 * IPC bridge exposed on window.AMWrapper via contextBridge. The preload object
 * carries `satisfies AMWrapperBridge`, because exposeInMainWorld() takes its
 * payload untyped and this declaration is otherwise checked against nothing.
 */
interface AMWrapperBridge {
  /** Allow-listed renderer-to-main event forwarding. */
  ipcRenderer: {
    /** Sends an event with its optional payload and document generation. */
    send(channel: SendChannel, data?: unknown, generation?: number): void;
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

/** Hook state and the isolated preload bridge exposed to the main world. */
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
  /** IPC bridge exposed by src/preload.ts, not by the hook. */
  AMWrapper: AMWrapperBridge;
}
