import { app, BrowserWindow } from 'electron';
import log from 'electron-log/main';

import { NowPlayingPayload, PlaybackState, PlaybackStatePayload, IntegrationContext, getShareUrl } from '../../player';
import { downloadArtwork } from '../../artwork';
import { errorMessage } from '../../utils';
import { getServiceByHost } from '../../musicService';

// @holusion/dbus-next is lazy-required because the MPRIS module only loads on Linux
const dbus = require('@holusion/dbus-next');
const {
  Interface,
  ACCESS_READ,
  ACCESS_READWRITE,
} = dbus.interface;
const { Variant } = require('@holusion/dbus-next');

// How close an incoming volume has to be to one this interface set for it to
// count as that value echoing back rather than as a change made in the app.
const VOLUME_ECHO_TOLERANCE = 0.01;
// How many unmatched `set Volume` values are tracked at once. A drag issues a
// burst of sets inside one echo round trip, and a single slot leaves all but
// the newest untracked: their echoes then read as in-app changes and pull the
// cached volume back behind the level the player has actually reached.
const MAX_PENDING_VOLUMES = 8;
const MS_TO_US = 1000;

const mprisLog = log.scope('mpris');

const MPRIS_PATH = '/org/mpris/MediaPlayer2';

/**
 * The `org.mpris.MediaPlayer2` root interface: how Sidra identifies itself to
 * media clients, and the two window actions the spec puts here.
 */
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
    return ['https'];
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

// `mpris:trackid` is a D-Bus object path ('o'), whose elements accept only
// [A-Za-z0-9_]. An Apple identifier carrying anything else fails to marshal.
function sanitiseTrackId(trackId: string): string {
  return trackId.replace(/[^A-Za-z0-9_]/g, '_');
}

function buildTrackId(rawId: string): string {
  const appName = app.getName().toLowerCase();
  return `/org/${appName}/track/${sanitiseTrackId(rawId)}`;
}

function buildMetadata(payload: NowPlayingPayload): Record<string, InstanceType<typeof Variant>> {
  const trackId = buildTrackId(payload.trackId ?? 'unknown');
  // MusicKit leaves `attributes.url` unset on a library item, so `xesam:url`
  // comes from getShareUrl(), which rebuilds the link from the catalogue id.
  // Radio and Classical playParams carry no such id, so it returns undefined
  // there and the key is left out.
  const trackUrl = getShareUrl(payload);

  const metadata: Record<string, InstanceType<typeof Variant>> = {
    'mpris:trackid': new Variant('o', trackId),
  };

  if (payload.durationInMillis != null) {
    // Convert milliseconds to microseconds (int64); truncated because the 'x'
    // marshaller throws on a fractional value
    metadata['mpris:length'] = new Variant('x', Math.trunc(payload.durationInMillis * MS_TO_US));
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

  if (trackUrl != null) {
    metadata['xesam:url'] = new Variant('s', trackUrl);
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

/**
 * The `org.mpris.MediaPlayer2.Player` interface. Property values are cached
 * here rather than read on demand: D-Bus asks for them at any moment, and the
 * renderer can only be reached asynchronously. Player events write the cache,
 * and control methods travel the other way as IPC to the hook.
 */
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

  // Volume echo suppression state. A `set Volume` reaches MusicKit, which
  // reports the new level straight back, and treating that report as an in-app
  // change would loop. The safety timeout drops the whole queue, so an echo
  // that never arrives cannot suppress volume changes for the rest of the
  // session.
  private readonly _volumeSafetyMs = 2000;
  private _pendingVolumes: number[] = [];
  private _volumeSafetyTimer: ReturnType<typeof setTimeout> | null = null;

  // Debounce timer for property change emissions
  private readonly _debounceMs = 250;
  private _debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private _pendingChanges: Record<string, unknown> = {};

  constructor(getMainWindow: () => BrowserWindow | null) {
    super('org.mpris.MediaPlayer2.Player');
    this._getMainWindow = getMainWindow;
  }

  private _send(channel: ReceiveChannel, ...args: unknown[]): void {
    const win = this._getMainWindow();
    if (win) {
      win.webContents.send(channel, ...args);
    }
  }

  /**
   * Coalesces property changes into one `PropertiesChanged` signal. dbus-next
   * emits nothing of its own accord, so a cached property that changes without
   * passing through here is one no client ever learns about.
   *
   * `Position` must never be among the properties: the MPRIS spec excludes it,
   * and clients read the property or follow `Seeked` instead.
   */
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

    // Only Playing and Paused have an MPRIS value of their own. Every other
    // MusicKit state falls through to 'Stopped', the transient ones (loading,
    // seeking, waiting, stalled) included, so MPRIS always reports the state
    // the player is in. Do not add early returns for the transient states, and
    // do not map Stopped to 'Paused', which shows clients a pause button for a
    // player that has stopped.
    let status: string;
    if (payload.state === PlaybackState.Playing) {
      status = 'Playing';
    } else if (payload.state === PlaybackState.Paused) {
      status = 'Paused';
    } else {
      status = 'Stopped';
    }

    if (status !== this._playbackStatus) {
      this._lastPositionTimestamp = Date.now();
    }
    this._playbackStatus = status;
    this._schedulePropertyEmission({ PlaybackStatus: status });
  }

  /**
   * Publishes the new track, or an empty metadata set when playback has nothing
   * loaded. Either way the playhead goes back to zero and `Seeked(0)` is
   * signalled: `Position` is barred from `PropertiesChanged`, so the signal is
   * the only way a client learns the playhead has moved without it asking.
   */
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
        // The download outlives a fast track change, and a late one would
        // otherwise put the previous cover on the track now playing.
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

    // A drag sets several values inside one echo round trip, so the echo is
    // matched against every value still pending, not only the newest. Echoes
    // arrive in order, so a match also discards the older entries: those sets
    // were overtaken, and keeping them would suppress a later in-app change.
    const matched = this._pendingVolumes.findIndex((pending) => Math.abs(payload - pending) < VOLUME_ECHO_TOLERANCE);
    if (matched !== -1) {
      this._pendingVolumes.splice(0, matched + 1);
      if (this._pendingVolumes.length === 0 && this._volumeSafetyTimer) {
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
    // dbus-next marshals an 'x' field with BigInt(data.toString()), which throws
    // on a fractional value, so truncate once here and let every consumer of the
    // position read the integer.
    const newPositionUs = Math.trunc(payload);
    const now = Date.now();
    const elapsedMs = this._playbackStatus === 'Playing' ? now - this._lastPositionTimestamp : 0;
    const expectedPositionUs = this._lastPositionUs + elapsedMs * MS_TO_US;

    if (Math.abs(newPositionUs - expectedPositionUs) > this._seekThresholdUs) {
      this.Seeked(newPositionUs);
    }

    this._lastPositionUs = newPositionUs;
    this._lastPositionTimestamp = now;
    this._position = newPositionUs;
  }

  /**
   * Drops every timer and every piece of cached echo state on shutdown, so
   * nothing fires into a bus that has already been disconnected.
   */
  cleanup(): void {
    if (this._volumeSafetyTimer) {
      clearTimeout(this._volumeSafetyTimer);
      this._volumeSafetyTimer = null;
    }
    this._pendingVolumes = [];
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
    return Math.trunc(this._position);
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
    this._schedulePropertyEmission({ Volume: clamped });
    // The queue is bounded, and a full one drops the value being added rather
    // than the oldest entry. Echoes arrive in order, so the oldest entry is the
    // one the next echo matches; discarding it makes that echo read as an
    // in-app change and drag the cached volume back to a value the drag left
    // behind. An untracked newest value costs nothing instead: its echo matches
    // nothing and writes the level the player has actually reached.
    if (this._pendingVolumes.length < MAX_PENDING_VOLUMES) {
      this._pendingVolumes.push(clamped);
    }
    if (this._volumeSafetyTimer) {
      clearTimeout(this._volumeSafetyTimer);
    }
    this._volumeSafetyTimer = setTimeout(() => {
      this._pendingVolumes = [];
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
    // Pause, never MusicKit's stop(): stop() clears the queue, and the MPRIS
    // spec requires Play() after Stop() to resume from the start of the track.
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

  /**
   * Opens a service URL a client hands over. The window navigates directly and
   * the persisted `musicService` is left alone, so after an OpenUri the window
   * can sit on one service's host while config still names the other.
   */
  OpenUri(uri: string): void {
    try {
      const parsed = new URL(uri);
      if (getServiceByHost(parsed.hostname) === undefined || parsed.protocol !== 'https:') {
        mprisLog.warn('OpenUri rejected:', uri);
        return;
      }
    } catch {
      mprisLog.warn('OpenUri rejected malformed URI:', uri);
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

/**
 * Exports both MPRIS interfaces on the session bus, claims
 * `org.mpris.MediaPlayer2.<app name>` and wires the interfaces to player
 * events. Linux only, and required lazily by `main.ts` for that reason.
 */
export function init(ctx: IntegrationContext): void {
  const { player, getMainWindow } = ctx;
  if (!getMainWindow) throw new Error('MPRIS requires getMainWindow');

  mprisLog.info('MPRIS module initialised');

  const rootIface = new MediaPlayer2(getMainWindow);
  const playerIface = new MediaPlayer2Player(getMainWindow);

  // Named wrappers, because `will-quit` has to hand removeListener the same
  // function reference; an inline handler could never be detached.
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

  // A session bus is not guaranteed to exist. dbus-next falls through to
  // getDbusAddressFromFs(), which throws synchronously when
  // DBUS_SESSION_BUS_ADDRESS is unset; containers, bare X and su-launched
  // sessions all hit it. Catching it here reports a missing bus as the ordinary
  // condition it is, rather than letting an exception stand in for it, and the
  // return leaves the export and the player subscriptions below undone. Losing
  // MPRIS is the correct outcome, and the connection is not retried.
  try {
    bus = dbus.sessionBus();
  } catch (err: unknown) {
    mprisLog.warn('no D-Bus session bus available, MPRIS disabled:', errorMessage(err));
    return;
  }

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

  // Subscribed after the bus, so the return on a missing bus leaves no
  // listener attached to update an interface no client can reach.
  player.on('playbackStateDidChange', onPlaybackStateDidChange);
  player.on('nowPlayingItemDidChange', onNowPlayingItemDidChange);
  player.on('repeatModeDidChange', onRepeatModeDidChange);
  player.on('shuffleModeDidChange', onShuffleModeDidChange);
  player.on('volumeDidChange', onVolumeDidChange);
  player.on('playbackTimeDidChange', onPlaybackTimeDidChange);
}
