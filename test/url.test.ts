// Covers the storefront fallback chain buildAppleMusicURL() resolves against:
// the persisted code first, then the one derived from the system locale. The
// language cases here are the ones where the built URL carries no query of its
// own, so ?l= is the first parameter.
// test/storefront.test.ts covers every start page and every last-page path with
// a storefront always set, and owns extractStorefrontFromURL.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import './mocks/storefront-deps';

import { buildAppleMusicURL } from '../src/storefront';
import { getStorefront, getLanguage, getStartPage, getLastPageUrl } from '../src/config';
import { getStorefront as getLocaleStorefront } from '../src/i18n';

const mockedGetStorefront = vi.mocked(getStorefront);
const mockedGetLanguage = vi.mocked(getLanguage);
const mockedGetStartPage = vi.mocked(getStartPage);
const mockedGetLastPageUrl = vi.mocked(getLastPageUrl);
const mockedGetLocaleStorefront = vi.mocked(getLocaleStorefront);

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
});
