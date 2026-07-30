import log from 'electron-log/main';
import { getStorefront, setStorefront, getLanguage, setLanguage, getStartPage, getLastPageUrl, getMusicService, getClassicalStartPage, getClassicalLastPageUrl, setClassicalLastPageUrl, setLastPageUrl } from './config';
import { getStorefront as getLocaleStorefront } from './i18n';
import { getService, getServiceByHost } from './musicService';
import type { ItmsRouteToken } from './itms';

export type { ItmsRouteToken } from './itms';

const storefrontLog = log.scope('storefront');

const ITMS_ROUTE_PATHS: Record<ItmsRouteToken, string> = {
  library: 'library',
  browse: 'browse',
  radio: 'radio',
  listenNow: 'listen-now',
  subscribe: 'subscribe',
};

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
  const serviceId = getMusicService();
  const service = getService(serviceId);

  const isClassical = serviceId === 'classical';
  const startPage = isClassical ? getClassicalStartPage() : getStartPage();

  if (startPage === 'last') {
    // Read the stored path only in this branch; the getters stay untouched for every other page.
    const lastPath = isClassical ? getClassicalLastPageUrl() : getLastPageUrl();
    if (lastPath) {
      return appendLanguage(`${service.origin}/${storefront}/${lastPath}`, language);
    }
    // fall through: no stored path yet, use the service default
  }

  const pageEntry = service.startPages.find(p => p.id === startPage)
    ?? service.startPages.find(p => p.id === service.defaultStartPage)
    ?? service.startPages[0];
  // The classical home entry has an empty path and must not gain a trailing slash.
  const pagePath = pageEntry.path === '' ? '' : `/${pageEntry.path}`;

  return appendLanguage(`${service.origin}/${storefront}${pagePath}`, language);
}

export function buildItmsRouteURL(token: ItmsRouteToken): string {
  let storefront = getStorefront();
  if (storefront === undefined) {
    storefront = getLocaleStorefront();
  }
  const language = getLanguage();
  const path = ITMS_ROUTE_PATHS[token];
  // itms:// is permanently pinned to the music service; transformItmsUrl in src/itms.ts pins the host
  return appendLanguage(`${getService('music').origin}/${storefront}/${path}`, language);
}

export function extractStorefrontFromURL(url: string): { storefront: string; language: string | null } | null {
  try {
    const parsed = new URL(url);
    const service = getServiceByHost(parsed.hostname);
    if (!service) {
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

  // Only update language when the URL explicitly provides an "l" parameter. Absence means no change.
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

export function handleLastPageNavigation(url: string): void {
  try {
    const parsed = new URL(url);
    const service = getServiceByHost(parsed.hostname);
    if (!service) return;
    const segments = parsed.pathname.split('/').filter(Boolean);
    const pageSegments = segments[0] && /^[a-z]{2}$/.test(segments[0]) ? segments.slice(1) : segments;
    if (pageSegments.length > 0) {
      const path = pageSegments.join('/');
      if (service.id === 'classical') {
        setClassicalLastPageUrl(path);
      } else {
        setLastPageUrl(path);
      }
    }
  } catch {
    storefrontLog.warn('failed to parse URL for last-page tracking:', url);
  }
}
