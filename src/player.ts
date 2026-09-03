import { EventEmitter } from 'events';
import { BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { getMusicService } from './config';
import { getService, getServiceByHost, isAllowedNavigationUrl } from './musicService';

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
  discNumber?: number;
  composerName?: string;
  releaseDate?: string;
  playParams?: PlayParams;
  /** Hostname of the document that produced this payload, set by assets/musicKitHook.js. */
  sourceHost?: string;
}

const MAX_DBUS_INT32 = 2_147_483_647;
const MAX_SAFE_DURATION_MS = Math.floor(Number.MAX_SAFE_INTEGER / 1_000);
type FieldValidator = (value: unknown) => boolean;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown): boolean {
  return typeof value === 'string';
}

function hasValidFields(value: Record<string, unknown>, validators: Record<string, FieldValidator>): boolean {
  return Object.keys(value).every(field => Object.hasOwn(validators, field)) &&
    Object.entries(validators).every(([field, validate]) => value[field] === undefined || validate(value[field]));
}

function isNonNegativeSafeInteger(value: unknown, maximum = Number.MAX_SAFE_INTEGER): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= maximum;
}

function isAllowedArtworkUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:' &&
      (parsed.hostname === 'mzstatic.com' || parsed.hostname.endsWith('.mzstatic.com'));
  } catch {
    return false;
  }
}

function isPlayParams(value: unknown): value is PlayParams {
  return isRecord(value) && hasValidFields(value, {
    catalogId: isString,
    globalId: isString,
    kind: isString,
    isLibrary: field => typeof field === 'boolean',
  } satisfies Record<keyof PlayParams, FieldValidator>);
}

const NOW_PLAYING_FIELD_VALIDATORS = {
  name: isString,
  artistName: isString,
  albumName: isString,
  artworkUrl: isAllowedArtworkUrl,
  durationInMillis: (field: unknown) => isNonNegativeSafeInteger(field, MAX_SAFE_DURATION_MS),
  url: (field: unknown) => typeof field === 'string' && isAllowedNavigationUrl(field),
  genreNames: (field: unknown) => Array.isArray(field) && field.every(genre => typeof genre === 'string'),
  trackId: isString,
  trackNumber: (field: unknown) => isNonNegativeSafeInteger(field, MAX_DBUS_INT32),
  discNumber: (field: unknown) => isNonNegativeSafeInteger(field, MAX_DBUS_INT32),
  composerName: isString,
  releaseDate: isString,
  playParams: isPlayParams,
  sourceHost: (field: unknown) => typeof field === 'string' && getServiceByHost(field) !== undefined,
} satisfies Record<keyof NowPlayingPayload, FieldValidator>;

function sanitiseNowPlayingPayload(value: unknown): NowPlayingPayload | null {
  if (!isRecord(value)) return null;
  const validators: Record<string, FieldValidator> = NOW_PLAYING_FIELD_VALIDATORS;
  const fields = Object.entries(value).filter(([field, fieldValue]) => {
    const validate = validators[field];
    if (validate?.(fieldValue)) return true;
    playerLog.warn('nowPlayingItemDidChange: dropping invalid metadata field', field);
    return false;
  });
  return Object.fromEntries(fields) as NowPlayingPayload;
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

/**
 * States that mean nothing is playing. The tray, the macOS dock and the Windows
 * taskbar all clear their Now Playing view on these, so a state added above must
 * be classified here or those three views disagree about the same player.
 * This is not the MPRIS mapping: src/integrations/mpris keeps its own table.
 */
const TERMINAL_PLAYBACK_STATES: ReadonlySet<number> = new Set([
  PlaybackState.None,
  PlaybackState.Stopped,
  PlaybackState.Ended,
  PlaybackState.Completed,
]);

export function isTerminalPlaybackState(state: number): boolean {
  return TERMINAL_PLAYBACK_STATES.has(state);
}

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
 * Invalid metadata fields are logged and dropped rather than forwarded.
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

  resetForDocumentReplacement(): void {
    this._state = PlaybackState.None;
    this._isPlaying = false;
    this._positionUs = 0;
    this.emit('playbackStateDidChange', { status: false, state: PlaybackState.None });
    this.emit('nowPlayingItemDidChange', null);
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

  handleNowPlayingItemDidChange(payload: unknown): void {
    if (payload === null) {
      playerLog.debug('nowPlayingItemDidChange:', payload);
      this.emit('nowPlayingItemDidChange', payload);
      return;
    }
    const sanitised = sanitiseNowPlayingPayload(payload);
    if (sanitised === null) {
      playerLog.warn('nowPlayingItemDidChange: invalid metadata payload');
      return;
    }
    playerLog.debug('nowPlayingItemDidChange:', sanitised);
    this.emit('nowPlayingItemDidChange', sanitised);
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

  /**
   * Shared body of the repeat and shuffle handlers, which differ only in the
   * event and the name table. The event name is the first word of every log
   * line, so both modes stay distinguishable in the log.
   */
  private handleModeChange(
    event: 'repeatModeDidChange' | 'shuffleModeDidChange',
    payload: number | null,
    names: Record<number, string>
  ): void {
    if (payload != null && typeof payload !== 'number') {
      playerLog.warn(`${event}: invalid payload, expected number or null`);
      return;
    }
    const modeName = typeof payload === 'number' ? (names[payload] ?? String(payload)) : payload;
    playerLog.debug(`${event}:`, modeName);
    this.emit(event, payload);
  }

  handleRepeatModeDidChange(payload: number | null): void {
    this.handleModeChange('repeatModeDidChange', payload, REPEAT_MODES);
  }

  handleShuffleModeDidChange(payload: number | null): void {
    this.handleModeChange('shuffleModeDidChange', payload, SHUFFLE_MODES);
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
