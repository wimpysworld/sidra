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

// Register receive channel handlers that dispatch to window.__sidra methods.
// The main process sends these via webContents.send() to control playback.
for (const channel of RECEIVE_CHANNELS) {
  ipcRenderer.on(channel, (_event, ...args: unknown[]) => {
    const sidra = (window as unknown as Record<string, unknown>).__sidra as
      Record<string, (...a: unknown[]) => unknown> | undefined;
    if (!sidra) {
      console.warn(`preload: received "${channel}" but window.__sidra is not available`);
      return;
    }

    switch (channel) {
      case 'player:play':
        sidra.play();
        break;
      case 'player:pause':
        sidra.pause();
        break;
      case 'player:playPause':
        sidra.playPause();
        break;
      case 'player:next':
        sidra.next();
        break;
      case 'player:previous':
        sidra.previous();
        break;
      case 'player:seek': {
        const secs = args[0];
        if (typeof secs !== 'number' || !isFinite(secs)) {
          console.warn(`preload: "${channel}" requires a finite number argument, got ${typeof secs}`);
          return;
        }
        sidra.seek(secs);
        break;
      }
      case 'player:setVolume': {
        const vol = args[0];
        if (typeof vol !== 'number' || !isFinite(vol)) {
          console.warn(`preload: "${channel}" requires a finite number argument, got ${typeof vol}`);
          return;
        }
        sidra.setVolume(vol);
        break;
      }
      case 'player:setRepeat': {
        const mode = args[0];
        if (typeof mode !== 'number') {
          console.warn(`preload: "${channel}" requires a number argument, got ${typeof mode}`);
          return;
        }
        sidra.setRepeat(mode);
        break;
      }
      case 'player:setShuffle': {
        const mode = args[0];
        if (typeof mode !== 'number') {
          console.warn(`preload: "${channel}" requires a number argument, got ${typeof mode}`);
          return;
        }
        sidra.setShuffle(mode);
        break;
      }
    }
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
