import log from 'electron-log/main';
import { getStorefront, setStorefront, getLanguage, setLanguage, getStartPage, getLastPageUrl } from './config';
import { getStorefront as getLocaleStorefront } from './i18n';

const mainLog = log.scope('main');

export function buildAppleMusicURL(): string {
  let storefront = getStorefront();
  let source: string;

  if (storefront !== undefined) {
    source = 'persisted';
  } else {
    storefront = getLocaleStorefront();
    source = storefront === 'us' ? 'fallback' : 'detected';
  }

  mainLog.info(`storefront resolved: ${storefront} (${source})`);

  const language = getLanguage();
  const startPage = getStartPage();

  if (startPage === 'last') {
    const lastPath = getLastPageUrl();
    if (lastPath) {
      let url = `https://music.apple.com/${storefront}/${lastPath}`;
      if (language !== undefined && language !== null) {
        url += `?l=${language}`;
      }
      return url;
    }
    // fall through: no stored path yet, use 'new'
  }

  const pagePathMap: Record<string, string> = {
    'home': 'home',
    'new': 'new',
    'radio': 'radio',
    'all-playlists': 'library/all-playlists/',
  };
  const pagePath = pagePathMap[startPage] ?? pagePathMap['new'];
  let url = `https://music.apple.com/${storefront}/${pagePath}`;
  if (language !== undefined && language !== null) {
    url += `?l=${language}`;
  }

  return url;
}

export function extractStorefrontFromURL(url: string): { storefront: string; language: string | null } | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'music.apple.com') {
      return null;
    }
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length === 0) {
      return null;
    }
    const storefront = segments[0];
    if (!/^[a-z]{2}$/.test(storefront)) {
      return null;
    }
    const language = parsed.searchParams.get('l');
    return { storefront, language };
  } catch {
    return null;
  }
}

export function handleStorefrontNavigation(url: string): void {
  const result = extractStorefrontFromURL(url);
  if (!result) {
    return;
  }

  const currentStorefront = getStorefront();
  const currentLanguage = getLanguage();
  const nextLanguage = result.language ?? currentLanguage ?? null;

  if (result.storefront !== currentStorefront) {
    setStorefront(result.storefront);
  }
  if (nextLanguage !== currentLanguage) {
    setLanguage(nextLanguage);
  }
  if (result.storefront !== currentStorefront || nextLanguage !== currentLanguage) {
    mainLog.info(`storefront changed: ${result.storefront} (language: ${nextLanguage})`);
  }
}
