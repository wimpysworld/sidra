import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { restorePlatform, setPlatform } from './mocks/platform';

type Listener = (...args: unknown[]) => unknown;

const bootstrap = vi.hoisted(() => {
  const mainWebListeners = new Map<string, Listener>();
  const appListeners = new Map<string, Listener>();

  const webContents = {
    on: vi.fn((event: string, listener: Listener) => {
      mainWebListeners.set(event, listener);
    }),
    once: vi.fn(),
    executeJavaScript: vi.fn(() => Promise.resolve(true)),
    insertCSS: vi.fn(() => Promise.resolve('css-key')),
    setZoomFactor: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    getURL: vi.fn(() => 'https://music.apple.com/gb/new'),
    openDevTools: vi.fn(),
    send: vi.fn(),
    reload: vi.fn(),
    navigationHistory: {
      goBack: vi.fn(),
      goForward: vi.fn(),
    },
  };

  const mainWindow = {
    webContents,
    loadURL: vi.fn(() => Promise.reject(new Error('offline'))),
    on: vi.fn(),
    once: vi.fn(),
    show: vi.fn(),
    hide: vi.fn(),
    close: vi.fn(),
    focus: vi.fn(),
    restore: vi.fn(),
    isVisible: vi.fn(() => true),
    isMinimized: vi.fn(() => false),
  };

  const splashWindow = {
    webContents: {
      on: vi.fn(),
      setZoomFactor: vi.fn(),
    },
    loadFile: vi.fn(() => Promise.resolve()),
    show: vi.fn(),
    close: vi.fn(),
  };

  const integrations = {
    notifications: vi.fn(),
    discord: vi.fn(),
    lastfm: vi.fn(),
    dock: vi.fn(),
    windowsTaskbar: vi.fn(),
    wedgeDetector: vi.fn(),
    trayState: vi.fn(() => vi.fn()),
  };
  const resetForDocumentReplacement = vi.fn();

  return {
    mainWebListeners,
    appListeners,
    webContents,
    mainWindow,
    splashWindow,
    integrations,
    resetForDocumentReplacement,
    browserWindow: vi.fn(),
    ipcOn: vi.fn(),
    appQuit: vi.fn(),
    appOn: vi.fn((event: string, listener: Listener) => {
      appListeners.set(event, listener);
    }),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      silly: vi.fn(),
    },
    tray: {},
  };
});

vi.mock('electron', () => ({
  app: {
    name: 'Sidra',
    isPackaged: false,
    getName: vi.fn(() => 'Sidra'),
    getVersion: vi.fn(() => '0.3.0'),
    getPath: vi.fn((name: string) => `/tmp/sidra-test/${name}`),
    whenReady: vi.fn(() => Promise.resolve()),
    on: bootstrap.appOn,
    quit: bootstrap.appQuit,
    requestSingleInstanceLock: vi.fn(() => true),
    setAppUserModelId: vi.fn(),
    setAsDefaultProtocolClient: vi.fn(() => true),
    commandLine: { appendSwitch: vi.fn() },
    setDesktopName: vi.fn(),
    userAgentFallback: '',
  },
  BrowserWindow: bootstrap.browserWindow,
  components: {
    whenReady: vi.fn(() => Promise.resolve()),
    status: vi.fn(() => ({})),
  },
  ipcMain: { on: bootstrap.ipcOn },
  Menu: {
    buildFromTemplate: vi.fn(),
    setApplicationMenu: vi.fn(),
  },
  session: {
    defaultSession: { setUserAgent: vi.fn() },
    fromPartition: vi.fn(() => ({
      clearData: vi.fn(() => Promise.resolve()),
      setUserAgent: vi.fn(),
      webRequest: { onBeforeSendHeaders: vi.fn() },
    })),
  },
  Tray: class {},
  webFrameMain: { fromId: vi.fn() },
}));

vi.mock('electron-log/main', () => ({
  default: {
    initialize: vi.fn(),
    transports: {
      file: { level: 'info', format: '' },
      console: { level: 'debug', format: '' },
    },
    scope: vi.fn(() => bootstrap.log),
  },
}));

vi.mock('fs', () => ({
  default: { readFileSync: vi.fn(() => 'asset') },
}));

vi.mock('../src/config', () => ({
  getZoomFactor: vi.fn(() => 1),
  getCloseToTrayEnabled: vi.fn(() => false),
  getMusicService: vi.fn(() => 'music'),
}));

vi.mock('../src/i18n', () => ({
  getLoadingText: vi.fn(() => ({ text: 'Loading...', lang: 'en' })),
  getNavigationStrings: vi.fn(() => ({})),
  NAV_LABELS_TOKEN: '__NAV_LABELS__',
}));

vi.mock('../src/paths', () => ({ getAssetPath: vi.fn((...parts: string[]) => parts.join('/')) }));

vi.mock('../src/player', () => ({
  Player: class {
    resetForDocumentReplacement = bootstrap.resetForDocumentReplacement;
  },
}));

vi.mock('../src/storefront', () => ({
  buildAppleMusicURL: vi.fn(() => 'https://music.apple.com/gb/new'),
  buildItmsRouteURL: vi.fn(),
  handleStorefrontNavigation: vi.fn(),
  handleLastPageNavigation: vi.fn(),
}));

vi.mock('../src/itms', () => ({ extractItmsUrlFromArgv: vi.fn(() => null) }));

vi.mock('../src/serviceSwitch', () => ({
  initServiceSwitch: vi.fn(),
  routeToMusicService: vi.fn(),
  switchService: vi.fn(),
}));

vi.mock('../src/theme', () => ({
  initThemeCSS: vi.fn(),
  injectThemeCss: vi.fn(() => Promise.resolve()),
  setRebuildTrayCallback: vi.fn(),
}));

vi.mock('../src/tray', () => ({
  createTray: vi.fn(() => bootstrap.tray),
  getMenuIcon: vi.fn(),
  initTrayStateManager: bootstrap.integrations.trayState,
  rebuildTrayMenu: vi.fn(),
  setGetMainWindowCallback: vi.fn(),
  setShowSettingsCallback: vi.fn(),
}));

vi.mock('../src/settings', () => ({
  initSettingsActions: vi.fn(() => vi.fn()),
  notifySettingsChanged: vi.fn(),
}));
vi.mock('../src/settingsWindow', () => ({
  initSettingsWindow: vi.fn(),
  showSettingsWindow: vi.fn(),
  handleSettingsNavigation: vi.fn(),
}));

vi.mock('../src/commandBridge', () => ({ initCommandBridge: vi.fn() }));
vi.mock('../src/controllerIPC', () => ({
  initControllerIPC: vi.fn(),
  goBackIfPossible: vi.fn(),
}));
vi.mock('../src/aboutWindow', () => ({ showAboutWindow: vi.fn() }));
vi.mock('../src/update', () => ({ checkForUpdates: vi.fn() }));
vi.mock('../src/autoUpdate', () => ({ isAutoUpdateSupported: vi.fn(() => false), initAutoUpdate: vi.fn() }));

vi.mock('../src/musicService', () => ({
  getService: vi.fn(() => ({ contentReadySelector: '#content' })),
  allServices: vi.fn(() => [{
    origin: 'https://music.apple.com',
    authFrameHosts: ['idmsa.apple.com'],
  }]),
  isAllowedNavigationUrl: vi.fn(() => true),
}));

vi.mock('../src/integrations/notifications', () => ({ init: bootstrap.integrations.notifications }));
vi.mock('../src/integrations/discord-presence', () => ({ init: bootstrap.integrations.discord }));
vi.mock('../src/integrations/lastfm', () => ({ init: bootstrap.integrations.lastfm }));
vi.mock('../src/integrations/macos-dock', () => ({ init: bootstrap.integrations.dock }));
vi.mock('../src/integrations/windows-taskbar', () => ({ init: bootstrap.integrations.windowsTaskbar }));
vi.mock('../src/artwork', () => ({ cleanArtworkCache: vi.fn() }));
vi.mock('../src/wedgeDetector', () => ({
  init: bootstrap.integrations.wedgeDetector,
  reset: vi.fn(),
}));
vi.mock('../src/contentReady', () => ({ contentReadyProbeScript: vi.fn(() => 'true') }));
vi.mock('../src/notify', () => ({ initNotificationProbe: vi.fn() }));
vi.mock('../src/utils/openExternal', () => ({ openExternalUrl: vi.fn() }));

vi.mock('../src/utils', () => ({
  runSteps: (steps: ReadonlyArray<readonly [string, () => void]>, report: (name: string, error: unknown) => void) => {
    for (const [name, step] of steps) {
      try {
        step();
      } catch (error: unknown) {
        report(name, error);
      }
    }
  },
}));

describe('main bootstrap', () => {
  let chromeDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    setPlatform('win32');
    chromeDescriptor = Object.getOwnPropertyDescriptor(process.versions, 'chrome');
    Object.defineProperty(process.versions, 'chrome', { value: '148.2.3.4', configurable: true });
    bootstrap.mainWebListeners.clear();
    bootstrap.appListeners.clear();
    bootstrap.browserWindow
      .mockImplementationOnce(function () { return bootstrap.splashWindow; })
      .mockImplementationOnce(function () { return bootstrap.mainWindow; });
    bootstrap.mainWindow.loadURL.mockRejectedValue(new Error('offline'));
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    restorePlatform();
    if (chromeDescriptor) {
      Object.defineProperty(process.versions, 'chrome', chromeDescriptor);
    } else {
      Reflect.deleteProperty(process.versions, 'chrome');
    }
  });

  async function startMain(): Promise<void> {
    await import('../src/main');
    for (let i = 0; i < 10 && bootstrap.mainWindow.loadURL.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    await Promise.resolve();
  }

  it('creates a locked-down window, wires integrations, and contains first navigation failure', async () => {
    await startMain();

    expect(bootstrap.browserWindow).toHaveBeenNthCalledWith(1, expect.objectContaining({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    }));
    expect(bootstrap.browserWindow).toHaveBeenNthCalledWith(2, expect.objectContaining({
      title: 'Sidra',
      show: false,
      webPreferences: expect.objectContaining({
        partition: 'persist:sidra',
        nodeIntegration: false,
        contextIsolation: true,
        spellcheck: false,
        plugins: true,
        sandbox: true,
      }),
    }));
    expect(bootstrap.mainWindow.loadURL).toHaveBeenCalledWith(
      'https://music.apple.com/gb/new',
      { userAgent: expect.stringContaining('Chrome/148.0.0.0') },
    );
    expect(bootstrap.log.warn).toHaveBeenCalledWith('initial navigation loadURL failed:', 'offline');

    const didFinishLoad = bootstrap.mainWebListeners.get('did-finish-load');
    expect(didFinishLoad).toBeDefined();
    await didFinishLoad?.();

    expect(bootstrap.integrations.notifications).toHaveBeenCalledOnce();
    expect(bootstrap.integrations.discord).toHaveBeenCalledOnce();
    expect(bootstrap.integrations.lastfm).toHaveBeenCalledOnce();
    expect(bootstrap.integrations.dock).toHaveBeenCalledOnce();
    expect(bootstrap.integrations.windowsTaskbar).toHaveBeenCalledOnce();
    expect(bootstrap.integrations.wedgeDetector).toHaveBeenCalledOnce();
    expect(bootstrap.integrations.trayState).toHaveBeenCalledOnce();
    expect(bootstrap.appOn).toHaveBeenCalledWith('will-quit', expect.any(Function));
  });

  it('initialises controller IPC once and reuses guarded back navigation', async () => {
    const { goBackIfPossible, initControllerIPC } = await import('../src/controllerIPC');
    await startMain();

    expect(initControllerIPC).toHaveBeenCalledOnce();
    expect(initControllerIPC).toHaveBeenCalledWith(bootstrap.mainWindow);

    const backCall = bootstrap.ipcOn.mock.calls.find(([channel]) => channel === 'nav:back');
    expect(backCall).toBeDefined();
    backCall?.[1]();
    expect(goBackIfPossible).toHaveBeenCalledWith(bootstrap.mainWindow);
  });

  it('wires Settings entry points and refreshes state without a tray', async () => {
    const { initSettingsActions, notifySettingsChanged } = await import('../src/settings');
    const { initSettingsWindow, showSettingsWindow, handleSettingsNavigation } = await import('../src/settingsWindow');
    const { createTray, setShowSettingsCallback } = await import('../src/tray');
    const { initServiceSwitch } = await import('../src/serviceSwitch');
    const { setRebuildTrayCallback } = await import('../src/theme');
    vi.mocked(createTray).mockReturnValueOnce(null as unknown as ReturnType<typeof createTray>);
    await startMain();
    expect(initSettingsActions).toHaveBeenCalledOnce();
    expect(initSettingsWindow).toHaveBeenCalledWith(bootstrap.mainWindow);
    expect(setShowSettingsCallback).toHaveBeenCalledWith(showSettingsWindow);
    const nav = bootstrap.ipcOn.mock.calls.find(([channel]) => channel === 'nav:settings');
    const event = {};
    nav?.[1](event);
    expect(handleSettingsNavigation).toHaveBeenCalledWith(event, bootstrap.mainWindow);
    vi.mocked(setRebuildTrayCallback).mock.calls[0][0]();
    expect(notifySettingsChanged).toHaveBeenCalledOnce();
    vi.mocked(initServiceSwitch).mock.calls[0][0].loadURL('https://music.apple.com/gb/new');
    expect(notifySettingsChanged).toHaveBeenCalledTimes(2);
  });

  it('resets controller state only for main-frame navigation', async () => {
    await startMain();
    const didStartNavigation = bootstrap.mainWebListeners.get('did-start-navigation');
    expect(didStartNavigation).toBeDefined();

    didStartNavigation?.({
      url: 'https://music.apple.com/gb/new#dialog',
      isSameDocument: true,
      isMainFrame: true,
    });
    expect(bootstrap.webContents.send).toHaveBeenCalledWith('controller:reset');

    didStartNavigation?.({
      url: 'https://music.apple.com/gb/album/example',
      isSameDocument: false,
      isMainFrame: true,
    });
    expect(bootstrap.webContents.send).toHaveBeenCalledTimes(2);

    didStartNavigation?.({
      url: 'https://music.apple.com/gb/iframe',
      isSameDocument: false,
      isMainFrame: false,
    });
    expect(bootstrap.webContents.send).toHaveBeenCalledTimes(2);
  });

  it('resets playback only after a committed document navigation', async () => {
    const { handleStorefrontNavigation } = await import('../src/storefront');
    await startMain();
    const didStartNavigation = bootstrap.mainWebListeners.get('did-start-navigation');
    const didNavigate = bootstrap.mainWebListeners.get('did-navigate');
    const didNavigateInPage = bootstrap.mainWebListeners.get('did-navigate-in-page');

    expect(didStartNavigation).toBeDefined();
    expect(didNavigate).toBeDefined();
    expect(didNavigateInPage).toBeDefined();

    didStartNavigation?.({
      url: 'https://music.apple.com/gb/album/example',
      isSameDocument: false,
      isMainFrame: true,
    });
    await didNavigateInPage?.({}, 'https://music.apple.com/gb/new#dialog');
    expect(bootstrap.resetForDocumentReplacement).not.toHaveBeenCalled();

    didNavigate?.({}, 'https://music.apple.com/gb/album/example');

    expect(bootstrap.resetForDocumentReplacement).toHaveBeenCalledOnce();
    expect(bootstrap.resetForDocumentReplacement.mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(handleStorefrontNavigation).mock.invocationCallOrder.at(-1)!);
  });

  it('logs process lifecycle events without private event data', async () => {
    const privatePath = '/home/alice/.config/sidra/access-token-secret/preload.js';
    const privateUrl = 'https://music.apple.com/gb/album/private?token=secret-token';
    const privateStack = `Error: secret-token\n    at ${privatePath}:1:1`;
    const privateMetadata = { title: 'Private Track', url: privateUrl };

    await startMain();

    const childProcessGoneCall = bootstrap.appOn.mock.calls
      .findIndex(([event]) => event === 'child-process-gone');
    expect(bootstrap.appOn.mock.invocationCallOrder[childProcessGoneCall])
      .toBeLessThan(bootstrap.browserWindow.mock.invocationCallOrder[0]);

    bootstrap.log.info.mockClear();
    bootstrap.log.warn.mockClear();
    bootstrap.log.error.mockClear();

    const unresponsive = bootstrap.mainWebListeners.get('unresponsive');
    const responsive = bootstrap.mainWebListeners.get('responsive');
    const renderProcessGone = bootstrap.mainWebListeners.get('render-process-gone');
    const preloadError = bootstrap.mainWebListeners.get('preload-error');
    const childProcessGone = bootstrap.appListeners.get('child-process-gone');

    expect(unresponsive).toBeDefined();
    expect(responsive).toBeDefined();
    expect(renderProcessGone).toBeDefined();
    expect(preloadError).toBeDefined();
    expect(childProcessGone).toBeDefined();

    unresponsive?.({ url: privateUrl, token: 'secret-token' });
    responsive?.({ url: privateUrl, metadata: privateMetadata });
    renderProcessGone?.({}, {
      reason: 'crashed',
      exitCode: 133,
      url: privateUrl,
      token: 'secret-token',
      metadata: privateMetadata,
      arguments: ['--secret-token'],
    });

    const error = new Error(`failed for ${privateUrl}`);
    error.name = 'TypeError';
    error.stack = privateStack;
    preloadError?.({}, privatePath, error);

    childProcessGone?.({}, {
      type: 'Utility',
      reason: 'crashed',
      exitCode: 9,
      serviceName: 'Audio Service',
      name: privateUrl,
      token: 'secret-token',
      metadata: privateMetadata,
      arguments: ['--secret-token'],
    });
    childProcessGone?.({}, {
      type: 'GPU',
      reason: 'oom',
      exitCode: 137,
      name: privateUrl,
    });

    expect(bootstrap.log.warn).toHaveBeenNthCalledWith(
      1,
      'event=unresponsive processType=renderer',
    );
    expect(bootstrap.log.info).toHaveBeenCalledOnce();
    expect(bootstrap.log.info).toHaveBeenCalledWith('event=responsive processType=renderer');
    expect(bootstrap.log.error).toHaveBeenCalledOnce();
    expect(bootstrap.log.error).toHaveBeenCalledWith(
      'event=render-process-gone processType=renderer reason=crashed exitCode=133',
    );
    expect(bootstrap.log.warn).toHaveBeenNthCalledWith(
      2,
      'event=preload-error processType=renderer preloadPath=preload.js errorName=TypeError',
    );
    expect(bootstrap.log.warn).toHaveBeenNthCalledWith(
      3,
      'event=child-process-gone processType=Utility reason=crashed exitCode=9 serviceName="Audio Service"',
    );
    expect(bootstrap.log.warn).toHaveBeenNthCalledWith(
      4,
      'event=child-process-gone processType=GPU reason=oom exitCode=137',
    );

    const logCalls = JSON.stringify([
      ...bootstrap.log.info.mock.calls,
      ...bootstrap.log.warn.mock.calls,
      ...bootstrap.log.error.mock.calls,
    ]);
    expect(logCalls).not.toContain(privatePath);
    expect(logCalls).not.toContain(privateUrl);
    expect(logCalls).not.toContain('secret-token');
    expect(logCalls).not.toContain(privateStack);
    expect(logCalls).not.toContain('Private Track');
    expect(logCalls).not.toContain('--secret-token');
    expect(bootstrap.webContents.reload).not.toHaveBeenCalled();
    expect(bootstrap.mainWindow.close).not.toHaveBeenCalled();
    expect(bootstrap.appQuit).not.toHaveBeenCalled();
    expect(bootstrap.mainWindow.loadURL).toHaveBeenCalledOnce();
  });

  it('replaces an unsafe preload error name with a fixed fallback', async () => {
    const privateUrl = 'https://music.apple.com/private?token=preload-secret';
    const privateName = `CustomError\r\n${privateUrl}\0token=preload-secret`;
    const privateMessage = `failed to load ${privateUrl}\tpreload-secret`;
    const privateStack = `${privateName}: ${privateMessage}\n    at /private/preload.js:1:1`;

    await startMain();

    bootstrap.log.info.mockClear();
    bootstrap.log.warn.mockClear();
    bootstrap.log.error.mockClear();

    const preloadError = bootstrap.mainWebListeners.get('preload-error');
    expect(preloadError).toBeDefined();

    const error = new Error(privateMessage);
    error.name = privateName;
    error.stack = privateStack;
    preloadError?.({}, '/private/preload.js', error);

    expect(bootstrap.log.warn).toHaveBeenCalledOnce();
    expect(bootstrap.log.warn).toHaveBeenCalledWith(
      'event=preload-error processType=renderer preloadPath=preload.js errorName=UnknownError',
    );
    expect(bootstrap.log.info).not.toHaveBeenCalled();
    expect(bootstrap.log.error).not.toHaveBeenCalled();

    const loggedValues = [
      ...bootstrap.log.info.mock.calls,
      ...bootstrap.log.warn.mock.calls,
      ...bootstrap.log.error.mock.calls,
    ].flat().map(String);
    for (const privateValue of [privateName, privateMessage, privateStack, privateUrl, 'preload-secret']) {
      expect(loggedValues.every(value => !value.includes(privateValue))).toBe(true);
    }
  });
});
