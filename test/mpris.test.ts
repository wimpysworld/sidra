import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import log from 'electron-log/main';

import { setMusicService } from '../src/config';
import { PlaybackState } from '../src/player';
import type { IntegrationContext, NowPlayingPayload } from '../src/player';
import * as mpris from '../src/integrations/mpris';
import { FakePlayer } from './mocks/player';

// updateNowPlaying() hands every https:// artwork URL to downloadArtwork(),
// which fetches over the network and writes to the cache directory. Resolving
// null leaves mpris:artUrl at the value buildMetadata() produced, so the
// metadata assertions read what the builder wrote and nothing else.
vi.mock('../src/artwork', () => ({
  downloadArtwork: vi.fn(() => Promise.resolve(null)),
}));

interface DbusBus {
  on: (event: string, listener: (err: Error) => void) => void;
  export: (path: string, iface: object) => void;
  requestName: (name: string, flags: number) => Promise<unknown>;
}

/** A dbus-next Variant, as buildMetadata() constructs them. */
interface VariantValue {
  signature: string;
  value: unknown;
}

interface DbusInterfaceClass {
  emitPropertiesChanged(iface: object, changed: Record<string, unknown>, invalidated?: string[]): void;
}

interface DbusModule {
  sessionBus: () => DbusBus;
  interface: { Interface: DbusInterfaceClass };
}

// src/integrations/mpris/index.ts pulls @holusion/dbus-next in with a bare
// require, which vi.mock does not intercept. The module loads fine off a bus -
// only sessionBus() opens a socket - so the real one is loaded and that single
// entry point is stubbed.
const dbus = require('@holusion/dbus-next') as DbusModule;

// Captured before any spy is installed, so the wrapper below calls the real
// static rather than itself. The real one is worth keeping in the path: it
// throws on a property that configureMembers() never declared, which turns a
// misspelled emission into a failure instead of a silent no-op.
const realEmitPropertiesChanged = dbus.interface.Interface.emitPropertiesChanged;

const busStub = {
  on: vi.fn(),
  export: vi.fn<(path: string, iface: object) => void>(),
  requestName: vi.fn(() => Promise.resolve()),
};

interface WindowStub {
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn>;
  webContents: { send: ReturnType<typeof vi.fn> };
}

interface PlayerInterface {
  OpenUri(uri: string): void;
  Next(): void;
  Previous(): void;
  Pause(): void;
  PlayPause(): void;
  Stop(): void;
  Play(): void;
  Seek(offset: bigint): void;
  SetPosition(trackId: string, position: bigint): void;
  Seeked(position: number): number;
  Volume: number;
  readonly PlaybackStatus: string;
  LoopStatus: string;
  Shuffle: boolean;
  readonly Metadata: Record<string, VariantValue>;
  readonly Position: number;
  readonly CanGoNext: boolean;
  readonly CanGoPrevious: boolean;
  readonly CanPlay: boolean;
  readonly CanPause: boolean;
  readonly CanSeek: boolean;
  readonly CanControl: boolean;
}

interface RootInterface {
  Raise(): void;
  Quit(): void;
  readonly SupportedUriSchemes: string[];
}

/**
 * PropertiesChanged payloads that carried a Position key, never cleared.
 *
 * Position moves on its own, so a PropertiesChanged carrying it would be
 * either a lie or a flood. The MPRIS spec forbids it outright: clients poll
 * the property or follow the Seeked signal. The check lives on the shared spy
 * so it covers every emission the file produces and belongs to no single test.
 * A debounced emission whose timer fires after its own test still fails the
 * next afterEach, which is why this array is never cleared.
 */
const positionBreaches: Array<Record<string, unknown>> = [];

/** The PropertiesChanged payloads of the current test, cleared in beforeEach. */
let emissions: Array<Record<string, unknown>> = [];

let win: WindowStub;
let player: FakePlayer;

/**
 * init() exports the root interface first and the player interface second, so
 * the live MediaPlayer2Player instance is the second argument of the second
 * export. Driving the real methods and properties this way needs no production
 * change.
 */
function initInterfaces(getMainWindow: () => BrowserWindow | null = () => win as unknown as BrowserWindow): {
  root: RootInterface;
  player: PlayerInterface;
} {
  const ctx: IntegrationContext = {
    player,
    getMainWindow,
  };
  mpris.init(ctx);
  expect(busStub.export).toHaveBeenCalledTimes(2);
  return {
    root: busStub.export.mock.calls[0][1] as RootInterface,
    player: busStub.export.mock.calls[1][1] as PlayerInterface,
  };
}

function initPlayerInterface(): PlayerInterface {
  return initInterfaces().player;
}

function mprisLogText(): string {
  const scopedLog = log.scope('mpris');
  return [scopedLog.info, scopedLog.warn, scopedLog.error, scopedLog.debug]
    .flatMap((method) => vi.mocked(method).mock.calls)
    .flat()
    .join(' ');
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(log.scope('mpris'), {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  });
  vi.spyOn(dbus, 'sessionBus').mockReturnValue(busStub);
  vi.spyOn(dbus.interface.Interface, 'emitPropertiesChanged').mockImplementation((iface, changed, invalidated) => {
    emissions.push(changed);
    // Recorded rather than asserted here: production wraps the emission in a
    // try/catch, which would swallow a thrown assertion and log a warning
    // while the test still passed. afterEach reads this.
    if ('Position' in changed) {
      positionBreaches.push(changed);
    }
    realEmitPropertiesChanged(iface, changed, invalidated);
  });
  emissions = [];
  setMusicService('music');
  // loadURL must return a promise: production attaches a .catch() to it.
  win = {
    show: vi.fn(),
    focus: vi.fn(),
    loadURL: vi.fn(() => Promise.resolve()),
    webContents: { send: vi.fn() },
  };
  player = new FakePlayer();
});

// The volume and position blocks install fake timers. Leaving them installed
// would break every later test that awaits a promise, so they come off here
// whether a test installed them or not.
afterEach(() => {
  // Timers come off first: an assertion that throws would skip the rest of
  // this hook and leave fake timers installed for every later test.
  vi.useRealTimers();
  expect(positionBreaches).toEqual([]);
});

const COMMAND_CASES: ReadonlyArray<{
  method: string;
  channel: string;
  args: unknown[];
  invoke: (iface: PlayerInterface) => void;
}> = [
  {
    method: 'LoopStatus',
    channel: 'player:setRepeat',
    args: [1],
    invoke: (iface) => { iface.LoopStatus = 'Track'; },
  },
  {
    method: 'Shuffle',
    channel: 'player:setShuffle',
    args: [1],
    invoke: (iface) => { iface.Shuffle = true; },
  },
  {
    method: 'Volume',
    channel: 'player:setVolume',
    args: [0.42],
    invoke: (iface) => { iface.Volume = 0.42; },
  },
  { method: 'Next', channel: 'player:next', args: [], invoke: (iface) => iface.Next() },
  { method: 'Previous', channel: 'player:previous', args: [], invoke: (iface) => iface.Previous() },
  { method: 'Pause', channel: 'player:pause', args: [], invoke: (iface) => iface.Pause() },
  { method: 'PlayPause', channel: 'player:playPause', args: [], invoke: (iface) => iface.PlayPause() },
  { method: 'Stop', channel: 'player:pause', args: [], invoke: (iface) => iface.Stop() },
  { method: 'Play', channel: 'player:play', args: [], invoke: (iface) => iface.Play() },
  { method: 'Seek', channel: 'player:seek', args: [2.5], invoke: (iface) => iface.Seek(2_500_000n) },
  {
    method: 'SetPosition',
    channel: 'player:seek',
    args: [7.25],
    invoke: (iface) => {
      player.emitNowPlaying({ trackId: 'track-1' });
      iface.SetPosition('/org/sidra/track/track_1', 7_250_000n);
    },
  },
];

describe('MPRIS command provenance', () => {
  it.each(COMMAND_CASES)('maps $method to $channel with its exact arguments', ({ method, channel, args, invoke }) => {
    vi.useFakeTimers();
    const iface = initPlayerInterface();

    invoke(iface);

    expect(win.webContents.send).toHaveBeenCalledOnce();
    expect(win.webContents.send).toHaveBeenCalledWith(channel, ...args);
    const commandLog = method === 'Volume' ? log.scope('mpris').debug : log.scope('mpris').info;
    expect(commandLog).toHaveBeenCalledWith(
      `source=mpris method=${method} channel=${channel} result=sent`,
    );
  });

  it.each(COMMAND_CASES)('logs $method as dropped when no window exists', ({ method, channel, invoke }) => {
    vi.useFakeTimers();
    const iface = initInterfaces(() => null).player;

    invoke(iface);

    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(log.scope('mpris').info).toHaveBeenCalledWith(
      `source=mpris method=${method} channel=${channel} result=dropped`,
    );
  });

  it('logs method-only provenance for Raise and Quit', () => {
    const { root } = initInterfaces();

    root.Raise();
    root.Quit();

    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
    expect(log.scope('mpris').info).toHaveBeenCalledWith('source=mpris method=Raise result=sent');
    expect(log.scope('mpris').info).toHaveBeenCalledWith('source=mpris method=Quit result=sent');
  });

  it('logs Raise as dropped when no window exists', () => {
    const { root } = initInterfaces(() => null);

    root.Raise();

    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    expect(log.scope('mpris').info).toHaveBeenCalledWith('source=mpris method=Raise result=dropped');
  });

  it('logs a sent Volume burst at debug without per-value info records', () => {
    vi.useFakeTimers();
    const iface = initPlayerInterface();

    iface.Volume = 0.2;
    iface.Volume = 0.4;
    iface.Volume = 0.6;

    const provenance = 'source=mpris method=Volume channel=player:setVolume result=sent';
    expect(win.webContents.send.mock.calls).toEqual([
      ['player:setVolume', 0.2],
      ['player:setVolume', 0.4],
      ['player:setVolume', 0.6],
    ]);
    expect(log.scope('mpris').debug).toHaveBeenCalledTimes(3);
    expect(log.scope('mpris').debug).toHaveBeenCalledWith(provenance);
    expect(log.scope('mpris').info).not.toHaveBeenCalledWith(provenance);
  });

  it('does not log accepted or rejected SetPosition request data', () => {
    const iface = initPlayerInterface();
    const acceptedTrackId = 'private-track-accepted';
    const rejectedTrackId = 'private-track-rejected';
    player.emitNowPlaying({ trackId: acceptedTrackId });

    iface.SetPosition('/org/sidra/track/private_track_accepted', 12_345_678n);

    expect(win.webContents.send).toHaveBeenCalledWith('player:seek', 12.345678);
    expect(mprisLogText()).toContain('source=mpris method=SetPosition channel=player:seek result=sent');
    expect(mprisLogText()).not.toContain(acceptedTrackId);
    expect(mprisLogText()).not.toContain('12345678');

    vi.mocked(log.scope('mpris').info).mockClear();
    win.webContents.send.mockClear();
    iface.SetPosition(rejectedTrackId, 98_765_432n);

    expect(win.webContents.send).not.toHaveBeenCalled();
    expect(mprisLogText()).toContain('SetPosition trackId mismatch, ignoring');
    expect(mprisLogText()).not.toContain('method=SetPosition');
    expect(mprisLogText()).not.toContain(rejectedTrackId);
    expect(mprisLogText()).not.toContain('98765432');
  });
});

describe('MPRIS OpenUri', () => {
  it('advertises HTTPS URI support', () => {
    initPlayerInterface();
    const rootIface = busStub.export.mock.calls[0][1] as { SupportedUriSchemes: string[] };
    expect(rootIface.SupportedUriSchemes).toEqual(['https']);
  });

  it('loads a music.apple.com URI', () => {
    initPlayerInterface().OpenUri('https://music.apple.com/gb/album/foo');
    expect(win.loadURL).toHaveBeenCalledWith('https://music.apple.com/gb/album/foo');
    expect(log.scope('mpris').info).toHaveBeenCalledWith('source=mpris method=OpenUri result=sent');
  });

  it('loads a classical.music.apple.com URI', () => {
    initPlayerInterface().OpenUri('https://classical.music.apple.com/gb/album/foo');
    expect(win.loadURL).toHaveBeenCalledWith('https://classical.music.apple.com/gb/album/foo');
  });

  // Every registered host is accepted whatever the active service is. A check
  // against the active service's host instead would drop every music.apple.com
  // URI an MPRIS client sends while Classical is selected.
  it('loads a music.apple.com URI while Classical is the active service', () => {
    setMusicService('classical');
    initPlayerInterface().OpenUri('https://music.apple.com/gb/album/foo');
    expect(win.loadURL).toHaveBeenCalledWith('https://music.apple.com/gb/album/foo');
  });

  it('rejects an unregistered host', () => {
    initPlayerInterface().OpenUri('https://example.com/gb/album/foo');
    expect(win.loadURL).not.toHaveBeenCalled();
  });

  it('rejects a non-https URI', () => {
    initPlayerInterface().OpenUri('http://music.apple.com/gb/album/foo');
    expect(win.loadURL).not.toHaveBeenCalled();
  });

  it('rejects a malformed URI without throwing', () => {
    const playerIface = initPlayerInterface();
    expect(() => playerIface.OpenUri('not a url')).not.toThrow();
    expect(win.loadURL).not.toHaveBeenCalled();
  });

  it('does not log accepted or rejected URI request data', () => {
    const iface = initPlayerInterface();
    const acceptedUri = 'https://music.apple.com/gb/album/private?token=accepted-secret';
    const rejectedUri = 'https://example.com/private?token=rejected-secret';

    iface.OpenUri(acceptedUri);

    expect(win.loadURL).toHaveBeenCalledWith(acceptedUri);
    expect(mprisLogText()).toContain('source=mpris method=OpenUri result=sent');
    expect(mprisLogText()).not.toContain(acceptedUri);
    expect(mprisLogText()).not.toContain('accepted-secret');

    vi.mocked(log.scope('mpris').info).mockClear();
    win.loadURL.mockClear();
    iface.OpenUri(rejectedUri);

    expect(win.loadURL).not.toHaveBeenCalled();
    expect(mprisLogText()).toContain('OpenUri rejected');
    expect(mprisLogText()).not.toContain('method=OpenUri');
    expect(mprisLogText()).not.toContain(rejectedUri);
    expect(mprisLogText()).not.toContain('rejected-secret');
  });

  it('logs an accepted URI as dropped when no window exists', () => {
    initInterfaces(() => null).player.OpenUri('https://music.apple.com/gb/album/foo');

    expect(win.loadURL).not.toHaveBeenCalled();
    expect(log.scope('mpris').info).toHaveBeenCalledWith('source=mpris method=OpenUri result=dropped');
  });
});

// MPRIS has three PlaybackStatus values and MusicKit has ten states, so the
// mapping is lossy by design. Stopped (4) is the row that matters: mapping it
// to 'Paused' leaves a client showing a pause button for a player that has
// stopped. AGENTS.md also forbids an early-return guard for the transient
// states, so those are pinned here rather than left to read as an accident.
describe('MPRIS PlaybackStatus mapping', () => {
  const STATUS_TABLE: ReadonlyArray<readonly [number, string]> = [
    [PlaybackState.None, 'Stopped'],
    [PlaybackState.Loading, 'Stopped'],
    [PlaybackState.Playing, 'Playing'],
    [PlaybackState.Paused, 'Paused'],
    [PlaybackState.Stopped, 'Stopped'],
    [PlaybackState.Ended, 'Stopped'],
    [PlaybackState.Seeking, 'Stopped'],
    [PlaybackState.Waiting, 'Stopped'],
    [PlaybackState.Stalled, 'Stopped'],
    [PlaybackState.Completed, 'Stopped'],
  ];

  it.each(STATUS_TABLE)('maps MusicKit state %i to %s', (state, expected) => {
    const iface = initPlayerInterface();
    player.emitPlaybackState(state);
    expect(iface.PlaybackStatus).toBe(expected);
  });

  // A state added to src/player.ts must be given a row above, otherwise it
  // falls through to 'Stopped' with nobody having decided that it should.
  it('covers every declared PlaybackState', () => {
    expect(STATUS_TABLE.map(([state]) => state).sort()).toEqual(Object.values(PlaybackState).sort());
  });

  // Called out because AGENTS.md names these four: they are momentary, and a
  // guard that suppressed them would leave MPRIS reporting a state the player
  // has already left.
  it('reports the transient states as Stopped', () => {
    const iface = initPlayerInterface();
    for (const state of [PlaybackState.Loading, PlaybackState.Seeking, PlaybackState.Waiting, PlaybackState.Stalled]) {
      player.emitPlaybackState(state);
      expect(iface.PlaybackStatus).toBe('Stopped');
    }
  });
});

describe('MPRIS metadata', () => {
  const FULL_TRACK: NowPlayingPayload = {
    trackId: '1440857781',
    name: 'Blue Monday',
    artistName: 'New Order',
    albumName: 'Power, Corruption & Lies',
    artworkUrl: 'https://example.com/artwork.jpg',
    url: 'https://music.apple.com/gb/album/blue-monday/1440857781',
    genreNames: ['Alternative', 'Dance'],
    trackNumber: 3,
    discNumber: 1,
    composerName: 'Bernard Sumner',
    releaseDate: '1983-03-07',
    durationInMillis: 449_000,
  };

  /** Flattens the Variant map so one assertion covers keys, signatures and values. */
  function flatten(metadata: Record<string, VariantValue>): Record<string, [string, unknown]> {
    return Object.fromEntries(Object.entries(metadata).map(([key, variant]) => [key, [variant.signature, variant.value]]));
  }

  // The signature travels with the value on D-Bus, so a wrong one is not a
  // cosmetic fault: a client reading xesam:artist expects an array of strings
  // and mpris:length an int64. The exact key set is asserted too, because an
  // extra key with a made-up name is as wrong as a missing one.
  it('builds every field of a full payload with the right signatures', () => {
    const iface = initPlayerInterface();
    player.emitNowPlaying(FULL_TRACK);

    expect(flatten(iface.Metadata)).toEqual({
      'mpris:trackid': ['o', '/org/sidra/track/1440857781'],
      'mpris:length': ['x', 449_000_000],
      'xesam:title': ['s', 'Blue Monday'],
      'xesam:artist': ['as', ['New Order']],
      'xesam:album': ['s', 'Power, Corruption & Lies'],
      'mpris:artUrl': ['s', 'https://example.com/artwork.jpg'],
      'xesam:url': ['s', 'https://music.apple.com/gb/album/blue-monday/1440857781'],
      'xesam:genre': ['as', ['Alternative', 'Dance']],
      'xesam:trackNumber': ['i', 3],
      'xesam:discNumber': ['i', 1],
      'xesam:composer': ['as', ['Bernard Sumner']],
      'xesam:contentCreated': ['s', '1983-03-07'],
    });
  });

  // mpris:length is an 'x' field, and the marshaller turns one into a BigInt.
  // A fractional duration would therefore throw at send time, taking out the
  // whole Metadata emission rather than one key.
  it('truncates mpris:length so the int64 marshaller accepts it', () => {
    const iface = initPlayerInterface();
    player.emitNowPlaying({ ...FULL_TRACK, durationInMillis: 449_000.7 });

    const length = iface.Metadata['mpris:length'].value;
    expect(Number.isInteger(length)).toBe(true);
    expect(() => BigInt(String(length))).not.toThrow();
  });

  // MusicKit omits fields rather than sending null, and a key present with an
  // empty value reads to a client as an empty title or a nameless artist.
  it('omits a key for every absent optional field', () => {
    const iface = initPlayerInterface();
    player.emitNowPlaying({ trackId: '1440857781', name: 'Blue Monday' });

    expect(flatten(iface.Metadata)).toEqual({
      'mpris:trackid': ['o', '/org/sidra/track/1440857781'],
      'xesam:title': ['s', 'Blue Monday'],
    });
  });

  it('clears stale playback data when the document is replaced', () => {
    vi.useFakeTimers();
    const iface = initPlayerInterface();
    const seeked = vi.spyOn(iface, 'Seeked');

    player.emitPlaybackState(PlaybackState.Playing);
    player.emitNowPlaying(FULL_TRACK);
    player.setPositionUs(42_000_000);
    player.emit('repeatModeDidChange', 2);
    player.emit('shuffleModeDidChange', 1);
    vi.advanceTimersByTime(250);

    const persistentProperties = {
      LoopStatus: iface.LoopStatus,
      Shuffle: iface.Shuffle,
      CanGoNext: iface.CanGoNext,
      CanGoPrevious: iface.CanGoPrevious,
      CanPlay: iface.CanPlay,
      CanPause: iface.CanPause,
      CanSeek: iface.CanSeek,
      CanControl: iface.CanControl,
    };
    emissions = [];
    seeked.mockClear();

    player.resetForDocumentReplacement();
    vi.advanceTimersByTime(250);

    expect(iface.PlaybackStatus).toBe('Stopped');
    expect(iface.Position).toBe(0);
    expect(flatten(iface.Metadata)).toEqual({
      'mpris:trackid': ['o', '/org/mpris/MediaPlayer2/TrackList/NoTrack'],
    });
    expect(seeked).toHaveBeenCalledOnce();
    expect(seeked).toHaveBeenCalledWith(0);
    expect(emissions).toHaveLength(1);
    expect(emissions[0]).toMatchObject({
      PlaybackStatus: 'Stopped',
      Metadata: iface.Metadata,
    });
    expect(emissions.every((properties) => !('Position' in properties))).toBe(true);
    expect({
      LoopStatus: iface.LoopStatus,
      Shuffle: iface.Shuffle,
      CanGoNext: iface.CanGoNext,
      CanGoPrevious: iface.CanGoPrevious,
      CanPlay: iface.CanPlay,
      CanPause: iface.CanPause,
      CanSeek: iface.CanSeek,
      CanControl: iface.CanControl,
    }).toEqual(persistentProperties);
  });
});

// MusicKit never populates attributes.url on a library item, so a payload that
// carries one is the catalogue case and without a fallback every library track
// reaches MPRIS with no xesam:url at all. getShareUrl() rebuilds it from the
// playParams ids.
describe('MPRIS xesam:url fallback', () => {
  it('rebuilds the song URL from catalogId when the payload carries no url', () => {
    const iface = initPlayerInterface();
    player.emitNowPlaying({ trackId: '999', playParams: { catalogId: '999', isLibrary: true, kind: 'song' } });

    expect(iface.Metadata['xesam:url'].value).toBe('https://music.apple.com/song/999');
  });

  it('rebuilds the song URL from globalId when catalogId is absent too', () => {
    const iface = initPlayerInterface();
    player.emitNowPlaying({ trackId: 'abc', playParams: { globalId: 'abc', kind: 'song' } });

    expect(iface.Metadata['xesam:url'].value).toBe('https://music.apple.com/song/abc');
  });

  // A radio station has no track to link to, and Classical sends no ids
  // either. Both must leave the key out rather than name a URL that 404s, and
  // neither needs a kind guard to get there.
  it('omits xesam:url when playParams carries neither id', () => {
    const iface = initPlayerInterface();
    player.emitNowPlaying({ trackId: 'ra.123', playParams: { kind: 'radioStation' } });
    expect(iface.Metadata['xesam:url']).toBeUndefined();

    player.emitNowPlaying({ trackId: '1440857781' });
    expect(iface.Metadata['xesam:url']).toBeUndefined();
  });
});

describe('MPRIS volume', () => {
  beforeEach(() => {
    // 250 ms property debounce, 2000 ms volume safety timeout.
    vi.useFakeTimers();
  });

  // A setter that caches the new value and tells the renderer without emitting
  // leaves only the client that made the change knowing about it, so a second
  // MPRIS client shows the old level until something else moves the volume.
  it('emits PropertiesChanged for a volume set over the interface', () => {
    const iface = initPlayerInterface();
    iface.Volume = 0.4;

    expect(win.webContents.send).toHaveBeenCalledWith('player:setVolume', 0.4);
    vi.advanceTimersByTime(250);
    expect(emissions).toEqual([{ Volume: 0.4 }]);

    // The renderer echoes the value straight back. Emitting again would tell
    // every client what it already knows, and the echo is the near half of a
    // feedback loop.
    player.emit('volumeDidChange', 0.4);
    vi.advanceTimersByTime(250);
    expect(emissions).toEqual([{ Volume: 0.4 }]);
  });

  // A drag sets several values inside one echo round trip. With a single
  // pending slot holding only the newest, the 0.5 and 0.6 echoes each read as
  // an in-app change and overwrite the cached volume, leaving the reported
  // level one echo behind the real one.
  it('reports the final value of a burst of sets', () => {
    const iface = initPlayerInterface();
    iface.Volume = 0.5;
    iface.Volume = 0.6;
    iface.Volume = 0.7;

    player.emit('volumeDidChange', 0.5);
    player.emit('volumeDidChange', 0.6);
    player.emit('volumeDidChange', 0.7);

    vi.advanceTimersByTime(250);
    expect(iface.Volume).toBe(0.7);
    expect(emissions).toEqual([{ Volume: 0.7 }]);
  });

  // A long drag can put more sets in flight than the queue holds. Evicting the
  // oldest entry to make room makes its echo read as an in-app change, and the
  // later matched echoes never put the cached value back, so the volume sticks
  // at a value the drag left behind. A full queue therefore drops the value
  // being added instead.
  it('reports the final value of a burst longer than the pending queue', () => {
    const iface = initPlayerInterface();
    const values = Array.from({ length: 12 }, (_, index) => (index + 1) * 0.05);

    for (const value of values) {
      iface.Volume = value;
    }
    for (const value of values) {
      player.emit('volumeDidChange', value);
    }

    vi.advanceTimersByTime(250);
    expect(iface.Volume).toBe(0.6);
    expect(emissions).toEqual([{ Volume: 0.6 }]);
  });

  // Suppression is what stops the feedback loop, so it must stay narrow. A
  // change made in the Apple Music player bar reaches here through the same
  // event as an echo and has to survive the widened match.
  it('emits a volume change that matches no pending set', () => {
    const iface = initPlayerInterface();
    iface.Volume = 0.5;
    player.emit('volumeDidChange', 0.5);
    vi.advanceTimersByTime(250);
    expect(emissions).toEqual([{ Volume: 0.5 }]);

    player.emit('volumeDidChange', 0.2);
    vi.advanceTimersByTime(250);
    expect(emissions).toEqual([{ Volume: 0.5 }, { Volume: 0.2 }]);
    expect(iface.Volume).toBe(0.2);
  });

  // An echo that never arrives would suppress the next in-app change for the
  // life of the process. The safety timeout drops the whole queue, and the
  // queue must not have cost that self-healing.
  it('stops suppressing once the safety timeout expires', () => {
    const iface = initPlayerInterface();
    iface.Volume = 0.5;
    vi.advanceTimersByTime(2000);
    expect(emissions).toEqual([{ Volume: 0.5 }]);

    player.emit('volumeDidChange', 0.5);
    vi.advanceTimersByTime(250);
    expect(emissions).toEqual([{ Volume: 0.5 }, { Volume: 0.5 }]);
  });
});

describe('MPRIS position', () => {
  beforeEach(() => {
    // The seek check compares the reported position against elapsed wall clock,
    // so the clock has to be under test control.
    vi.useFakeTimers();
  });

  // Seeked tells a client to throw away its own extrapolation. Emitting it on
  // an ordinary tick makes a progress bar stutter, so the 1 second threshold
  // has to hold for normal playback and give way for a real jump.
  it('emits Seeked for a jump and not for ordinary ticks', () => {
    const iface = initPlayerInterface();
    const seeked = vi.spyOn(iface, 'Seeked');
    player.emitPlaybackState(PlaybackState.Playing);

    for (let second = 1; second <= 5; second += 1) {
      vi.advanceTimersByTime(1000);
      player.setPositionUs(second * 1_000_000);
    }
    expect(seeked).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1000);
    player.setPositionUs(60_000_000);
    expect(seeked).toHaveBeenCalledTimes(1);
    expect(seeked).toHaveBeenCalledWith(60_000_000);
  });

  it('does not count paused wall time after playback resumes', () => {
    const iface = initPlayerInterface();
    const seeked = vi.spyOn(iface, 'Seeked');

    player.emitPlaybackState(PlaybackState.Playing);
    vi.advanceTimersByTime(1000);
    player.setPositionUs(1_000_000);
    player.emitPlaybackState(PlaybackState.Paused);

    vi.advanceTimersByTime(60_000);
    player.emitPlaybackState(PlaybackState.Playing);
    vi.advanceTimersByTime(1000);
    player.setPositionUs(2_000_000);

    expect(seeked).not.toHaveBeenCalled();
  });

  it('does not extrapolate position while paused', () => {
    const iface = initPlayerInterface();
    const seeked = vi.spyOn(iface, 'Seeked');

    player.emitPlaybackState(PlaybackState.Playing);
    vi.advanceTimersByTime(1000);
    player.setPositionUs(1_000_000);
    player.emitPlaybackState(PlaybackState.Paused);

    vi.advanceTimersByTime(60_000);
    player.setPositionUs(1_000_000);

    expect(seeked).not.toHaveBeenCalled();
  });

  // Both the Seeked argument and the Position property are int64 fields, and
  // the dbus-next marshaller converts one with BigInt(data.toString()), which
  // throws on anything fractional. BigInt(String(value)) is that exact
  // operation, so it is the honest assertion rather than a proxy for it.
  it('keeps a fractional position integral for the int64 marshaller', () => {
    const iface = initPlayerInterface();
    const seeked = vi.spyOn(iface, 'Seeked');

    vi.advanceTimersByTime(1000);
    player.setPositionUs(30_000_000.5);

    expect(seeked).toHaveBeenCalledTimes(1);
    const reported = seeked.mock.calls[0][0];
    expect(() => BigInt(String(reported))).not.toThrow();
    expect(() => BigInt(String(iface.Position))).not.toThrow();
    expect(iface.Position).toBe(30_000_000);
  });
});

describe('MPRIS without a session bus', () => {
  // dbus-next throws synchronously from sessionBus() when
  // DBUS_SESSION_BUS_ADDRESS is unset and it cannot read the address from the
  // filesystem. init() is called bare inside the did-finish-load handler in
  // main.ts, so an escaping throw takes out every integration after it and the
  // splash screen never closes.
  it('does not throw when the bus cannot be opened', () => {
    vi.spyOn(dbus, 'sessionBus').mockImplementation(() => {
      throw new Error('could not get DISPLAY environment variable');
    });

    const ctx: IntegrationContext = {
      player,
      getMainWindow: () => win as unknown as BrowserWindow,
    };

    expect(() => mpris.init(ctx)).not.toThrow();
  });

  it('exports no interfaces when the bus cannot be opened', () => {
    vi.spyOn(dbus, 'sessionBus').mockImplementation(() => {
      throw new Error('could not get DISPLAY environment variable');
    });

    mpris.init({ player, getMainWindow: () => win as unknown as BrowserWindow });

    expect(busStub.export).not.toHaveBeenCalled();
    expect(busStub.requestName).not.toHaveBeenCalled();
  });

  it('subscribes to no player events when the bus cannot be opened', () => {
    vi.spyOn(dbus, 'sessionBus').mockImplementation(() => {
      throw new Error('could not get DISPLAY environment variable');
    });

    mpris.init({ player, getMainWindow: () => win as unknown as BrowserWindow });

    // The subscriptions sit after the bus is opened, so a bail-out leaves the
    // player untouched and nothing holds a reference to the dead integration.
    expect(player.listenerCount('playbackStateDidChange')).toBe(0);
    expect(player.listenerCount('nowPlayingItemDidChange')).toBe(0);
    expect(player.listenerCount('playbackTimeDidChange')).toBe(0);
  });
});
