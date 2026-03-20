import { contextBridge, ipcRenderer } from 'electron';

/**
 * Minimal IPC bridge exposed to the renderer as window.AMWrapper.
 * MLP: validates contextBridge works. No MusicKit hook consumes this yet.
 */
contextBridge.exposeInMainWorld('AMWrapper', {
  ipcRenderer: {
    send: (channel: string, data: unknown) => {
      ipcRenderer.send(channel, data);
    },
    on: (channel: string, func: (...args: unknown[]) => void) => {
      ipcRenderer.on(channel, (_event, ...args) => func(...args));
    },
  },
});
