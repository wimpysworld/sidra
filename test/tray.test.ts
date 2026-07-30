import { describe, it, expect, expectTypeOf, vi, beforeEach, afterEach } from 'vitest';
import type { TrayStrings } from '../src/i18n';

// Mock modules that import electron-conf/main at import time.
vi.mock('../src/config', () => ({
  getNotificationsEnabled: () => true,
  setNotificationsEnabled: vi.fn(),
  getDiscordEnabled: () => true,
  setDiscordEnabled: vi.fn(),
  getLastfmEnabled: vi.fn(() => false),
  setLastfmEnabled: vi.fn(),
  getLastfmSessionKey: vi.fn(() => null),
  getLastfmUsername: vi.fn(() => null),
  setLastfmSession: vi.fn(),
  clearLastfmSession: vi.fn(),
  getTheme: vi.fn(() => 'apple-music'),
  setTheme: vi.fn(),
  getStartPage: () => 'new',
  setStartPage: vi.fn(),
  getZoomFactor: () => 1.0,
  setZoomFactor: vi.fn(),
  getCloseToTrayEnabled: vi.fn(() => false),
  setCloseToTrayEnabled: vi.fn(),
  getMusicService: vi.fn(() => 'music'),
  setMusicService: vi.fn(),
  getClassicalStartPage: vi.fn(() => 'home'),
  setClassicalStartPage: vi.fn(),
}));

const mockTrayStrings: TrayStrings = {
  about: 'About Sidra',
  quit: 'Quit',
  notifications: 'Notifications',
  discord: 'Discord',
  player: 'Player',
  lastfmConnect: 'Connect to Last.fm…',
  lastfmDisconnect: 'Disconnect',
  startPage: 'Start Page',
  startPageHome: 'Home',
  startPageNew: 'New',
  startPageRadio: 'Radio',
  startPageAllPlaylists: 'All Playlists',
  startPageBrowse: 'Browse',
  startPageLibrary: 'Library',
  startPagePlaylists: 'Playlists',
  startPageSearch: 'Search',
  startPageLast: 'Last',
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
  share: 'Share',
  hideWindow: 'Hide Sidra',
  showWindow: 'Show Sidra',
  closeToTray: 'Close to tray',
};

// Expected menu label per registry page id. Typed over the union, so a new page
// with no expectation here fails tsc rather than going untested.
const TEST_START_PAGE_LABELS: Record<AnyStartPageId, string> = {
  'home': mockTrayStrings.startPageHome,
  'new': mockTrayStrings.startPageNew,
  'radio': mockTrayStrings.startPageRadio,
  'all-playlists': mockTrayStrings.startPageAllPlaylists,
  'browse': mockTrayStrings.startPageBrowse,
  'playlists': mockTrayStrings.startPagePlaylists,
  'search': mockTrayStrings.startPageSearch,
};

vi.mock('../src/i18n', () => ({
  getTrayStrings: () => mockTrayStrings,
  getAboutStrings: () => ({ close: 'Close', versionPrefix: 'Version', copyrightSuffix: 'All rights reserved', licensePrefix: 'License' }),
  getUpdateStrings: () => ({ updateAvailable: 'Update available: {version}', upToDate: 'Up to date' }),
  getAutoUpdateStrings: () => ({ ready: 'Restart to update' }),
}));

vi.mock('../src/integrations/lastfm', () => ({
  enable: vi.fn(),
  disable: vi.fn(),
  startAuth: vi.fn(),
  disconnect: vi.fn(),
  isConfigured: vi.fn(() => false),
}));

vi.mock('../src/update', () => ({
  getUpdateInfo: vi.fn(() => null),
}));

vi.mock('../src/autoUpdate', () => ({
  quitAndInstall: vi.fn(),
}));

vi.mock('../src/theme', () => ({
  applyTheme: vi.fn(),
  resolveTheme: vi.fn(),
  hasCustomCss: vi.fn(),
}));

vi.mock('../src/artwork', () => ({
  downloadArtwork: vi.fn(() => Promise.resolve('/tmp/downloaded-artwork.png')),
}));

vi.mock('../src/paths', () => ({
  getAssetPath: vi.fn((...parts: string[]) => parts.join('/')),
  getProductInfo: () => ({ productName: 'Sidra', description: 'Apple Music client', author: 'Test', license: 'MIT' }),
}));

import { BrowserWindow, Menu, Tray, nativeImage, nativeTheme } from 'electron';
import { getUpdateInfo } from '../src/update';
import { truncateMenuLabel, sanitiseLinuxLabel, cancelTrayRebuild, createTray, getMenuIcon, updateNowPlayingState, updateTrayTooltip, rebuildTrayMenu, initTrayStateManager, setGetMainWindowCallback, setSwitchServiceCallback } from '../src/tray';
import { getCloseToTrayEnabled, getTheme, setTheme, getMusicService, setMusicService, getClassicalStartPage, getLastfmEnabled, setLastfmEnabled, getLastfmSessionKey, getLastfmUsername } from '../src/config';
import { downloadArtwork } from '../src/artwork';
import { PlaybackState } from '../src/player';
import type { NowPlayingPayload, PlayerEvents } from '../src/player';
import { applyTheme, hasCustomCss, resolveTheme } from '../src/theme';
import { startAuth as startLastfmAuth, disconnect as disconnectLastfm, isConfigured as isLastfmConfigured } from '../src/integrations/lastfm';
import { FakePlayer } from './mocks/player';
import { MUSIC_SERVICES, type AnyStartPageId, type ClassicalStartPageId, type MusicServiceId } from '../src/musicService';

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

  beforeEach(() => {
    vi.mocked(resolveTheme).mockReturnValue('apple-music');
    vi.mocked(hasCustomCss).mockReturnValue(false);
  });

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
    afterEach(() => {
      vi.mocked(isLastfmConfigured).mockReturnValue(false);
    });

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

    // With now-playing state cleared, Volume is gone and every remaining item
    // with a submenu is a top-level settings parent. Comparing the text before
    // the first ':' keeps the assertion independent of the toggle states.
    it('asserts the full top-level submenu order', () => {
      setPlatform('linux');
      updateNowPlayingState(null, null, false, 0);
      vi.mocked(isLastfmConfigured).mockReturnValue(true);
      createTray();
      const parents = getLastTemplate()
        .filter((item) => item.submenu !== undefined)
        .map((item) => String(item.label).split(':')[0]);
      expect(parents).toEqual([
        'Player',
        'Start Page',
        'Close to tray',
        'Notifications',
        'Discord',
        'Last.fm',
        'Style',
        'Zoom',
      ]);
    });
  });

  describe('Player submenu', () => {
    beforeEach(() => {
      setPlatform('linux');
      vi.mocked(getMusicService).mockReturnValue('music');
      vi.mocked(resolveTheme).mockReturnValue('apple-music');
      vi.mocked(hasCustomCss).mockReturnValue(false);
    });

    it('Player submenu parent is present in the template', () => {
      createTray();
      const template = getLastTemplate();
      const playerItem = findItem(template, 'Player');
      expect(playerItem).toBeDefined();
    });

    it('Player submenu parent label shows active service', () => {
      createTray();
      const template = getLastTemplate();
      const playerItem = findItem(template, 'Player');
      expect(playerItem!.label).toBe('Player: Apple Music');
    });

    it('Apple Music radio item is checked when music service is active', () => {
      createTray();
      const template = getLastTemplate();
      const playerItem = findItem(template, 'Player');
      const submenu = playerItem!.submenu as Electron.MenuItemConstructorOptions[];
      const musicItem = submenu.find(item => item.label === 'Apple Music');
      expect(musicItem).toBeDefined();
      expect(musicItem!.checked).toBe(true);
    });

    it('Apple Music Classical radio item is unchecked when music service is active', () => {
      createTray();
      const template = getLastTemplate();
      const playerItem = findItem(template, 'Player');
      const submenu = playerItem!.submenu as Electron.MenuItemConstructorOptions[];
      const classicalItem = submenu.find(item => item.label === 'Apple Music Classical');
      expect(classicalItem).toBeDefined();
      expect(classicalItem!.checked).toBe(false);
    });

    it('Player submenu parent label shows Classical when classical is active', () => {
      vi.mocked(getMusicService).mockReturnValue('classical');
      createTray();
      const template = getLastTemplate();
      const playerItem = findItem(template, 'Player');
      expect(playerItem!.label).toBe('Player: Apple Music Classical');
    });

    it('Apple Music Classical radio item is checked when classical service is active', () => {
      vi.mocked(getMusicService).mockReturnValue('classical');
      createTray();
      const template = getLastTemplate();
      const playerItem = findItem(template, 'Player');
      const submenu = playerItem!.submenu as Electron.MenuItemConstructorOptions[];
      const classicalItem = submenu.find(item => item.label === 'Apple Music Classical');
      expect(classicalItem!.checked).toBe(true);
    });
  });

  describe('Player submenu service switch', () => {
    const onSwitch = vi.fn();

    beforeEach(() => {
      setPlatform('linux');
      vi.mocked(getMusicService).mockReturnValue('music');
      vi.mocked(resolveTheme).mockReturnValue('apple-music');
      vi.mocked(hasCustomCss).mockReturnValue(false);
      vi.mocked(setMusicService).mockClear();
      onSwitch.mockClear();
      setSwitchServiceCallback(onSwitch);
    });

    // Mocks are not reset between tests, so hand back the state the rest of the
    // file builds the menu in.
    afterEach(() => {
      setSwitchServiceCallback(() => {});
      vi.mocked(getMusicService).mockReturnValue('music');
    });

    function playerSubmenu(): Electron.MenuItemConstructorOptions[] {
      createTray();
      const playerItem = findItem(getLastTemplate(), 'Player');
      expect(playerItem).toBeDefined();
      return playerItem!.submenu as Electron.MenuItemConstructorOptions[];
    }

    it('hands the clicked service id to the wired callback', () => {
      const classicalItem = playerSubmenu().find(item => item.label === 'Apple Music Classical');
      expect(classicalItem).toBeDefined();
      (classicalItem!.click as Function)();
      expect(onSwitch).toHaveBeenCalledTimes(1);
      expect(onSwitch).toHaveBeenCalledWith('classical');
    });

    it('does nothing when the active service is clicked', () => {
      const musicItem = playerSubmenu().find(item => item.label === 'Apple Music');
      expect(musicItem).toBeDefined();
      (musicItem!.click as Function)();
      expect(onSwitch).not.toHaveBeenCalled();
      expect(vi.mocked(setMusicService)).not.toHaveBeenCalled();
    });

    it('takes a service id rather than any string', () => {
      expectTypeOf(setSwitchServiceCallback).parameter(0).parameter(0).toEqualTypeOf<MusicServiceId>();
      expectTypeOf(setSwitchServiceCallback).parameter(0).parameter(0).not.toEqualTypeOf<string>();
    });
  });

  describe('Player submenu with an unregistered service id', () => {
    // Stands in for a hand-edited config file, or for a downgrade past a future
    // release that adds a third service id.
    const UNREGISTERED_SERVICE_ID = 'jazz' as string as MusicServiceId;

    beforeEach(() => {
      setPlatform('linux');
      vi.mocked(getMusicService).mockReturnValue(UNREGISTERED_SERVICE_ID);
      vi.mocked(getTheme).mockReturnValue('apple-music');
      vi.mocked(resolveTheme).mockReturnValue('apple-music');
      vi.mocked(hasCustomCss).mockReturnValue(false);
    });

    // Mocks are not reset between tests, so hand back the state the rest of the
    // file builds the menu in.
    afterEach(() => {
      vi.mocked(getMusicService).mockReturnValue('music');
      vi.mocked(getTheme).mockReturnValue('apple-music');
      vi.mocked(resolveTheme).mockReturnValue('apple-music');
      vi.mocked(hasCustomCss).mockReturnValue(false);
    });

    it('builds a menu rather than leaving the tray without one', () => {
      expect(() => createTray()).not.toThrow();
      expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalled();
      expect(getLastTemplate().length).toBeGreaterThan(0);
    });

    it('names the default service in the Player parent label', () => {
      createTray();
      const playerItem = findItem(getLastTemplate(), 'Player');
      expect(playerItem!.label).toBe('Player: Apple Music');
    });

    it('still lists every registered service', () => {
      createTray();
      const playerItem = findItem(getLastTemplate(), 'Player');
      const submenu = playerItem!.submenu as Electron.MenuItemConstructorOptions[];
      expect(submenu.map(item => item.label)).toEqual(['Apple Music', 'Apple Music Classical']);
    });
  });

  describe('Start Page submenu with classical service', () => {
    beforeEach(() => {
      setPlatform('linux');
      vi.mocked(getMusicService).mockReturnValue('classical');
      vi.mocked(getClassicalStartPage).mockReturnValue('home');
      vi.mocked(resolveTheme).mockReturnValue('apple-music');
      vi.mocked(hasCustomCss).mockReturnValue(false);
    });

    it('Start Page submenu shows classical pages when classical is active', () => {
      createTray();
      const template = getLastTemplate();
      const startPageItem = findItem(template, 'Start Page');
      const submenu = startPageItem!.submenu as Electron.MenuItemConstructorOptions[];
      const labels = submenu.map(item => item.label);
      expect(labels).toEqual(['Home', 'Browse', 'Playlists', 'Search', 'Last']);
      expect(labels).not.toContain('New');
      expect(labels).not.toContain('Radio');
    });

    it('falls back to Home when a stored library page is no longer offered', () => {
      // 'library' was persisted before WW-92 dropped the page; the store can still
      // hold it, the type no longer admits it.
      vi.mocked(getClassicalStartPage).mockReturnValue('library' as string as ClassicalStartPageId);
      createTray();
      const template = getLastTemplate();
      const startPageItem = findItem(template, 'Start Page');
      expect(startPageItem!.label).toBe('Start Page: Home');
      const submenu = startPageItem!.submenu as Electron.MenuItemConstructorOptions[];
      const ticked = submenu.filter(item => item.checked === true).map(item => item.label);
      expect(ticked).toEqual(['Home']);
    });
  });

  describe('Start Page submenu covers the registry', () => {
    beforeEach(() => {
      setPlatform('linux');
      vi.mocked(resolveTheme).mockReturnValue('apple-music');
      vi.mocked(hasCustomCss).mockReturnValue(false);
    });

    // Mocks are not reset between tests, so hand back the state the rest of the
    // file builds the menu in.
    afterEach(() => {
      vi.mocked(getMusicService).mockReturnValue('music');
      vi.mocked(getClassicalStartPage).mockReturnValue('home');
    });

    function startPageSubmenu(): Electron.MenuItemConstructorOptions[] {
      createTray();
      const startPageItem = findItem(getLastTemplate(), 'Start Page');
      expect(startPageItem).toBeDefined();
      return startPageItem!.submenu as Electron.MenuItemConstructorOptions[];
    }

    it('offers a radio entry for every music start page in the registry', () => {
      vi.mocked(getMusicService).mockReturnValue('music');
      const submenu = startPageSubmenu();
      for (const page of MUSIC_SERVICES.music.startPages) {
        const entry = submenu.find(item => item.label === TEST_START_PAGE_LABELS[page.id]);
        expect(entry, `${page.id} should have a menu entry`).toBeDefined();
        expect(entry!.type).toBe('radio');
      }
    });

    it('offers a radio entry for every classical start page in the registry', () => {
      vi.mocked(getMusicService).mockReturnValue('classical');
      const submenu = startPageSubmenu();
      for (const page of MUSIC_SERVICES.classical.startPages) {
        const entry = submenu.find(item => item.label === TEST_START_PAGE_LABELS[page.id]);
        expect(entry, `${page.id} should have a menu entry`).toBeDefined();
        expect(entry!.type).toBe('radio');
      }
    });
  });

  describe('Style submenu disabled on Classical', () => {
    beforeEach(() => {
      setPlatform('linux');
      vi.mocked(getMusicService).mockReturnValue('classical');
      vi.mocked(resolveTheme).mockReturnValue('apple-music');
      vi.mocked(hasCustomCss).mockReturnValue(false);
    });

    it('Style submenu is disabled when classical is active', () => {
      createTray();
      const template = getLastTemplate();
      const styleItem = findItem(template, 'Style');
      expect(styleItem).toBeDefined();
      expect(styleItem!.enabled).toBe(false);
    });

    it('Style submenu is enabled when music service is active', () => {
      vi.mocked(getMusicService).mockReturnValue('music');
      createTray();
      const template = getLastTemplate();
      const styleItem = findItem(template, 'Style');
      expect(styleItem!.enabled).toBe(true);
    });
  });

  describe('Style submenu theme on Classical', () => {
    // Classical injects no override CSS, so resolveTheme() reduces the stored
    // choice to 'apple-music'. The menu must still report what is stored.
    beforeEach(() => {
      setPlatform('linux');
      vi.mocked(getMusicService).mockReturnValue('classical');
      vi.mocked(getTheme).mockReturnValue('dracula');
      vi.mocked(resolveTheme).mockReturnValue('apple-music');
      vi.mocked(hasCustomCss).mockReturnValue(false);
    });

    // Mocks are not reset between tests, so hand back the state the rest of the
    // file builds the menu in.
    afterEach(() => {
      vi.mocked(getMusicService).mockReturnValue('music');
      vi.mocked(getTheme).mockReturnValue('apple-music');
      vi.mocked(resolveTheme).mockReturnValue('apple-music');
      vi.mocked(hasCustomCss).mockReturnValue(false);
    });

    it('names the stored theme in the parent label', () => {
      createTray();
      const styleItem = findItem(getLastTemplate(), 'Style');
      expect(styleItem!.label).toBe('Style: Dracula');
    });

    it('ticks the stored theme and nothing else', () => {
      createTray();
      const styleItem = findItem(getLastTemplate(), 'Style');
      const submenu = styleItem!.submenu as Electron.MenuItemConstructorOptions[];
      const ticked = submenu.filter(item => item.checked === true).map(item => item.label);
      expect(ticked).toEqual(['Dracula']);
    });

    it('stays disabled with a stored theme other than Apple Music', () => {
      createTray();
      const styleItem = findItem(getLastTemplate(), 'Style');
      expect(styleItem!.enabled).toBe(false);
    });

    it('falls back to Apple Music when the stored custom.css is gone', () => {
      vi.mocked(getTheme).mockReturnValue('custom');
      createTray();
      const styleItem = findItem(getLastTemplate(), 'Style');
      expect(styleItem!.label).toBe('Style: Apple Music');
      const submenu = styleItem!.submenu as Electron.MenuItemConstructorOptions[];
      const ticked = submenu.filter(item => item.checked === true).map(item => item.label);
      expect(ticked).toEqual(['Apple Music']);
    });

    it('follows resolveTheme rather than the stored theme on the music service', () => {
      vi.mocked(getMusicService).mockReturnValue('music');
      vi.mocked(resolveTheme).mockReturnValue('rose-pine');
      createTray();
      const styleItem = findItem(getLastTemplate(), 'Style');
      expect(styleItem!.label).toBe('Style: Rosé Pine');
      const submenu = styleItem!.submenu as Electron.MenuItemConstructorOptions[];
      const ticked = submenu.filter(item => item.checked === true).map(item => item.label);
      expect(ticked).toEqual(['Rosé Pine']);
    });
  });

  describe('style submenu', () => {
    beforeEach(() => {
      setPlatform('linux');
      vi.mocked(resolveTheme).mockReturnValue('apple-music');
      vi.mocked(hasCustomCss).mockReturnValue(false);
      vi.mocked(setTheme).mockClear();
      vi.mocked(applyTheme).mockClear();
    });

    it('lists Apple Music and bundled themes in order', () => {
      createTray();
      const template = getLastTemplate();
      const styleItem = findItem(template, 'Style');
      const submenu = styleItem!.submenu as Electron.MenuItemConstructorOptions[];
      const labels = submenu.map(item => item.label);
      expect(labels).toEqual(['Apple Music', 'Catppuccin', 'Dracula', 'Gruvbox', 'Nord', 'Rosé Pine', 'Solarized']);
      expect(submenu.every(item => item.type === 'radio')).toBe(true);
    });

    it('adds Custom only when custom.css exists', () => {
      createTray();
      let template = getLastTemplate();
      let styleItem = findItem(template, 'Style');
      let submenu = styleItem!.submenu as Electron.MenuItemConstructorOptions[];
      expect(submenu.some(item => item.label === 'Custom')).toBe(false);

      vi.mocked(hasCustomCss).mockReturnValue(true);
      createTray();
      template = getLastTemplate();
      styleItem = findItem(template, 'Style');
      submenu = styleItem!.submenu as Electron.MenuItemConstructorOptions[];
      expect(submenu.some(item => item.label === 'Custom')).toBe(true);
    });

    it('clicking a theme radio updates config and applies theme', () => {
      createTray();
      const template = getLastTemplate();
      const styleItem = findItem(template, 'Style');
      const submenu = styleItem!.submenu as Electron.MenuItemConstructorOptions[];
      const draculaItem = submenu.find(item => item.label === 'Dracula');
      expect(draculaItem).toBeDefined();
      (draculaItem!.click as Function)();
      expect(vi.mocked(setTheme)).toHaveBeenCalledWith('dracula');
      expect(vi.mocked(applyTheme)).toHaveBeenCalledWith('dracula');
    });

    it('uses resolveTheme for the parent label', () => {
      vi.mocked(resolveTheme).mockReturnValue('rose-pine');
      createTray();
      const template = getLastTemplate();
      const styleItem = findItem(template, 'Style');
      expect(styleItem!.label).toBe('Style: Rosé Pine');
    });
  });

  describe('Last.fm submenu', () => {
    beforeEach(() => {
      setPlatform('linux');
      vi.mocked(isLastfmConfigured).mockReturnValue(true);
      vi.mocked(startLastfmAuth).mockClear();
      vi.mocked(disconnectLastfm).mockClear();
      vi.mocked(setLastfmEnabled).mockClear();
    });

    // The rest of the file runs with no credentials, which is the state the
    // menu is built in everywhere else.
    afterEach(() => {
      vi.mocked(isLastfmConfigured).mockReturnValue(false);
      vi.mocked(getLastfmSessionKey).mockReturnValue(null);
      vi.mocked(getLastfmUsername).mockReturnValue(null);
      vi.mocked(getLastfmEnabled).mockReturnValue(false);
    });

    /** Puts the config mocks in the state left by a completed auth flow. */
    function linkAccount(username = 'martin'): void {
      vi.mocked(getLastfmSessionKey).mockReturnValue('session-key');
      vi.mocked(getLastfmUsername).mockReturnValue(username);
      vi.mocked(getLastfmEnabled).mockReturnValue(true);
    }

    function lastfmItem(): Electron.MenuItemConstructorOptions {
      createTray();
      const item = findItem(getLastTemplate(), 'Last.fm');
      expect(item).toBeDefined();
      return item!;
    }

    function lastfmSubmenu(): Electron.MenuItemConstructorOptions[] {
      return lastfmItem().submenu as Electron.MenuItemConstructorOptions[];
    }

    it('offers a single connect action when no account is linked', () => {
      expect(lastfmSubmenu().map(item => item.label)).toEqual(['Connect to Last.fm…']);
    });

    it('starts the auth flow when connect is clicked', () => {
      const connectItem = lastfmSubmenu()[0];
      (connectItem.click as Function)();
      expect(vi.mocked(setLastfmEnabled)).toHaveBeenCalledWith(true);
      expect(vi.mocked(startLastfmAuth)).toHaveBeenCalled();
    });

    it('reports the scrobbling state in the parent label when connected', () => {
      linkAccount();
      expect(lastfmItem().label).toBe('Last.fm: On');
    });

    it('names the linked account in a row of its own', () => {
      linkAccount('wimpy');
      const account = findItem(lastfmSubmenu(), 'wimpy');
      expect(account).toBeDefined();
      expect(account!.label).toBe('✓ wimpy');
      expect(account!.enabled).toBe(false);
    });

    it('disconnects the account when the disconnect item is clicked', () => {
      linkAccount();
      const disconnectItem = findItem(lastfmSubmenu(), 'Disconnect');
      expect(disconnectItem).toBeDefined();
      (disconnectItem!.click as Function)();
      expect(vi.mocked(disconnectLastfm)).toHaveBeenCalled();
    });

    it('omits the Last.fm item entirely when no credentials are configured', () => {
      vi.mocked(isLastfmConfigured).mockReturnValue(false);
      createTray();
      expect(findItem(getLastTemplate(), 'Last.fm')).toBeUndefined();
    });
  });

  describe('close-to-tray enabled state', () => {
    let mockWin: { isVisible: ReturnType<typeof vi.fn>; show: ReturnType<typeof vi.fn>; hide: ReturnType<typeof vi.fn>; focus: ReturnType<typeof vi.fn> };

    beforeEach(() => {
      setPlatform('linux');
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: true, configurable: true });
      mockWin = { isVisible: vi.fn(() => true), show: vi.fn(), hide: vi.fn(), focus: vi.fn() };
      setGetMainWindowCallback(() => mockWin as unknown as BrowserWindow);
      vi.mocked(getCloseToTrayEnabled).mockReturnValue(true);
    });

    afterEach(() => {
      setGetMainWindowCallback(() => null);
      vi.mocked(getCloseToTrayEnabled).mockReturnValue(false);
    });

    it('shows Hide Sidra when window is visible', () => {
      createTray();
      const template = getLastTemplate();
      expect(findItem(template, 'Hide Sidra')).toBeDefined();
      expect(findItem(template, 'Show Sidra')).toBeUndefined();
    });

    it('shows Show Sidra when window is hidden', () => {
      mockWin.isVisible.mockReturnValue(false);
      createTray();
      const template = getLastTemplate();
      expect(findItem(template, 'Show Sidra')).toBeDefined();
      expect(findItem(template, 'Hide Sidra')).toBeUndefined();
    });

    it('resolves a different icon for the Hide state and the Show state', () => {
      // Both entries once shared a single icon key, so each state is checked for
      // the icon it needs and against the icon the other state needs.
      const iconPaths = (visible: boolean): string[] => {
        mockWin.isVisible.mockReturnValue(visible);
        vi.mocked(nativeImage.createFromPath).mockClear();
        createTray();
        return vi.mocked(nativeImage.createFromPath).mock.calls.map((call) => String(call[0]));
      };

      const whenVisible = iconPaths(true);
      expect(whenVisible.some((p) => p.endsWith('/dark/eye-slash.png'))).toBe(true);
      expect(whenVisible.some((p) => p.endsWith('/dark/eye.png'))).toBe(false);

      const whenHidden = iconPaths(false);
      expect(whenHidden.some((p) => p.endsWith('/dark/eye.png'))).toBe(true);
      expect(whenHidden.some((p) => p.endsWith('/dark/eye-slash.png'))).toBe(false);
    });

    it('shows neither item when close-to-tray is disabled', () => {
      vi.mocked(getCloseToTrayEnabled).mockReturnValue(false);
      createTray();
      const template = getLastTemplate();
      expect(findItem(template, 'Hide Sidra')).toBeUndefined();
      expect(findItem(template, 'Show Sidra')).toBeUndefined();
    });

    it('shows and focuses the window when disabling close-to-tray while hidden', () => {
      mockWin.isVisible.mockReturnValue(false);
      createTray();
      const template = getLastTemplate();
      const closeToTrayItem = findItem(template, 'Close to tray');
      const submenu = closeToTrayItem!.submenu as Electron.MenuItemConstructorOptions[];
      const offItem = submenu.find(item => item.label === 'Off');
      expect(offItem).toBeDefined();
      (offItem!.click as Function)();
      expect(mockWin.show).toHaveBeenCalled();
      expect(mockWin.focus).toHaveBeenCalled();
    });

    it('tray click shows and focuses the window when hidden', () => {
      mockWin.isVisible.mockReturnValue(false);
      const tray = createTray();
      const onFn = tray.on as ReturnType<typeof vi.fn>;
      const clickCall = onFn.mock.calls.find(([event]: [string]) => event === 'click');
      expect(clickCall).toBeDefined();
      (clickCall![1] as () => void)();
      expect(mockWin.show).toHaveBeenCalled();
      expect(mockWin.focus).toHaveBeenCalled();
    });

    it('tray click rebuilds the menu after showing a hidden window', () => {
      mockWin.isVisible.mockReturnValue(false);
      // Showing the window flips visibility, so the rebuilt menu is built against the new state.
      mockWin.show.mockImplementation(() => { mockWin.isVisible.mockReturnValue(true); });
      const tray = createTray();
      const setContextMenu = tray.setContextMenu as ReturnType<typeof vi.fn>;
      // Delta, never an absolute count: createTray() sets the menu once on its own.
      const before = setContextMenu.mock.calls.length;
      const onFn = tray.on as ReturnType<typeof vi.fn>;
      const clickCall = onFn.mock.calls.find(([event]: [string]) => event === 'click');
      expect(clickCall).toBeDefined();
      (clickCall![1] as () => void)();
      expect(setContextMenu.mock.calls.length).toBe(before + 1);
      // Without the rebuild the menu still offers Show Sidra for a window that is now visible.
      const template = getLastTemplate();
      expect(findItem(template, 'Hide Sidra')).toBeDefined();
      expect(findItem(template, 'Show Sidra')).toBeUndefined();
    });

    it('tray click focuses a visible window without rebuilding the menu', () => {
      const tray = createTray();
      const setContextMenu = tray.setContextMenu as ReturnType<typeof vi.fn>;
      const before = setContextMenu.mock.calls.length;
      const onFn = tray.on as ReturnType<typeof vi.fn>;
      const clickCall = onFn.mock.calls.find(([event]: [string]) => event === 'click');
      expect(clickCall).toBeDefined();
      (clickCall![1] as () => void)();
      expect(mockWin.focus).toHaveBeenCalled();
      expect(mockWin.show).not.toHaveBeenCalled();
      expect(setContextMenu.mock.calls.length).toBe(before);
    });

    it('tray click is a no-op when close-to-tray is disabled', () => {
      mockWin.isVisible.mockReturnValue(false);
      vi.mocked(getCloseToTrayEnabled).mockReturnValue(false);
      const tray = createTray();
      const onFn = tray.on as ReturnType<typeof vi.fn>;
      const clickCall = onFn.mock.calls.find(([event]: [string]) => event === 'click');
      expect(clickCall).toBeDefined();
      (clickCall![1] as () => void)();
      expect(mockWin.show).not.toHaveBeenCalled();
      expect(mockWin.focus).not.toHaveBeenCalled();
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

    it('maps the window actions to the open and closed eye PNGs', () => {
      Object.defineProperty(nativeTheme, 'shouldUseDarkColors', { value: false, configurable: true });
      getMenuIcon('show-window');
      expect(vi.mocked(nativeImage.createFromPath)).toHaveBeenCalledWith(
        expect.stringContaining('tray/menu/light/eye.png')
      );
      getMenuIcon('hide-window');
      expect(vi.mocked(nativeImage.createFromPath)).toHaveBeenCalledWith(
        expect.stringContaining('tray/menu/light/eye-slash.png')
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

    it('resolves correct SF Symbol for each Now Playing and window action', () => {
      const cases: [string, string][] = [
        ['artist', 'star'],
        ['album', 'opticaldisc'],
        ['previous', 'backward.end'],
        ['play', 'play'],
        ['pause', 'pause'],
        ['next', 'forward.end'],
        ['volume', 'speaker.wave.2'],
        ['show-window', 'eye'],
        ['hide-window', 'eye.slash'],
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
  let player: FakePlayer;
  let mockTray: InstanceType<typeof Tray>;

  // The state manager coalesces rebuilds behind a 250ms window, so every test
  // in this block runs on fake timers and steps past the window to see the
  // rebuild land.
  const COALESCE_MS = 250;

  /**
   * The handler the state manager registered for `event`. Taking it from the
   * emitter rather than emitting keeps the async handlers awaitable, and lets a
   * test set the playback snapshot without a state change of its own.
   */
  function handlerFor<K extends keyof PlayerEvents & string>(event: K): (...args: PlayerEvents[K]) => unknown {
    const [listener] = player.listeners(event);
    expect(listener).toBeDefined();
    return listener as (...args: PlayerEvents[K]) => unknown;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // The coalescing timer is module state, and switching timer modes discards
    // the pending callback without clearing the handle it was stored under.
    cancelTrayRebuild();
    player = new FakePlayer();
    mockTray = new Tray('test-icon.png');
    vi.mocked(Menu.buildFromTemplate).mockClear();
    vi.mocked(downloadArtwork).mockReset();
    vi.mocked(downloadArtwork).mockResolvedValue('/tmp/downloaded-artwork.png');
    vi.mocked(resolveTheme).mockReturnValue('apple-music');
    vi.mocked(hasCustomCss).mockReturnValue(false);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('event subscription', () => {
    it('registers all three event listeners on the player', () => {
      initTrayStateManager(player, mockTray);
      expect(player.listenerCount('nowPlayingItemDidChange')).toBe(1);
      expect(player.listenerCount('playbackStateDidChange')).toBe(1);
      expect(player.listenerCount('volumeDidChange')).toBe(1);
      expect(player.eventNames()).toHaveLength(3);
    });
  });

  describe('cleanup function', () => {
    it('removes all three event listeners from the player', () => {
      const cleanup = initTrayStateManager(player, mockTray);
      cleanup();
      expect(player.eventNames()).toHaveLength(0);
    });

    it('clears the pause timer when called during an active pause timeout', () => {
      const cleanup = initTrayStateManager(player, mockTray);

      // Simulate playing then pausing to start the pause timer
      player.setPlaybackState(PlaybackState.Playing);
      handlerFor('playbackStateDidChange')({ status: true, state: PlaybackState.Playing });

      player.setPlaybackState(PlaybackState.Paused);
      handlerFor('playbackStateDidChange')({ status: true, state: PlaybackState.Paused });

      // Timer is now pending. Cleanup should clear it.
      cleanup();

      // Advance past the 30s timeout - should not trigger any state clearing
      vi.mocked(Menu.buildFromTemplate).mockClear();
      vi.advanceTimersByTime(35_000);

      // No additional menu rebuild from the timer callback
      expect(vi.mocked(Menu.buildFromTemplate)).not.toHaveBeenCalled();
    });

    it('drops a rebuild still inside the coalescing window', () => {
      const cleanup = initTrayStateManager(player, mockTray);
      player.setPlaybackState(PlaybackState.Playing);

      handlerFor('volumeDidChange')(0.5);
      cleanup();

      vi.advanceTimersByTime(COALESCE_MS);
      expect(vi.mocked(Menu.buildFromTemplate)).not.toHaveBeenCalled();
    });
  });

  describe('pause timeout', () => {
    it('clears Now Playing after 30s of inactivity when paused', () => {
      initTrayStateManager(player, mockTray);

      // Transition to playing first (sets previousPlaying = true)
      player.setPlaybackState(PlaybackState.Playing);
      handlerFor('playbackStateDidChange')({ status: true, state: PlaybackState.Playing });

      // Transition to paused
      player.setPlaybackState(PlaybackState.Paused);
      handlerFor('playbackStateDidChange')({ status: true, state: PlaybackState.Paused });

      // Advance 29s - should not have cleared yet
      vi.mocked(Menu.buildFromTemplate).mockClear();
      const setToolTipFn = mockTray.setToolTip as ReturnType<typeof vi.fn>;
      setToolTipFn.mockClear();

      vi.advanceTimersByTime(29_000);
      // The tooltip should not have been cleared to the product name yet
      expect(setToolTipFn).not.toHaveBeenCalled();

      // Advance past 30s, then past the rebuild window
      vi.advanceTimersByTime(2_000);

      // Now the tooltip should be reset (updateTrayTooltip(tray, null) sets product name)
      expect(setToolTipFn).toHaveBeenCalled();
      // And the menu should be rebuilt
      expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalled();
    });

    it('cancels the pause timer when playback resumes', () => {
      initTrayStateManager(player, mockTray);

      // Play -> Pause (start timer)
      player.setPlaybackState(PlaybackState.Playing);
      handlerFor('playbackStateDidChange')({ status: true, state: PlaybackState.Playing });

      player.setPlaybackState(PlaybackState.Paused);
      handlerFor('playbackStateDidChange')({ status: true, state: PlaybackState.Paused });

      // Resume playing before timeout
      vi.advanceTimersByTime(10_000);
      player.setPlaybackState(PlaybackState.Playing);
      handlerFor('playbackStateDidChange')({ status: true, state: PlaybackState.Playing });

      // Advance past original timeout - should not clear
      vi.mocked(Menu.buildFromTemplate).mockClear();
      const setToolTipFn = mockTray.setToolTip as ReturnType<typeof vi.fn>;
      setToolTipFn.mockClear();
      vi.advanceTimersByTime(25_000);

      expect(setToolTipFn).not.toHaveBeenCalled();
    });

    it('cancels the pause timer on track change', async () => {
      initTrayStateManager(player, mockTray);

      // Play -> Pause (start timer)
      player.setPlaybackState(PlaybackState.Playing);
      handlerFor('playbackStateDidChange')({ status: true, state: PlaybackState.Playing });

      player.setPlaybackState(PlaybackState.Paused);
      handlerFor('playbackStateDidChange')({ status: true, state: PlaybackState.Paused });

      // New track arrives - should cancel timer
      const payload: NowPlayingPayload = { name: 'New Track', artistName: 'Artist' };
      vi.mocked(downloadArtwork).mockResolvedValue(null);
      player.setPlaybackState(PlaybackState.Playing);
      await handlerFor('nowPlayingItemDidChange')(payload);

      // Advance past original timeout - should not clear
      vi.mocked(Menu.buildFromTemplate).mockClear();
      const setToolTipFn = mockTray.setToolTip as ReturnType<typeof vi.fn>;
      setToolTipFn.mockClear();
      vi.advanceTimersByTime(35_000);

      // No timeout-triggered tooltip reset
      expect(setToolTipFn).not.toHaveBeenCalled();
    });
  });

  describe('nowPlayingItemDidChange handler', () => {
    it('updates tooltip and menu when a new track arrives', async () => {
      initTrayStateManager(player, mockTray);
      const payload: NowPlayingPayload = { name: 'Test Song', artistName: 'Test Artist' };
      vi.mocked(downloadArtwork).mockResolvedValue(null);
      player.setPlaybackState(PlaybackState.Playing);

      await handlerFor('nowPlayingItemDidChange')(payload);
      vi.advanceTimersByTime(COALESCE_MS);

      const setToolTipFn = mockTray.setToolTip as ReturnType<typeof vi.fn>;
      expect(setToolTipFn).toHaveBeenCalled();
      expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalled();
    });

    it('clears state when null payload is received', async () => {
      initTrayStateManager(player, mockTray);

      await handlerFor('nowPlayingItemDidChange')(null);
      vi.advanceTimersByTime(COALESCE_MS);

      const setToolTipFn = mockTray.setToolTip as ReturnType<typeof vi.fn>;
      expect(setToolTipFn).toHaveBeenCalled();
      expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalled();
    });

    it('downloads artwork when artworkUrl is present', async () => {
      initTrayStateManager(player, mockTray);
      const payload: NowPlayingPayload = { name: 'Song', artworkUrl: 'https://example.com/art.jpg' };
      player.setPlaybackState(PlaybackState.Playing);

      await handlerFor('nowPlayingItemDidChange')(payload);

      expect(vi.mocked(downloadArtwork)).toHaveBeenCalledWith('https://example.com/art.jpg');
    });

    it('guards against stale payload after artwork download', async () => {
      initTrayStateManager(player, mockTray);

      // First track starts downloading artwork slowly
      let resolveFirst: (value: string | null) => void;
      const firstDownload = new Promise<string | null>((resolve) => { resolveFirst = resolve; });
      vi.mocked(downloadArtwork).mockReturnValueOnce(firstDownload);

      const payload1: NowPlayingPayload = { name: 'First Song', artworkUrl: 'https://example.com/art1.jpg' };
      const payload2: NowPlayingPayload = { name: 'Second Song', artworkUrl: 'https://example.com/art2.jpg' };

      player.setPlaybackState(PlaybackState.Playing);

      // Fire first track
      const firstPromise = handlerFor('nowPlayingItemDidChange')(payload1) as Promise<void>;

      // Fire second track before first artwork resolves
      vi.mocked(downloadArtwork).mockResolvedValueOnce('/tmp/art2.png');
      await handlerFor('nowPlayingItemDidChange')(payload2);

      // Clear the mock calls from the second track handler
      vi.advanceTimersByTime(COALESCE_MS);
      vi.mocked(Menu.buildFromTemplate).mockClear();

      // Resolve first artwork download - should be discarded (stale)
      resolveFirst!('/tmp/art1.png');
      await firstPromise;
      vi.advanceTimersByTime(COALESCE_MS);

      // No additional menu rebuild from the stale first track
      expect(vi.mocked(Menu.buildFromTemplate)).not.toHaveBeenCalled();
    });
  });

  describe('playbackStateDidChange handler', () => {
    it('clears state on terminal playback states', () => {
      initTrayStateManager(player, mockTray);

      for (const state of [PlaybackState.None, PlaybackState.Stopped, PlaybackState.Ended, PlaybackState.Completed]) {
        vi.mocked(Menu.buildFromTemplate).mockClear();
        handlerFor('playbackStateDidChange')({ status: true, state });
        vi.advanceTimersByTime(COALESCE_MS);
        expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalled();
      }
    });

    it('rebuilds menu on playback state change', () => {
      initTrayStateManager(player, mockTray);
      player.setPlaybackState(PlaybackState.Playing);

      vi.mocked(Menu.buildFromTemplate).mockClear();
      handlerFor('playbackStateDidChange')({ status: true, state: PlaybackState.Playing });
      vi.advanceTimersByTime(COALESCE_MS);

      expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalled();
    });
  });

  describe('volumeDidChange handler', () => {
    it('updates state and rebuilds menu on volume change', () => {
      initTrayStateManager(player, mockTray);
      player.setPlaybackState(PlaybackState.Playing);

      vi.mocked(Menu.buildFromTemplate).mockClear();
      handlerFor('volumeDidChange')(0.5);
      vi.advanceTimersByTime(COALESCE_MS);

      expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalled();
    });

    it('ignores null volume', () => {
      initTrayStateManager(player, mockTray);

      vi.mocked(Menu.buildFromTemplate).mockClear();
      handlerFor('volumeDidChange')(null);
      vi.advanceTimersByTime(COALESCE_MS);

      expect(vi.mocked(Menu.buildFromTemplate)).not.toHaveBeenCalled();
    });
  });

  describe('rebuild coalescing', () => {
    // The hook polls mk.volume every 250ms while the slider moves, and a page
    // in the renderer can emit far faster than that. Each rebuild walks every
    // submenu, reads custom.css and resizes the artwork five times.
    it('collapses a burst of volume events into a single rebuild', () => {
      initTrayStateManager(player, mockTray);
      player.setPlaybackState(PlaybackState.Playing);
      vi.mocked(Menu.buildFromTemplate).mockClear();

      const onVolume = handlerFor('volumeDidChange');
      for (let i = 1; i <= 20; i++) onVolume(i / 20);

      expect(vi.mocked(Menu.buildFromTemplate)).not.toHaveBeenCalled();
      vi.advanceTimersByTime(COALESCE_MS);
      expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalledTimes(1);
    });

    it('collapses a mixed burst of playback and volume events', () => {
      initTrayStateManager(player, mockTray);
      player.setPlaybackState(PlaybackState.Playing);
      vi.mocked(Menu.buildFromTemplate).mockClear();

      for (let i = 0; i < 10; i++) {
        handlerFor('volumeDidChange')(0.5);
        handlerFor('playbackStateDidChange')({ status: true, state: PlaybackState.Playing });
      }

      vi.advanceTimersByTime(COALESCE_MS);
      expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalledTimes(1);
    });

    it('shows the volume from the end of the burst', async () => {
      initTrayStateManager(player, mockTray);
      player.setPlaybackState(PlaybackState.Playing);
      vi.mocked(downloadArtwork).mockResolvedValue(null);
      await handlerFor('nowPlayingItemDidChange')({ name: 'Track', artistName: 'Artist' });
      vi.advanceTimersByTime(COALESCE_MS);

      const onVolume = handlerFor('volumeDidChange');
      onVolume(0.25);
      onVolume(0.5);
      onVolume(0.75);
      vi.mocked(Menu.buildFromTemplate).mockClear();
      vi.advanceTimersByTime(COALESCE_MS);

      const volumeItem = findItem(getLastTemplate(), 'Volume');
      expect(volumeItem!.label).toBe('Volume: 75%');
    });

    it('rebuilds again for events that arrive after the window closes', () => {
      initTrayStateManager(player, mockTray);
      player.setPlaybackState(PlaybackState.Playing);
      vi.mocked(Menu.buildFromTemplate).mockClear();

      const onVolume = handlerFor('volumeDidChange');
      onVolume(0.25);
      onVolume(0.5);
      vi.advanceTimersByTime(COALESCE_MS);
      expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalledTimes(1);

      onVolume(0.75);
      vi.advanceTimersByTime(COALESCE_MS);
      expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalledTimes(2);
    });

    it('keeps rebuilding under a flood that never pauses', () => {
      // A debounce restarted by every event would never expire here, leaving
      // the menu frozen. The window has to close on schedule regardless.
      initTrayStateManager(player, mockTray);
      player.setPlaybackState(PlaybackState.Playing);
      vi.mocked(Menu.buildFromTemplate).mockClear();

      const onVolume = handlerFor('volumeDidChange');
      for (let tick = 0; tick < 40; tick++) {
        onVolume(tick % 2 === 0 ? 0.4 : 0.6);
        vi.advanceTimersByTime(25);
      }

      expect(vi.mocked(Menu.buildFromTemplate)).toHaveBeenCalledTimes(4);
    });
  });
});
