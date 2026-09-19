// Shared contract for assets/musicKitHook.js and src/preload.ts. The hook defines
// window.__sidra, window.__sidraHookInjected, and window.__sidraHookedMk. The
// preload exposes window.AMWrapper. TypeScript checks the preload allowlists
// against these unions. Contract tests read the JavaScript hook because
// TypeScript does not check that file.

// ---------------------------------------------------------------------------
// IPC channel string literal types
// ---------------------------------------------------------------------------

/**
 * Channels that the renderer sends to the main process (renderer → main).
 * A `Record` over this union makes an omitted or misspelled preload allowlist
 * entry fail compilation instead of being silently discarded at runtime.
 */
type SendChannel =
 | "hookReady"
 | "playbackCapabilitiesDidChange"
 | "playbackStopped"
 | "playbackStateDidChange"
 | "nowPlayingItemDidChange"
 | "timedMetadataDidChange"
 | "playbackTimeDidChange"
 | "repeatModeDidChange"
 | "shuffleModeDidChange"
 | "volumeDidChange"
 | "nav:back"
 | "nav:forward"
 | "nav:reload"
 | "nav:settings";

/**
 * Channels that the main process sends to the renderer (main → renderer).
 * Every sender uses this union, so a misspelled channel fails TypeScript
 * compilation instead of being silently dropped by the preload allowlist.
 */
type ReceiveChannel =
 | "player:openUri"
 | "player:play"
 | "player:pause"
 | "player:stop"
 | "player:playPause"
 | "player:next"
 | "player:previous"
 | "player:seek"
 | "player:setVolume"
 | "player:setRepeat"
 | "player:setShuffle";

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
 * Command payload that the isolated preload sends to the main-world hook.
 * `window.postMessage()` crosses the context isolation boundary that prevents
 * the preload from calling `window.__sidra` directly.
 */
interface SidraCommandMessage {
 type: "sidra:command";
 channel: ReceiveChannel;
 args?: unknown[];
}

// ---------------------------------------------------------------------------
// Global window augmentation
// ---------------------------------------------------------------------------

/** Hook state and the isolated preload bridge exposed to the main world. */
interface Window {
 /** The command surface, assigned last so a partial attachment leaves it unset. */
 __sidra: SidraHook;
 /**
  * Set once at the top of the hook's IIFE and never cleared. It prevents a
  * second injection from installing duplicate document listeners and timers.
  */
 __sidraHookInjected: boolean;
 /**
  * The MusicKit instance that the hook uses. This marker is separate from the
  * injection guard because the monitor compares it with the current singleton
  * to detect a replacement and attach again.
  */
 __sidraHookedMk: unknown;
 /** IPC bridge exposed by src/preload.ts, not by the hook. */
 AMWrapper: AMWrapperBridge;
}
