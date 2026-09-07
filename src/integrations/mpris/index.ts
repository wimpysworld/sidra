import { app, BrowserWindow } from 'electron';
import log from 'electron-log/main';

import { NowPlayingPayload, TimedMetadataPayload, PlaybackState, PlaybackStatePayload, PlaybackCapabilities, PlaybackStopped, IntegrationContext, getShareUrl } from '../../player';
import { downloadArtwork } from '../../artwork';
import { errorMessage } from '../../utils';
import { getServiceByHost } from '../../musicService';
import { getMusicService } from '../../config';
import { switchService } from '../../serviceSwitch';

// main.ts loads this module only on Linux, keeping dbus-next off other platforms.
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

function parseServiceUri(uri: string): URL | null {
  try {
    const url = new URL(uri);
    const service = getServiceByHost(url.hostname);
    return service?.origin === url.origin && !url.username && !url.password ? url : null;
  } catch {
    return null;
  }
}

type MprisMethod =
  | 'LoopStatus'
  | 'Rate'
  | 'Shuffle'
  | 'Volume'
  | 'Next'
  | 'Previous'
  | 'Pause'
  | 'PlayPause'
  | 'Stop'
  | 'Play'
  | 'Seek'
  | 'SetPosition'
  | 'OpenUri'
  | 'Fullscreen'
  | 'Raise'
  | 'Quit';

function logCommand(method: MprisMethod, result: 'sent' | 'dropped', channel?: ReceiveChannel): void {
  const channelField = channel === undefined ? '' : ` channel=${channel}`;
  const message = `source=mpris method=${method}${channelField} result=${result}`;
  if (method === 'Volume' && result === 'sent') {
    mprisLog.debug(message);
    return;
  }
  mprisLog.info(message);
}

/**
 * The `org.mpris.MediaPlayer2` root interface: how Sidra identifies itself to
 * media clients, and the window controls the spec puts here.
 */
class MediaPlayer2 extends Interface {
  private _getMainWindow: () => BrowserWindow | null;

  /** Creates the root interface with a current-window lookup. */
  constructor(getMainWindow: () => BrowserWindow | null) {
    super('org.mpris.MediaPlayer2');
    this._getMainWindow = getMainWindow;
  }

  /** Returns the application name shown by media clients. */
  get Identity(): string {
    return app.getName();
  }

  /** Returns the desktop entry name without its .desktop suffix. */
  get DesktopEntry(): string {
    return app.getName().toLowerCase();
  }

  /** Reports that clients can quit Sidra. */
  get CanQuit(): boolean {
    return true;
  }

  /** Reports that clients can bring Sidra to the foreground. */
  get CanRaise(): boolean {
    return true;
  }

  /** Reads fullscreen state from the current window. */
  get Fullscreen(): boolean {
    const win = this._getMainWindow();
    return win && !win.isDestroyed() ? win.isFullScreen() : false;
  }

  /** Applies fullscreen state if the window is available. */
  set Fullscreen(value: boolean) {
    const win = this._getMainWindow();
    if (win && !win.isDestroyed()) {
      win.setFullScreen(value);
      logCommand('Fullscreen', 'sent');
    } else {
      logCommand('Fullscreen', 'dropped');
    }
  }

  /** Reports support for changing fullscreen state. */
  get CanSetFullscreen(): boolean {
    return true;
  }

  /** Reports that Sidra exposes no MPRIS TrackList interface. */
  get HasTrackList(): boolean {
    return false;
  }

  /** Reports no MIME-type-based opening support. */
  get SupportedMimeTypes(): string[] {
    return [];
  }

  /** Advertises HTTPS for validated service URLs. */
  get SupportedUriSchemes(): string[] {
    return ['https'];
  }

  /** Shows and focuses the current window. */
  Raise(): void {
    const win = this._getMainWindow();
    if (win) {
      win.show();
      win.focus();
      logCommand('Raise', 'sent');
    } else {
      logCommand('Raise', 'dropped');
    }
  }

  /** Requests application shutdown. */
  Quit(): void {
    app.quit();
    logCommand('Quit', 'sent');
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
    Fullscreen: {
      signature: 'b',
      access: ACCESS_READWRITE,
    },
    CanSetFullscreen: {
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
    // Truncate microseconds because the D-Bus 'x' marshaller rejects fractional values.
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
  private _capabilities: PlaybackCapabilities;
  private _itemLengthUs: number | undefined;
  private _itemGeneration = 0;
  private _radioStation: NowPlayingPayload | null = null;
  private _readyUrl: string | null;
  private _navigating = false;
  private _pendingOpenUri: { url: string; navigationUrl: string } | null = null;
  private _openUriTimer: ReturnType<typeof setTimeout> | null = null;
  private _stopRequestId = 0;
  private _pendingStopId: number | null = null;
  private _stopTimer: ReturnType<typeof setTimeout> | null = null;
  private _stopped = false;

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

  /** Initialises cached capabilities and the ready hook URL. */
  constructor(getMainWindow: () => BrowserWindow | null, capabilities: PlaybackCapabilities, readyUrl: string | null) {
    super('org.mpris.MediaPlayer2.Player');
    this._getMainWindow = getMainWindow;
    this._capabilities = capabilities;
    this._readyUrl = readyUrl;
  }

  private _send(method: MprisMethod, channel: ReceiveChannel, ...args: unknown[]): boolean {
    const win = this._getMainWindow();
    if (win) {
      win.webContents.send(channel, ...args);
      logCommand(method, 'sent', channel);
      return true;
    } else {
      logCommand(method, 'dropped', channel);
      return false;
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

  /** Publishes changed capabilities and refreshes the current track length. */
  updateCapabilities(capabilities: PlaybackCapabilities): void {
    const previous = this._capabilities;
    this._capabilities = capabilities;
    const changed: Record<string, unknown> = {};
    if (previous.canPlay !== capabilities.canPlay) changed.CanPlay = this.CanPlay;
    if (previous.canPause !== capabilities.canPause) changed.CanPause = this.CanPause;
    if ((previous.canSeek !== false) !== this.CanSeek) changed.CanSeek = this.CanSeek;
    if (previous.durationUs !== capabilities.durationUs && this._currentTrackId !== NO_TRACK) {
      this._updateMetadataLength();
      changed.Metadata = this._metadata;
    }
    if (Object.keys(changed).length > 0) this._schedulePropertyEmission(changed);
  }

  private _updateMetadataLength(): void {
    const lengthUs = this._trackLengthUs;
    if (lengthUs === undefined) delete this._metadata['mpris:length'];
    else this._metadata['mpris:length'] = new Variant('x', lengthUs);
  }

  /** Maps MusicKit state to MPRIS while preserving an acknowledged Stop. */
  updatePlaybackStatus(payload: PlaybackStatePayload): void {
    if (!payload) return;
    if (payload.state === PlaybackState.Playing) {
      this._clearPendingStop();
      this._stopped = false;
    }

    // An acknowledged Stop stays Stopped until play resumes or the track changes.
    // All states except Playing and ordinary Paused, including transient states,
    // map to Stopped so clients do not show controls for the previous state.
    let status: string;
    if (payload.state === PlaybackState.Playing) {
      status = 'Playing';
    } else if (payload.state === PlaybackState.Paused && !this._stopped) {
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
    const itemGeneration = ++this._itemGeneration;
    this._radioStation = payload?.playParams?.kind === 'radioStation' ? payload : null;
    this._clearPendingStop();
    this._stopped = false;
    if (!payload) {
      const emptyMetadata: Record<string, InstanceType<typeof Variant>> = {
        'mpris:trackid': new Variant('o', NO_TRACK),
      };
      this._metadata = emptyMetadata;
      this._itemLengthUs = undefined;
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
    this._itemLengthUs = metadata['mpris:length']?.value;
    this._updateMetadataLength();
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
        if (this._itemGeneration !== itemGeneration) return;
        const fileUri = `file://${localPath}`;
        this._metadata = { ...this._metadata, 'mpris:artUrl': new Variant('s', fileUri) };
        this._schedulePropertyEmission({ Metadata: this._metadata });
        mprisLog.debug('mpris:artUrl updated to local file:', fileUri);
      }).catch((err: unknown) => {
        mprisLog.warn('artwork caching failed:', errorMessage(err));
      });
    }
  }

  /** Updates radio song labels without replacing station identity or position. */
  updateTimedMetadata(payload: TimedMetadataPayload): void {
    if (!this._radioStation) return;
    const url = getShareUrl({ ...payload, sourceHost: this._radioStation.sourceHost }) ?? getShareUrl(this._radioStation);
    const values = [payload.name, [payload.artistName], payload.albumName ?? null, url ?? null];
    const current = ['xesam:title', 'xesam:artist', 'xesam:album', 'xesam:url']
      .map(key => this._metadata[key]?.value ?? null);
    if (JSON.stringify(values) === JSON.stringify(current)) return;
    const metadata: Record<string, InstanceType<typeof Variant>> = {
      ...this._metadata,
      'xesam:title': new Variant('s', payload.name),
      'xesam:artist': new Variant('as', [payload.artistName]),
    };
    if (payload.albumName === undefined) delete metadata['xesam:album'];
    else metadata['xesam:album'] = new Variant('s', payload.albumName);
    if (url === undefined) delete metadata['xesam:url'];
    else metadata['xesam:url'] = new Variant('s', url);
    this._metadata = metadata;
    this._schedulePropertyEmission({ Metadata: metadata });
  }

  /** Maps a recognised MusicKit repeat mode to MPRIS LoopStatus. */
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

  /** Publishes whether MusicKit shuffle is enabled. */
  updateShuffleMode(payload: number | null): void {
    if (payload == null) return;

    const shuffle = payload === 1;
    this._shuffle = shuffle;
    this._schedulePropertyEmission({ Shuffle: shuffle });
  }

  /** Publishes in-app volume changes while suppressing pending control echoes. */
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

  /** Caches microseconds and signals seeks without scheduling property emissions. */
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
    this._clearOpenUri();
    this._clearPendingStop();
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

  /** Returns the cached MPRIS playback state. */
  get PlaybackStatus(): string {
    return this._playbackStatus;
  }

  /** Returns the cached track metadata as D-Bus variants. */
  get Metadata(): Record<string, InstanceType<typeof Variant>> {
    return this._metadata;
  }

  /** Returns the cached playhead in integer microseconds. */
  get Position(): number {
    return Math.trunc(this._position);
  }

  /** Reports normal speed as the minimum supported rate. */
  get MinimumRate(): number {
    return 1.0;
  }

  /** Reports normal speed as the maximum supported rate. */
  get MaximumRate(): number {
    return 1.0;
  }

  /** Advertises support for the next-track command. */
  get CanGoNext(): boolean {
    return true;
  }

  /** Advertises support for the previous-track command. */
  get CanGoPrevious(): boolean {
    return true;
  }

  /** Returns the latest validated play capability. */
  get CanPlay(): boolean {
    return this._capabilities.canPlay;
  }

  /** Returns the latest validated pause capability. */
  get CanPause(): boolean {
    return this._capabilities.canPause;
  }

  /** Allows seeking unless the renderer explicitly disables it. */
  get CanSeek(): boolean {
    return this._capabilities.canSeek !== false;
  }

  /** Advertises support for player control. */
  get CanControl(): boolean {
    return true;
  }

  // --- Read/write properties ---

  /** Reports normal playback speed. */
  get Rate(): number {
    return 1.0;
  }

  /** Treats zero as pause and ignores other rate changes. */
  set Rate(value: number) {
    if (value === 0) this._send('Rate', 'player:pause');
  }

  /** Returns the cached MPRIS repeat mode. */
  get LoopStatus(): string {
    return this._loopStatus;
  }

  /** Maps a valid MPRIS repeat mode to MusicKit. */
  set LoopStatus(value: string) {
    const loopToMusicKit: Record<string, number> = {
      'None': 0,
      'Track': 1,
      'Playlist': 2,
    };
    const mode = loopToMusicKit[value];
    if (mode === undefined) {
      mprisLog.warn('invalid LoopStatus value');
      return;
    }
    this._loopStatus = value;
    this._send('LoopStatus', 'player:setRepeat', mode);
  }

  /** Returns the cached shuffle setting. */
  get Shuffle(): boolean {
    return this._shuffle;
  }

  /** Sends the shuffle setting to MusicKit. */
  set Shuffle(value: boolean) {
    this._shuffle = value;
    const mode = value ? 1 : 0;
    this._send('Shuffle', 'player:setShuffle', mode);
  }

  /** Returns cached software volume rounded to two decimal places. */
  get Volume(): number {
    return Math.round(this._volume * 100) / 100;
  }

  /** Clamps software volume and records pending echoes before sending it. */
  set Volume(value: number) {
    const clamped = Math.round(Math.max(0.0, Math.min(1.0, value)) * 100) / 100;
    this._volume = clamped;
    this._schedulePropertyEmission({ Volume: clamped });
    // Preserve old entries when full because echoes arrive in order. Dropping
    // the oldest makes its echo look like an in-app change and restores stale volume.
    // An untracked newest echo instead reports the level that the player reached.
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
    this._send('Volume', 'player:setVolume', clamped);
  }

  // --- Methods ---

  /** Requests the next queue item. */
  Next(): void {
    this._send('Next', 'player:next');
  }

  /** Requests the previous queue item. */
  Previous(): void {
    this._send('Previous', 'player:previous');
  }

  /** Requests a playback pause. */
  Pause(): void {
    this._send('Pause', 'player:pause');
  }

  /** Requests a play/pause toggle. */
  PlayPause(): void {
    this._send('PlayPause', 'player:playPause');
  }

  /** Requests Stop once and waits for acknowledgement with a bounded timeout. */
  Stop(): void {
    if (this._stopped || this._pendingStopId !== null) return;
    this._pendingStopId = ++this._stopRequestId;
    this._stopTimer = setTimeout(() => {
      this._clearPendingStop();
      mprisLog.warn('Stop completion timed out');
    }, 6000);
    if (!this._send('Stop', 'player:stop', this._pendingStopId)) this._clearPendingStop();
  }

  private _clearPendingStop(): void {
    this._pendingStopId = null;
    if (this._stopTimer) clearTimeout(this._stopTimer);
    this._stopTimer = null;
  }

  /** Publishes Stopped only after the matching successful acknowledgement. */
  updateStopped(payload: PlaybackStopped): void {
    if (payload.requestId !== this._pendingStopId) return;
    this._clearPendingStop();
    if (!payload.success) return;
    this._stopped = true;
    this._playbackStatus = 'Stopped';
    this._schedulePropertyEmission({ PlaybackStatus: 'Stopped' });
  }

  /** Requests playback start or resume. */
  Play(): void {
    this._send('Play', 'player:play');
  }

  /** Seeks by a microsecond offset, advancing tracks when the target exceeds known duration. */
  Seek(offset: bigint): void {
    if (!this.CanSeek || !Number.isSafeInteger(this._position)) return;
    const targetUs = BigInt(this._position) + offset;
    const lengthUs = this._trackLengthUs;
    if (lengthUs !== undefined && targetUs > BigInt(lengthUs)) {
      this._send('Seek', 'player:next');
      return;
    }
    if (targetUs > BigInt(Number.MAX_SAFE_INTEGER)) return;
    this._send('Seek', 'player:seek', Number(targetUs < 0n ? 0n : targetUs) / 1_000_000);
  }

  /** Seeks to valid microseconds only when the supplied track ID matches. */
  SetPosition(trackId: string, position: bigint): void {
    if (trackId === NO_TRACK || trackId !== this._currentTrackId) {
      mprisLog.debug('SetPosition trackId mismatch, ignoring');
      return;
    }
    const lengthUs = this._trackLengthUs;
    if (!this.CanSeek || position < 0n || position > BigInt(Number.MAX_SAFE_INTEGER)
      || (lengthUs !== undefined && position > BigInt(lengthUs))) return;
    const targetSeconds = Number(position) / 1_000_000;
    this._send('SetPosition', 'player:seek', targetSeconds);
  }

  private get _trackLengthUs(): number | undefined {
    const length: unknown = this._capabilities.durationUs ?? this._itemLengthUs;
    return typeof length === 'number' && Number.isSafeInteger(length) && length >= 0 ? length : undefined;
  }

  /** Opens a validated service URL, navigating first when its hook is not ready. */
  OpenUri(uri: string): void {
    const parsed = parseServiceUri(uri);
    if (!parsed) {
      mprisLog.warn('OpenUri rejected');
      return;
    }
    const win = this._getMainWindow();
    if (!win || win.isDestroyed()) {
      logCommand('OpenUri', 'dropped');
      return;
    }
    this._clearOpenUri();
    const service = getServiceByHost(parsed.hostname)!;
    if (!this._navigating && this._readyUrl && getMusicService() === service.id &&
      parseServiceUri(this._readyUrl)?.origin === parsed.origin && parseServiceUri(win.webContents.getURL())?.origin === parsed.origin) {
      this._send('OpenUri', 'player:openUri', parsed.href);
      return;
    }
    this._readyUrl = null;
    this._pendingOpenUri = { url: parsed.href, navigationUrl: parsed.href };
    this._navigating = true;
    this._openUriTimer = setTimeout(() => {
      this._clearOpenUri();
      mprisLog.warn('OpenUri hook readiness timed out');
    }, 10_000);
    switchService(service.id, parsed.href);
    logCommand('OpenUri', 'sent');
  }

  private _clearOpenUri(): void {
    this._pendingOpenUri = null;
    if (this._openUriTimer) clearTimeout(this._openUriTimer);
    this._openUriTimer = null;
  }

  /** Dispatches a pending URL only after its navigation target reports hook readiness. */
  updateHookReady(url: string | null): void {
    this._readyUrl = this._navigating ? null : url;
    const pending = this._pendingOpenUri;
    if (!pending || this._readyUrl !== pending.navigationUrl) return;
    this._clearOpenUri();
    this._send('OpenUri', 'player:openUri', pending.url);
  }

  /** Invalidates replaced-document readiness and cancels unrelated pending URL requests. */
  navigationStarted(url: string, sameDocument: boolean): void {
    if (!sameDocument) {
      this._readyUrl = null;
      this._navigating = true;
    }
    if (this._pendingOpenUri && parseServiceUri(url)?.href !== this._pendingOpenUri.navigationUrl) this._clearOpenUri();
  }

  /** Tracks same-service redirects and cancels pending requests that leave the service. */
  navigationRedirected(url: string): void {
    const pending = this._pendingOpenUri;
    if (!pending) return;
    const redirected = parseServiceUri(url);
    if (redirected?.origin === parseServiceUri(pending.url)?.origin) pending.navigationUrl = redirected!.href;
    else this._clearOpenUri();
  }

  /** Marks document navigation complete so hook readiness can be accepted. */
  navigationCommitted(): void {
    this._navigating = false;
  }

  /** Emits the D-Bus Seeked signal through configureMembers, with a position in microseconds. */
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
      access: ACCESS_READWRITE,
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
  const playerIface = new MediaPlayer2Player(getMainWindow, player.capabilitiesSnapshot(), player.hookReadyUrl());
  const navigationWindow = getMainWindow();
  const onNavigationStarted = (details: { isMainFrame: boolean; isSameDocument: boolean; url: string }): void => {
    if (details.isMainFrame) playerIface.navigationStarted(details.url, details.isSameDocument);
  };
  const onNavigationRedirected = (details: { isMainFrame: boolean; url: string }): void => {
    if (details.isMainFrame) playerIface.navigationRedirected(details.url);
  };
  const onNavigationCommitted = (): void => { playerIface.navigationCommitted(); };
  let fullscreenWindow: BrowserWindow | null = null;
  const onFullscreenChanged = (): void => {
    if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
      try {
        Interface.emitPropertiesChanged(rootIface, { Fullscreen: rootIface.Fullscreen });
      } catch (err: unknown) {
        mprisLog.warn('failed to emit fullscreen PropertiesChanged:', errorMessage(err));
      }
    }
  };

  // Named wrappers let will-quit detach the same function references.
  const onPlaybackStateDidChange = (payload: PlaybackStatePayload): void => {
    playerIface.updatePlaybackStatus(payload);
  };
  const onHookReady = (url: string | null): void => { playerIface.updateHookReady(url); };
  const onPlaybackCapabilitiesDidChange = (payload: PlaybackCapabilities): void => {
    playerIface.updateCapabilities(payload);
  };
  const onPlaybackStopped = (payload: PlaybackStopped): void => {
    playerIface.updateStopped(payload);
  };
  const onNowPlayingItemDidChange = (payload: NowPlayingPayload | null): void => {
    playerIface.updateNowPlaying(payload);
  };
  const onTimedMetadataDidChange = (payload: TimedMetadataPayload): void => {
    playerIface.updateTimedMetadata(payload);
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
    navigationWindow?.webContents.removeListener('did-start-navigation', onNavigationStarted);
    navigationWindow?.webContents.removeListener('will-redirect', onNavigationRedirected);
    navigationWindow?.webContents.removeListener('did-navigate', onNavigationCommitted);
    player.removeListener('hookReady', onHookReady);
    fullscreenWindow?.removeListener('enter-full-screen', onFullscreenChanged);
    fullscreenWindow?.removeListener('leave-full-screen', onFullscreenChanged);
    player.removeListener('playbackStateDidChange', onPlaybackStateDidChange);
    player.removeListener('playbackCapabilitiesDidChange', onPlaybackCapabilitiesDidChange);
    player.removeListener('playbackStopped', onPlaybackStopped);
    player.removeListener('nowPlayingItemDidChange', onNowPlayingItemDidChange);
    player.removeListener('timedMetadataDidChange', onTimedMetadataDidChange);
    player.removeListener('repeatModeDidChange', onRepeatModeDidChange);
    player.removeListener('shuffleModeDidChange', onShuffleModeDidChange);
    player.removeListener('volumeDidChange', onVolumeDidChange);
    player.removeListener('playbackTimeDidChange', onPlaybackTimeDidChange);
    playerIface.cleanup();
    disconnectBus();
  });

  mprisLog.info('enabling MPRIS service');

  // Without DBUS_SESSION_BUS_ADDRESS, dbus-next can throw while reading the bus
  // address from disk. Disable MPRIS without exports, subscriptions or retries
  // when no session bus exists, as in containers or su-launched sessions.
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
  navigationWindow?.webContents.on('did-start-navigation', onNavigationStarted);
  navigationWindow?.webContents.on('will-redirect', onNavigationRedirected);
  navigationWindow?.webContents.on('did-navigate', onNavigationCommitted);

  fullscreenWindow = getMainWindow();
  if (fullscreenWindow && !fullscreenWindow.isDestroyed()) {
    fullscreenWindow.on('enter-full-screen', onFullscreenChanged);
    fullscreenWindow.on('leave-full-screen', onFullscreenChanged);
  }

  const busName = `org.mpris.MediaPlayer2.${app.getName().toLowerCase()}`;
  bus.requestName(busName, 0).then(() => {
    mprisLog.info('bus name acquired:', busName);
  }).catch((err: Error) => {
    mprisLog.error('failed to acquire bus name:', busName, err.message);
  });

  // Subscribed after the bus, so the return on a missing bus leaves no
  // listener attached to update an interface no client can reach.
  player.on('playbackStateDidChange', onPlaybackStateDidChange);
  player.on('hookReady', onHookReady);
  player.on('playbackCapabilitiesDidChange', onPlaybackCapabilitiesDidChange);
  player.on('playbackStopped', onPlaybackStopped);
  player.on('nowPlayingItemDidChange', onNowPlayingItemDidChange);
  player.on('timedMetadataDidChange', onTimedMetadataDidChange);
  player.on('repeatModeDidChange', onRepeatModeDidChange);
  player.on('shuffleModeDidChange', onShuffleModeDidChange);
  player.on('volumeDidChange', onVolumeDidChange);
  player.on('playbackTimeDidChange', onPlaybackTimeDidChange);
}
