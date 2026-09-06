import { app, BrowserWindow, ipcMain, type IpcMainEvent, type IpcMainInvokeEvent } from 'electron';
import path from 'path';
import { pathToFileURL } from 'url';
import log from 'electron-log/main';
import { getAssetPath } from './paths';
import { getTrayStrings } from './i18n';
import { isAllowedNavigationUrl } from './musicService';
import { applySettingsAction, getSettingsState, subscribeSettingsChanges } from './settings';

let settingsWindow: BrowserWindow | null = null;
let mainWindow: BrowserWindow | null = null;
const settingsLog = log.scope('settings');

function settingsUrl(): string {
  return pathToFileURL(getAssetPath('assets', 'settings.html')).href;
}

function validateSender(event: IpcMainInvokeEvent): void {
  const contents = settingsWindow?.webContents;
  if (!settingsWindow || settingsWindow.isDestroyed() || !contents || contents.isDestroyed()
    || event.sender !== contents || event.senderFrame !== contents.mainFrame
    || event.senderFrame?.url !== settingsUrl() || contents.getURL() !== settingsUrl()) {
    throw new Error('Invalid settings sender');
  }
}

export function showSettingsWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return;
  }
  const window = new BrowserWindow({
    title: getTrayStrings().settings,
    width: 620,
    height: 760,
    minWidth: 360,
    minHeight: 420,
    show: false,
    frame: true,
    resizable: true,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      preload: path.join(__dirname, 'settingsPreload.js'),
    },
  });
  settingsWindow = window;
  window.setMenu(null);
  window.once('ready-to-show', () => {
    if (!window.isDestroyed()) window.show();
  });
  window.once('closed', () => {
    if (settingsWindow === window) settingsWindow = null;
  });
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('will-frame-navigate', event => event.preventDefault());
  window.webContents.on('will-redirect', event => event.preventDefault());
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.loadFile(getAssetPath('assets', 'settings.html')).catch(() => {
    settingsLog.warn('Settings page failed to load');
    if (!window.isDestroyed()) window.close();
  });
}

export function handleSettingsNavigation(event: IpcMainEvent, window: BrowserWindow): void {
  if (window.isDestroyed() || window.webContents.isDestroyed()
    || event.sender !== window.webContents || event.senderFrame !== window.webContents.mainFrame
    || !event.senderFrame || !isAllowedNavigationUrl(event.senderFrame.url)) return;
  showSettingsWindow();
}

export function initSettingsWindow(window: BrowserWindow): () => void {
  mainWindow = window;
  const contents = window.webContents;
  ipcMain.handle('settings:get', event => {
    validateSender(event);
    return getSettingsState();
  });
  ipcMain.handle('settings:apply', (event, action: unknown) => {
    validateSender(event);
    return applySettingsAction(action);
  });
  const unsubscribe = subscribeSettingsChanges(state => {
    const contents = settingsWindow?.webContents;
    if (contents && !contents.isDestroyed() && contents.getURL() === settingsUrl()) {
      contents.send('settings:state', state);
    }
  });
  const onInput = (event: Electron.Event, input: Electron.Input): void => {
    const modifier = process.platform === 'darwin'
      ? input.meta && !input.control : input.control && !input.meta;
    if (input.type !== 'keyDown' || input.key !== ',' || !modifier || input.alt || input.shift) return;
    event.preventDefault();
    if (!input.isAutoRepeat) showSettingsWindow();
  };
  contents.on('before-input-event', onInput);
  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    contents.removeListener('before-input-event', onInput);
    window.removeListener('closed', dispose);
    app.removeListener('will-quit', dispose);
    ipcMain.removeHandler('settings:get');
    ipcMain.removeHandler('settings:apply');
    unsubscribe();
    mainWindow = null;
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  };
  window.once('closed', dispose);
  app.on('will-quit', dispose);
  return dispose;
}
