import { app, BrowserWindow } from 'electron';
import log from 'electron-log/main';

import { Player, NowPlayingPayload, PlaybackState, PlaybackStatePayload, IntegrationContext } from '../../player';
import { downloadArtwork } from '../../artwork';
import { errorMessage } from '../../utils';

// @holusion/dbus-next is lazy-required because the MPRIS module only loads on Linux
const dbus = require('@holusion/dbus-next');
const {
  Interface,
  ACCESS_READ,
  ACCESS_READWRITE,
} = dbus.interface;
const { Variant } = require('@holusion/dbus-next');

const VOLUME_ECHO_TOLERANCE = 0.01;
const MS_TO_US = 1000;

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

function sanitiseTrackId(trackId: string): string {
  return trackId.replace(/[^A-Za-z0-9_]/g, '_');
}

function buildTrackId(rawId: string): string {
  const appName = app.getName().toLowerCase();
  return `/org/${appName}/track/${sanitiseTrackId(rawId)}`;
}

function buildMetadata(payload: NowPlayingPayload): Record<string, InstanceType<typeof Variant>> {
  const trackId = buildTrackId(payload.trackId ?? 'unknown');

  const metadata: Record<string, InstanceType<typeof Variant>> = {
    'mpris:trackid': new Variant('o', trackId),
  };

  if (payload.durationInMillis != null) {
    // Convert milliseconds to microseconds (int64)
    metadata['mpris:length'] = new Variant('x', payload.durationInMillis * MS_TO_US);
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
    metadata['mpris:artUrl'] = new Variant('s', payload.artworkUrl);
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

  if (payload.discNumber != null) {
    metadata['xesam:discNumber'] = new Variant('i', payload.discNumber);
  }

  if (payload.composerName != null && payload.composerName !== '') {
    metadata['xesam:composer'] = new Variant('as', [payload.composerName]);
  }

  if (payload.releaseDate != null) {
    metadata['xesam:contentCreated'] = new Variant('s', payload.releaseDate);
  }

  return metadata;
}

class MediaPlayer2Player extends Interface {
  private _getMainWindow: () => BrowserWindow | null;

  // Cached D-Bus property values
  private _playbackStatus = 'Stopped';
  private _loopStatus = 'None';
  private _shuffle = false;
  private _metadata: Record<string, InstanceType<typeof Variant>> = {
    'mpris:trackid': new Variant('o', NO_TRACK),
  };
  private _volume = 1.0;
  private _position = 0; // microseconds (int64)
  private _currentTrackId = NO_TRACK;

  // Seek detection state
  private readonly _seekThresholdUs = 1_000_000; // 1 second in microseconds
  private _lastPositionUs = 0;
  private _lastPositionTimestamp = Date.now();

  // Volume suppression state - prevents feedback loops when MPRIS sets volume
  private readonly _volumeSafetyMs = 2000; // safety timeout to prevent permanent suppression
  private _pendingVolume: number | null = null;
  private _volumeSafetyTimer: ReturnType<typeof setTimeout> | null = null;

  // Debounce timer for property change emissions
  private readonly _debounceMs = 1000;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingChanges: Record<string, unknown> = {};

  constructor(getMainWindow: () => BrowserWindow | null) {
    super('org.mpris.MediaPlayer2.Player');
    this._getMainWindow = getMainWindow;
  }

  private _send(channel: string, ...args: unknown[]): void {
    const win = this._getMainWindow();
    if (win) {
      win.webContents.send(channel, ...args);
    }
  }

  private _schedulePropertyEmission(properties: Record<string, unknown>): void {
    Object.assign(this._pendingChanges, properties);
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._debounceTimer = setTimeout(() => {
      this._debounceTimer = null;
      if (Object.keys(this._pendingChanges).length > 0) {
        try {
          Interface.emitPropertiesChanged(this, this._pendingChanges, []);
        } catch (err: unknown) {
          mprisLog.warn('failed to emit PropertiesChanged:', errorMessage(err));
        }
        this._pendingChanges = {};
      }
    }, this._debounceMs);
  }

  // --- Update methods (called by player event handlers) ---

  updatePlaybackStatus(payload: PlaybackStatePayload): void {
    if (!payload) return;

    // MusicKit PlaybackStates
    let status: string;
    if (payload.state === PlaybackState.Playing) {
      status = 'Playing';
    } else if (payload.state === PlaybackState.Paused || payload.state === PlaybackState.Stopped) {
      status = 'Paused';
    } else {
      status = 'Stopped';
    }

    this._playbackStatus = status;
    this._schedulePropertyEmission({ PlaybackStatus: status });
  }

  updateNowPlaying(payload: NowPlayingPayload | null): void {
    if (!payload) {
      const emptyMetadata: Record<string, InstanceType<typeof Variant>> = {
        'mpris:trackid': new Variant('o', NO_TRACK),
      };
      this._metadata = emptyMetadata;
      this._currentTrackId = NO_TRACK;
      this._schedulePropertyEmission({ Metadata: emptyMetadata });
      this._lastPositionUs = 0;
      this._lastPositionTimestamp = Date.now();
      this._position = 0;
      this.Seeked(0);
      return;
    }

    const metadata = buildMetadata(payload);
    const trackId = buildTrackId(payload.trackId ?? 'unknown');

    this._metadata = metadata;
    this._currentTrackId = trackId;
    this._schedulePropertyEmission({ Metadata: metadata });

    this._lastPositionUs = 0;
    this._lastPositionTimestamp = Date.now();
    this._position = 0;
    this.Seeked(0);

    if (payload.artworkUrl && payload.artworkUrl.startsWith('https://')) {
      downloadArtwork(payload.artworkUrl).then((localPath) => {
        if (!localPath) return;
        // Only update if this track is still current
        if (this._currentTrackId !== trackId) return;
        const fileUri = `file://${localPath}`;
        metadata['mpris:artUrl'] = new Variant('s', fileUri);
        this._metadata = metadata;
        this._schedulePropertyEmission({ Metadata: metadata });
        mprisLog.debug('mpris:artUrl updated to local file:', fileUri);
      }).catch((err: unknown) => {
        mprisLog.warn('artwork caching failed:', errorMessage(err));
      });
    }
  }

  updateRepeatMode(payload: number | null): void {
    if (payload == null) return;

    const musicKitToLoop: Record<number, string> = {
      0: 'None',
      1: 'Track',
      2: 'Playlist',
    };
    const loopStatus = musicKitToLoop[payload];
    if (loopStatus === undefined) {
      mprisLog.warn('unknown repeat mode:', payload);
      return;
    }

    this._loopStatus = loopStatus;
    this._schedulePropertyEmission({ LoopStatus: loopStatus });
  }

  updateShuffleMode(payload: number | null): void {
    if (payload == null) return;

    const shuffle = payload === 1;
    this._shuffle = shuffle;
    this._schedulePropertyEmission({ Shuffle: shuffle });
  }

  updateVolume(payload: number | null): void {
    if (payload == null) return;

    if (this._pendingVolume !== null && Math.abs(payload - this._pendingVolume) < VOLUME_ECHO_TOLERANCE) {
      this._pendingVolume = null;
      if (this._volumeSafetyTimer) {
        clearTimeout(this._volumeSafetyTimer);
        this._volumeSafetyTimer = null;
      }
      return;
    }

    const rounded = Math.round(payload * 100) / 100;
    this._volume = rounded;
    this._schedulePropertyEmission({ Volume: rounded });
  }

  updatePosition(payload: number): void {
    const newPositionUs = payload;
    const now = Date.now();
    const elapsedMs = now - this._lastPositionTimestamp;
    const expectedPositionUs = this._lastPositionUs + elapsedMs * MS_TO_US;

    if (Math.abs(newPositionUs - expectedPositionUs) > this._seekThresholdUs) {
      this.Seeked(newPositionUs);
    }

    this._lastPositionUs = newPositionUs;
    this._lastPositionTimestamp = now;
    this._position = newPositionUs;
  }

  cleanup(): void {
    if (this._volumeSafetyTimer) {
      clearTimeout(this._volumeSafetyTimer);
      this._volumeSafetyTimer = null;
    }
    this._pendingVolume = null;
    this._lastPositionUs = 0;
    this._lastPositionTimestamp = Date.now();
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }
    this._pendingChanges = {};
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
    this._send('player:setRepeat', mode);
  }

  get Shuffle(): boolean {
    return this._shuffle;
  }

  set Shuffle(value: boolean) {
    this._shuffle = value;
    const mode = value ? 1 : 0;
    this._send('player:setShuffle', mode);
  }

  get Volume(): number {
    return Math.round(this._volume * 100) / 100;
  }

  set Volume(value: number) {
    const clamped = Math.round(Math.max(0.0, Math.min(1.0, value)) * 100) / 100;
    this._volume = clamped;
    this._pendingVolume = clamped;
    if (this._volumeSafetyTimer) {
      clearTimeout(this._volumeSafetyTimer);
    }
    this._volumeSafetyTimer = setTimeout(() => {
      this._pendingVolume = null;
      this._volumeSafetyTimer = null;
    }, this._volumeSafetyMs);
    this._send('player:setVolume', clamped);
  }

  // --- Methods ---

  Next(): void {
    this._send('player:next');
  }

  Previous(): void {
    this._send('player:previous');
  }

  Pause(): void {
    this._send('player:pause');
  }

  PlayPause(): void {
    this._send('player:playPause');
  }

  Stop(): void {
    // Maps to pause(), not mk.stop(), to preserve queue state
    this._send('player:pause');
  }

  Play(): void {
    this._send('player:play');
  }

  Seek(offset: bigint): void {
    // offset is in microseconds; dbus-next delivers int64 as BigInt
    const targetUs = this._position + Number(offset);
    const targetSeconds = Math.max(0, targetUs) / 1_000_000;
    this._send('player:seek', targetSeconds);
  }

  SetPosition(trackId: string, position: bigint): void {
    // position is in microseconds; dbus-next delivers int64 as BigInt
    if (trackId !== this._currentTrackId) {
      mprisLog.debug('SetPosition trackId mismatch, ignoring');
      return;
    }
    const targetSeconds = Number(position) / 1_000_000;
    this._send('player:seek', targetSeconds);
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

// Typed interface for dbus-next internal socket access.
// Verified against @holusion/dbus-next 0.11.2.
interface DbusMessageBusInternals {
  _connection?: {
    stream?: {
      destroy: () => void;
    };
  };
}

function disconnectBus(): void {
  if (bus) {
    mprisLog.info('disconnecting from D-Bus');
    // bus.disconnect() calls stream.end() which only half-closes the socket.
    // Force-destroy the underlying stream to release the event loop handle.
    const stream = (bus as DbusMessageBusInternals)._connection?.stream;
    bus.disconnect();
    if (stream && typeof stream.destroy === 'function') {
      stream.destroy();
    }
    bus = null;
  }
}

// --- Public API ---

export function init(ctx: IntegrationContext): void {
  const { player, getMainWindow } = ctx;
  if (!getMainWindow) throw new Error('MPRIS requires getMainWindow');

  mprisLog.info('MPRIS module initialised');

  const rootIface = new MediaPlayer2(getMainWindow);
  const playerIface = new MediaPlayer2Player(getMainWindow);

  // Thin wrappers with stable references for removeListener
  const onPlaybackStateDidChange = (payload: PlaybackStatePayload): void => {
    playerIface.updatePlaybackStatus(payload);
  };
  const onNowPlayingItemDidChange = (payload: NowPlayingPayload | null): void => {
    playerIface.updateNowPlaying(payload);
  };
  const onRepeatModeDidChange = (payload: number | null): void => {
    playerIface.updateRepeatMode(payload);
  };
  const onShuffleModeDidChange = (payload: number | null): void => {
    playerIface.updateShuffleMode(payload);
  };
  const onVolumeDidChange = (payload: number | null): void => {
    playerIface.updateVolume(payload);
  };
  const onPlaybackTimeDidChange = (payload: number): void => {
    playerIface.updatePosition(payload);
  };

  app.on('will-quit', () => {
    player.removeListener('playbackStateDidChange', onPlaybackStateDidChange);
    player.removeListener('nowPlayingItemDidChange', onNowPlayingItemDidChange);
    player.removeListener('repeatModeDidChange', onRepeatModeDidChange);
    player.removeListener('shuffleModeDidChange', onShuffleModeDidChange);
    player.removeListener('volumeDidChange', onVolumeDidChange);
    player.removeListener('playbackTimeDidChange', onPlaybackTimeDidChange);
    playerIface.cleanup();
    disconnectBus();
  });

  mprisLog.info('enabling MPRIS service');

  bus = dbus.sessionBus();

  bus.on('error', (err: Error) => {
    mprisLog.warn('D-Bus connection error:', err.message);
  });

  bus.export(MPRIS_PATH, rootIface);
  bus.export(MPRIS_PATH, playerIface);

  const busName = `org.mpris.MediaPlayer2.${app.getName().toLowerCase()}`;
  bus.requestName(busName, 0).then(() => {
    mprisLog.info('bus name acquired:', busName);
  }).catch((err: Error) => {
    mprisLog.error('failed to acquire bus name:', busName, err.message);
  });

  // Subscribe to player events
  player.on('playbackStateDidChange', onPlaybackStateDidChange);
  player.on('nowPlayingItemDidChange', onNowPlayingItemDidChange);
  player.on('repeatModeDidChange', onRepeatModeDidChange);
  player.on('shuffleModeDidChange', onShuffleModeDidChange);
  player.on('volumeDidChange', onVolumeDidChange);
  player.on('playbackTimeDidChange', onPlaybackTimeDidChange);
}
