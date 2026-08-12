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

  return {
    mainWebListeners,
    appListeners,
    webContents,
    mainWindow,
    splashWindow,
    integrations,
    browserWindow: vi.fn(),
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
    quit: vi.fn(),
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
  ipcMain: { on: vi.fn() },
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

vi.mock('../src/player', () => ({ Player: class {} }));

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
  setApplyZoomCallback: vi.fn(),
  setGetMainWindowCallback: vi.fn(),
  setSwitchServiceCallback: vi.fn(),
}));

vi.mock('../src/commandBridge', () => ({ initCommandBridge: vi.fn() }));
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

  it('creates a locked-down window, wires integrations, and contains first navigation failure', async () => {
    await import('../src/main');
    for (let i = 0; i < 10 && bootstrap.mainWindow.loadURL.mock.calls.length === 0; i++) {
      await Promise.resolve();
    }
    await Promise.resolve();

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
});
