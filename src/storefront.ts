import log from 'electron-log/main';
import { getStorefront, setStorefront, getLanguage, setLanguage, getStartPage, getLastPageUrl } from './config';
import { getStorefront as getLocaleStorefront } from './i18n';

const storefrontLog = log.scope('storefront');

function appendLanguage(url: string, language: string | null | undefined): string {
  if (language != null) {
    return `${url}?l=${language}`;
  }
  return url;
}

export function buildAppleMusicURL(): string {
  let storefront = getStorefront();
  let source: string;

  if (storefront !== undefined) {
    source = 'persisted';
  } else {
    storefront = getLocaleStorefront();
    source = storefront === 'us' ? 'fallback' : 'detected';
  }

  storefrontLog.info(`storefront resolved: ${storefront} (${source})`);

  const language = getLanguage();
  const startPage = getStartPage();

  if (startPage === 'last') {
    const lastPath = getLastPageUrl();
    if (lastPath) {
      return appendLanguage(`https://music.apple.com/${storefront}/${lastPath}`, language);
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

  return appendLanguage(`https://music.apple.com/${storefront}/${pagePath}`, language);
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

  // Only update language when the URL explicitly provides ?l=; absence means no change
  const storefrontChanged = result.storefront !== currentStorefront;
  const languageChanged = result.language !== null && result.language !== currentLanguage;

  if (storefrontChanged) {
    setStorefront(result.storefront);
  }
  if (languageChanged) {
    setLanguage(result.language);
  }
  if (storefrontChanged || languageChanged) {
    storefrontLog.info(`storefront changed: ${result.storefront} (language: ${result.language ?? currentLanguage})`);
  }
}
