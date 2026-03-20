import { contextBridge, ipcRenderer } from 'electron';

// Channels the renderer is allowed to use.
// Extend these lists as new IPC messages are added.
const SEND_CHANNELS: string[] = [];
const RECEIVE_CHANNELS: string[] = [];

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
    on: (channel: string, func: (...args: unknown[]) => void) => {
      if (!RECEIVE_CHANNELS.includes(channel)) {
        console.warn(`AMWrapper: blocked listener on unlisted channel "${channel}"`);
        return;
      }
      ipcRenderer.on(channel, (_event, ...args) => func(...args));
    },
  },
});
