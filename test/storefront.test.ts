// test/storefront.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock modules that storefront.ts imports with side effects.
// These must be declared before the import of storefront.ts.
vi.mock('../src/config', () => ({
  getStorefront: vi.fn(),
  setStorefront: vi.fn(),
  getLanguage: vi.fn(),
  setLanguage: vi.fn(),
  getCatppuccinEnabled: vi.fn(() => false),
  getStartPage: vi.fn(() => 'new'),
  getLastPageUrl: vi.fn(),
  getZoomFactor: vi.fn(() => 1.0),
}));

vi.mock('../src/i18n', () => ({
  getLoadingText: vi.fn(() => ({ text: 'Loading...', lang: 'en' })),
  getStorefront: vi.fn(() => 'us'),
}));

vi.mock('../src/paths', () => ({
  getAssetPath: vi.fn((...parts: string[]) => parts.join('/')),
}));

vi.mock('../src/player', () => ({
  Player: vi.fn(),
}));

vi.mock('../src/tray', () => ({
  createTray: vi.fn(),
  rebuildTrayMenu: vi.fn(),
  setApplyZoomCallback: vi.fn(),
}));

vi.mock('../src/update', () => ({
  checkForUpdates: vi.fn(),
}));

vi.mock('../src/autoUpdate', () => ({
  isAutoUpdateSupported: vi.fn(() => false),
  initAutoUpdate: vi.fn(),
}));

vi.mock('../src/integrations/notifications', () => ({
  init: vi.fn(),
}));

vi.mock('../src/integrations/discord-presence', () => ({
  init: vi.fn(),
}));

vi.mock('../src/wedgeDetector', () => ({
  init: vi.fn(),
  reset: vi.fn(),
}));

vi.mock('fs', () => ({
  default: { readFileSync: vi.fn(() => '') },
  readFileSync: vi.fn(() => ''),
}));

import { handleStorefrontNavigation } from '../src/storefront';
import { getStorefront, setStorefront, getLanguage, setLanguage } from '../src/config';

const mockedGetStorefront = vi.mocked(getStorefront);
const mockedSetStorefront = vi.mocked(setStorefront);
const mockedGetLanguage = vi.mocked(getLanguage);
const mockedSetLanguage = vi.mocked(setLanguage);

describe('handleStorefrontNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetStorefront.mockReturnValue('us');
    mockedGetLanguage.mockReturnValue(undefined);
  });

  it('persists new storefront and language from a valid Apple Music URL', () => {
    mockedGetStorefront.mockReturnValue('us');
    handleStorefrontNavigation('https://music.apple.com/gb/album/foo?l=en-GB');
    expect(mockedSetStorefront).toHaveBeenCalledWith('gb');
    expect(mockedSetLanguage).toHaveBeenCalledWith('en-GB');
  });

  it('saves storefront and clears language when URL has no language parameter', () => {
    mockedGetStorefront.mockReturnValue('us');
    mockedGetLanguage.mockReturnValue(undefined);
    handleStorefrontNavigation('https://music.apple.com/gb/new');
    expect(mockedSetStorefront).toHaveBeenCalledWith('gb');
    // nextLanguage = null ?? undefined ?? null = null, currentLanguage = undefined, null !== undefined
    expect(mockedSetLanguage).toHaveBeenCalledWith(null);
  });

  it('does not update config for non-Apple Music URLs', () => {
    handleStorefrontNavigation('https://example.com/gb/new');
    expect(mockedSetStorefront).not.toHaveBeenCalled();
    expect(mockedSetLanguage).not.toHaveBeenCalled();
  });

  it('does not update config for malformed URLs', () => {
    handleStorefrontNavigation('not-a-url');
    expect(mockedSetStorefront).not.toHaveBeenCalled();
    expect(mockedSetLanguage).not.toHaveBeenCalled();
  });

  it('does not call setStorefront when storefront is unchanged', () => {
    mockedGetStorefront.mockReturnValue('gb');
    mockedGetLanguage.mockReturnValue('en-GB');
    handleStorefrontNavigation('https://music.apple.com/gb/album/foo?l=en-GB');
    expect(mockedSetStorefront).not.toHaveBeenCalled();
  });

  it('preserves current language when URL has no language parameter and language is already set', () => {
    mockedGetStorefront.mockReturnValue('gb');
    mockedGetLanguage.mockReturnValue('en-GB');
    handleStorefrontNavigation('https://music.apple.com/gb/new');
    // nextLanguage = null ?? 'en-GB' ?? null = 'en-GB', currentLanguage = 'en-GB', no change
    expect(mockedSetLanguage).not.toHaveBeenCalled();
  });

  it('overwrites stored language when URL provides a different language', () => {
    mockedGetStorefront.mockReturnValue('gb');
    mockedGetLanguage.mockReturnValue('en-GB');
    handleStorefrontNavigation('https://music.apple.com/gb/album/foo?l=cy');
    expect(mockedSetLanguage).toHaveBeenCalledWith('cy');
  });
});
