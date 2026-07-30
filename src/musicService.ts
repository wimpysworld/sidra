// src/musicService.ts
// Pure music service registry: no imports from electron, electron-log, or config.
// Kept dependency-free so itms.ts and tests can import without pulling in Electron.

export type MusicServiceId = 'music' | 'classical';

export interface StartPage<PageId extends string = string> {
  id: PageId;
  path: string;
}

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

const SHARED_CONTENT_READY_SELECTOR = '[data-testid="app-container"] amp-playback-controls-play[hydrated]';
const SHARED_AUTH_FRAME_HOSTS = ['auth.music.apple.com', 'idmsa.apple.com'] as const;

export const MUSIC_SERVICES = {
  music: defineService({
    id: 'music',
    host: 'music.apple.com',
    origin: 'https://music.apple.com',
    displayName: 'Apple Music',
    authFrameHosts: SHARED_AUTH_FRAME_HOSTS,
    contentReadySelector: SHARED_CONTENT_READY_SELECTOR,
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
    contentReadySelector: SHARED_CONTENT_READY_SELECTOR,
    startPages: [
      { id: 'home', path: '' },
      { id: 'browse', path: 'browse/catalog' },
      { id: 'playlists', path: 'browse/playlists' },
      { id: 'search', path: 'search' },
    ],
    defaultStartPage: 'home',
  }),
} satisfies Record<MusicServiceId, MusicService>;

/** Start page ids offered by Apple Music Classical, derived from the registry. */
export type ClassicalStartPageId = typeof MUSIC_SERVICES.classical.startPages[number]['id'];

export const DEFAULT_SERVICE_ID: MusicServiceId = 'music';

export function isMusicServiceId(value: string): value is MusicServiceId {
  return Object.hasOwn(MUSIC_SERVICES, value);
}

// Total at runtime as well as in the type. An id that escaped validation must not throw here:
// every dereference is on the path that builds the tray, the app's only settings surface.
export function getService(id: MusicServiceId): MusicService {
  return MUSIC_SERVICES[id] ?? MUSIC_SERVICES[DEFAULT_SERVICE_ID];
}

export function getServiceByHost(host: string): MusicService | undefined {
  return Object.values(MUSIC_SERVICES).find(svc => svc.host === host);
}

export function allServices(): readonly MusicService[] {
  return Object.values(MUSIC_SERVICES);
}
