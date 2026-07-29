// src/musicService.ts
// Pure music service registry: no imports from electron, electron-log, or config.
// Kept dependency-free so itms.ts and tests can import without pulling in Electron.

export type MusicServiceId = 'music' | 'classical';

export interface MusicService {
  id: MusicServiceId;
  host: string;
  origin: string;
  displayName: string;
  /** Authentication iframe hostnames permitted by setupAuthFrameInjection. */
  authFrameHosts: readonly string[];
  /** CSS selector probed to detect when the web app is interactive. */
  contentReadySelector: string;
  /** Ordered start page entries rendered in the tray Start Page submenu. */
  startPages: readonly { id: string; path: string }[];
  /** Default start page id used when no persisted value exists. */
  defaultStartPage: string;
}

const SHARED_CONTENT_READY_SELECTOR = '[data-testid="app-container"] amp-playback-controls-play[hydrated]';
const SHARED_AUTH_FRAME_HOSTS = ['auth.music.apple.com', 'idmsa.apple.com'] as const;

export const MUSIC_SERVICES: Record<MusicServiceId, MusicService> = {
  music: {
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
  },
  classical: {
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
  },
};

export const DEFAULT_SERVICE_ID: MusicServiceId = 'music';

export function getService(id: MusicServiceId): MusicService {
  return MUSIC_SERVICES[id];
}

export function getServiceByHost(host: string): MusicService | undefined {
  return Object.values(MUSIC_SERVICES).find(svc => svc.host === host);
}

export function allServices(): readonly MusicService[] {
  return Object.values(MUSIC_SERVICES);
}
