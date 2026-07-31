import { contextBridge, ipcRenderer } from 'electron';

/**
 * Builds a channel allowlist from a record keyed by the channel union, so the
 * allowlist and the union cannot drift: a missing key and an unknown key are
 * both compile errors. Object.keys() is typed string[], so the cast lives here
 * rather than at the two call sites.
 */
function channelSet<C extends string>(channels: Record<C, true>): ReadonlySet<C> {
  return new Set(Object.keys(channels) as C[]);
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

// Register receive channel handlers that bridge commands to the main world.
// The preload runs in the isolated world (contextIsolation: true), so it cannot
// access window.__sidra directly - that object lives in the main world, set up
// by musicKitHook.js. window.postMessage() crosses the isolation boundary;
// musicKitHook.js listens for these messages and dispatches to __sidra methods.
for (const channel of RECEIVE_CHANNELS) {
  ipcRenderer.on(channel, (_event, ...args: unknown[]) => {
    window.postMessage({ type: 'sidra:command', channel, args }, window.location.origin);
  });
}

/**
 * Minimal IPC bridge exposed to the renderer as window.AMWrapper.
 * MLP: validates contextBridge works. No MusicKit hook consumes this yet.
 */
contextBridge.exposeInMainWorld('AMWrapper', {
  ipcRenderer: {
    send: (channel: string, data: unknown) => {
      if (!SEND_CHANNELS.has(channel as SendChannel)) {
        console.warn(`AMWrapper: blocked send on unlisted channel "${channel}"`);
        return;
      }
      ipcRenderer.send(channel, data);
    },
  },
});
