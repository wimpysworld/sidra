import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/config', () => ({
  getZoomFactor: vi.fn(() => 1.0),
}));

vi.mock('../src/i18n', () => ({
  getTrayStrings: () => ({ about: 'About Sidra' }),
  getAboutStrings: () => ({ close: 'Close', versionPrefix: 'Version', copyrightSuffix: 'All rights reserved', licensePrefix: 'License' }),
}));

vi.mock('../src/paths', () => ({
  getAssetPath: vi.fn((...parts: string[]) => parts.join('/')),
  getProductInfo: () => ({ productName: 'Sidra', description: 'Apple Music client', author: 'Test', license: 'MIT' }),
}));

import type { BrowserWindow as ElectronBrowserWindow } from 'electron';

// Helpers to build a mock BrowserWindow with event support
interface MockWebContents {
  setZoomFactor: ReturnType<typeof vi.fn>;
}

interface MockBrowserWindowInstance {
  once: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  show: ReturnType<typeof vi.fn>;
  loadFile: ReturnType<typeof vi.fn>;
  webContents: MockWebContents;
  _listeners: Record<string, ((...args: unknown[]) => void)[]>;
}

function createMockBrowserWindow(): MockBrowserWindowInstance {
  const listeners: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    _listeners: listeners,
    once: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(handler);
    }),
    on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
      listeners[event] = listeners[event] ?? [];
      listeners[event].push(handler);
    }),
    focus: vi.fn(),
    show: vi.fn(),
    loadFile: vi.fn(),
    webContents: {
      setZoomFactor: vi.fn(),
    },
  };
}

// The most recently constructed mock window, assigned by the constructor mock.
let latestMockInstance: MockBrowserWindowInstance;

describe('showAboutWindow', () => {
  let showAboutWindow: typeof import('../src/aboutWindow').showAboutWindow;
  let BrowserWindow: typeof import('electron').BrowserWindow;
  let app: typeof import('electron').app;
  let getZoomFactor: typeof import('../src/config').getZoomFactor;

  beforeEach(async () => {
    // src/aboutWindow.ts holds its window at module scope, so each test loads a
    // fresh copy rather than closing the previous window by hand.
    vi.resetModules();

    // resetModules re-runs the mock factories, so the local references must be
    // rebound or they point at the previous test's instances.
    const electron = await import('electron');
    BrowserWindow = electron.BrowserWindow;
    app = electron.app;
    ({ getZoomFactor } = await import('../src/config'));

    // BrowserWindow is called with `new`, so the mock must be a constructor function
    vi.mocked(BrowserWindow).mockImplementation(function (this: unknown) {
      latestMockInstance = createMockBrowserWindow();
      return latestMockInstance as unknown as ElectronBrowserWindow;
    } as unknown as () => ElectronBrowserWindow);
    vi.mocked(getZoomFactor).mockReturnValue(1.0);
    vi.mocked(BrowserWindow).mockClear();

    ({ showAboutWindow } = await import('../src/aboutWindow'));
  });

  it('creates a BrowserWindow with correct options', () => {
    showAboutWindow();

    expect(BrowserWindow).toHaveBeenCalledOnce();
    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
      width: 400,
      height: 400,
      frame: false,
      resizable: false,
      fullscreenable: false,
      fullscreen: false,
      center: true,
      skipTaskbar: true,
      backgroundColor: '#1a0a10',
      show: false,
      webPreferences: expect.objectContaining({
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      }),
    }));
  });

  it('scales window dimensions by zoom factor', () => {
    vi.mocked(getZoomFactor).mockReturnValue(1.5);
    showAboutWindow();

    expect(BrowserWindow).toHaveBeenCalledWith(expect.objectContaining({
      width: 600,
      height: 600,
    }));
  });

  it('calls loadFile with correct query params', () => {
    showAboutWindow();

    expect(latestMockInstance.loadFile).toHaveBeenCalledWith('assets/about.html', {
      query: {
        name: 'Sidra',
        version: app.getVersion(),
        description: 'Apple Music client',
        author: 'Test',
        license: 'MIT',
        about: 'About Sidra',
        close: 'Close',
        versionPrefix: 'Version',
        copyrightSuffix: 'All rights reserved',
        licensePrefix: 'License',
      },
    });
  });

  it('focuses existing window instead of creating a new one', () => {
    showAboutWindow();
    vi.mocked(BrowserWindow).mockClear();

    showAboutWindow();

    expect(BrowserWindow).not.toHaveBeenCalled();
    expect(latestMockInstance.focus).toHaveBeenCalledOnce();
  });

  it('resets aboutWindow to null on closed event', () => {
    showAboutWindow();

    const closedHandlers = latestMockInstance._listeners['closed'];
    expect(closedHandlers).toBeDefined();
    expect(closedHandlers.length).toBeGreaterThan(0);
    closedHandlers[0]();

    // The module holds one window reference, so a closed window that is not
    // cleared leaves the About item dead for the rest of the session: focus()
    // would be called on a destroyed window and nothing would be shown.
    vi.mocked(BrowserWindow).mockClear();

    showAboutWindow();
    expect(BrowserWindow).toHaveBeenCalledOnce();
  });

  it('shows window and sets zoom on ready-to-show', () => {
    showAboutWindow();

    const readyHandlers = latestMockInstance._listeners['ready-to-show'];
    expect(readyHandlers).toBeDefined();
    expect(readyHandlers.length).toBeGreaterThan(0);

    readyHandlers[0]();

    expect(latestMockInstance.webContents.setZoomFactor).toHaveBeenCalledWith(1.0);
    expect(latestMockInstance.show).toHaveBeenCalledOnce();
  });
});
