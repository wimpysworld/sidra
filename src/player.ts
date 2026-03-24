import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import log from 'electron-log/main';

const playerLog = log.scope('player');

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

const PLAYBACK_STATES: Record<number, string> = {
  0: 'none',
  1: 'loading',
  2: 'playing',
  3: 'paused',
  4: 'stopped',
  5: 'ended',
  6: 'seeking',
  7: 'waiting',
  8: 'stalled',
  9: 'completed',
};

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

export class Player extends TypedEmitter<PlayerEvents> {
  private lastTimeLogAt = 0;

  constructor() {
    super();
  }

  handlePlaybackStateDidChange(payload: PlaybackStatePayload): void {
    const stateName = payload != null ? (PLAYBACK_STATES[payload.state] ?? String(payload.state)) : null;
    playerLog.debug('playbackStateDidChange:', { ...payload, state: stateName });
    this.emit('playbackStateDidChange', payload);
  }

  handleNowPlayingItemDidChange(payload: NowPlayingPayload | null): void {
    playerLog.debug('nowPlayingItemDidChange:', payload);
    this.emit('nowPlayingItemDidChange', payload);
  }

  handlePlaybackTimeDidChange(payload: number): void {
    const now = Date.now();
    if (now - this.lastTimeLogAt >= 10_000) {
      playerLog.debug('playbackTimeDidChange:', payload);
      this.lastTimeLogAt = now;
    }
    this.emit('playbackTimeDidChange', payload);
  }

  handleRepeatModeDidChange(payload: number | null): void {
    const modeName = typeof payload === 'number' ? (REPEAT_MODES[payload] ?? String(payload)) : payload;
    playerLog.debug('repeatModeDidChange:', modeName);
    this.emit('repeatModeDidChange', payload);
  }

  handleShuffleModeDidChange(payload: number | null): void {
    const modeName = typeof payload === 'number' ? (SHUFFLE_MODES[payload] ?? String(payload)) : payload;
    playerLog.debug('shuffleModeDidChange:', modeName);
    this.emit('shuffleModeDidChange', payload);
  }

  handleVolumeDidChange(payload: number | null): void {
    playerLog.debug('volumeDidChange:', payload);
    this.emit('volumeDidChange', payload);
  }
}
