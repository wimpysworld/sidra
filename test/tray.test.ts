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
  getUpdateInfo: vi.fn(() => null),
}));

vi.mock('../src/autoUpdate', () => ({
  quitAndInstall: vi.fn(),
}));

vi.mock('../src/theme', () => ({
  applyTheme: vi.fn(),
}));

vi.mock('../src/artwork', () => ({
  downloadArtwork: vi.fn(() => Promise.resolve('/tmp/downloaded-artwork.png')),
}));

vi.mock('../src/paths', () => ({
  getAssetPath: vi.fn((...parts: string[]) => parts.join('/')),
  getProductInfo: () => ({ productName: 'Sidra', description: 'Apple Music client', author: 'Test', license: 'MIT' }),
}));

import { Menu, Tray, nativeImage, nativeTheme } from 'electron';
import { getUpdateInfo } from '../src/update';
import { truncateMenuLabel, sanitiseLinuxLabel, createTray, getMenuIcon, updateNowPlayingState, updateTrayTooltip, rebuildTrayMenu, initTrayStateManager } from '../src/tray';
import { downloadArtwork } from '../src/artwork';
import { Player, PlaybackState } from '../src/player';
import type { NowPlayingPayload } from '../src/player';

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
    vi.mocked(process.getSystemVersion).mockReturnValue('15.0.0');
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
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
    });

    it('uses plain text label for About on Linux', () => {
      createTray();
      const template = getLastTemplate();
      const aboutItem = findItem(template, 'About Sidra');
      expect(aboutItem).toBeDefined();
      expect(aboutItem!.label).toBe('About Sidra');
    });

    it('attaches icon to About on Linux', () => {
      createTray();
      const template = getLastTemplate();
      const aboutItem = findItem(template, 'About Sidra');
      expect(aboutItem!.icon).toBeDefined();
    });

    it('uses plain text label for Quit on Linux', () => {
      createTray();
      const template = getLastTemplate();
      const quitItem = findItem(template, 'Quit');
      expect(quitItem).toBeDefined();
      expect(quitItem!.label).toBe('Quit');
    });

    it('attaches icon to Quit on Linux', () => {
      createTray();
      const template = getLastTemplate();
      const quitItem = findItem(template, 'Quit');
      expect(quitItem!.icon).toBeDefined();
    });

    it('attaches icons to all top-level submenu parents on Linux', () => {
      createTray();
      const template = getLastTemplate();
      for (const labelSubstring of ['Start Page', 'Notifications', 'Discord', 'Style', 'Zoom']) {
        const item = findItem(template, labelSubstring);
        expect(item, `${labelSubstring} should exist`).toBeDefined();
        expect(item!.icon, `${labelSubstring} should have icon`).toBeDefined();
        expect(item!.submenu, `${labelSubstring} should have submenu`).toBeDefined();
      }
    });

    it('uses plain text labels for submenu parents on Linux', () => {
      createTray();
      const template = getLastTemplate();
      const startPageItem = findItem(template, 'Start Page');
      expect(startPageItem!.label).toBe('Start Page: New');
    });

    it('does not attach icons to submenu radio items', () => {
      createTray();
      const template = getLastTemplate();
      const startPageItem = findItem(template, 'Start Page');
      const submenu = startPageItem!.submenu as Electron.MenuItemConstructorOptions[];
      for (const child of submenu) {
        expect(child.icon).toBeUndefined();
      }
    });

    it('registers a nativeTheme listener on Linux', () => {
      createTray();
      expect(vi.mocked(nativeTheme.on)).toHaveBeenCalledWith('updated', expect.any(Function));
    });
  });

  describe('Windows platform', () => {
    beforeEach(() => {
      setPlatform('win32');
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
    });

    it('uses plain text label for About on Windows', () => {
      createTray();
      const template = getLastTemplate();
      const aboutItem = findItem(template, 'About Sidra');
      expect(aboutItem).toBeDefined();
      expect(aboutItem!.label).toBe('About Sidra');
    });

    it('attaches icon to About on Windows', () => {
      createTray();
      const template = getLastTemplate();
      const aboutItem = findItem(template, 'About Sidra');
      expect(aboutItem!.icon).toBeDefined();
    });

    it('uses plain text label for Quit on Windows', () => {
      createTray();
      const template = getLastTemplate();
      const quitItem = findItem(template, 'Quit');
      expect(quitItem).toBeDefined();
      expect(quitItem!.label).toBe('Quit');
    });

    it('attaches icon to Quit on Windows', () => {
      createTray();
      const template = getLastTemplate();
      const quitItem = findItem(template, 'Quit');
      expect(quitItem!.icon).toBeDefined();
    });

    it('registers a nativeTheme listener on Windows', () => {
      vi.mocked(nativeTheme.on).mockClear();
      createTray();
      expect(vi.mocked(nativeTheme.on)).toHaveBeenCalledWith('updated', expect.any(Function));
    });
  });

  describe('macOS Tahoe+ platform', () => {
    beforeEach(() => {
      setPlatform('darwin');
      vi.spyOn(process, 'getSystemVersion').mockReturnValue('26.1.0');
    });

    it('uses plain text label for About on macOS Tahoe+', () => {
      createTray();
      const template = getLastTemplate();
      const aboutItem = findItem(template, 'About Sidra');
      expect(aboutItem).toBeDefined();
      expect(aboutItem!.label).toBe('About Sidra');
    });

    it('attaches SF Symbol icon to About on macOS Tahoe+', () => {
      createTray();
      const template = getLastTemplate();
      const aboutItem = findItem(template, 'About Sidra');
      expect(aboutItem!.icon).toBeDefined();
      expect(vi.mocked(nativeImage.createFromNamedImage)).toHaveBeenCalledWith('info.circle', [-1, 0, 1]);
    });

    it('attaches SF Symbol icon to Quit on macOS Tahoe+', () => {
      createTray();
      const template = getLastTemplate();
      const quitItem = findItem(template, 'Quit');
      expect(quitItem!.icon).toBeDefined();
    });

    it('does not register a nativeTheme listener on macOS', () => {
      vi.mocked(nativeTheme.on).mockClear();
      createTray();
      expect(vi.mocked(nativeTheme.on)).not.toHaveBeenCalled();
    });
  });

  describe('pre-Tahoe macOS platform', () => {
    beforeEach(() => {
      setPlatform('darwin');
      vi.spyOn(process, 'getSystemVersion').mockReturnValue('15.2.0');
    });

    it('uses plain text label for About on pre-Tahoe macOS', () => {
      createTray();
      const template = getLastTemplate();
      const aboutItem = findItem(template, 'About Sidra');
      expect(aboutItem).toBeDefined();
      expect(aboutItem!.label).toBe('About Sidra');
    });

    it('does not attach icon to About on pre-Tahoe macOS', () => {
      createTray();
      const template = getLastTemplate();
      const aboutItem = findItem(template, 'About Sidra');
      expect(aboutItem!.icon).toBeUndefined();
    });

    it('does not attach icon to Quit on pre-Tahoe macOS', () => {
      createTray();
      const template = getLastTemplate();
      const quitItem = findItem(template, 'Quit');
      expect(quitItem!.icon).toBeUndefined();
    });

    it('does not attach icons to submenu parents on pre-Tahoe macOS', () => {
      createTray();
      const template = getLastTemplate();
      for (const labelSubstring of ['Start Page', 'Notifications', 'Discord', 'Style', 'Zoom']) {
        const item = findItem(template, labelSubstring);
        expect(item!.icon, `${labelSubstring} should not have icon`).toBeUndefined();
      }
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

  describe('update menu item icons', () => {
    afterEach(() => {
      vi.mocked(getUpdateInfo).mockReturnValue(null);
    });

    it('attaches update-ready icon on Linux when update is ready', () => {
      setPlatform('linux');
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
      vi.mocked(getUpdateInfo).mockReturnValue({ version: '1.0.0', url: 'https://example.com', ready: true });
      createTray();
      const template = getLastTemplate();
      const readyItem = findItem(template, 'Restart to update');
      expect(readyItem).toBeDefined();
      expect(readyItem!.label).toBe('Restart to update');
      expect(readyItem!.icon).toBeDefined();
    });

    it('attaches update-available icon on Linux when update is available', () => {
      setPlatform('linux');
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
      vi.mocked(getUpdateInfo).mockReturnValue({ version: '1.1.0', url: 'https://example.com', ready: false });
      createTray();
      const template = getLastTemplate();
      const availableItem = findItem(template, 'Update available');
      expect(availableItem).toBeDefined();
      expect(availableItem!.label).toBe('Update available: 1.1.0');
      expect(availableItem!.icon).toBeDefined();
    });

    it('does not attach icon to up-to-date item', () => {
      setPlatform('linux');
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
      vi.mocked(getUpdateInfo).mockReturnValue(null);
      createTray();
      const template = getLastTemplate();
      const upToDateItem = findItem(template, 'Up to date');
      expect(upToDateItem).toBeDefined();
      expect(upToDateItem!.icon).toBeUndefined();
    });

    it('attaches SF Symbol icon to update-ready on macOS Tahoe+', () => {
      setPlatform('darwin');
      vi.spyOn(process, 'getSystemVersion').mockReturnValue('26.1.0');
      vi.mocked(getUpdateInfo).mockReturnValue({ version: '1.0.0', url: 'https://example.com', ready: true });
      createTray();
      const template = getLastTemplate();
      const readyItem = findItem(template, 'Restart to update');
      expect(readyItem).toBeDefined();
      expect(readyItem!.icon).toBeDefined();
    });

    it('does not attach icon to update-ready on pre-Tahoe macOS', () => {
      setPlatform('darwin');
      vi.spyOn(process, 'getSystemVersion').mockReturnValue('15.2.0');
      vi.mocked(getUpdateInfo).mockReturnValue({ version: '1.0.0', url: 'https://example.com', ready: true });
      createTray();
      const template = getLastTemplate();
      const readyItem = findItem(template, 'Restart to update');
      expect(readyItem).toBeDefined();
      expect(readyItem!.icon).toBeUndefined();
    });

    it('attaches icon to update-available on Windows', () => {
      setPlatform('win32');
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
      vi.mocked(getUpdateInfo).mockReturnValue({ version: '1.1.0', url: 'https://example.com', ready: false });
      createTray();
      const template = getLastTemplate();
      const availableItem = findItem(template, 'Update available');
      expect(availableItem).toBeDefined();
      expect(availableItem!.icon).toBeDefined();
    });
  });

  describe('Now Playing menu items', () => {
    const nowPlayingPayload = {
      name: 'Test Track',
      artistName: 'Test Artist',
      albumName: 'Test Album',
      artwork: { url: '' },
    };

    function setupNowPlaying(artworkPath: string | null = '/tmp/artwork.png'): void {
      updateNowPlayingState(nowPlayingPayload, artworkPath, true, 0.75);
    }

    function createTrayWithNowPlaying(artworkPath: string | null = '/tmp/artwork.png'): ReturnType<typeof createTray> {
      setupNowPlaying(artworkPath);
      const tray = createTray();
      return tray;
    }

    afterEach(() => {
      updateNowPlayingState(null, null, false, 0);
    });

    describe('Linux Now Playing icons', () => {
      beforeEach(() => {
        setPlatform('linux');
        Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
      });

      it('attaches icon to artist item on Linux', () => {
        createTrayWithNowPlaying();
        const template = getLastTemplate();
        const artistItem = findItem(template, 'Test Artist');
        expect(artistItem).toBeDefined();
        expect(artistItem!.icon).toBeDefined();
        expect(artistItem!.label).toBe('Test Artist');
      });

      it('attaches icon to album item on Linux', () => {
        createTrayWithNowPlaying();
        const template = getLastTemplate();
        const albumItem = findItem(template, 'Test Album');
        expect(albumItem).toBeDefined();
        expect(albumItem!.icon).toBeDefined();
        expect(albumItem!.label).toBe('Test Album');
      });

      it('attaches icon to Previous on Linux', () => {
        createTrayWithNowPlaying();
        const template = getLastTemplate();
        const prevItem = findItem(template, 'Previous');
        expect(prevItem).toBeDefined();
        expect(prevItem!.icon).toBeDefined();
        expect(prevItem!.label).toBe('Previous');
      });

      it('attaches pause icon when playing on Linux', () => {
        createTrayWithNowPlaying();
        const template = getLastTemplate();
        const pauseItem = findItem(template, 'Pause');
        expect(pauseItem).toBeDefined();
        expect(pauseItem!.icon).toBeDefined();
        expect(pauseItem!.label).toBe('Pause');
      });

      it('attaches play icon when paused on Linux', () => {
        updateNowPlayingState(nowPlayingPayload, '/tmp/artwork.png', false, 0.75);
        createTray();
        const template = getLastTemplate();
        const playItem = findItem(template, 'Play');
        expect(playItem).toBeDefined();
        expect(playItem!.icon).toBeDefined();
        expect(playItem!.label).toBe('Play');
      });

      it('attaches icon to Next on Linux', () => {
        createTrayWithNowPlaying();
        const template = getLastTemplate();
        const nextItem = findItem(template, 'Next');
        expect(nextItem).toBeDefined();
        expect(nextItem!.icon).toBeDefined();
        expect(nextItem!.label).toBe('Next');
      });

      it('attaches icon to Volume on Linux', () => {
        createTrayWithNowPlaying();
        const template = getLastTemplate();
        const volumeItem = findItem(template, 'Volume');
        expect(volumeItem).toBeDefined();
        expect(volumeItem!.icon).toBeDefined();
        expect(volumeItem!.label).toBe('Volume: 75%');
      });

      it('preserves artwork icon on track name item', () => {
        createTrayWithNowPlaying();
        const template = getLastTemplate();
        const trackItem = findItem(template, 'Test Track');
        expect(trackItem).toBeDefined();
        expect(trackItem!.icon).toBeDefined();
        // Artwork icon is loaded via nativeImage.createFromPath with resize
        expect(vi.mocked(nativeImage.createFromPath)).toHaveBeenCalledWith('/tmp/artwork.png');
      });

      it('uses plain text labels without glyphs on Linux', () => {
        createTrayWithNowPlaying();
        const template = getLastTemplate();
        const artistItem = findItem(template, 'Test Artist');
        expect(artistItem!.label).not.toMatch(/[★⦿]/);
        const prevItem = findItem(template, 'Previous');
        expect(prevItem!.label).not.toMatch(/[⇤⇥◫🞂🕪]/);
      });
    });

    describe('Windows Now Playing icons', () => {
      beforeEach(() => {
        setPlatform('win32');
        Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
      });

      it('attaches icons to Now Playing items on Windows', () => {
        createTrayWithNowPlaying();
        const template = getLastTemplate();
        for (const label of ['Test Artist', 'Test Album', 'Previous', 'Pause', 'Next']) {
          const item = findItem(template, label);
          expect(item, `${label} should exist`).toBeDefined();
          expect(item!.icon, `${label} should have icon`).toBeDefined();
        }
        const volumeItem = findItem(template, 'Volume');
        expect(volumeItem!.icon).toBeDefined();
      });

      it('preserves artwork icon on track name item on Windows', () => {
        createTrayWithNowPlaying();
        const template = getLastTemplate();
        const trackItem = findItem(template, 'Test Track');
        expect(trackItem).toBeDefined();
        expect(trackItem!.icon).toBeDefined();
      });
    });

    describe('macOS Tahoe+ Now Playing icons', () => {
      beforeEach(() => {
        setPlatform('darwin');
        vi.spyOn(process, 'getSystemVersion').mockReturnValue('26.1.0');
      });

      it('attaches SF Symbol icons to Now Playing items on macOS Tahoe+', () => {
        createTrayWithNowPlaying();
        const template = getLastTemplate();
        for (const label of ['Test Artist', 'Test Album', 'Previous', 'Pause', 'Next']) {
          const item = findItem(template, label);
          expect(item, `${label} should exist`).toBeDefined();
          expect(item!.icon, `${label} should have icon`).toBeDefined();
        }
        const volumeItem = findItem(template, 'Volume');
        expect(volumeItem!.icon).toBeDefined();
      });

      it('preserves artwork icon on track name item on macOS Tahoe+', () => {
        createTrayWithNowPlaying();
        const template = getLastTemplate();
        const trackItem = findItem(template, 'Test Track');
        expect(trackItem).toBeDefined();
        expect(trackItem!.icon).toBeDefined();
      });
    });

    describe('pre-Tahoe macOS Now Playing icons', () => {
      beforeEach(() => {
        setPlatform('darwin');
        vi.spyOn(process, 'getSystemVersion').mockReturnValue('15.2.0');
      });

      it('does not attach icons to Now Playing items on pre-Tahoe macOS', () => {
        createTrayWithNowPlaying(null);
        const template = getLastTemplate();
        for (const label of ['Test Artist', 'Test Album', 'Previous', 'Pause', 'Next']) {
          const item = findItem(template, label);
          expect(item, `${label} should exist`).toBeDefined();
          expect(item!.icon, `${label} should not have icon`).toBeUndefined();
        }
        const volumeItem = findItem(template, 'Volume');
        expect(volumeItem!.icon).toBeUndefined();
      });

      it('does not attach icon to track name item without artwork on pre-Tahoe macOS', () => {
        createTrayWithNowPlaying(null);
        const template = getLastTemplate();
        const trackItem = findItem(template, 'Test Track');
        expect(trackItem).toBeDefined();
        expect(trackItem!.icon).toBeUndefined();
      });

      it('uses plain text labels without glyphs on pre-Tahoe macOS', () => {
        createTrayWithNowPlaying(null);
        const template = getLastTemplate();
        const artistItem = findItem(template, 'Test Artist');
        expect(artistItem!.label).toBe('Test Artist');
        const prevItem = findItem(template, 'Previous');
        expect(prevItem!.label).toBe('Previous');
      });
    });

    describe('album icon based on release year', () => {
      beforeEach(() => {
        setPlatform('linux');
        Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
      });

      it('uses record-vinyl icon when releaseDate year is 1981 or earlier', () => {
        const payload = { ...nowPlayingPayload, releaseDate: '1973-09-19' };
        updateNowPlayingState(payload, '/tmp/artwork.png', true, 0.75);
        createTray();
        const template = getLastTemplate();
        const albumItem = findItem(template, 'Test Album');
        expect(albumItem).toBeDefined();
        expect(albumItem!.icon).toBeDefined();
        // Verify getMenuIcon was called with 'record-vinyl' by checking the resolved path
        expect(vi.mocked(nativeImage.createFromPath)).toHaveBeenCalledWith(
          expect.stringContaining('record-vinyl.png'),
        );
      });

      it('uses compact-disc icon when releaseDate year is after 1981', () => {
        const payload = { ...nowPlayingPayload, releaseDate: '1982-01-01' };
        updateNowPlayingState(payload, '/tmp/artwork.png', true, 0.75);
        createTray();
        const template = getLastTemplate();
        const albumItem = findItem(template, 'Test Album');
        expect(albumItem).toBeDefined();
        expect(albumItem!.icon).toBeDefined();
        expect(vi.mocked(nativeImage.createFromPath)).toHaveBeenCalledWith(
          expect.stringContaining('compact-disc.png'),
        );
      });

      it('uses compact-disc icon when releaseDate is not available', () => {
        updateNowPlayingState(nowPlayingPayload, '/tmp/artwork.png', true, 0.75);
        createTray();
        const template = getLastTemplate();
        const albumItem = findItem(template, 'Test Album');
        expect(albumItem).toBeDefined();
        expect(albumItem!.icon).toBeDefined();
        expect(vi.mocked(nativeImage.createFromPath)).toHaveBeenCalledWith(
          expect.stringContaining('compact-disc.png'),
        );
      });
    });
  });
});

describe('theme change menu refresh', () => {
  const originalPlatform = process.platform;

  function setPlatform(platform: string): void {
    Object.defineProperty(process, 'platform', { value: platform, writable: true, configurable: true });
  }

  beforeEach(() => {
    vi.mocked(nativeTheme.on).mockClear();
    vi.mocked(Menu.buildFromTemplate).mockClear();
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: originalPlatform, writable: true, configurable: true });
  });

  it('rebuilds context menu on theme change on Linux', () => {
    setPlatform('linux');
    Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
    const tray = createTray();
    const setContextMenuFn = tray.setContextMenu as ReturnType<typeof vi.fn>;
    const buildCountBefore = vi.mocked(Menu.buildFromTemplate).mock.calls.length;
    const contextMenuCountBefore = setContextMenuFn.mock.calls.length;

    // Extract and invoke the theme callback
    const themeCall = vi.mocked(nativeTheme.on).mock.calls.find(([event]) => event === 'updated');
    expect(themeCall).toBeDefined();
    const callback = themeCall![1] as () => void;
    callback();

    const buildCountAfter = vi.mocked(Menu.buildFromTemplate).mock.calls.length;
    expect(buildCountAfter).toBeGreaterThan(buildCountBefore);
    expect(setContextMenuFn.mock.calls.length).toBeGreaterThan(contextMenuCountBefore);
  });

  it('updates tray image on theme change on Linux', () => {
    setPlatform('linux');
    Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
    const tray = createTray();
    const setImageFn = tray.setImage as ReturnType<typeof vi.fn>;

    const themeCall = vi.mocked(nativeTheme.on).mock.calls.find(([event]) => event === 'updated');
    const callback = themeCall![1] as () => void;
    callback();

    expect(setImageFn).toHaveBeenCalled();
  });

  it('rebuilds context menu on theme change on Windows', () => {
    setPlatform('win32');
    Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
    const tray = createTray();
    const setContextMenuFn = tray.setContextMenu as ReturnType<typeof vi.fn>;
    const buildCountBefore = vi.mocked(Menu.buildFromTemplate).mock.calls.length;
    const contextMenuCountBefore = setContextMenuFn.mock.calls.length;

    const themeCall = vi.mocked(nativeTheme.on).mock.calls.find(([event]) => event === 'updated');
    expect(themeCall).toBeDefined();
    const callback = themeCall![1] as () => void;
    callback();

    const buildCountAfter = vi.mocked(Menu.buildFromTemplate).mock.calls.length;
    expect(buildCountAfter).toBeGreaterThan(buildCountBefore);
    expect(setContextMenuFn.mock.calls.length).toBeGreaterThan(contextMenuCountBefore);
  });

  it('does not update tray image on theme change on Windows', () => {
    setPlatform('win32');
    Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
    const tray = createTray();
    const setImageFn = tray.setImage as ReturnType<typeof vi.fn>;

    const themeCall = vi.mocked(nativeTheme.on).mock.calls.find(([event]) => event === 'updated');
    const callback = themeCall![1] as () => void;
    callback();

    expect(setImageFn).not.toHaveBeenCalled();
  });

  it('does not register a nativeTheme listener on macOS', () => {
    setPlatform('darwin');
    vi.spyOn(process, 'getSystemVersion').mockReturnValue('26.1.0');
    vi.mocked(nativeTheme.on).mockClear();
    createTray();
    expect(vi.mocked(nativeTheme.on)).not.toHaveBeenCalled();
  });

  it('does not register a nativeTheme listener on pre-Tahoe macOS', () => {
    setPlatform('darwin');
    vi.spyOn(process, 'getSystemVersion').mockReturnValue('15.2.0');
    vi.mocked(nativeTheme.on).mockClear();
    createTray();
    expect(vi.mocked(nativeTheme.on)).not.toHaveBeenCalled();
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
      expect(vi.mocked(nativeImage.createFromNamedImage)).toHaveBeenCalledWith('info.circle', [-1, 0, 1]);
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
        expect(vi.mocked(nativeImage.createFromNamedImage)).toHaveBeenCalledWith(symbol, [-1, 0, 1]);
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

describe('initTrayStateManager', () => {
  let mockPlayer: {
    on: ReturnType<typeof vi.fn>;
    off: ReturnType<typeof vi.fn>;
    playbackSnapshot: ReturnType<typeof vi.fn>;
    listeners: Record<string, ((...args: unknown[]) => unknown)>;
  };
  let mockTray: InstanceType<typeof Tray>;

  function createMockPlayer() {
    const listeners: Record<string, ((...args: unknown[]) => unknown)> = {};
    return {
      listeners,
      on: vi.fn((event: string, handler: (...args: unknown[]) => unknown) => {
        listeners[event] = handler;
      }),
      off: vi.fn((event: string, _handler: (...args: unknown[]) => unknown) => {
        delete listeners[event];
      }),
      playbackSnapshot: vi.fn(() => ({ isPlaying: false, positionUs: 0, state: 0 })),
    };
  }

  beforeEach(() => {
    mockPlayer = createMockPlayer();
    mockTray = new Tray('test-icon.png');
    vi.mocked(Menu.buildFromTemplate).mockClear();
    vi.mocked(downloadArtwork).mockReset();
    vi.mocked(downloadArtwork).mockResolvedValue('/tmp/downloaded-artwork.png');
  });

  describe('event subscription', () => {
    it('registers all three event listeners on the player', () => {
      initTrayStateManager(mockPlayer as unknown as Player, mockTray);
      expect(mockPlayer.on).toHaveBeenCalledWith('nowPlayingItemDidChange', expect.any(Function));
      expect(mockPlayer.on).toHaveBeenCalledWith('playbackStateDidChange', expect.any(Function));
      expect(mockPlayer.on).toHaveBeenCalledWith('volumeDidChange', expect.any(Function));
      expect(mockPlayer.on).toHaveBeenCalledTimes(3);
    });
  });

  describe('cleanup function', () => {
    it('removes all three event listeners from the player', () => {
      const cleanup = initTrayStateManager(mockPlayer as unknown as Player, mockTray);
      cleanup();
      expect(mockPlayer.off).toHaveBeenCalledWith('nowPlayingItemDidChange', expect.any(Function));
      expect(mockPlayer.off).toHaveBeenCalledWith('playbackStateDidChange', expect.any(Function));
      expect(mockPlayer.off).toHaveBeenCalledWith('volumeDidChange', expect.any(Function));
      expect(mockPlayer.off).toHaveBeenCalledTimes(3);
    });

    it('clears the pause timer when called during an active pause timeout', () => {
      vi.useFakeTimers();
      try {
        const cleanup = initTrayStateManager(mockPlayer as unknown as Player, mockTray);

        // Simulate playing then pausing to start the pause timer
        mockPlayer.playbackSnapshot.mockReturnValue({ isPlaying: true, positionUs: 0, state: PlaybackState.Playing });
        mockPlayer.listeners['playbackStateDidChange']({ status: true, state: PlaybackState.Playing });

        mockPlayer.playbackSnapshot.mockReturnValue({ isPlaying: false, positionUs: 0, state: PlaybackState.Paused });
        mockPlayer.listeners['playbackStateDidChange']({ status: true, state: PlaybackState.Paused });

        // Timer is now pending. Cleanup should clear it.
        cleanup();

        // Advance past the 30s timeout - should not trigger any state clearing
        vi.mocked(Menu.buildFromTemplate).mockClear();
        vi.advanceTimersByTime(35_000);

        // No additional menu rebuild from the timer callback
        expect(vi.mocked(Menu.buildFromTemplate)).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('pause timeout', () => {
    it('clears Now Playing after 30s of inactivity when paused', () => {
      vi.useFakeTimers();
      try {
        initTrayStateManager(mockPlayer as unknown as Player, mockTray);

        // Transition to playing first (sets previousPlaying = true)
        mockPlayer.playbackSnapshot.mockReturnValue({ isPlaying: true, positionUs: 0, state: PlaybackState.Playing });
        mockPlayer.listeners['playbackStateDidChange']({ status: true, state: PlaybackState.Playing });

        // Transition to paused
        mockPlayer.playbackSnapshot.mockReturnValue({ isPlaying: false, positionUs: 0, state: PlaybackState.Paused });
        mockPlayer.listeners['playbackStateDidChange']({ status: true, state: PlaybackState.Paused });

        // Advance 29s - should not have cleared yet
        vi.mocked(Menu.buildFromTemplate).mockClear();
        const setToolTipFn = mockTray.setToolTip as ReturnType<typeof vi.fn>;
        setToolTipFn.mockClear();

        vi.advanceTimersByTime(29_000);
        // The tooltip should not have been cleared to the product name yet
        expect(setToolTipFn).not.toHaveBeenCalled();

        // Advance past 30s
        vi.advanceTimersByTime(2_000);

        // Now the tooltip should be reset (updateTrayTooltip(tray, null) sets product name)
        expect(setToolTipFn).toHaveBeenCalled();
        // And the menu should be rebuilt
        expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancels the pause timer when playback resumes', () => {
      vi.useFakeTimers();
      try {
        initTrayStateManager(mockPlayer as unknown as Player, mockTray);

        // Play -> Pause (start timer)
        mockPlayer.playbackSnapshot.mockReturnValue({ isPlaying: true, positionUs: 0, state: PlaybackState.Playing });
        mockPlayer.listeners['playbackStateDidChange']({ status: true, state: PlaybackState.Playing });

        mockPlayer.playbackSnapshot.mockReturnValue({ isPlaying: false, positionUs: 0, state: PlaybackState.Paused });
        mockPlayer.listeners['playbackStateDidChange']({ status: true, state: PlaybackState.Paused });

        // Resume playing before timeout
        vi.advanceTimersByTime(10_000);
        mockPlayer.playbackSnapshot.mockReturnValue({ isPlaying: true, positionUs: 0, state: PlaybackState.Playing });
        mockPlayer.listeners['playbackStateDidChange']({ status: true, state: PlaybackState.Playing });

        // Advance past original timeout - should not clear
        vi.mocked(Menu.buildFromTemplate).mockClear();
        const setToolTipFn = mockTray.setToolTip as ReturnType<typeof vi.fn>;
        setToolTipFn.mockClear();
        vi.advanceTimersByTime(25_000);

        expect(setToolTipFn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });

    it('cancels the pause timer on track change', async () => {
      vi.useFakeTimers();
      try {
        initTrayStateManager(mockPlayer as unknown as Player, mockTray);

        // Play -> Pause (start timer)
        mockPlayer.playbackSnapshot.mockReturnValue({ isPlaying: true, positionUs: 0, state: PlaybackState.Playing });
        mockPlayer.listeners['playbackStateDidChange']({ status: true, state: PlaybackState.Playing });

        mockPlayer.playbackSnapshot.mockReturnValue({ isPlaying: false, positionUs: 0, state: PlaybackState.Paused });
        mockPlayer.listeners['playbackStateDidChange']({ status: true, state: PlaybackState.Paused });

        // New track arrives - should cancel timer
        const payload: NowPlayingPayload = { name: 'New Track', artistName: 'Artist' };
        vi.mocked(downloadArtwork).mockResolvedValue(null);
        mockPlayer.playbackSnapshot.mockReturnValue({ isPlaying: true, positionUs: 0, state: PlaybackState.Playing });
        await mockPlayer.listeners['nowPlayingItemDidChange'](payload);

        // Advance past original timeout - should not clear
        vi.mocked(Menu.buildFromTemplate).mockClear();
        const setToolTipFn = mockTray.setToolTip as ReturnType<typeof vi.fn>;
        setToolTipFn.mockClear();
        vi.advanceTimersByTime(35_000);

        // No timeout-triggered tooltip reset
        expect(setToolTipFn).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe('nowPlayingItemDidChange handler', () => {
    it('updates tooltip and menu when a new track arrives', async () => {
      initTrayStateManager(mockPlayer as unknown as Player, mockTray);
      const payload: NowPlayingPayload = { name: 'Test Song', artistName: 'Test Artist' };
      vi.mocked(downloadArtwork).mockResolvedValue(null);
      mockPlayer.playbackSnapshot.mockReturnValue({ isPlaying: true, positionUs: 0, state: PlaybackState.Playing });

      await mockPlayer.listeners['nowPlayingItemDidChange'](payload);

      const setToolTipFn = mockTray.setToolTip as ReturnType<typeof vi.fn>;
      expect(setToolTipFn).toHaveBeenCalled();
      expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalled();
    });

    it('clears state when null payload is received', async () => {
      initTrayStateManager(mockPlayer as unknown as Player, mockTray);

      await mockPlayer.listeners['nowPlayingItemDidChange'](null);

      const setToolTipFn = mockTray.setToolTip as ReturnType<typeof vi.fn>;
      expect(setToolTipFn).toHaveBeenCalled();
      expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalled();
    });

    it('downloads artwork when artworkUrl is present', async () => {
      initTrayStateManager(mockPlayer as unknown as Player, mockTray);
      const payload: NowPlayingPayload = { name: 'Song', artworkUrl: 'https://example.com/art.jpg' };
      mockPlayer.playbackSnapshot.mockReturnValue({ isPlaying: true, positionUs: 0, state: PlaybackState.Playing });

      await mockPlayer.listeners['nowPlayingItemDidChange'](payload);

      expect(vi.mocked(downloadArtwork)).toHaveBeenCalledWith('https://example.com/art.jpg');
    });

    it('guards against stale payload after artwork download', async () => {
      initTrayStateManager(mockPlayer as unknown as Player, mockTray);

      // First track starts downloading artwork slowly
      let resolveFirst: (value: string | null) => void;
      const firstDownload = new Promise<string | null>((resolve) => { resolveFirst = resolve; });
      vi.mocked(downloadArtwork).mockReturnValueOnce(firstDownload);

      const payload1: NowPlayingPayload = { name: 'First Song', artworkUrl: 'https://example.com/art1.jpg' };
      const payload2: NowPlayingPayload = { name: 'Second Song', artworkUrl: 'https://example.com/art2.jpg' };

      mockPlayer.playbackSnapshot.mockReturnValue({ isPlaying: true, positionUs: 0, state: PlaybackState.Playing });

      // Fire first track
      const firstPromise = mockPlayer.listeners['nowPlayingItemDidChange'](payload1) as Promise<void>;

      // Fire second track before first artwork resolves
      vi.mocked(downloadArtwork).mockResolvedValueOnce('/tmp/art2.png');
      await mockPlayer.listeners['nowPlayingItemDidChange'](payload2);

      // Clear the mock calls from the second track handler
      vi.mocked(Menu.buildFromTemplate).mockClear();

      // Resolve first artwork download - should be discarded (stale)
      resolveFirst!('/tmp/art1.png');
      await firstPromise;

      // No additional menu rebuild from the stale first track
      expect(vi.mocked(Menu.buildFromTemplate)).not.toHaveBeenCalled();
    });
  });

  describe('playbackStateDidChange handler', () => {
    it('clears state on terminal playback states', () => {
      initTrayStateManager(mockPlayer as unknown as Player, mockTray);

      for (const state of [PlaybackState.None, PlaybackState.Stopped, PlaybackState.Ended, PlaybackState.Completed]) {
        vi.mocked(Menu.buildFromTemplate).mockClear();
        mockPlayer.listeners['playbackStateDidChange']({ status: true, state });
        expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalled();
      }
    });

    it('rebuilds menu on playback state change', () => {
      initTrayStateManager(mockPlayer as unknown as Player, mockTray);
      mockPlayer.playbackSnapshot.mockReturnValue({ isPlaying: true, positionUs: 0, state: PlaybackState.Playing });

      vi.mocked(Menu.buildFromTemplate).mockClear();
      mockPlayer.listeners['playbackStateDidChange']({ status: true, state: PlaybackState.Playing });

      expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalled();
    });
  });

  describe('volumeDidChange handler', () => {
    it('updates state and rebuilds menu on volume change', () => {
      initTrayStateManager(mockPlayer as unknown as Player, mockTray);
      mockPlayer.playbackSnapshot.mockReturnValue({ isPlaying: true, positionUs: 0, state: PlaybackState.Playing });

      vi.mocked(Menu.buildFromTemplate).mockClear();
      mockPlayer.listeners['volumeDidChange'](0.5);

      expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalled();
    });

    it('ignores null volume', () => {
      initTrayStateManager(mockPlayer as unknown as Player, mockTray);

      vi.mocked(Menu.buildFromTemplate).mockClear();
      mockPlayer.listeners['volumeDidChange'](null);

      expect(vi.mocked(Menu.buildFromTemplate)).not.toHaveBeenCalled();
    });
  });
});
