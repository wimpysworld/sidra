import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent, type IpcMainEvent } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAssetPath } from '../src/paths';
import { getSettingsState, applySettingsAction, subscribeSettingsChanges, type SettingsState } from '../src/settings';
import { handleSettingsNavigation, initSettingsWindow, showSettingsWindow } from '../src/settingsWindow';
import { restorePlatform, setPlatform } from './mocks/platform';
import { quit } from './mocks/appLifecycle';

vi.mock('../src/settings', () => ({
  getSettingsState: vi.fn(() => ({ theme: 'apple-music' })),
  applySettingsAction: vi.fn(() => ({ theme: 'custom' })),
  subscribeSettingsChanges: vi.fn(),
}));

class WindowStub extends EventEmitter {
  destroyed = false;
  minimised = false;
  url = pathToFileURL(getAssetPath('assets', 'settings.html')).href;
  webContents = Object.assign(new EventEmitter(), {
    mainFrame: { url: this.url },
    isDestroyed: () => this.destroyed,
    getURL: () => this.url,
    send: vi.fn(),
    setWindowOpenHandler: vi.fn(),
  });
  isDestroyed = () => this.destroyed;
  isMinimized = () => this.minimised;
  restore = vi.fn();
  show = vi.fn();
  focus = vi.fn();
  setMenu = vi.fn();
  loadFile = vi.fn(() => Promise.resolve());
  close = vi.fn(() => { this.destroyed = true; this.emit('closed'); });
}

const asWindow = (window: WindowStub) => window as unknown as BrowserWindow;
const handlers = new Map<string, (event: IpcMainInvokeEvent, action?: unknown) => unknown>();
let main: WindowStub;
let opened: WindowStub;
let dispose: () => void;
const unsubscribe = vi.fn();

function request(window = opened): IpcMainInvokeEvent {
  return { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as IpcMainInvokeEvent;
}

beforeEach(() => {
  vi.clearAllMocks();
  handlers.clear();
  main = new WindowStub();
  Object.assign(app, { removeListener: vi.fn() });
  Object.assign(ipcMain, { removeHandler: vi.fn((channel: string) => handlers.delete(channel)) });
  vi.mocked(ipcMain.handle).mockImplementation((channel, handler) => { handlers.set(channel, handler); });
  vi.mocked(BrowserWindow).mockImplementation(function () {
    opened = new WindowStub();
    return asWindow(opened);
  });
  vi.mocked(subscribeSettingsChanges).mockReturnValue(unsubscribe);
  dispose = initSettingsWindow(asWindow(main));
});

afterEach(() => { dispose(); restorePlatform(); });

describe('Settings window', () => {
  it('uses a sandboxed local page with normal window controls', () => {
    showSettingsWindow();
    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
      frame: true, resizable: true, minWidth: 360, minHeight: 420,
      webPreferences: expect.objectContaining({ contextIsolation: true, sandbox: true, nodeIntegration: false }),
    }));
    expect(opened.loadFile).toHaveBeenCalledWith(getAssetPath('assets', 'settings.html'));
    expect(opened.show).not.toHaveBeenCalled();
    opened.emit('ready-to-show');
    expect(opened.show).toHaveBeenCalledOnce();
    opened.minimised = true;
    showSettingsWindow();
    expect(BrowserWindow).toHaveBeenCalledOnce();
    expect(opened.restore).toHaveBeenCalledOnce();
    expect(opened.focus).toHaveBeenCalledOnce();
  });

  it('reopens without registering duplicate handlers or subscribers', () => {
    showSettingsWindow();
    opened.close();
    showSettingsWindow();
    expect(BrowserWindow).toHaveBeenCalledTimes(2);
    expect(ipcMain.handle).toHaveBeenCalledTimes(2);
    expect(subscribeSettingsChanges).toHaveBeenCalledOnce();
  });

  it('accepts only the current Settings document and passes unknown payloads to the validator', () => {
    showSettingsWindow();
    const read = handlers.get('settings:get')!;
    const apply = handlers.get('settings:apply')!;
    expect(read(request())).toEqual({ theme: 'apple-music' });
    const payload = { type: 'theme', value: 'custom' };
    expect(apply(request(), payload)).toEqual({ theme: 'custom' });
    expect(applySettingsAction).toHaveBeenCalledWith(payload);
    const attacks = [
      request(main),
      { ...request(), senderFrame: { url: opened.url } },
      { ...request(), senderFrame: null },
    ];
    for (const event of attacks) {
      expect(() => read(event as IpcMainInvokeEvent)).toThrow('Invalid settings sender');
      expect(() => apply(event as IpcMainInvokeEvent, payload)).toThrow('Invalid settings sender');
    }
    opened.webContents.mainFrame.url = 'https://music.apple.com';
    expect(() => read(request())).toThrow('Invalid settings sender');
    opened.webContents.mainFrame.url = opened.url;
    opened.url += '?other';
    expect(() => read(request())).toThrow('Invalid settings sender');
    opened.close();
    expect(() => read(request())).toThrow('Invalid settings sender');
    expect(getSettingsState).toHaveBeenCalledOnce();
  });

  it('blocks navigation, redirects and new windows', () => {
    showSettingsWindow();
    for (const name of ['will-navigate', 'will-frame-navigate', 'will-redirect']) {
      const event = { preventDefault: vi.fn() };
      opened.webContents.emit(name, event);
      expect(event.preventDefault).toHaveBeenCalledOnce();
    }
    expect(opened.webContents.setWindowOpenHandler.mock.calls[0][0]()).toEqual({ action: 'deny' });
  });

  it('publishes state only to the exact current document', () => {
    showSettingsWindow();
    const listener = vi.mocked(subscribeSettingsChanges).mock.calls[0][0];
    const state = { theme: 'custom' } as SettingsState;
    listener(state);
    expect(opened.webContents.send).toHaveBeenCalledWith('settings:state', state);
    opened.url = 'file:///another.html';
    listener(state);
    expect(opened.webContents.send).toHaveBeenCalledOnce();
  });

  it.each(['linux', 'darwin', 'win32'])('handles a local platform-correct shortcut on %s', platform => {
    setPlatform(platform);
    const input = { type: 'keyDown', key: ',', meta: platform === 'darwin', control: platform !== 'darwin', alt: false, shift: false, isAutoRepeat: false };
    const event = { preventDefault: vi.fn() };
    for (const invalid of [{ ...input, type: 'keyUp' }, { ...input, alt: true }, { ...input, shift: true }, { ...input, meta: !input.meta, control: !input.control }]) {
      main.webContents.emit('before-input-event', event, invalid);
    }
    expect(BrowserWindow).not.toHaveBeenCalled();
    main.webContents.emit('before-input-event', event, input);
    main.webContents.emit('before-input-event', event, { ...input, isAutoRepeat: true });
    expect(BrowserWindow).toHaveBeenCalledOnce();
    expect(opened.focus).not.toHaveBeenCalled();
  });

  it('opens from only the player main frame on an allowed service', () => {
    handleSettingsNavigation(request(main) as unknown as IpcMainEvent, asWindow(main));
    expect(BrowserWindow).not.toHaveBeenCalled();
    main.webContents.mainFrame.url = 'https://classical.music.apple.com/';
    handleSettingsNavigation(request(main) as unknown as IpcMainEvent, asWindow(main));
    expect(BrowserWindow).toHaveBeenCalledOnce();
    const subframe = { ...request(main), senderFrame: { url: main.webContents.mainFrame.url } };
    handleSettingsNavigation(subframe as unknown as IpcMainEvent, asWindow(main));
    expect(opened.focus).not.toHaveBeenCalled();
  });

  it.each(['main close', 'quit'])('cleans handlers, subscriptions and the window on %s', trigger => {
    showSettingsWindow();
    if (trigger === 'main close') main.close();
    else quit();
    expect(opened.close).toHaveBeenCalledOnce();
    expect(main.webContents.listenerCount('before-input-event')).toBe(0);
    expect(handlers.size).toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    showSettingsWindow();
    expect(BrowserWindow).toHaveBeenCalledOnce();
  });

  it('cleans up when Electron invalidates the destroyed main window getters', () => {
    showSettingsWindow();
    const contents = main.webContents;
    Object.defineProperty(main, 'webContents', {
      get: () => {
        if (main.destroyed) throw new Error('Object has been destroyed');
        return contents;
      },
    });
    expect(() => main.close()).not.toThrow();
    expect(opened.close).toHaveBeenCalledOnce();
    expect(contents.listenerCount('before-input-event')).toBe(0);
    expect(main.listenerCount('closed')).toBe(0);
    expect(app.removeListener).toHaveBeenCalledWith('will-quit', dispose);
    expect(handlers.size).toBe(0);
    expect(unsubscribe).toHaveBeenCalledOnce();
    dispose();
    expect(unsubscribe).toHaveBeenCalledOnce();
    showSettingsWindow();
    expect(BrowserWindow).toHaveBeenCalledOnce();
  });
});
