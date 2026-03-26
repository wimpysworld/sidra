// test/setup.ts
import { vi } from 'vitest';

// Mock electron modules - these are unavailable outside the Electron runtime.
// Each test file can override specific behaviour via vi.mocked().
vi.mock('electron', () => ({
  app: {
    getName: () => 'Sidra',
    getVersion: () => '0.3.0',
    getPath: (name: string) => `/tmp/sidra-test/${name}`,
    getPreferredSystemLanguages: () => ['en-GB', 'en'],
    getLocaleCountryCode: () => 'GB',
    isPackaged: false,
    whenReady: () => new Promise(() => {}),  // Never resolves - prevents bootstrap from running
    on: vi.fn(),
    emit: vi.fn(),
    quit: vi.fn(),
    setAppUserModelId: vi.fn(),
    commandLine: { appendSwitch: vi.fn() },
    setDesktopName: vi.fn(),
    userAgentFallback: '',
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() },
  session: {
    defaultSession: { setUserAgent: vi.fn() },
    fromPartition: vi.fn(() => ({
      setUserAgent: vi.fn(),
      clearData: vi.fn(() => Promise.resolve()),
      webRequest: { onBeforeSendHeaders: vi.fn() },
    })),
  },
  components: {
    whenReady: () => Promise.resolve(),
    status: () => ({}),
  },
  shell: { openExternal: vi.fn() },
  nativeTheme: { shouldUseDarkColors: true, on: vi.fn() },
  nativeImage: {
    createFromPath: vi.fn(() => ({
      isEmpty: () => false,
      resize: vi.fn(function (this: { isEmpty: () => boolean; toPNG: () => Buffer }) { return this; }),
      toPNG: vi.fn(() => Buffer.from([])),
    })),
    createFromNamedImage: vi.fn(() => ({
      isEmpty: () => false,
      resize: vi.fn(function (this: { isEmpty: () => boolean; toPNG: () => Buffer }) { return this; }),
      toPNG: vi.fn(() => Buffer.from([])),
    })),
    createEmpty: vi.fn(() => ({
      isEmpty: () => true,
      addRepresentation: vi.fn(),
    })),
  },
  Menu: {
    buildFromTemplate: vi.fn((template: unknown[]) => ({ items: template })),
    setApplicationMenu: vi.fn(),
  },
  Tray: class MockTray {
    setContextMenu = vi.fn();
    setToolTip = vi.fn();
    setImage = vi.fn();
    on = vi.fn();
  },
  Notification: vi.fn(),
  dialog: { showMessageBox: vi.fn() },
  net: { fetch: vi.fn() },
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { send: vi.fn() },
}));

vi.mock('electron-log/main', () => {
  const noop = vi.fn();
  const scopedLogger = { info: noop, warn: noop, error: noop, debug: noop, silly: noop };
  return {
    default: {
      initialize: noop,
      transports: {
        file: { level: 'info', format: '' },
        console: { level: 'debug', format: '' },
      },
      scope: () => scopedLogger,
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
    },
  };
});

// Mock process.getSystemVersion() - used by tray.ts for macOS version detection.
// Default returns '15.0.0' (pre-Tahoe). Tests override via vi.spyOn().
if (!process.getSystemVersion) {
  (process as unknown as Record<string, unknown>).getSystemVersion = vi.fn(() => '15.0.0');
} else {
  vi.spyOn(process, 'getSystemVersion').mockReturnValue('15.0.0');
}

vi.mock('electron-store', () => {
  const data = new Map<string, unknown>();
  return {
    default: class {
      has(key: string) { return data.has(key); }
      get(key: string) { return data.get(key); }
      set(key: string, value: unknown) { data.set(key, value); }
      clear() { data.clear(); }
      // Expose for test manipulation
      static _data = data;
    },
  };
});
