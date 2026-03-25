import { contextBridge, ipcRenderer } from 'electron';

// Channels the renderer is allowed to send to the main process.
// Extend this list as new renderer-to-main IPC messages are added.
const SEND_CHANNELS = new Set<string>([
  'playbackStateDidChange',
  'nowPlayingItemDidChange',
  'playbackTimeDidChange',
  'repeatModeDidChange',
  'shuffleModeDidChange',
  'volumeDidChange',
  'nav:back',
  'nav:forward',
  'nav:reload',
]);

// Channels the main process is allowed to send to the renderer.
// Each channel maps to a window.__sidra method dispatched via ipcRenderer.on().
const RECEIVE_CHANNELS = new Set<string>([
  'player:play',
  'player:pause',
  'player:playPause',
  'player:next',
  'player:previous',
  'player:seek',
  'player:setVolume',
  'player:setRepeat',
  'player:setShuffle',
]);

// Register receive channel handlers that bridge commands to the main world.
// The preload runs in the isolated world (contextIsolation: true), so it cannot
// access window.__sidra directly - that object lives in the main world, set up
// by musicKitHook.js. window.postMessage() crosses the isolation boundary;
// musicKitHook.js listens for these messages and dispatches to __sidra methods.
for (const channel of RECEIVE_CHANNELS) {
  ipcRenderer.on(channel, (_event, ...args: unknown[]) => {
    window.postMessage({ type: 'sidra:command', channel, args }, '*');
  });
}

/**
 * Minimal IPC bridge exposed to the renderer as window.AMWrapper.
 * MLP: validates contextBridge works. No MusicKit hook consumes this yet.
 */
contextBridge.exposeInMainWorld('AMWrapper', {
  ipcRenderer: {
    send: (channel: string, data: unknown) => {
      if (!SEND_CHANNELS.has(channel)) {
        console.warn(`AMWrapper: blocked send on unlisted channel "${channel}"`);
        return;
      }
      ipcRenderer.send(channel, data);
    },
  },
});
