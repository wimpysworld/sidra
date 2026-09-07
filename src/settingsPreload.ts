import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { SettingsBridge, SettingsState } from './settings';

// Expose only Settings operations, with an unsubscribe function for renderer listeners.
contextBridge.exposeInMainWorld('sidraSettings', {
  getState: () => ipcRenderer.invoke('settings:get'),
  apply: action => ipcRenderer.invoke('settings:apply', action),
  onState: listener => {
    const onState = (_event: IpcRendererEvent, state: SettingsState): void => listener(state);
    ipcRenderer.on('settings:state', onState);
    return () => { ipcRenderer.removeListener('settings:state', onState); };
  },
} satisfies SettingsBridge);
