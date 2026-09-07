// Pure music service registry: no imports from electron, electron-log, or config.
// The readiness selector is a pure constant, so importing this registry does not start Electron.

import { CONTENT_READY_SELECTOR } from './contentReady';

/** The two Apple web services Sidra wraps. */
export type MusicServiceId = 'music' | 'classical';

/** One start page choice: the id persisted in config, and its path under the storefront. */
export interface StartPage<PageId extends string = string> {
  id: PageId;
  path: string;
}

/** A wrapped web service and everything Sidra needs to address and drive it. */
export interface MusicService<PageId extends string = string> {
  id: MusicServiceId;
  host: string;
  origin: string;
  displayName: string;
  /** Authentication iframe hostnames permitted by setupAuthFrameInjection. */
  authFrameHosts: readonly string[];
  /** CSS selector probed to detect when the web app is interactive. */
  contentReadySelector: string;
  /** Ordered start page entries rendered in the tray Start Page submenu. Non-empty, so [0] is total. */
  startPages: readonly [StartPage<PageId>, ...StartPage<PageId>[]];
  /** Default start page id used when no persisted value exists. */
  defaultStartPage: PageId;
}

// PageId is inferred from startPages alone. NoInfer keeps defaultStartPage out of the inference,
// so a typo there fails to compile instead of widening the union.
function defineService<const PageId extends string>(
  def: Omit<MusicService<PageId>, 'defaultStartPage'> & { defaultStartPage: NoInfer<PageId> },
): MusicService<PageId> {
  return def;
}

const SHARED_AUTH_FRAME_HOSTS = ['auth.music.apple.com', 'idmsa.apple.com'] as const;

/** The registry. Every host, origin and start page comes from here, never from a literal at the call site. */
export const MUSIC_SERVICES = {
  music: defineService({
    id: 'music',
    host: 'music.apple.com',
    origin: 'https://music.apple.com',
    displayName: 'Apple Music',
    authFrameHosts: SHARED_AUTH_FRAME_HOSTS,
    contentReadySelector: CONTENT_READY_SELECTOR,
    startPages: [
      { id: 'home', path: 'home' },
      { id: 'new', path: 'new' },
      { id: 'radio', path: 'radio' },
      { id: 'all-playlists', path: 'library/all-playlists/' },
    ],
    defaultStartPage: 'new',
  }),
  classical: defineService({
    id: 'classical',
    host: 'classical.music.apple.com',
    origin: 'https://classical.music.apple.com',
    displayName: 'Apple Music Classical',
    authFrameHosts: SHARED_AUTH_FRAME_HOSTS,
    contentReadySelector: CONTENT_READY_SELECTOR,
    startPages: [
      { id: 'home', path: '' },
      { id: 'browse', path: 'browse/catalog' },
      { id: 'playlists', path: 'browse/playlists' },
      { id: 'search', path: 'search' },
    ],
    defaultStartPage: 'home',
  }),
} satisfies Record<MusicServiceId, MusicService>;

/** Start page ids offered by Apple Music, derived from the registry. */
export type MusicStartPageId = typeof MUSIC_SERVICES.music.startPages[number]['id'];

/** Start page ids offered by Apple Music Classical, derived from the registry. */
export type ClassicalStartPageId = typeof MUSIC_SERVICES.classical.startPages[number]['id'];

/** Every start page id in the registry, for records that must cover both services. */
export type AnyStartPageId = MusicStartPageId | ClassicalStartPageId;

/** Service used when nothing is persisted, and when a stored id turns out not to be one. */
export const DEFAULT_SERVICE_ID: MusicServiceId = 'music';

/** Narrows a stored or externally supplied string to a registry id. */
export function isMusicServiceId(value: string): value is MusicServiceId {
  return Object.hasOwn(MUSIC_SERVICES, value);
}

/** Return the registered service, or the default if an unvalidated id reaches a UI caller. */
export function getService(id: MusicServiceId): MusicService {
  return MUSIC_SERVICES[id] ?? MUSIC_SERVICES[DEFAULT_SERVICE_ID];
}

/** The service serving a hostname, or undefined when the host is not one of ours. */
export function getServiceByHost(host: string): MusicService | undefined {
  return Object.values(MUSIC_SERVICES).find(svc => svc.host === host);
}

/** Every registered service, for callers that iterate rather than look one up. */
export function allServices(): readonly MusicService[] {
  return Object.values(MUSIC_SERVICES);
}

/** Service and authentication hosts derived from the registry for navigation checks. */
export const ALLOWED_NAVIGATION_HOSTS: ReadonlySet<string> = new Set(
  allServices().flatMap(svc => [svc.host, ...svc.authFrameHosts]),
);

/**
 * Accept HTTPS URLs with an exact registered hostname, after URL normalisation.
 * Hostname matching rejects subdomains and suffixes, but ignores ports and credentials.
 * Check the scheme separately because non-web URLs can also contain an allowed hostname.
 */
export function isAllowedNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_NAVIGATION_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}
