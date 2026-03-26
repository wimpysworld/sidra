import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import log from 'electron-log/main';

const playerLog = log.scope('player');

export interface PlayParams {
  catalogId?: string;
  globalId?: string;
  kind?: string;
  isLibrary?: boolean;
}

export interface NowPlayingPayload {
  name?: string;
  artistName?: string;
  albumName?: string;
  artworkUrl?: string;
  durationInMillis?: number;
  url?: string;
  genreNames?: string[];
  trackId?: string;
  trackNumber?: number;
  audioTraits?: string[];
  targetBitrate?: number;
  discNumber?: number;
  composerName?: string;
  releaseDate?: string;
  contentRating?: string;
  itemType?: string;
  containerId?: string;
  containerType?: string;
  containerName?: string;
  playParams?: PlayParams;
  isrc?: string;
  queueLength?: number;
  queueIndex?: number;
}

/**
 * Derives a shareable Apple Music URL from the payload, falling back to
 * playParams.catalogId or playParams.globalId when payload.url is absent.
 */
export function getShareUrl(payload: NowPlayingPayload): string | undefined {
  if (payload.url) return payload.url;
  const catalogId = payload.playParams?.catalogId;
  if (catalogId) return `https://music.apple.com/song/${catalogId}`;
  const globalId = payload.playParams?.globalId;
  if (globalId) return `https://music.apple.com/song/${globalId}`;
  return undefined;
}

export const PlaybackState = {
  None: 0,
  Loading: 1,
  Playing: 2,
  Paused: 3,
  Stopped: 4,
  Ended: 5,
  Seeking: 6,
  Waiting: 7,
  Stalled: 8,
  Completed: 9,
} as const;

export type PlaybackStatePayload = { status: boolean; state: number } | null;

export interface PlayerEvents {
  playbackStateDidChange: [payload: PlaybackStatePayload];
  nowPlayingItemDidChange: [payload: NowPlayingPayload | null];
  /** Playback position in microseconds (from MusicKit.currentPlaybackTime * 1e6 in assets/musicKitHook.js:40). */
  playbackTimeDidChange: [payload: number];
  repeatModeDidChange: [payload: number | null];
  shuffleModeDidChange: [payload: number | null];
  volumeDidChange: [payload: number | null];
}

export interface IntegrationContext {
  player: Player;
  getMainWindow?: () => BrowserWindow | null;
}

const REPEAT_MODES: Record<number, string> = {
  0: 'none',
  1: 'one',
  2: 'all',
};

const SHUFFLE_MODES: Record<number, string> = {
  0: 'off',
  1: 'songs',
};

const PLAYBACK_STATES: Record<number, string> = Object.fromEntries(
  Object.entries(PlaybackState).map(([k, v]) => [v, k.toLowerCase()])
);

// Type-safe EventEmitter wrapper. Provides compile-time payload checking on
// emit, on, once, removeListener, and off while preserving full runtime
// compatibility with Node's EventEmitter.
export class TypedEmitter<Events extends { [K in keyof Events]: unknown[] }> extends EventEmitter {
  override emit<K extends keyof Events & string>(event: K, ...args: Events[K]): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    return super.on(event, listener as (...args: unknown[]) => void);
  }

  override once<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    return super.once(event, listener as (...args: unknown[]) => void);
  }

  override removeListener<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    return super.removeListener(event, listener as (...args: unknown[]) => void);
  }

  override off<K extends keyof Events & string>(event: K, listener: (...args: Events[K]) => void): this {
    return super.off(event, listener as (...args: unknown[]) => void);
  }
}

export interface PlaybackSnapshot {
  isPlaying: boolean;
  positionUs: number;
  state: number;
}

export class Player extends TypedEmitter<PlayerEvents> {
  private lastTimeLogAt = 0;
  private _isPlaying = false;
  private _positionUs = 0;
  private _state = 0;

  constructor() {
    super();
  }

  playbackSnapshot(): PlaybackSnapshot {
    return { isPlaying: this._isPlaying, positionUs: this._positionUs, state: this._state };
  }

  handlePlaybackStateDidChange(payload: PlaybackStatePayload): void {
    if (payload != null) {
      if (typeof payload !== 'object' || Array.isArray(payload)) {
        playerLog.warn('playbackStateDidChange: invalid payload, expected object or null');
        return;
      }
      if (typeof payload.status !== 'boolean') {
        playerLog.warn('playbackStateDidChange: invalid payload, expected status to be boolean');
        return;
      }
      if (typeof payload.state !== 'number') {
        playerLog.warn('playbackStateDidChange: invalid payload, expected state to be number');
        return;
      }
    }
    if (payload != null) {
      this._state = payload.state;
      this._isPlaying = payload.state === PlaybackState.Playing;
    } else {
      this._state = 0;
      this._isPlaying = false;
    }
    const stateName = payload != null ? (PLAYBACK_STATES[payload.state] ?? String(payload.state)) : null;
    playerLog.debug('playbackStateDidChange:', { ...payload, state: stateName });
    this.emit('playbackStateDidChange', payload);
  }

  handleNowPlayingItemDidChange(payload: NowPlayingPayload | null): void {
    if (payload != null) {
      if (typeof payload !== 'object' || Array.isArray(payload)) {
        playerLog.warn('nowPlayingItemDidChange: invalid payload, expected object or null');
        return;
      }
    }
    playerLog.debug('nowPlayingItemDidChange:', payload);
    this.emit('nowPlayingItemDidChange', payload);
  }

  handlePlaybackTimeDidChange(payload: number): void {
    if (typeof payload !== 'number' || !isFinite(payload)) {
      playerLog.warn('playbackTimeDidChange: invalid payload, expected finite number');
      return;
    }
    this._positionUs = payload;
    const now = Date.now();
    if (now - this.lastTimeLogAt >= 10_000) {
      playerLog.debug('playbackTimeDidChange:', payload);
      this.lastTimeLogAt = now;
    }
    this.emit('playbackTimeDidChange', payload);
  }

  handleRepeatModeDidChange(payload: number | null): void {
    if (payload != null && typeof payload !== 'number') {
      playerLog.warn('repeatModeDidChange: invalid payload, expected number or null');
      return;
    }
    const modeName = typeof payload === 'number' ? (REPEAT_MODES[payload] ?? String(payload)) : payload;
    playerLog.debug('repeatModeDidChange:', modeName);
    this.emit('repeatModeDidChange', payload);
  }

  handleShuffleModeDidChange(payload: number | null): void {
    if (payload != null && typeof payload !== 'number') {
      playerLog.warn('shuffleModeDidChange: invalid payload, expected number or null');
      return;
    }
    const modeName = typeof payload === 'number' ? (SHUFFLE_MODES[payload] ?? String(payload)) : payload;
    playerLog.debug('shuffleModeDidChange:', modeName);
    this.emit('shuffleModeDidChange', payload);
  }

  handleVolumeDidChange(payload: number | null): void {
    if (payload != null && typeof payload !== 'number') {
      playerLog.warn('volumeDidChange: invalid payload, expected number or null');
      return;
    }
    playerLog.debug('volumeDidChange:', payload != null ? Math.round(payload * 100) / 100 : payload);
    this.emit('volumeDidChange', payload);
  }
}
