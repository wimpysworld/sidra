// test/storefront.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import './mocks/storefront-deps';

import { handleStorefrontNavigation, buildAppleMusicURL, buildItmsRouteURL, extractStorefrontFromURL, handleLastPageNavigation, type ItmsRouteToken } from '../src/storefront';
import { getStorefront, setStorefront, getLanguage, setLanguage, getMusicService, getStartPage, getLastPageUrl, getClassicalStartPage, getClassicalLastPageUrl, setLastPageUrl, setClassicalLastPageUrl } from '../src/config';
import { MUSIC_SERVICES, type ClassicalStartPageId } from '../src/musicService';

const mockedGetStorefront = vi.mocked(getStorefront);
const mockedSetStorefront = vi.mocked(setStorefront);
const mockedGetLanguage = vi.mocked(getLanguage);
const mockedSetLanguage = vi.mocked(setLanguage);
const mockedGetMusicService = vi.mocked(getMusicService);
const mockedGetStartPage = vi.mocked(getStartPage);
const mockedGetLastPageUrl = vi.mocked(getLastPageUrl);
const mockedGetClassicalStartPage = vi.mocked(getClassicalStartPage);
const mockedGetClassicalLastPageUrl = vi.mocked(getClassicalLastPageUrl);
const mockedSetLastPageUrl = vi.mocked(setLastPageUrl);
const mockedSetClassicalLastPageUrl = vi.mocked(setClassicalLastPageUrl);

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

  it('does not change language when URL has no language parameter', () => {
    mockedGetStorefront.mockReturnValue('us');
    mockedGetLanguage.mockReturnValue(undefined);
    handleStorefrontNavigation('https://music.apple.com/gb/new');
    expect(mockedSetStorefront).toHaveBeenCalledWith('gb');
    expect(mockedSetLanguage).not.toHaveBeenCalled();
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
    // No ?l= in URL means no language change, regardless of current value
    expect(mockedSetLanguage).not.toHaveBeenCalled();
  });

  it('overwrites stored language when URL provides a different language', () => {
    mockedGetStorefront.mockReturnValue('gb');
    mockedGetLanguage.mockReturnValue('en-GB');
    handleStorefrontNavigation('https://music.apple.com/gb/album/foo?l=cy');
    expect(mockedSetLanguage).toHaveBeenCalledWith('cy');
  });
});

describe('extractStorefrontFromURL', () => {
  it('returns storefront and null language from a music URL with no language', () => {
    const result = extractStorefrontFromURL('https://music.apple.com/gb/new');
    expect(result).not.toBeNull();
    expect(result!.storefront).toBe('gb');
    expect(result!.language).toBeNull();
  });

  it('returns storefront and language from a music URL with language', () => {
    const result = extractStorefrontFromURL('https://music.apple.com/gb/album/foo?l=en-GB');
    expect(result).not.toBeNull();
    expect(result!.storefront).toBe('gb');
    expect(result!.language).toBe('en-GB');
  });

  it('returns storefront from a classical URL', () => {
    const result = extractStorefrontFromURL('https://classical.music.apple.com/gb/browse');
    expect(result).not.toBeNull();
    expect(result!.storefront).toBe('gb');
  });

  it('returns null for classical URL with no path segments', () => {
    expect(extractStorefrontFromURL('https://classical.music.apple.com/gb')).not.toBeNull();
    expect(extractStorefrontFromURL('https://classical.music.apple.com/')).toBeNull();
  });

  it('returns null for an unknown host', () => {
    expect(extractStorefrontFromURL('https://unknown.example.com/gb/new')).toBeNull();
  });

  it('returns null for a malformed URL', () => {
    expect(extractStorefrontFromURL('not-a-url')).toBeNull();
  });
});

describe('buildAppleMusicURL - music service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetMusicService.mockReturnValue('music');
    mockedGetStorefront.mockReturnValue('us');
    mockedGetLanguage.mockReturnValue(null);
  });

  it('builds home URL', () => {
    mockedGetStartPage.mockReturnValue('home');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://music.apple.com/us/home');
  });

  it('builds new URL', () => {
    mockedGetStartPage.mockReturnValue('new');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://music.apple.com/us/new');
  });

  it('builds radio URL', () => {
    mockedGetStartPage.mockReturnValue('radio');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://music.apple.com/us/radio');
  });

  it('builds all-playlists URL', () => {
    mockedGetStartPage.mockReturnValue('all-playlists');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://music.apple.com/us/library/all-playlists/');
  });

  it('builds last URL when stored path exists', () => {
    mockedGetStartPage.mockReturnValue('last');
    mockedGetLastPageUrl.mockReturnValue('album/foo/123');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://music.apple.com/us/album/foo/123');
  });

  it('falls back to new when last is selected but no path stored', () => {
    mockedGetStartPage.mockReturnValue('last');
    mockedGetLastPageUrl.mockReturnValue(undefined);
    const url = buildAppleMusicURL();
    expect(url).toBe('https://music.apple.com/us/new');
  });
});

describe('buildAppleMusicURL - classical service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetMusicService.mockReturnValue('classical');
    mockedGetStorefront.mockReturnValue('gb');
    mockedGetLanguage.mockReturnValue(null);
  });

  it('builds classical home URL', () => {
    mockedGetClassicalStartPage.mockReturnValue('home');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://classical.music.apple.com/gb');
  });

  it('builds classical browse URL', () => {
    mockedGetClassicalStartPage.mockReturnValue('browse');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://classical.music.apple.com/gb/browse/catalog');
  });

  it('falls back to home when a removed library start page is still persisted', () => {
    // 'library' was persisted before WW-92 dropped the page: the type no longer admits it,
    // the store still holds it.
    mockedGetClassicalStartPage.mockReturnValue('library' as ClassicalStartPageId);
    const url = buildAppleMusicURL();
    expect(url).toBe('https://classical.music.apple.com/gb');
  });

  it('builds a probed URL for every declared classical start page id', () => {
    // Every URL here returned 200 unauthenticated; a new id must be probed before it is added.
    const expected: Record<string, string> = {
      'home': 'https://classical.music.apple.com/gb',
      'browse': 'https://classical.music.apple.com/gb/browse/catalog',
      'playlists': 'https://classical.music.apple.com/gb/browse/playlists',
      'search': 'https://classical.music.apple.com/gb/search',
    };
    const ids = MUSIC_SERVICES.classical.startPages.map(p => p.id);
    expect(ids).toEqual(Object.keys(expected));
    for (const id of ids) {
      mockedGetClassicalStartPage.mockReturnValue(id);
      const url = buildAppleMusicURL();
      expect(url).toBe(expected[id]);
      expect(new URL(url).pathname.split('/').filter(Boolean)).not.toContain('library');
    }
  });

  it('builds classical playlists URL', () => {
    mockedGetClassicalStartPage.mockReturnValue('playlists');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://classical.music.apple.com/gb/browse/playlists');
  });

  it('builds classical search URL', () => {
    mockedGetClassicalStartPage.mockReturnValue('search');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://classical.music.apple.com/gb/search');
  });

  it('builds classical last URL when stored path exists', () => {
    mockedGetClassicalStartPage.mockReturnValue('last');
    mockedGetClassicalLastPageUrl.mockReturnValue('browse/albums');
    const url = buildAppleMusicURL();
    expect(url).toBe('https://classical.music.apple.com/gb/browse/albums');
  });

  it('falls back to default when last is selected but no path stored', () => {
    mockedGetClassicalStartPage.mockReturnValue('last');
    mockedGetClassicalLastPageUrl.mockReturnValue(undefined);
    const url = buildAppleMusicURL();
    // falls through to default (home), which has empty path
    expect(url).toBe('https://classical.music.apple.com/gb');
  });
});

describe('buildAppleMusicURL - registry-driven page paths', () => {
  // Adding a start page to MUSIC_SERVICES must need no edit in storefront.ts.
  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetStorefront.mockReturnValue('gb');
    mockedGetLanguage.mockReturnValue(null);
  });

  it('resolves every music start page from the registry', () => {
    mockedGetMusicService.mockReturnValue('music');
    for (const page of MUSIC_SERVICES.music.startPages) {
      mockedGetStartPage.mockReturnValue(page.id);
      expect(buildAppleMusicURL()).toBe(`${MUSIC_SERVICES.music.origin}/gb/${page.path}`);
    }
    expect(mockedGetLastPageUrl).not.toHaveBeenCalled();
  });

  it('resolves every classical start page from the registry', () => {
    mockedGetMusicService.mockReturnValue('classical');
    for (const page of MUSIC_SERVICES.classical.startPages) {
      mockedGetClassicalStartPage.mockReturnValue(page.id);
      const expected = page.path === ''
        ? `${MUSIC_SERVICES.classical.origin}/gb`
        : `${MUSIC_SERVICES.classical.origin}/gb/${page.path}`;
      expect(buildAppleMusicURL()).toBe(expected);
    }
    expect(mockedGetClassicalLastPageUrl).not.toHaveBeenCalled();
  });
});

describe('buildItmsRouteURL', () => {
  // The Record type fails to compile if an ItmsRouteToken is missed.
  const routePaths: Record<ItmsRouteToken, string> = {
    library: 'library',
    browse: 'browse',
    radio: 'radio',
    listenNow: 'listen-now',
    subscribe: 'subscribe',
  };
  const tokens = Object.keys(routePaths) as ItmsRouteToken[];

  beforeEach(() => {
    vi.clearAllMocks();
    mockedGetStorefront.mockReturnValue('gb');
    mockedGetLanguage.mockReturnValue(null);
  });

  // itms:// is pinned to the music host and ITMS_ROUTE_PATHS holds music-only paths,
  // so the active service must not reach the origin.
  for (const service of ['classical', 'music'] as const) {
    describe(`with the ${service} service active`, () => {
      beforeEach(() => {
        mockedGetMusicService.mockReturnValue(service);
      });

      for (const token of tokens) {
        it(`builds ${token} against the music host`, () => {
          const url = buildItmsRouteURL(token);
          expect(url).toBe(`${MUSIC_SERVICES.music.origin}/gb/${routePaths[token]}`);
          expect(new URL(url).origin).toBe(MUSIC_SERVICES.music.origin);
        });
      }
    });
  }
});

describe('handleLastPageNavigation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('stores path against music service for music.apple.com URL', () => {
    handleLastPageNavigation('https://music.apple.com/gb/album/foo/123');
    expect(mockedSetLastPageUrl).toHaveBeenCalledWith('album/foo/123');
    expect(mockedSetClassicalLastPageUrl).not.toHaveBeenCalled();
  });

  it('stores path against classical service for classical.music.apple.com URL', () => {
    handleLastPageNavigation('https://classical.music.apple.com/gb/browse/albums');
    expect(mockedSetClassicalLastPageUrl).toHaveBeenCalledWith('browse/albums');
    expect(mockedSetLastPageUrl).not.toHaveBeenCalled();
  });

  it('does nothing for an unknown host', () => {
    handleLastPageNavigation('https://example.com/gb/album/foo');
    expect(mockedSetLastPageUrl).not.toHaveBeenCalled();
    expect(mockedSetClassicalLastPageUrl).not.toHaveBeenCalled();
  });

  it('does nothing for a malformed URL', () => {
    handleLastPageNavigation('not-a-url');
    expect(mockedSetLastPageUrl).not.toHaveBeenCalled();
    expect(mockedSetClassicalLastPageUrl).not.toHaveBeenCalled();
  });
});
