// test/url.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock modules that main.ts imports with side effects.
// These must be declared before the import of main.ts.
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

import { extractStorefrontFromURL, buildAppleMusicURL } from '../src/storefront';
import { getStorefront, getLanguage, getStartPage, getLastPageUrl } from '../src/config';
import { getStorefront as getLocaleStorefront } from '../src/i18n';

const mockedGetStorefront = vi.mocked(getStorefront);
const mockedGetLanguage = vi.mocked(getLanguage);
const mockedGetStartPage = vi.mocked(getStartPage);
const mockedGetLastPageUrl = vi.mocked(getLastPageUrl);
const mockedGetLocaleStorefront = vi.mocked(getLocaleStorefront);

describe('extractStorefrontFromURL', () => {
  it('extracts storefront and language from a valid URL', () => {
    const result = extractStorefrontFromURL('https://music.apple.com/gb/album/foo?l=en-GB');
    expect(result).toEqual({ storefront: 'gb', language: 'en-GB' });
  });

  it('returns null language when no ?l= parameter', () => {
    const result = extractStorefrontFromURL('https://music.apple.com/us/new');
    expect(result).toEqual({ storefront: 'us', language: null });
  });

  it('rejects non-Apple Music hostnames', () => {
    expect(extractStorefrontFromURL('https://example.com/gb/new')).toBeNull();
  });

  it('rejects uppercase storefront codes', () => {
    expect(extractStorefrontFromURL('https://music.apple.com/GB/new')).toBeNull();
  });

  it('rejects three-letter codes', () => {
    expect(extractStorefrontFromURL('https://music.apple.com/gbr/new')).toBeNull();
  });

  it('rejects empty path', () => {
    expect(extractStorefrontFromURL('https://music.apple.com/')).toBeNull();
  });

  it('returns null for malformed URLs', () => {
    expect(extractStorefrontFromURL('not-a-url')).toBeNull();
  });
});

describe('buildAppleMusicURL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetStartPage.mockReturnValue('new');
    mockedGetLanguage.mockReturnValue(undefined);
    mockedGetStorefront.mockReturnValue(undefined);
    mockedGetLocaleStorefront.mockReturnValue('us');
    mockedGetLastPageUrl.mockReturnValue(undefined);
  });

  it('uses persisted storefront when available', () => {
    mockedGetStorefront.mockReturnValue('gb');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://music.apple.com/gb/new');
  });

  it('falls back to locale storefront when none persisted', () => {
    mockedGetStorefront.mockReturnValue(undefined);
    mockedGetLocaleStorefront.mockReturnValue('de');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://music.apple.com/de/new');
  });

  it('appends ?l= when language is set', () => {
    mockedGetStorefront.mockReturnValue('gb');
    mockedGetLanguage.mockReturnValue('en-GB');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://music.apple.com/gb/new?l=en-GB');
  });

  it('omits ?l= when language is undefined', () => {
    mockedGetStorefront.mockReturnValue('us');
    mockedGetLanguage.mockReturnValue(undefined);
    const url = buildAppleMusicURL();
    expect(url).not.toContain('?l=');
  });

  it('omits ?l= when language is null', () => {
    mockedGetStorefront.mockReturnValue('us');
    mockedGetLanguage.mockReturnValue(null);
    const url = buildAppleMusicURL();
    expect(url).not.toContain('?l=');
  });

  it('constructs correct URL for home start page', () => {
    mockedGetStorefront.mockReturnValue('us');
    mockedGetStartPage.mockReturnValue('home');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://music.apple.com/us/home');
  });

  it('constructs correct URL for radio start page', () => {
    mockedGetStorefront.mockReturnValue('us');
    mockedGetStartPage.mockReturnValue('radio');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://music.apple.com/us/radio');
  });

  it('constructs correct URL for all-playlists start page', () => {
    mockedGetStorefront.mockReturnValue('us');
    mockedGetStartPage.mockReturnValue('all-playlists');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://music.apple.com/us/library/all-playlists/');
  });

  it('uses last page URL when startPage is last and path exists', () => {
    mockedGetStorefront.mockReturnValue('gb');
    mockedGetStartPage.mockReturnValue('last');
    mockedGetLastPageUrl.mockReturnValue('album/some-album/12345');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://music.apple.com/gb/album/some-album/12345');
  });

  it('uses last page URL with language parameter', () => {
    mockedGetStorefront.mockReturnValue('gb');
    mockedGetStartPage.mockReturnValue('last');
    mockedGetLastPageUrl.mockReturnValue('album/some-album/12345');
    mockedGetLanguage.mockReturnValue('en-GB');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://music.apple.com/gb/album/some-album/12345?l=en-GB');
  });

  it('falls back from last to new when no stored path exists', () => {
    mockedGetStorefront.mockReturnValue('us');
    mockedGetStartPage.mockReturnValue('last');
    mockedGetLastPageUrl.mockReturnValue(undefined);
    const url = buildAppleMusicURL();
    expect(url).toBe('https://music.apple.com/us/new');
  });
});
