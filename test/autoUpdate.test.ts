import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Module from 'node:module';
import { restorePlatform, setPlatform } from './mocks/platform';

const updater = vi.hoisted(() => {
  type Listener = (value: { version: string } | Error) => void | Promise<void>;

  class NsisUpdater {}

  const listeners = new Map<string, Listener>();
  const autoUpdater = Object.assign(new NsisUpdater(), {
    logger: {} as unknown,
    autoDownload: false,
    verifyUpdateCodeSignature: vi.fn((_publisherNames: string[], _path: string) => Promise.resolve('rejected')),
    on: vi.fn((event: string, listener: Listener) => {
      listeners.set(event, listener);
      return autoUpdater;
    }),
    checkForUpdates: vi.fn(() => Promise.resolve(null)),
    quitAndInstall: vi.fn(),
  });

  return { autoUpdater, listeners, NsisUpdater };
});

vi.mock('../src/config', () => ({
  getAutoUpdateEnabled: vi.fn(() => true),
}));

vi.mock('../src/i18n', () => ({
  getAutoUpdateStrings: vi.fn(() => ({
    ready: 'Update ready',
    restartNow: 'Restart now',
    later: 'Later',
  })),
}));

vi.mock('../src/update', () => ({
  setUpdateReady: vi.fn(),
  showUpdateNotification: vi.fn(),
}));

import { app, dialog, Tray } from 'electron';
import { getAutoUpdateEnabled } from '../src/config';
import { configureAutoUpdate, initAutoUpdate, isAutoUpdateSupported } from '../src/autoUpdate';
import { setUpdateReady, showUpdateNotification } from '../src/update';

const moduleApi = Module as unknown as {
  _load: (request: string, parent: unknown, isMain: boolean) => unknown;
};
const realLoad = moduleApi._load;

function configure(tray: Tray, rebuildMenu: (tray: Tray) => void): Promise<void> {
  const updaterModule = {
    autoUpdater: updater.autoUpdater,
    NsisUpdater: updater.NsisUpdater,
  } as unknown as Parameters<typeof configureAutoUpdate>[0];
  return configureAutoUpdate(updaterModule, tray, rebuildMenu);
}

describe('auto-update', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    updater.listeners.clear();
    updater.autoUpdater.logger = {};
    updater.autoUpdater.autoDownload = false;
    updater.autoUpdater.verifyUpdateCodeSignature = vi.fn(
      (_publisherNames: string[], _path: string) => Promise.resolve('rejected'),
    );
    updater.autoUpdater.checkForUpdates.mockResolvedValue(null);
    vi.mocked(getAutoUpdateEnabled).mockReturnValue(true);
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });
    vi.stubEnv('APPIMAGE', '');
    vi.stubEnv('SNAP', '');
    vi.stubEnv('SIDRA_DISABLE_AUTO_UPDATE', '');
    Object.defineProperty(app, 'isPackaged', { value: false, configurable: true, writable: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    moduleApi._load = realLoad;
    restorePlatform();
    vi.unstubAllEnvs();
  });

  it('supports AppImage and packaged Windows installs only', () => {
    setPlatform('linux');
    vi.stubEnv('APPIMAGE', '/tmp/Sidra.AppImage');
    expect(isAutoUpdateSupported()).toBe(true);

    vi.stubEnv('SNAP', '/snap/sidra/current');
    expect(isAutoUpdateSupported()).toBe(false);

    vi.stubEnv('APPIMAGE', '');
    vi.stubEnv('SNAP', '');
    setPlatform('win32');
    Object.defineProperty(app, 'isPackaged', { value: true, configurable: true, writable: true });
    expect(isAutoUpdateSupported()).toBe(true);

    setPlatform('darwin');
    expect(isAutoUpdateSupported()).toBe(false);
  });

  it('respects the environment and config disable switches', () => {
    setPlatform('linux');
    vi.stubEnv('APPIMAGE', '/tmp/Sidra.AppImage');
    vi.stubEnv('SIDRA_DISABLE_AUTO_UPDATE', '1');
    expect(isAutoUpdateSupported()).toBe(false);

    vi.stubEnv('SIDRA_DISABLE_AUTO_UPDATE', '');
    vi.mocked(getAutoUpdateEnabled).mockReturnValue(false);
    expect(isAutoUpdateSupported()).toBe(false);
  });

  it('configures the updater and registers its workflow handlers', async () => {
    const tray = new Tray('icon');

    await configure(tray, vi.fn());

    expect(updater.autoUpdater.logger).toBeNull();
    expect(updater.autoUpdater.autoDownload).toBe(true);
    expect(updater.autoUpdater.on.mock.calls.map(([event]) => event)).toEqual([
      'update-available',
      'update-downloaded',
      'error',
    ]);
    expect(updater.autoUpdater.checkForUpdates).toHaveBeenCalledOnce();
    await expect(updater.autoUpdater.verifyUpdateCodeSignature([], 'update.exe')).resolves.toBeNull();
  });

  it('records a download, rebuilds the menu, and installs from either prompt', async () => {
    vi.spyOn(app, 'getName').mockReturnValue('Test Player');
    const tray = new Tray('icon');
    const rebuildMenu = vi.fn();
    await configure(tray, rebuildMenu);

    const downloaded = updater.listeners.get('update-downloaded');
    expect(downloaded).toBeDefined();
    await downloaded?.({ version: '1.2.3' });

    expect(setUpdateReady).toHaveBeenCalledWith('1.2.3');
    expect(rebuildMenu).toHaveBeenCalledWith(tray);
    expect(showUpdateNotification).toHaveBeenCalledWith('1.2.3', 'update-downloaded', expect.any(Function));
    expect(dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Update ready',
      message: 'Test Player 1.2.3',
      buttons: ['Restart now', 'Later'],
    }));
    expect(updater.autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    const notificationClick = vi.mocked(showUpdateNotification).mock.calls[0][2];
    notificationClick();
    expect(updater.autoUpdater.quitAndInstall).toHaveBeenCalledOnce();

    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 0, checkboxChecked: false });
    await downloaded?.({ version: '1.2.4' });
    expect(updater.autoUpdater.quitAndInstall).toHaveBeenCalledTimes(2);
  });

  it('contains a failed update check', async () => {
    updater.autoUpdater.checkForUpdates.mockRejectedValue(new Error('offline'));

    await expect(configure(new Tray('icon'), vi.fn())).resolves.toBeUndefined();
  });

  it('contains a failed updater load', async () => {
    moduleApi._load = (request, parent, isMain) => {
      if (request === 'electron-updater') throw new Error('cannot find module');
      return Reflect.apply(realLoad, Module, [request, parent, isMain]);
    };

    await expect(initAutoUpdate(new Tray('icon'), vi.fn())).resolves.toBeUndefined();
  });
});
