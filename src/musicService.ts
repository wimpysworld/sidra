// src/musicService.ts
// Pure music service registry: no imports from electron, electron-log, or config.
// Kept dependency-free so itms.ts and tests can import without pulling in Electron.

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

// PageId is inferred from startPages alone; NoInfer keeps defaultStartPage out of the inference,
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

// Total at runtime as well as in the type. An id that escaped validation must not throw here:
// every dereference is on the path that builds the tray, the app's only settings surface.
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

// Derived from the registry so a new service or auth host widens the allowlist automatically.
export const ALLOWED_NAVIGATION_HOSTS: ReadonlySet<string> = new Set(
  allServices().flatMap(svc => [svc.host, ...svc.authFrameHosts]),
);

// Takes a URL string rather than a hostname so malformed input is rejected in one place.
// URL.hostname is lowercased, punycoded and port-free, and the match is exact: a subdomain,
// a suffix or a userinfo prefix of an allowed host is not an allowed host.
// The scheme is checked too, because hostname alone does not imply a web origin: the parser
// reads an authority out of any URL carrying '//', so 'javascript://music.apple.com/%0aalert(1)'
// and 'file://music.apple.com/etc/passwd' both yield an allowed hostname. Apple serves both
// services and the authentication flow over https, so nothing legitimate needs another scheme.
export function isAllowedNavigationUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ALLOWED_NAVIGATION_HOSTS.has(parsed.hostname);
  } catch {
    return false;
  }
}
