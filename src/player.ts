import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { getMusicService } from './config';
import { getService, getServiceByHost } from './musicService';

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
  /** Hostname of the document that produced this payload, set by assets/musicKitHook.js. */
  sourceHost?: string;
}

/**
 * Derives a shareable Apple Music URL from the payload, falling back to
 * playParams.catalogId or playParams.globalId when payload.url is absent.
 */
export function getShareUrl(payload: NowPlayingPayload): string | undefined {
  if (payload.url) return payload.url;
  // The origin comes from the document that announced the track, not from the
  // persisted service: the two can disagree, and config would then name a host
  // the track was never on. An absent or unknown host falls back to config, so
  // an older hook and an unexpected host both degrade to the previous result.
  const sourceService = payload.sourceHost ? getServiceByHost(payload.sourceHost) : undefined;
  const origin = (sourceService ?? getService(getMusicService())).origin;
  const catalogId = payload.playParams?.catalogId;
  if (catalogId) return `${origin}/song/${catalogId}`;
  const globalId = payload.playParams?.globalId;
  if (globalId) return `${origin}/song/${globalId}`;
  return undefined;
}

/**
 * MusicKit playback states as the hook reports them. Integrations map every
 * value, transient ones included: src/integrations/mpris gives Playing and
 * Paused an MPRIS status of their own and lets the rest fall through to
 * 'Stopped', and test/mpris.test.ts fails when a state added here has no row.
 */
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
  /** Playback position in microseconds, sent by the playbackTimeDidChange listener in assets/musicKitHook.js. */
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

/**
 * Type-safe EventEmitter wrapper. Gives emit, on, once, removeListener and off
 * compile-time payload checking while staying a plain Node EventEmitter at
 * runtime, so a misspelled event or a wrong payload fails tsc rather than
 * reaching an integration as a listener that never fires.
 */
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

/**
 * Main-process hub for the renderer's MusicKit events. Each handle* method is
 * wired to one IPC channel in initPlayerIPC() (src/main.ts), validates the
 * payload the untrusted renderer sent, then re-emits it to the integrations.
 * An invalid payload is logged and dropped rather than forwarded.
 */
export class Player extends TypedEmitter<PlayerEvents> {
  private lastTimeLogAt = 0;
  private _isPlaying = false;
  private _positionUs = 0;
  private _state = 0;

  /**
   * Current playback state, for callers that must read it outside an event.
   * The Last.fm scrobble timer is wall-clock, so it re-reads this at submission
   * time to confirm the play is still live and the playhead has advanced.
   */
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
      this._state = payload.state;
      this._isPlaying = payload.state === PlaybackState.Playing;
    } else {
      this._state = PlaybackState.None;
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
