// src/storefront.ts
// Builds every URL Sidra navigates to itself, and records where the user has
// been. Storefront, language and start page are resolved per service through the
// registry in src/musicService.ts, so neither host is written down here.

import log from 'electron-log/main';
import { getStorefront, setStorefront, getLanguage, setLanguage, getMusicService, getStartPageFor, getLastPageUrlFor, setLastPageUrlFor } from './config';
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
  // No language means the URL is returned untouched; a URL round trip would
  // normalise it and the callers expect the string they passed in.
  if (language == null) {
    return url;
  }
  // A stored last page can already carry a query, so set the parameter through
  // URL rather than concatenating a second "?".
  const parsed = new URL(url);
  parsed.searchParams.set('l', language);
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

  const language = getLanguage();
  const serviceId = getMusicService();
  const service = getService(serviceId);

  const startPage = getStartPageFor(serviceId);

  if (startPage === 'last') {
    // Read the stored path only in this branch; the getter stays untouched for every other page.
    const lastPath = getLastPageUrlFor(serviceId);
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

/** In-app URL for an itms:// deeplink route token, on the user's storefront and language. */
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

/**
 * Reads the storefront and the 'l' language out of a service URL. Null when the
 * URL is unparseable, the host is not a known service, or the first path segment
 * is not a two-letter storefront code.
 */
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

/**
 * Follow the user: Apple's own region and language switchers navigate, so a
 * changed storefront or language in the URL is persisted as the new preference.
 */
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
    if (pageSegments.length > 0) {
      // Keep the query so a search or a filtered view resumes as it was left.
      // The fragment is dropped: it is renderer state, not a page address.
      const path = `${pageSegments.join('/')}${parsed.search}`;
      setLastPageUrlFor(service.id, path);
    }
  } catch {
    storefrontLog.warn('failed to parse URL for last-page tracking:', url);
  }
}
