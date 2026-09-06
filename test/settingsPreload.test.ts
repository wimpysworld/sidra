import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { beforeEach, expect, it, vi } from 'vitest';
import type { SettingsBridge, SettingsState } from '../src/settings';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.assign(ipcRenderer, { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() });
});

it('exposes only the typed Settings API and hides Electron events', async () => {
  await import('../src/settingsPreload');
  const [name, bridge] = vi.mocked(contextBridge.exposeInMainWorld).mock.calls[0] as [string, SettingsBridge];
  expect(name).toBe('sidraSettings');
  expect(Object.keys(bridge)).toEqual(['getState', 'apply', 'onState']);
  bridge.getState();
  bridge.apply({ type: 'notifications', value: false });
  expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(1, 'settings:get');
  expect(ipcRenderer.invoke).toHaveBeenNthCalledWith(2, 'settings:apply', { type: 'notifications', value: false });
  const listener = vi.fn();
  const remove = bridge.onState(listener);
  const [channel, handler] = vi.mocked(ipcRenderer.on).mock.calls[0];
  const state = { notifications: false } as SettingsState;
  handler({} as IpcRendererEvent, state);
  expect(channel).toBe('settings:state');
  expect(listener).toHaveBeenCalledWith(state);
  remove();
  expect(ipcRenderer.removeListener).toHaveBeenCalledWith('settings:state', handler);
});
