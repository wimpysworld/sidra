import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { TrayStrings } from '../src/i18n';

// Mock modules that trigger require('electron-store') at import time.
vi.mock('../src/config', () => ({
  getNotificationsEnabled: () => true,
  setNotificationsEnabled: vi.fn(),
  getDiscordEnabled: () => true,
  setDiscordEnabled: vi.fn(),
  getTheme: () => 'apple-music',
  setTheme: vi.fn(),
  getStartPage: () => 'new',
  setStartPage: vi.fn(),
  getZoomFactor: () => 1.0,
  setZoomFactor: vi.fn(),
}));

const mockTrayStrings: TrayStrings = {
  about: 'About Sidra',
  quit: 'Quit',
  notifications: 'Notifications',
  discord: 'Discord',
  startPage: 'Start Page',
  startPageHome: 'Home',
  startPageNew: 'New',
  startPageRadio: 'Radio',
  startPageAllPlaylists: 'All Playlists',
  startPageLast: 'Last',
  catppuccin: 'Catppuccin',
  on: 'On',
  off: 'Off',
  style: 'Style',
  styleAppleMusic: 'Apple Music',
  zoom: 'Zoom',
  zoom100: '100%',
  zoom125: '125%',
  zoom150: '150%',
  zoom175: '175%',
  zoom200: '200%',
  previous: 'Previous',
  play: 'Play',
  pause: 'Pause',
  next: 'Next',
  volume: 'Volume',
  mute: 'Mute',
};

vi.mock('../src/i18n', () => ({
  getTrayStrings: () => mockTrayStrings,
  getAboutStrings: () => ({ close: 'Close', versionPrefix: 'Version', copyrightSuffix: 'All rights reserved', licensePrefix: 'License' }),
  getUpdateStrings: () => ({ updateAvailable: 'Update available: {version}', upToDate: 'Up to date' }),
  getAutoUpdateStrings: () => ({ ready: 'Restart to update' }),
}));

vi.mock('../src/update', () => ({
  getUpdateInfo: () => null,
}));

vi.mock('../src/autoUpdate', () => ({
  quitAndInstall: vi.fn(),
}));

vi.mock('../src/theme', () => ({
  applyTheme: vi.fn(),
}));

vi.mock('../src/paths', () => ({
  getAssetPath: vi.fn((...parts: string[]) => parts.join('/')),
  getProductInfo: () => ({ productName: 'Sidra', description: 'Apple Music client', author: 'Test', license: 'MIT' }),
}));

import { Menu, Tray, nativeImage, nativeTheme } from 'electron';
import { truncateMenuLabel, sanitiseLinuxLabel, createTray, getMenuIcon } from '../src/tray';

// Helper: extract the template array from the last Menu.buildFromTemplate call
function getLastTemplate(): Electron.MenuItemConstructorOptions[] {
  const calls = vi.mocked(Menu.buildFromTemplate).mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  return calls[calls.length - 1][0] as Electron.MenuItemConstructorOptions[];
}

// Helper: find a menu item by label substring
function findItem(template: Electron.MenuItemConstructorOptions[], labelSubstring: string): Electron.MenuItemConstructorOptions | undefined {
  return template.find((item) => typeof item.label === 'string' && item.label.includes(labelSubstring));
}

describe('truncateMenuLabel', () => {
  it('passes through short text without truncation', () => {
    expect(truncateMenuLabel('Short Title', 32)).toBe('Short Title');
  });

  it('truncates long text with ellipsis', () => {
    expect(truncateMenuLabel('Long Title That Exceeds The Maximum Length Allowed', 32)).toBe('Long Title That Exceeds The Maxi…');
  });

  it('splits on ( and trims trailing space', () => {
    expect(truncateMenuLabel('Track Name (feat. Artist)', 32)).toBe('Track Name');
  });

  it('splits on [ and trims trailing space', () => {
    expect(truncateMenuLabel('Track Name [Deluxe Edition]', 32)).toBe('Track Name');
  });

  it('handles empty string without crashing', () => {
    expect(truncateMenuLabel('', 32)).toBe('');
  });

  it('keeps label when ( is at index 0', () => {
    expect(truncateMenuLabel('(Intro)', 32)).toBe('(Intro)');
  });
});

describe('sanitiseLinuxLabel', () => {
  it('replaces & with fullwidth ampersand', () => {
    expect(sanitiseLinuxLabel('Paul McCartney & Wings')).toBe('Paul McCartney \uFF06 Wings');
  });

  it('replaces multiple ampersands', () => {
    expect(sanitiseLinuxLabel('A & B & C')).toBe('A \uFF06 B \uFF06 C');
  });

  it('leaves text without ampersands unchanged', () => {
    expect(sanitiseLinuxLabel('No ampersands here')).toBe('No ampersands here');
  });

  it('handles empty string', () => {
    expect(sanitiseLinuxLabel('')).toBe('');
  });
});

describe('createTray - menu template inspection', () => {
  const originalPlatform = process.platform;

  function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, writable: true, configurable: true });
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true, configurable: true });
    vi.mocked(Menu.buildFromTemplate).mockClear();
  });

  it('calls Menu.buildFromTemplate and captures the template', () => {
    setPlatform('linux');
    createTray();
    const template = getLastTemplate();
    expect(Array.isArray(template)).toBe(true);
    expect(template.length).toBeGreaterThan(0);
  });

  it('returns a Tray instance with setContextMenu called', () => {
    setPlatform('linux');
    const tray = createTray();
    expect(tray).toBeDefined();
    expect(tray.setContextMenu).toBeDefined();
  });

  describe('Linux platform', () => {
    beforeEach(() => {
      setPlatform('linux');
    });

    it('prefixes About label with glyph on Linux', () => {
      createTray();
      const template = getLastTemplate();
      const aboutItem = findItem(template, 'About Sidra');
      expect(aboutItem).toBeDefined();
      // Linux labels include a glyph prefix
      expect(aboutItem!.label).toMatch(/^.+ About Sidra$/);
    });

    it('prefixes Quit label with glyph on Linux', () => {
      createTray();
      const template = getLastTemplate();
      const quitItem = findItem(template, 'Quit');
      expect(quitItem).toBeDefined();
      expect(quitItem!.label).toMatch(/^.+ Quit$/);
    });

    it('includes glyph in submenu parent labels on Linux', () => {
      createTray();
      const template = getLastTemplate();
      const startPageItem = findItem(template, 'Start Page');
      expect(startPageItem).toBeDefined();
      // Has glyph prefix and submenu
      expect(startPageItem!.label).toMatch(/^.+ Start Page/);
      expect(startPageItem!.submenu).toBeDefined();
    });

    it('registers a nativeTheme listener on Linux', () => {
      createTray();
      expect(vi.mocked(nativeTheme.on)).toHaveBeenCalledWith('updated', expect.any(Function));
    });
  });

  describe('Windows platform', () => {
    beforeEach(() => {
      setPlatform('win32');
    });

    it('does not prefix About label with glyph on Windows', () => {
      createTray();
      const template = getLastTemplate();
      const aboutItem = findItem(template, 'About Sidra');
      expect(aboutItem).toBeDefined();
      expect(aboutItem!.label).toBe('About Sidra');
    });

    it('does not prefix Quit label with glyph on Windows', () => {
      createTray();
      const template = getLastTemplate();
      const quitItem = findItem(template, 'Quit');
      expect(quitItem).toBeDefined();
      expect(quitItem!.label).toBe('Quit');
    });

    it('does not register a nativeTheme listener on Windows', () => {
      vi.mocked(nativeTheme.on).mockClear();
      createTray();
      expect(vi.mocked(nativeTheme.on)).not.toHaveBeenCalled();
    });
  });

  describe('macOS platform', () => {
    beforeEach(() => {
      setPlatform('darwin');
    });

    it('does not prefix About label with glyph on macOS', () => {
      createTray();
      const template = getLastTemplate();
      const aboutItem = findItem(template, 'About Sidra');
      expect(aboutItem).toBeDefined();
      expect(aboutItem!.label).toBe('About Sidra');
    });

    it('does not prefix Quit label with glyph on macOS', () => {
      createTray();
      const template = getLastTemplate();
      const quitItem = findItem(template, 'Quit');
      expect(quitItem).toBeDefined();
      expect(quitItem!.label).toBe('Quit');
    });

    it('does not register a nativeTheme listener on macOS', () => {
      vi.mocked(nativeTheme.on).mockClear();
      createTray();
      expect(vi.mocked(nativeTheme.on)).not.toHaveBeenCalled();
    });
  });

  describe('menu structure', () => {
    it('includes separator before Quit', () => {
      setPlatform('linux');
      createTray();
      const template = getLastTemplate();
      const lastItem = template[template.length - 1];
      const secondLast = template[template.length - 2];
      expect(lastItem.label).toContain('Quit');
      expect(secondLast.type).toBe('separator');
    });

    it('includes Up to date item when no update available', () => {
      setPlatform('linux');
      createTray();
      const template = getLastTemplate();
      const upToDateItem = findItem(template, 'Up to date');
      expect(upToDateItem).toBeDefined();
      expect(upToDateItem!.enabled).toBe(false);
    });

    it('includes all submenu sections', () => {
      setPlatform('darwin');
      createTray();
      const template = getLastTemplate();
      expect(findItem(template, 'About Sidra')).toBeDefined();
      expect(findItem(template, 'Start Page')).toBeDefined();
      expect(findItem(template, 'Notifications')).toBeDefined();
      expect(findItem(template, 'Discord')).toBeDefined();
      expect(findItem(template, 'Style')).toBeDefined();
      expect(findItem(template, 'Zoom')).toBeDefined();
      expect(findItem(template, 'Quit')).toBeDefined();
    });
  });
});

describe('getMenuIcon', () => {
  const originalPlatform = process.platform;

  function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, writable: true, configurable: true });
  }

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true, configurable: true });
    vi.mocked(nativeImage.createFromPath).mockClear();
    vi.mocked(nativeImage.createFromNamedImage).mockClear();
  });

  describe('Linux - themed PNG icons', () => {
    beforeEach(() => {
      setPlatform('linux');
    });

    it('returns a NativeImage from the dark PNG directory when shouldUseDarkColors is true', () => {
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
      const icon = getMenuIcon('about');
      expect(icon).toBeDefined();
      expect(vi.mocked(nativeImage.createFromPath)).toHaveBeenCalledWith(
        expect.stringContaining('tray/menu/dark/circle-info.png')
      );
    });

    it('returns a NativeImage from the light PNG directory when shouldUseDarkColors is false', () => {
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: false, configurable: true });
      const icon = getMenuIcon('quit');
      expect(icon).toBeDefined();
      expect(vi.mocked(nativeImage.createFromPath)).toHaveBeenCalledWith(
        expect.stringContaining('tray/menu/light/eject.png')
      );
    });

    it('returns undefined for an unknown action', () => {
      expect(getMenuIcon('nonexistent')).toBeUndefined();
    });

    it('returns undefined when the image is empty', () => {
      vi.mocked(nativeImage.createFromPath).mockReturnValueOnce({
        isEmpty: () => true,
        resize: vi.fn(function (this: { isEmpty: () => boolean }) { return this; }),
      } as unknown as Electron.NativeImage);
      expect(getMenuIcon('about')).toBeUndefined();
    });
  });

  describe('Windows - themed PNG icons', () => {
    beforeEach(() => {
      setPlatform('win32');
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
    });

    it('returns a NativeImage from the dark PNG directory', () => {
      const icon = getMenuIcon('play');
      expect(icon).toBeDefined();
      expect(vi.mocked(nativeImage.createFromPath)).toHaveBeenCalledWith(
        expect.stringContaining('tray/menu/dark/play.png')
      );
    });
  });

  describe('macOS Tahoe+ (26.x) - SF Symbol icons', () => {
    beforeEach(() => {
      setPlatform('darwin');
      vi.spyOn(process, 'getSystemVersion').mockReturnValue('26.1.0');
    });

    it('returns a NativeImage from createFromNamedImage with SF Symbol name', () => {
      const icon = getMenuIcon('about');
      expect(icon).toBeDefined();
      expect(vi.mocked(nativeImage.createFromNamedImage)).toHaveBeenCalledWith('info.circle');
    });

    it('returns undefined for an unknown action', () => {
      expect(getMenuIcon('nonexistent')).toBeUndefined();
    });

    it('returns undefined when the SF Symbol image is empty', () => {
      vi.mocked(nativeImage.createFromNamedImage).mockReturnValueOnce({
        isEmpty: () => true,
      } as unknown as Electron.NativeImage);
      expect(getMenuIcon('about')).toBeUndefined();
    });

    it('resolves correct SF Symbol for each Now Playing action', () => {
      const cases: [string, string][] = [
        ['artist', 'person'],
        ['album', 'opticaldisc'],
        ['previous', 'backward.end'],
        ['play', 'play'],
        ['pause', 'pause'],
        ['next', 'forward.end'],
        ['volume', 'speaker.wave.2'],
      ];
      for (const [action, symbol] of cases) {
        vi.mocked(nativeImage.createFromNamedImage).mockClear();
        getMenuIcon(action);
        expect(vi.mocked(nativeImage.createFromNamedImage)).toHaveBeenCalledWith(symbol);
      }
    });
  });

  describe('pre-Tahoe macOS - no icons', () => {
    beforeEach(() => {
      setPlatform('darwin');
      vi.spyOn(process, 'getSystemVersion').mockReturnValue('15.2.0');
    });

    it('returns undefined on pre-Tahoe macOS', () => {
      expect(getMenuIcon('about')).toBeUndefined();
    });

    it('does not call createFromPath or createFromNamedImage', () => {
      getMenuIcon('about');
      expect(vi.mocked(nativeImage.createFromPath)).not.toHaveBeenCalled();
      expect(vi.mocked(nativeImage.createFromNamedImage)).not.toHaveBeenCalled();
    });
  });
});
