// Build service launch URLs and record navigation preferences.
// Resolve hosts and start pages through the registry in src/musicService.ts.

import log from 'electron-log/main';
import { getStorefront, setStorefront, getLanguageFor, setLanguageFor, getMusicService, getStartPageFor, getLastPageUrlFor, setLastPageUrlFor } from './config';
import { getStorefront as getLocaleStorefront } from './i18n';
import { getService, getServiceByHost, type MusicServiceId } from './musicService';
import type { ItmsRouteToken } from './itms';
import type { BrowserWindow } from 'electron';
import { liveWebContents } from './utils';

export type { ItmsRouteToken } from './itms';

const storefrontLog = log.scope('storefront');

const ITMS_ROUTE_PATHS: Record<ItmsRouteToken, string> = {
  library: 'library',
  browse: 'browse',
  radio: 'radio',
  listenNow: 'listen-now',
  subscribe: 'subscribe',
};

function applyLanguage(url: string, language: string | null | undefined): string {
  const parsed = new URL(url);
  if (language == null) {
    if (!parsed.searchParams.has('l')) return url;
    parsed.searchParams.delete('l');
  } else {
    parsed.searchParams.set('l', language);
  }
  return parsed.toString();
}

/**
 * Launch URL for the active service. The storefront is the persisted one, else
 * the one detected from the system locale, else 'us'; the page is the stored
 * start page, falling back to the service default when it names nothing valid.
 */
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

  const serviceId = getMusicService();
  const language = getLanguageFor(serviceId);
  const service = getService(serviceId);

  const startPage = getStartPageFor(serviceId);

  if (startPage === 'last') {
    const lastPath = getLastPageUrlFor(serviceId);
    // Classical's Home is stored as the empty root path, possibly carrying a
    // query, so only an absent value falls through. Neither form takes the
    // separator slash: the root must not gain a trailing one.
    if (lastPath !== undefined) {
      const separator = lastPath === '' || lastPath.startsWith('?') ? '' : '/';
      return applyLanguage(`${service.origin}/${storefront}${separator}${lastPath}`, language);
    }
    // fall through: no stored path yet, use the service default
  }

  const pageEntry = service.startPages.find(p => p.id === startPage)
    ?? service.startPages.find(p => p.id === service.defaultStartPage)
    ?? service.startPages[0];
  // The classical home entry has an empty path and must not gain a trailing slash.
  const pagePath = pageEntry.path === '' ? '' : `/${pageEntry.path}`;

  return applyLanguage(`${service.origin}/${storefront}${pagePath}`, language);
}

/** In-app URL for an itms:// deeplink route token, on the user's storefront and language. */
export function buildItmsRouteURL(token: ItmsRouteToken): string {
  let storefront = getStorefront();
  if (storefront === undefined) {
    storefront = getLocaleStorefront();
  }
  const language = getLanguageFor('music');
  const path = ITMS_ROUTE_PATHS[token];
  // itms:// is permanently pinned to the music service; transformItmsUrl in src/itms.ts pins the host
  return applyLanguage(`${getService('music').origin}/${storefront}/${path}`, language);
}

/**
 * Reads the storefront and the 'l' language out of a service URL. Null when the
 * URL is unparseable, the host is not a known service, or the first path segment
 * is not a two-letter storefront code.
 */
export function extractStorefrontFromURL(url: string): { serviceId: MusicServiceId; storefront: string; language: string | null } | null {
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
    return { serviceId: service.id, storefront, language };
  } catch {
    return null;
  }
}

/**
 * Persist region and explicit language changes from Apple's own navigation controls.
 */
export function handleStorefrontNavigation(url: string): void {
  const result = extractStorefrontFromURL(url);
  if (!result) {
    return;
  }

  const currentStorefront = getStorefront();
  const currentLanguage = getLanguageFor(result.serviceId);

  // Only update language when the URL explicitly provides an "l" parameter. Absence means no change.
  const storefrontChanged = result.storefront !== currentStorefront;
  const languageChanged = result.language !== null && result.language !== currentLanguage;

  if (storefrontChanged) {
    setStorefront(result.storefront);
  }
  if (languageChanged) {
    setLanguageFor(result.serviceId, result.language);
  }
  if (storefrontChanged || languageChanged) {
    storefrontLog.info(`storefront changed: ${result.storefront} (language: ${result.language ?? currentLanguage})`);
  }
}

export function initPageLanguageTracking(win: BrowserWindow): void {
  const contents = liveWebContents(win);
  if (!contents) return;
  let navigationGeneration = 0;

  async function captureLanguage(): Promise<void> {
    const generation = ++navigationGeneration;
    try {
      const current = liveWebContents(win);
      if (!current) return;
      const url = current.getURL();
      const result = extractStorefrontFromURL(url);
      if (!result || result.language !== null || result.serviceId !== getMusicService()
        || new URL(url).origin !== getService(result.serviceId).origin) return;

      // Apple omits the default language from its URLs, including chooser links.
      const page: unknown = await current.executeJavaScript(
        '({ url: window.location.href, language: document.documentElement.lang })',
      );
      if (generation !== navigationGeneration || liveWebContents(win) !== current
        || current.getURL() !== url || getMusicService() !== result.serviceId
        || typeof page !== 'object' || page === null
        || !('url' in page) || page.url !== url
        || !('language' in page) || typeof page.language !== 'string' || !page.language) return;

      let language: string;
      try {
        const locale = new Intl.Locale(page.language);
        if (!locale.language || locale.language === 'und') return;
        language = locale.toString();
      } catch {
        return;
      }
      if (language !== getLanguageFor(result.serviceId)) {
        setLanguageFor(result.serviceId, language);
      }
    } catch {
      storefrontLog.warn('failed to read page language');
    }
  }

  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame) navigationGeneration += 1;
  });
  contents.on('did-finish-load', captureLanguage);
  contents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame) return captureLanguage();
  });
}

/**
 * Record the current page against its service, for the 'last' start page. The
 * storefront segment is stripped so the path survives a change of region.
 */
export function handleLastPageNavigation(url: string): void {
  try {
    const parsed = new URL(url);
    const service = getServiceByHost(parsed.hostname);
    if (!service) return;
    const segments = parsed.pathname.split('/').filter(Boolean);
    const pageSegments = segments[0] && /^[a-z]{2}$/.test(segments[0]) ? segments.slice(1) : segments;
    const pagePath = pageSegments.join('/');
    // The storefront root is a real page only on a service whose registry
    // declares a root start page (Classical's Home). Elsewhere a bare root is
    // a redirect stop, not a page, and must not displace the stored path.
    if (pagePath !== '' || service.startPages.some(page => page.path === '')) {
      // Keep the query so a search or a filtered view resumes as it was left.
      // The fragment is dropped: it is renderer state, not a page address.
      const path = `${pagePath}${parsed.search}`;
      setLastPageUrlFor(service.id, path);
    }
  } catch {
    storefrontLog.warn('failed to parse URL for last-page tracking:', url);
  }
}
