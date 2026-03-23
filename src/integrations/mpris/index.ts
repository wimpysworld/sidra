import { app, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { getMprisEnabled } from '../../config';
import { Player } from '../../player';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const dbus = require('dbus-next');
const {
  Interface,
  ACCESS_READ,
  ACCESS_READWRITE,
} = dbus.interface;
const { Variant } = require('dbus-next');

const mprisLog = log.scope('mpris');

const MPRIS_PATH = '/org/mpris/MediaPlayer2';

class MediaPlayer2 extends Interface {
  private _getMainWindow: () => BrowserWindow | null;

  constructor(getMainWindow: () => BrowserWindow | null) {
    super('org.mpris.MediaPlayer2');
    this._getMainWindow = getMainWindow;
  }

  get Identity(): string {
    return app.getName();
  }

  get DesktopEntry(): string {
    return app.getName().toLowerCase();
  }

  get CanQuit(): boolean {
    return true;
  }

  get CanRaise(): boolean {
    return true;
  }

  get HasTrackList(): boolean {
    return false;
  }

  get SupportedMimeTypes(): string[] {
    return [];
  }

  get SupportedUriSchemes(): string[] {
    return [];
  }

  Raise(): void {
    const win = this._getMainWindow();
    if (win) {
      win.show();
      win.focus();
    }
  }

  Quit(): void {
    app.quit();
  }
}

MediaPlayer2.configureMembers({
  properties: {
    Identity: {
      signature: 's',
      access: ACCESS_READ,
    },
    DesktopEntry: {
      signature: 's',
      access: ACCESS_READ,
    },
    CanQuit: {
      signature: 'b',
      access: ACCESS_READ,
    },
    CanRaise: {
      signature: 'b',
      access: ACCESS_READ,
    },
    HasTrackList: {
      signature: 'b',
      access: ACCESS_READ,
    },
    SupportedMimeTypes: {
      signature: 'as',
      access: ACCESS_READ,
    },
    SupportedUriSchemes: {
      signature: 'as',
      access: ACCESS_READ,
    },
  },
  methods: {
    Raise: {
      inSignature: '',
      outSignature: '',
    },
    Quit: {
      inSignature: '',
      outSignature: '',
    },
  },
});

const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';

class MediaPlayer2Player extends Interface {
  private _getMainWindow: () => BrowserWindow | null;

  // Cached property values (not private - updated by event handlers in init())
  _playbackStatus = 'Stopped';
  _loopStatus = 'None';
  _shuffle = false;
  _metadata: Record<string, InstanceType<typeof Variant>> = {
    'mpris:trackid': new Variant('o', NO_TRACK),
  };
  _volume = 1.0;
  _position = 0; // microseconds (int64)
  _currentTrackId = NO_TRACK;

  constructor(getMainWindow: () => BrowserWindow | null) {
    super('org.mpris.MediaPlayer2.Player');
    this._getMainWindow = getMainWindow;
  }

  // --- Read-only properties ---

  get PlaybackStatus(): string {
    return this._playbackStatus;
  }

  get Rate(): number {
    return 1.0;
  }

  get Metadata(): Record<string, InstanceType<typeof Variant>> {
    return this._metadata;
  }

  get Position(): number {
    return this._position;
  }

  get MinimumRate(): number {
    return 1.0;
  }

  get MaximumRate(): number {
    return 1.0;
  }

  get CanGoNext(): boolean {
    return true;
  }

  get CanGoPrevious(): boolean {
    return true;
  }

  get CanPlay(): boolean {
    return true;
  }

  get CanPause(): boolean {
    return true;
  }

  get CanSeek(): boolean {
    return true;
  }

  get CanControl(): boolean {
    return true;
  }

  // --- Read/write properties ---

  get LoopStatus(): string {
    return this._loopStatus;
  }

  set LoopStatus(value: string) {
    const loopToMusicKit: Record<string, number> = {
      'None': 0,
      'Track': 1,
      'Playlist': 2,
    };
    const mode = loopToMusicKit[value];
    if (mode === undefined) {
      mprisLog.warn('invalid LoopStatus value:', value);
      return;
    }
    this._loopStatus = value;
    const win = this._getMainWindow();
    if (win) {
      win.webContents.executeJavaScript(`window.__sidra.setRepeat(${mode})`).catch((err: Error) => {
        mprisLog.warn('failed to set repeat mode:', err.message);
      });
    }
  }

  get Shuffle(): boolean {
    return this._shuffle;
  }

  set Shuffle(value: boolean) {
    this._shuffle = value;
    const mode = value ? 1 : 0;
    const win = this._getMainWindow();
    if (win) {
      win.webContents.executeJavaScript(`window.__sidra.setShuffle(${mode})`).catch((err: Error) => {
        mprisLog.warn('failed to set shuffle mode:', err.message);
      });
    }
  }

  get Volume(): number {
    return this._volume;
  }

  set Volume(value: number) {
    const clamped = Math.max(0.0, Math.min(1.0, value));
    this._volume = clamped;
    pendingVolume = clamped;
    if (volumeSuppressionTimer) {
      clearTimeout(volumeSuppressionTimer);
    }
    volumeSuppressionTimer = setTimeout(() => {
      pendingVolume = null;
      volumeSuppressionTimer = null;
    }, VOLUME_SUPPRESSION_MS);
    const win = this._getMainWindow();
    if (win) {
      win.webContents.executeJavaScript(`window.__sidra.setVolume(${clamped})`).catch((err: Error) => {
        mprisLog.warn('failed to set volume:', err.message);
      });
    }
  }

  // --- Methods ---

  Next(): void {
    const win = this._getMainWindow();
    if (win) {
      win.webContents.executeJavaScript('window.__sidra.next()').catch((err: Error) => {
        mprisLog.warn('failed to call next:', err.message);
      });
    }
  }

  Previous(): void {
    const win = this._getMainWindow();
    if (win) {
      win.webContents.executeJavaScript('window.__sidra.previous()').catch((err: Error) => {
        mprisLog.warn('failed to call previous:', err.message);
      });
    }
  }

  Pause(): void {
    const win = this._getMainWindow();
    if (win) {
      win.webContents.executeJavaScript('window.__sidra.pause()').catch((err: Error) => {
        mprisLog.warn('failed to call pause:', err.message);
      });
    }
  }

  PlayPause(): void {
    const win = this._getMainWindow();
    if (win) {
      win.webContents.executeJavaScript('window.__sidra.playPause()').catch((err: Error) => {
        mprisLog.warn('failed to call playPause:', err.message);
      });
    }
  }

  Stop(): void {
    // Maps to pause(), not mk.stop(), to preserve queue state
    const win = this._getMainWindow();
    if (win) {
      win.webContents.executeJavaScript('window.__sidra.pause()').catch((err: Error) => {
        mprisLog.warn('failed to call stop (pause):', err.message);
      });
    }
  }

  Play(): void {
    const win = this._getMainWindow();
    if (win) {
      win.webContents.executeJavaScript('window.__sidra.play()').catch((err: Error) => {
        mprisLog.warn('failed to call play:', err.message);
      });
    }
  }

  Seek(offset: bigint): void {
    // offset is in microseconds; dbus-next delivers int64 as BigInt
    const targetUs = this._position + Number(offset);
    const targetSeconds = Math.max(0, targetUs) / 1_000_000;
    const win = this._getMainWindow();
    if (win) {
      win.webContents.executeJavaScript(`window.__sidra.seek(${targetSeconds})`).catch((err: Error) => {
        mprisLog.warn('failed to seek:', err.message);
      });
    }
  }

  SetPosition(trackId: string, position: bigint): void {
    // position is in microseconds; dbus-next delivers int64 as BigInt
    if (trackId !== this._currentTrackId) {
      mprisLog.debug('SetPosition trackId mismatch, ignoring');
      return;
    }
    const targetSeconds = Number(position) / 1_000_000;
    const win = this._getMainWindow();
    if (win) {
      win.webContents.executeJavaScript(`window.__sidra.seek(${targetSeconds})`).catch((err: Error) => {
        mprisLog.warn('failed to set position:', err.message);
      });
    }
  }

  OpenUri(uri: string): void {
    if (!uri.startsWith('https://music.apple.com/')) {
      mprisLog.warn('OpenUri rejected non-Apple Music URI:', uri);
      return;
    }
    const win = this._getMainWindow();
    if (win) {
      win.loadURL(uri).catch((err: Error) => {
        mprisLog.warn('failed to open URI:', err.message);
      });
    }
  }

  // Signal - declared via configureMembers, calling this method emits on D-Bus
  Seeked(_position: number): number {
    return _position;
  }
}

MediaPlayer2Player.configureMembers({
  properties: {
    PlaybackStatus: {
      signature: 's',
      access: ACCESS_READ,
    },
    LoopStatus: {
      signature: 's',
      access: ACCESS_READWRITE,
    },
    Rate: {
      signature: 'd',
      access: ACCESS_READ,
    },
    Shuffle: {
      signature: 'b',
      access: ACCESS_READWRITE,
    },
    Metadata: {
      signature: 'a{sv}',
      access: ACCESS_READ,
    },
    Volume: {
      signature: 'd',
      access: ACCESS_READWRITE,
    },
    Position: {
      signature: 'x',
      access: ACCESS_READ,
    },
    MinimumRate: {
      signature: 'd',
      access: ACCESS_READ,
    },
    MaximumRate: {
      signature: 'd',
      access: ACCESS_READ,
    },
    CanGoNext: {
      signature: 'b',
      access: ACCESS_READ,
    },
    CanGoPrevious: {
      signature: 'b',
      access: ACCESS_READ,
    },
    CanPlay: {
      signature: 'b',
      access: ACCESS_READ,
    },
    CanPause: {
      signature: 'b',
      access: ACCESS_READ,
    },
    CanSeek: {
      signature: 'b',
      access: ACCESS_READ,
    },
    CanControl: {
      signature: 'b',
      access: ACCESS_READ,
    },
  },
  methods: {
    Next: {
      inSignature: '',
      outSignature: '',
    },
    Previous: {
      inSignature: '',
      outSignature: '',
    },
    Pause: {
      inSignature: '',
      outSignature: '',
    },
    PlayPause: {
      inSignature: '',
      outSignature: '',
    },
    Stop: {
      inSignature: '',
      outSignature: '',
    },
    Play: {
      inSignature: '',
      outSignature: '',
    },
    Seek: {
      inSignature: 'x',
      outSignature: '',
    },
    SetPosition: {
      inSignature: 'ox',
      outSignature: '',
    },
    OpenUri: {
      inSignature: 's',
      outSignature: '',
    },
  },
  signals: {
    Seeked: {
      signature: 'x',
    },
  },
});

// Module-level bus reference for graceful shutdown
let bus: InstanceType<typeof dbus.MessageBus> | null = null;

// Stored references from init() for use by enable/disable
let playerRef: Player | null = null;
let getMainWindowRef: (() => BrowserWindow | null) | null = null;

// Seek detection state - tracks position to detect user-initiated seeks
const SEEK_THRESHOLD_US = 1_000_000; // 1 second in microseconds
let lastPositionUs = 0;
let lastPositionTimestamp = Date.now();

// Volume suppression state - prevents feedback loops when MPRIS sets volume
const VOLUME_SUPPRESSION_MS = 500; // 2x the 250ms poll interval in musicKitHook.js
let pendingVolume: number | null = null;
let volumeSuppressionTimer: ReturnType<typeof setTimeout> | null = null;

// Debounce timer for property change emissions
const DEBOUNCE_MS = 1000;
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pendingChanges: Record<string, unknown> = {};
let playerIfaceRef: MediaPlayer2Player | null = null;

function schedulePropertyEmission(properties: Record<string, unknown>): void {
  Object.assign(pendingChanges, properties);
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    if (playerIfaceRef && Object.keys(pendingChanges).length > 0) {
      try {
        Interface.emitPropertiesChanged(playerIfaceRef, pendingChanges, []);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        mprisLog.warn('failed to emit PropertiesChanged:', message);
      }
      pendingChanges = {};
    }
  }, DEBOUNCE_MS);
}

function sanitiseTrackId(trackId: string): string {
  return trackId.replace(/[^A-Za-z0-9_]/g, '_');
}

function buildMetadata(payload: {
  name?: string;
  albumName?: string;
  artistName?: string;
  durationInMillis?: number;
  genreNames?: string[];
  artworkUrl?: string;
  trackId?: string;
  trackNumber?: number;
  url?: string;
}): Record<string, InstanceType<typeof Variant>> {
  const appName = app.getName().toLowerCase();
  const rawId = payload.trackId ?? 'unknown';
  const trackId = `/org/${appName}/track/${sanitiseTrackId(rawId)}`;

  const metadata: Record<string, InstanceType<typeof Variant>> = {
    'mpris:trackid': new Variant('o', trackId),
  };

  if (payload.durationInMillis != null) {
    // Convert milliseconds to microseconds (int64)
    metadata['mpris:length'] = new Variant('x', payload.durationInMillis * 1000);
  }

  if (payload.name != null) {
    metadata['xesam:title'] = new Variant('s', payload.name);
  }

  if (payload.artistName != null) {
    metadata['xesam:artist'] = new Variant('as', [payload.artistName]);
  }

  if (payload.albumName != null) {
    metadata['xesam:album'] = new Variant('s', payload.albumName);
  }

  if (payload.artworkUrl != null) {
    metadata['xesam:artUrl'] = new Variant('s', payload.artworkUrl);
  }

  if (payload.url != null) {
    metadata['xesam:url'] = new Variant('s', payload.url);
  }

  if (payload.genreNames != null && payload.genreNames.length > 0) {
    metadata['xesam:genre'] = new Variant('as', payload.genreNames);
  }

  if (payload.trackNumber != null) {
    metadata['xesam:trackNumber'] = new Variant('i', payload.trackNumber);
  }

  return metadata;
}

// --- Named event handlers (stored for removeListener on disable) ---

function onPlaybackStateDidChange(payload: unknown): void {
  const p = payload as { state: number } | null;
  if (!p || !playerIfaceRef) return;

  // MusicKit PlaybackStates: 2 = playing, 3 = paused, 4 = stopped
  let status: string;
  if (p.state === 2) {
    status = 'Playing';
  } else if (p.state === 3 || p.state === 4) {
    status = 'Paused';
  } else {
    status = 'Stopped';
  }

  playerIfaceRef._playbackStatus = status;
  schedulePropertyEmission({ PlaybackStatus: status });
}

function onNowPlayingItemDidChange(payload: unknown): void {
  if (!playerIfaceRef) return;

  const p = payload as {
    name?: string;
    albumName?: string;
    artistName?: string;
    durationInMillis?: number;
    genreNames?: string[];
    artworkUrl?: string;
    trackId?: string;
    trackNumber?: number;
    url?: string;
  } | null;

  if (!p) {
    const emptyMetadata: Record<string, InstanceType<typeof Variant>> = {
      'mpris:trackid': new Variant('o', NO_TRACK),
    };
    playerIfaceRef._metadata = emptyMetadata;
    playerIfaceRef._currentTrackId = NO_TRACK;
    schedulePropertyEmission({ Metadata: emptyMetadata });
    lastPositionUs = 0;
    lastPositionTimestamp = Date.now();
    playerIfaceRef._position = 0;
    playerIfaceRef.Seeked(0);
    return;
  }

  const metadata = buildMetadata(p);
  const appName = app.getName().toLowerCase();
  const rawId = p.trackId ?? 'unknown';
  const trackId = `/org/${appName}/track/${sanitiseTrackId(rawId)}`;

  playerIfaceRef._metadata = metadata;
  playerIfaceRef._currentTrackId = trackId;
  schedulePropertyEmission({ Metadata: metadata });

  lastPositionUs = 0;
  lastPositionTimestamp = Date.now();
  playerIfaceRef._position = 0;
  playerIfaceRef.Seeked(0);
}

function onRepeatModeDidChange(payload: unknown): void {
  const mode = payload as number | null;
  if (mode == null || !playerIfaceRef) return;

  const musicKitToLoop: Record<number, string> = {
    0: 'None',
    1: 'Track',
    2: 'Playlist',
  };
  const loopStatus = musicKitToLoop[mode];
  if (loopStatus === undefined) {
    mprisLog.warn('unknown repeat mode:', mode);
    return;
  }

  playerIfaceRef._loopStatus = loopStatus;
  schedulePropertyEmission({ LoopStatus: loopStatus });
}

function onShuffleModeDidChange(payload: unknown): void {
  const mode = payload as number | null;
  if (mode == null || !playerIfaceRef) return;

  const shuffle = mode === 1;
  playerIfaceRef._shuffle = shuffle;
  schedulePropertyEmission({ Shuffle: shuffle });
}

function onVolumeDidChange(payload: unknown): void {
  const volume = payload as number | null;
  if (volume == null || !playerIfaceRef) return;

  if (pendingVolume !== null && Math.abs(volume - pendingVolume) < 0.01) {
    return;
  }

  playerIfaceRef._volume = volume;
  schedulePropertyEmission({ Volume: volume });
}

function onPlaybackTimeDidChange(payload: unknown): void {
  if (typeof payload !== 'number' || !playerIfaceRef) return;

  const newPositionUs = payload;
  const now = Date.now();
  const elapsedMs = now - lastPositionTimestamp;
  const expectedPositionUs = lastPositionUs + elapsedMs * 1000;

  if (Math.abs(newPositionUs - expectedPositionUs) > SEEK_THRESHOLD_US) {
    playerIfaceRef.Seeked(newPositionUs);
  }

  lastPositionUs = newPositionUs;
  lastPositionTimestamp = now;
  playerIfaceRef._position = newPositionUs;
}

// --- Cleanup helper (shared by disable and will-quit) ---

function cleanupState(): void {
  if (volumeSuppressionTimer) {
    clearTimeout(volumeSuppressionTimer);
    volumeSuppressionTimer = null;
  }
  pendingVolume = null;
  lastPositionUs = 0;
  lastPositionTimestamp = Date.now();
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pendingChanges = {};
}

function disconnectBus(): void {
  if (bus) {
    mprisLog.info('disconnecting from D-Bus');
    // bus.disconnect() calls stream.end() which only half-closes the socket.
    // Force-destroy the underlying stream to release the event loop handle.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const stream = (bus as any)._connection?.stream;
    bus.disconnect();
    if (stream && typeof stream.destroy === 'function') {
      stream.destroy();
    }
    bus = null;
  }
  playerIfaceRef = null;
}

// --- Public API ---

export function enable(): void {
  if (bus) {
    mprisLog.debug('already enabled, skipping');
    return;
  }

  if (!playerRef || !getMainWindowRef) {
    mprisLog.warn('enable called before init, skipping');
    return;
  }

  mprisLog.info('enabling MPRIS service');

  bus = dbus.sessionBus();

  bus.on('error', (err: Error) => {
    mprisLog.warn('D-Bus connection error:', err.message);
  });

  const rootIface = new MediaPlayer2(getMainWindowRef);
  const playerIface = new MediaPlayer2Player(getMainWindowRef);
  playerIfaceRef = playerIface;

  bus.export(MPRIS_PATH, rootIface);
  bus.export(MPRIS_PATH, playerIface);

  const busName = `org.mpris.MediaPlayer2.${app.getName().toLowerCase()}`;
  bus.requestName(busName, 0).then(() => {
    mprisLog.info('bus name acquired:', busName);
  }).catch((err: Error) => {
    mprisLog.error('failed to acquire bus name:', busName, err.message);
  });

  // Subscribe to player events
  playerRef.on('playbackStateDidChange', onPlaybackStateDidChange);
  playerRef.on('nowPlayingItemDidChange', onNowPlayingItemDidChange);
  playerRef.on('repeatModeDidChange', onRepeatModeDidChange);
  playerRef.on('shuffleModeDidChange', onShuffleModeDidChange);
  playerRef.on('volumeDidChange', onVolumeDidChange);
  playerRef.on('playbackTimeDidChange', onPlaybackTimeDidChange);
}

export function disable(): void {
  if (!bus) {
    mprisLog.debug('already disabled, skipping');
    return;
  }

  mprisLog.info('disabling MPRIS service');

  // Remove event listeners
  if (playerRef) {
    playerRef.removeListener('playbackStateDidChange', onPlaybackStateDidChange);
    playerRef.removeListener('nowPlayingItemDidChange', onNowPlayingItemDidChange);
    playerRef.removeListener('repeatModeDidChange', onRepeatModeDidChange);
    playerRef.removeListener('shuffleModeDidChange', onShuffleModeDidChange);
    playerRef.removeListener('volumeDidChange', onVolumeDidChange);
    playerRef.removeListener('playbackTimeDidChange', onPlaybackTimeDidChange);
  }

  cleanupState();
  disconnectBus();
}

export function init(
  player: Player,
  getMainWindow: () => BrowserWindow | null,
): void {
  mprisLog.info('MPRIS module initialised');

  playerRef = player;
  getMainWindowRef = getMainWindow;

  app.on('will-quit', () => {
    if (playerRef) {
      playerRef.removeListener('playbackStateDidChange', onPlaybackStateDidChange);
      playerRef.removeListener('nowPlayingItemDidChange', onNowPlayingItemDidChange);
      playerRef.removeListener('repeatModeDidChange', onRepeatModeDidChange);
      playerRef.removeListener('shuffleModeDidChange', onShuffleModeDidChange);
      playerRef.removeListener('volumeDidChange', onVolumeDidChange);
      playerRef.removeListener('playbackTimeDidChange', onPlaybackTimeDidChange);
    }
    cleanupState();
    disconnectBus();
  });

  if (getMprisEnabled()) {
    enable();
  } else {
    mprisLog.info('MPRIS disabled by config, skipping bus connection');
  }
}
