import { contextBridge, ipcRenderer } from 'electron';

// Channels the renderer is allowed to use.
// Extend these lists as new IPC messages are added.
const SEND_CHANNELS: string[] = [
  'playbackStateDidChange',
  'nowPlayingItemDidChange',
  'playbackTimeDidChange',
  'repeatModeDidChange',
  'shuffleModeDidChange',
  'volumeDidChange',
];

/**
 * Minimal IPC bridge exposed to the renderer as window.AMWrapper.
 * MLP: validates contextBridge works. No MusicKit hook consumes this yet.
 */
contextBridge.exposeInMainWorld('AMWrapper', {
  ipcRenderer: {
    send: (channel: string, data: unknown) => {
      if (!SEND_CHANNELS.includes(channel)) {
        console.warn(`AMWrapper: blocked send on unlisted channel "${channel}"`);
        return;
      }
      ipcRenderer.send(channel, data);
    },
  },
});
