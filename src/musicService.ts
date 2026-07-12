// src/musicService.ts
// Pure music service registry: no imports from electron, electron-log, or config.
// Kept dependency-free so itms.ts and tests can import without pulling in Electron.

export type MusicServiceId = 'music';

export interface MusicService {
  id: MusicServiceId;
  host: string;
  origin: string;
  displayName: string;
  /** Authentication iframe hostnames permitted by setupAuthFrameInjection. */
  authFrameHosts: readonly string[];
}

export const MUSIC_SERVICES: Record<MusicServiceId, MusicService> = {
  music: {
    id: 'music',
    host: 'music.apple.com',
    origin: 'https://music.apple.com',
    displayName: 'Apple Music',
    authFrameHosts: ['auth.music.apple.com', 'idmsa.apple.com'],
  },
};

export const DEFAULT_SERVICE_ID: MusicServiceId = 'music';

export function getService(id: MusicServiceId): MusicService {
  return MUSIC_SERVICES[id];
}
