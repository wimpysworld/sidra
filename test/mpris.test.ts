import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'node:events';
import { app } from 'electron';
import type { BrowserWindow } from 'electron';
import log from 'electron-log/main';

import { setMusicService } from '../src/config';
import { downloadArtwork } from '../src/artwork';
import { switchService } from '../src/serviceSwitch';
import type { MusicServiceId } from '../src/musicService';
import { PlaybackState } from '../src/player';
import type { IntegrationContext, NowPlayingPayload, TimedMetadataPayload } from '../src/player';
import * as mpris from '../src/integrations/mpris';
import { FakePlayer } from './mocks/player';
import { quit } from './mocks/appLifecycle';

// Avoid artwork network and cache writes. Resolving null preserves buildMetadata()'s mpris:artUrl for assertions.
vi.mock('../src/artwork', () => ({
  downloadArtwork: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../src/serviceSwitch', () => ({
  switchService: vi.fn((id: MusicServiceId, url: string) => {
    setMusicService(id);
    win.loadURL(url);
  }),
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

// vi.mock does not intercept the integration's bare require of @holusion/dbus-next.
// Load the real module and stub sessionBus(), the entry point that opens a socket.
const dbus = require('@holusion/dbus-next') as DbusModule;

// Capture the real static before spying to avoid recursion.
// Its validation rejects properties that configureMembers() does not declare.
const realEmitPropertiesChanged = dbus.interface.Interface.emitPropertiesChanged;

const busStub = {
  on: vi.fn(),
  export: vi.fn<(path: string, iface: object) => void>(),
  requestName: vi.fn(() => Promise.resolve()),
  disconnect: vi.fn(),
};

type ContentsStub = EventEmitter & {
  send: ReturnType<typeof vi.fn>;
  getURL: ReturnType<typeof vi.fn<() => string>>;
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
};

interface WindowStub extends EventEmitter {
  show: ReturnType<typeof vi.fn>;
  focus: ReturnType<typeof vi.fn>;
  loadURL: ReturnType<typeof vi.fn<(url: string) => Promise<void>>>;
  isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
  isFullScreen: ReturnType<typeof vi.fn<() => boolean>>;
  setFullScreen: ReturnType<typeof vi.fn<(value: boolean) => void>>;
  /** Throws once isDestroyed() is true, as Electron's native getter does. */
  readonly webContents: ContentsStub;
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
  Rate: number;
  readonly MinimumRate: number;
  readonly MaximumRate: number;
  $introspect(): { property: Array<{ $: { name: string; type: string; access: string } }> };
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
  Fullscreen: boolean;
  readonly CanSetFullscreen: boolean;
  $introspect(): { property: Array<{ $: { name: string; type: string; access: string } }> };
  readonly SupportedUriSchemes: string[];
}

/**
 * Retain every PropertiesChanged payload containing Position, which MPRIS forbids.
 * Clients poll Position or use Seeked instead.
 * Never clear this shared record, so a delayed emission still fails the next afterEach.
 */
const positionBreaches: Array<Record<string, unknown>> = [];

/** The PropertiesChanged payloads of the current test, cleared in beforeEach. */
let emissions: Array<Record<string, unknown>> = [];

let win: WindowStub;
// Held apart from win, because reading win.webContents throws once the window
// is destroyed and an assertion must still reach the send and emit spies.
let winContents: ContentsStub;
let player: FakePlayer;

/**
 * Read the live interfaces from init()'s bus exports, root first and player second.
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
  winContents = Object.assign(new EventEmitter(), {
    send: vi.fn(),
    getURL: vi.fn(() => 'https://music.apple.com/gb/new'),
    isDestroyed: vi.fn(() => false),
  });
  const windowBase = Object.assign(new EventEmitter(), {
    show: vi.fn(),
    focus: vi.fn(),
    loadURL: vi.fn<(url: string) => Promise<void>>(() => Promise.resolve()),
    isDestroyed: vi.fn(() => false),
    isFullScreen: vi.fn(() => false),
    setFullScreen: vi.fn<(value: boolean) => void>(),
  });
  // Electron throws "Object has been destroyed" from this native getter once the
  // window has gone, which quitting does before will-quit runs (#257). A plain
  // property would let an unguarded read pass the whole suite.
  win = Object.defineProperty(windowBase, 'webContents', {
    get(): ContentsStub {
      if (windowBase.isDestroyed()) throw new TypeError('Object has been destroyed');
      return winContents;
    },
  }) as WindowStub;
  player = new FakePlayer();
  player.handlePlaybackCapabilitiesDidChange({ canPlay: true, canPause: true, canSeek: true, durationUs: null });
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

describe('MPRIS fullscreen', () => {
  it('exports boolean fullscreen properties with the required access', () => {
    const { root } = initInterfaces();

    expect(root.CanSetFullscreen).toBe(true);
    expect(root.$introspect().property).toEqual(expect.arrayContaining([
      { $: { name: 'Fullscreen', type: 'b', access: 'readwrite' } },
      { $: { name: 'CanSetFullscreen', type: 'b', access: 'read' } },
    ]));
    expect(root.Fullscreen).toBe(false);
    win.isFullScreen.mockReturnValue(true);
    expect(root.Fullscreen).toBe(true);
  });

  it.each([true, false])('waits for the window transition after requesting %s', (value) => {
    win.isFullScreen.mockReturnValue(!value);
    const { root } = initInterfaces();

    root.Fullscreen = value;

    expect(win.setFullScreen).toHaveBeenCalledWith(value);
    expect(root.Fullscreen).toBe(!value);
    expect(emissions).toEqual([]);

    win.isFullScreen.mockReturnValue(value);
    win.emit(value ? 'enter-full-screen' : 'leave-full-screen');

    expect(root.Fullscreen).toBe(value);
    expect(emissions).toEqual([{ Fullscreen: value }]);
    expect(dbus.interface.Interface.emitPropertiesChanged).toHaveBeenCalledWith(root, { Fullscreen: value });
  });

  it('reports external window transitions without a request', () => {
    initInterfaces();

    win.isFullScreen.mockReturnValue(true);
    win.emit('enter-full-screen');
    win.isFullScreen.mockReturnValue(false);
    win.emit('leave-full-screen');

    expect(win.setFullScreen).not.toHaveBeenCalled();
    expect(emissions).toEqual([{ Fullscreen: true }, { Fullscreen: false }]);
  });

  it.each(['enter-full-screen', 'leave-full-screen'])('logs an emission failure on %s without throwing', (event) => {
    initInterfaces();
    vi.mocked(dbus.interface.Interface.emitPropertiesChanged).mockImplementationOnce(() => {
      throw new Error('D-Bus connection closed');
    });

    expect(() => win.emit(event)).not.toThrow();
    expect(log.scope('mpris').warn).toHaveBeenCalledWith(
      'failed to emit fullscreen PropertiesChanged:', 'D-Bus connection closed',
    );
  });

  it('does not announce a request that the window ignores', () => {
    vi.useFakeTimers();
    const { root } = initInterfaces();

    root.Fullscreen = true;
    vi.advanceTimersByTime(5000);

    expect(root.Fullscreen).toBe(false);
    expect(emissions).toEqual([]);
  });

  it.each(['missing', 'destroyed'])('handles a %s window', (state) => {
    win.isDestroyed.mockReturnValue(state === 'destroyed');
    const { root } = initInterfaces(() => state === 'missing' ? null : win as unknown as BrowserWindow);

    expect(root.Fullscreen).toBe(false);
    expect(() => { root.Fullscreen = true; }).not.toThrow();
    expect(win.isFullScreen).not.toHaveBeenCalled();
    expect(win.setFullScreen).not.toHaveBeenCalled();
    expect(win.listenerCount('enter-full-screen')).toBe(0);
    expect(win.listenerCount('leave-full-screen')).toBe(0);
    expect(emissions).toEqual([]);
  });

  it('ignores events and requests after the window is destroyed', () => {
    const { root } = initInterfaces();
    win.isDestroyed.mockReturnValue(true);

    root.Fullscreen = true;
    win.emit('enter-full-screen');

    expect(root.Fullscreen).toBe(false);
    expect(win.isFullScreen).not.toHaveBeenCalled();
    expect(win.setFullScreen).not.toHaveBeenCalled();
    expect(emissions).toEqual([]);
  });

  it('removes both listeners before disconnecting the bus', () => {
    initInterfaces();
    expect(win.listenerCount('enter-full-screen')).toBe(1);
    expect(win.listenerCount('leave-full-screen')).toBe(1);
    const listenersAtDisconnect: number[] = [];
    busStub.disconnect.mockImplementationOnce(() => {
      listenersAtDisconnect.push(win.listenerCount('enter-full-screen'), win.listenerCount('leave-full-screen'));
    });

    quit();
    win.isFullScreen.mockReturnValue(true);
    win.emit('enter-full-screen');
    win.emit('leave-full-screen');

    expect(busStub.disconnect).toHaveBeenCalledOnce();
    expect(listenersAtDisconnect).toEqual([0, 0]);
    expect(emissions).toEqual([]);
  });
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
  { method: 'Stop', channel: 'player:stop', args: [1], invoke: (iface) => iface.Stop() },
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

    expect(winContents.send).toHaveBeenCalledOnce();
    expect(winContents.send).toHaveBeenCalledWith(channel, ...args);
    const commandLog = method === 'Volume' ? log.scope('mpris').debug : log.scope('mpris').info;
    expect(commandLog).toHaveBeenCalledWith(
      `source=mpris method=${method} channel=${channel} result=sent`,
    );
  });

  it.each(COMMAND_CASES)('logs $method as dropped when no window exists', ({ method, channel, invoke }) => {
    vi.useFakeTimers();
    const iface = initInterfaces(() => null).player;

    invoke(iface);

    expect(winContents.send).not.toHaveBeenCalled();
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

  it.each(COMMAND_CASES)('drops $method once the window is destroyed', ({ method, channel, invoke }) => {
    vi.useFakeTimers();
    const iface = initPlayerInterface();
    win.isDestroyed.mockReturnValue(true);

    expect(() => invoke(iface)).not.toThrow();

    expect(winContents.send).not.toHaveBeenCalled();
    expect(log.scope('mpris').info).toHaveBeenCalledWith(
      `source=mpris method=${method} channel=${channel} result=dropped`,
    );
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
    expect(winContents.send.mock.calls).toEqual([
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

    expect(winContents.send).toHaveBeenCalledWith('player:seek', 12.345678);
    expect(mprisLogText()).toContain('source=mpris method=SetPosition channel=player:seek result=sent');
    expect(mprisLogText()).not.toContain(acceptedTrackId);
    expect(mprisLogText()).not.toContain('12345678');

    vi.mocked(log.scope('mpris').info).mockClear();
    winContents.send.mockClear();
    iface.SetPosition(rejectedTrackId, 98_765_432n);

    expect(winContents.send).not.toHaveBeenCalled();
    expect(mprisLogText()).toContain('SetPosition trackId mismatch, ignoring');
    expect(mprisLogText()).not.toContain('method=SetPosition');
    expect(mprisLogText()).not.toContain(rejectedTrackId);
    expect(mprisLogText()).not.toContain('98765432');
  });
});

describe('MPRIS teardown', () => {
  it('detaches the navigation listeners it attached', () => {
    initInterfaces();
    expect(winContents.listenerCount('did-start-navigation')).toBe(1);
    expect(winContents.listenerCount('will-redirect')).toBe(1);
    expect(winContents.listenerCount('did-navigate')).toBe(1);

    quit();

    expect(winContents.listenerCount('did-start-navigation')).toBe(0);
    expect(winContents.listenerCount('will-redirect')).toBe(0);
    expect(winContents.listenerCount('did-navigate')).toBe(0);
  });

  // Quitting destroys the window before will-quit runs, and reading its
  // webContents then throws "Object has been destroyed", which Electron shows as
  // a main-process error dialog while the app exits (#257). disconnectBus() runs
  // last in the handler, so the call proves the whole handler completed.
  it('completes without reading the renderer of a destroyed window', () => {
    initInterfaces();
    win.isDestroyed.mockReturnValue(true);

    expect(() => quit()).not.toThrow();

    expect(busStub.disconnect).toHaveBeenCalledOnce();
  });
});

describe('MPRIS Stop', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  it('reports Stopped only after completion and keeps it through paused reports', () => {
    const iface = initPlayerInterface();
    player.emitPlaybackState(PlaybackState.Playing);
    iface.Stop();
    expect(iface.PlaybackStatus).toBe('Playing');
    player.emitPlaybackState(PlaybackState.Paused);
    expect(iface.PlaybackStatus).toBe('Paused');
    player.handlePlaybackStopped({ requestId: 1, success: true });
    expect(iface.PlaybackStatus).toBe('Stopped');
    player.emitPlaybackState(PlaybackState.Paused);
    expect(iface.PlaybackStatus).toBe('Stopped');
    iface.Play();
    expect(iface.PlaybackStatus).toBe('Stopped');
    player.emitPlaybackState(PlaybackState.Playing);
    player.emitPlaybackState(PlaybackState.Paused);
    expect(iface.PlaybackStatus).toBe('Paused');
  });

  it('coalesces pending and completed Stop requests', () => {
    const iface = initPlayerInterface();
    iface.Stop();
    iface.Stop();
    player.handlePlaybackStopped({ requestId: 1, success: true });
    iface.Stop();
    expect(winContents.send).toHaveBeenCalledExactlyOnceWith('player:stop', 1);
  });

  it('accepts another Stop after a failed or unacknowledged request', () => {
    const iface = initPlayerInterface();
    player.emitPlaybackState(PlaybackState.Paused);
    iface.Stop();
    player.handlePlaybackStopped({ requestId: 1, success: false });
    expect(iface.PlaybackStatus).toBe('Paused');
    iface.Stop();
    vi.advanceTimersByTime(6000);
    player.handlePlaybackStopped({ requestId: 2, success: true });
    expect(iface.PlaybackStatus).toBe('Paused');
    iface.Stop();
    expect(winContents.send.mock.calls).toEqual([
      ['player:stop', 1], ['player:stop', 2], ['player:stop', 3],
    ]);
  });

  it.each(['item', 'document', 'playing'])('ignores stale completion after %s changes', (change) => {
    const iface = initPlayerInterface();
    iface.Stop();
    if (change === 'item') player.emitNowPlaying({ trackId: 'new' });
    else if (change === 'document') player.resetForDocumentReplacement();
    else player.emitPlaybackState(PlaybackState.Playing);
    player.emitPlaybackState(PlaybackState.Paused);
    iface.Stop();
    player.handlePlaybackStopped({ requestId: 1, success: true });
    expect(iface.PlaybackStatus).toBe('Paused');
    player.handlePlaybackStopped({ requestId: 2, success: true });
    expect(iface.PlaybackStatus).toBe('Stopped');
  });

  it('clears the completion timer and listener on quit', () => {
    const iface = initPlayerInterface();
    iface.Stop();
    quit();
    vi.advanceTimersByTime(6000);
    expect(player.listenerCount('playbackStopped')).toBe(0);
    expect(log.scope('mpris').warn).not.toHaveBeenCalledWith('Stop completion timed out');
  });
});

describe('MPRIS playback capabilities', () => {
  it('starts with the cached snapshot and clears capabilities on navigation', () => {
    vi.useFakeTimers();
    player.handlePlaybackCapabilitiesDidChange({ canPlay: true, canPause: true, canSeek: null, durationUs: null });
    const iface = initPlayerInterface();
    expect([iface.CanPlay, iface.CanPause, iface.CanSeek]).toEqual([true, true, true]);
    player.resetForDocumentReplacement();
    expect([iface.CanPlay, iface.CanPause, iface.CanSeek]).toEqual([false, false, false]);
    expect([iface.CanGoNext, iface.CanGoPrevious]).toEqual([true, true]);
    vi.advanceTimersByTime(250);
    expect(emissions).toEqual([expect.objectContaining({ CanPlay: false, CanPause: false, CanSeek: false })]);
  });

  it('does not seek without a capability or when it is explicitly unavailable', () => {
    player = new FakePlayer();
    const iface = initPlayerInterface();
    iface.Seek(1_000_000n);
    player.emitNowPlaying({ trackId: 'track-1', durationInMillis: 10_000 });
    iface.SetPosition('/org/sidra/track/track_1', 1_000_000n);
    expect(winContents.send).not.toHaveBeenCalled();
    player.handlePlaybackCapabilitiesDidChange({ canPlay: true, canPause: true, canSeek: null, durationUs: null });
    iface.SetPosition('/org/sidra/track/track_1', 1_000_000n);
    expect(winContents.send).toHaveBeenCalledExactlyOnceWith('player:seek', 1);
  });

  it('uses effective duration for metadata and seek bounds, then clears the bound', () => {
    vi.useFakeTimers();
    const iface = initPlayerInterface();
    player.emitNowPlaying({ trackId: 'radio', playParams: { kind: 'radioStation' } });
    player.handlePlaybackCapabilitiesDidChange({ canPlay: true, canPause: true, canSeek: true, durationUs: 10_000_000 });
    expect(iface.Metadata['mpris:length'].value).toBe(10_000_000);
    iface.SetPosition('/org/sidra/track/radio', 10_000_001n);
    iface.Seek(10_000_001n);
    expect(winContents.send).toHaveBeenCalledExactlyOnceWith('player:next');
    player.handlePlaybackCapabilitiesDidChange({ canPlay: true, canPause: true, canSeek: null, durationUs: null });
    expect(iface.Metadata['mpris:length']).toBeUndefined();
    expect(iface.CanSeek).toBe(true);
    vi.advanceTimersByTime(250);
    expect(emissions).toEqual([expect.objectContaining({ Metadata: iface.Metadata })]);
  });
});

describe('MPRIS seek bounds', () => {
  const trackId = '/org/sidra/track/track_1';

  beforeEach(() => {
    vi.useFakeTimers();
  });

  it.each([0n, 10_000_000n])('accepts SetPosition at boundary %s', (position) => {
    const iface = initPlayerInterface();
    player.emitNowPlaying({ trackId: 'track-1', durationInMillis: 10_000 });

    iface.SetPosition(trackId, position);

    expect(winContents.send).toHaveBeenCalledExactlyOnceWith('player:seek', Number(position) / 1_000_000);
  });

  it.each([-1n, 10_000_001n, 9_223_372_036_854_775_807n])('ignores invalid SetPosition %s', (position) => {
    const iface = initPlayerInterface();
    player.emitNowPlaying({ trackId: 'track-1', durationInMillis: 10_000 });

    iface.SetPosition(trackId, position);

    expect(winContents.send).not.toHaveBeenCalled();
  });

  it('ignores NoTrack before playback and after a document replacement', () => {
    const iface = initPlayerInterface();
    iface.SetPosition('/org/mpris/MediaPlayer2/TrackList/NoTrack', 0n);
    player.emitNowPlaying({ trackId: 'track-1', durationInMillis: 10_000 });
    player.resetForDocumentReplacement();
    iface.SetPosition('/org/mpris/MediaPlayer2/TrackList/NoTrack', 0n);
    iface.SetPosition(trackId, 0n);

    expect(winContents.send).not.toHaveBeenCalled();
  });

  it.each([
    [-9_223_372_036_854_775_808n, 'player:seek', [0]],
    [-3_000_000n, 'player:seek', [1]],
    [6_000_000n, 'player:seek', [10]],
    [6_000_001n, 'player:next', []],
    [9_223_372_036_854_775_807n, 'player:next', []],
  ] as const)('routes Seek %s to %s', (offset, channel, args) => {
    const iface = initPlayerInterface();
    player.emitNowPlaying({ trackId: 'track-1', durationInMillis: 10_000 });
    player.setPositionUs(4_000_000);

    iface.Seek(offset);

    expect(winContents.send).toHaveBeenCalledExactlyOnceWith(channel, ...args);
    expect(log.scope('mpris').info).toHaveBeenCalledWith(`source=mpris method=Seek channel=${channel} result=sent`);
  });

  it('uses the replacement track length and forgets an absent length', () => {
    const iface = initPlayerInterface();
    player.emitNowPlaying({ trackId: 'track-1', durationInMillis: 10_000 });
    player.emitNowPlaying({ trackId: 'track-1', durationInMillis: 20_000 });
    iface.SetPosition(trackId, 15_000_000n);
    player.emitNowPlaying({ trackId: 'track-1' });
    iface.SetPosition(trackId, 30_000_000n);
    iface.Seek(30_000_000n);

    expect(winContents.send.mock.calls).toEqual([
      ['player:seek', 15], ['player:seek', 30], ['player:seek', 30],
    ]);
  });

  it('uses the advertised truncated length for fractional durations', () => {
    const iface = initPlayerInterface();
    player.emitNowPlaying({ trackId: 'track-1', durationInMillis: 10_000.0007 });
    iface.SetPosition(trackId, 10_000_001n);
    iface.Seek(10_000_001n);

    expect(winContents.send).toHaveBeenCalledExactlyOnceWith('player:next');
  });

  it('rejects unsafe targets when the duration is unknown', () => {
    const iface = initPlayerInterface();
    player.emitNowPlaying({ trackId: 'track-1' });
    iface.SetPosition(trackId, BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    player.setPositionUs(1);
    iface.Seek(BigInt(Number.MAX_SAFE_INTEGER));

    expect(winContents.send).not.toHaveBeenCalled();
  });

  it('treats a zero duration as a known bound', () => {
    const iface = initPlayerInterface();
    player.emitNowPlaying({ trackId: 'track-1', durationInMillis: 0 });
    iface.SetPosition(trackId, 1n);
    iface.Seek(1n);

    expect(winContents.send).toHaveBeenCalledExactlyOnceWith('player:next');
  });
});

describe('MPRIS fixed Rate', () => {
  it('exports writable Rate and read-only limits at normal speed', () => {
    const iface = initPlayerInterface();

    expect(iface.$introspect().property).toEqual(expect.arrayContaining([
      { $: { name: 'Rate', type: 'd', access: 'readwrite' } },
      { $: { name: 'MinimumRate', type: 'd', access: 'read' } },
      { $: { name: 'MaximumRate', type: 'd', access: 'read' } },
    ]));
    expect([iface.Rate, iface.MinimumRate, iface.MaximumRate]).toEqual([1, 1, 1]);
  });

  it.each([1, 0.5, 2, -1, NaN, Infinity])('keeps normal speed after setting %s', (rate) => {
    vi.useFakeTimers();
    const iface = initPlayerInterface();
    expect(() => { iface.Rate = rate; }).not.toThrow();
    vi.advanceTimersByTime(250);

    expect(iface.Rate).toBe(1);
    expect(winContents.send).not.toHaveBeenCalled();
    expect(emissions).toEqual([]);
  });

  it('pauses when Rate is set to zero without changing the speed', () => {
    const iface = initPlayerInterface();
    iface.Rate = 0;

    expect(winContents.send).toHaveBeenCalledExactlyOnceWith('player:pause');
    expect(iface.Rate).toBe(1);
    expect(log.scope('mpris').info).toHaveBeenCalledWith('source=mpris method=Rate channel=player:pause result=sent');
  });
});

describe('MPRIS OpenUri', () => {
  beforeEach(() => { vi.useFakeTimers(); });

  function commitAndReady(url: string): void {
    winContents.getURL.mockReturnValue(url);
    winContents.emit('did-navigate', {}, url);
    player.handleHookReady(url);
  }

  it('queues media immediately on a ready active service without navigation', () => {
    player.handleHookReady('https://music.apple.com/gb/new');
    initPlayerInterface().OpenUri('https://music.apple.com/gb/album/123');
    expect(winContents.send).toHaveBeenCalledExactlyOnceWith('player:openUri', 'https://music.apple.com/gb/album/123');
    expect(switchService).not.toHaveBeenCalled();
    expect(win.loadURL).not.toHaveBeenCalled();
  });

  it('switches service first and waits for hook readiness rather than load completion', () => {
    const url = 'https://classical.music.apple.com/gb/album/123';
    initPlayerInterface().OpenUri(url);
    expect(switchService).toHaveBeenCalledExactlyOnceWith('classical', url);
    winContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
    winContents.emit('did-finish-load');
    expect(winContents.send).not.toHaveBeenCalled();
    commitAndReady(url);
    expect(winContents.send).toHaveBeenCalledExactlyOnceWith('player:openUri', url);
    expect(vi.mocked(switchService).mock.invocationCallOrder[0]).toBeLessThan(winContents.send.mock.invocationCallOrder[0]);
  });

  it('keeps the original media request through a same-service storefront redirect', () => {
    const url = 'https://classical.music.apple.com/album/123';
    const redirected = 'https://classical.music.apple.com/gb/album/123';
    initPlayerInterface().OpenUri(url);
    winContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url });
    winContents.emit('will-redirect', { isMainFrame: true, url: redirected });
    commitAndReady(redirected);
    expect(winContents.send).toHaveBeenCalledExactlyOnceWith('player:openUri', url);
  });

  it('keeps only the latest request while readiness is delayed', () => {
    const iface = initPlayerInterface();
    const first = 'https://classical.music.apple.com/album/1';
    const latest = 'https://classical.music.apple.com/album/2';
    iface.OpenUri(first);
    iface.OpenUri(latest);
    commitAndReady(first);
    expect(winContents.send).not.toHaveBeenCalled();
    winContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, url: latest });
    commitAndReady(latest);
    expect(winContents.send).toHaveBeenCalledExactlyOnceWith('player:openUri', latest);
  });

  it.each([false, true])('cancels pending media on unrelated navigation with sameDocument=%s', (isSameDocument) => {
    const target = 'https://classical.music.apple.com/album/1';
    initPlayerInterface().OpenUri(target);
    winContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument, url: 'https://classical.music.apple.com/search' });
    commitAndReady(target);
    expect(winContents.send).not.toHaveBeenCalled();
  });

  it('expires a pending request and removes readiness listeners on quit', () => {
    const target = 'https://classical.music.apple.com/album/1';
    const iface = initPlayerInterface();
    iface.OpenUri(target);
    vi.advanceTimersByTime(10_000);
    commitAndReady(target);
    expect(winContents.send).not.toHaveBeenCalled();
    player.resetForDocumentReplacement();
    iface.OpenUri(target);
    quit();
    expect(player.listenerCount('hookReady')).toBe(0);
    expect(winContents.listenerCount('did-start-navigation')).toBe(0);
    expect(winContents.listenerCount('will-redirect')).toBe(0);
    expect(winContents.listenerCount('did-navigate')).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(log.scope('mpris').warn).toHaveBeenCalledTimes(1);
  });

  it.each(['https://music.apple.com.evil.test/album/1', 'https://user@music.apple.com/album/1', 'https://music.apple.com:1234/album/1'])('rejects a URI outside the service origin %#', (uri) => {
    initPlayerInterface().OpenUri(uri);
    expect(switchService).not.toHaveBeenCalled();
    expect(winContents.send).not.toHaveBeenCalled();
  });
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

// MusicKit states map to three MPRIS statuses. Stopped and transient states report 'Stopped', never the previous status.
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

  // Suppressing transient states leaves MPRIS reporting a state that the player no longer holds.
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

  // D-Bus clients require the exact keys and signatures, including a string array for xesam:artist and int64 for mpris:length.
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
    }).toEqual({ ...persistentProperties, CanPlay: false, CanPause: false, CanSeek: false });
  });
});

describe('MPRIS radio song metadata', () => {
  const station: NowPlayingPayload = {
    trackId: 'ra.123', name: 'Station', artistName: 'Station host', albumName: 'Station album',
    artworkUrl: 'https://example.com/station.jpg', url: 'https://music.apple.com/gb/station/example/ra.123',
    sourceHost: 'music.apple.com', playParams: { kind: 'radioStation' },
  };
  const song: TimedMetadataPayload = {
    name: 'Song', artistName: 'Artist', albumName: 'Album', trackId: '123',
    playParams: { kind: 'song', catalogId: '123' }, transition: 'clean',
  };

  beforeEach(() => { vi.useFakeTimers(); });

  it.each([null, 7_200_000_000])('updates song details without changing stream state for duration %s', (durationUs) => {
    const iface = initPlayerInterface();
    player.emitNowPlaying(station);
    player.handlePlaybackCapabilitiesDidChange({ canPlay: true, canPause: true, canSeek: durationUs === null ? null : true, durationUs });
    player.setPositionUs(120_000_000);
    vi.advanceTimersByTime(250);
    emissions = [];
    const seeked = vi.spyOn(iface, 'Seeked');
    setMusicService('classical');

    player.emitTimedMetadata(song);
    vi.advanceTimersByTime(250);

    expect(iface.Metadata).toMatchObject({
      'mpris:trackid': { signature: 'o', value: '/org/sidra/track/ra_123' },
      'xesam:title': { signature: 's', value: 'Song' },
      'xesam:artist': { signature: 'as', value: ['Artist'] },
      'xesam:album': { signature: 's', value: 'Album' },
      'xesam:url': { signature: 's', value: 'https://music.apple.com/song/123' },
      'mpris:artUrl': { signature: 's', value: station.artworkUrl },
    });
    expect(iface.Metadata['mpris:length']?.value ?? null).toBe(durationUs);
    expect(iface.Position).toBe(120_000_000);
    expect(seeked).not.toHaveBeenCalled();
    expect(downloadArtwork).toHaveBeenCalledOnce();
    expect(emissions).toEqual([{ Metadata: iface.Metadata }]);
  });

  it('clears absent song album and catalogue data while retaining the station URL', () => {
    const iface = initPlayerInterface();
    player.emitNowPlaying(station);
    player.emitTimedMetadata(song);
    player.emitTimedMetadata({ name: 'Next song', artistName: 'Next artist', transition: 'clean' });
    expect(iface.Metadata['xesam:title'].value).toBe('Next song');
    expect(iface.Metadata['xesam:album']).toBeUndefined();
    expect(iface.Metadata['xesam:url'].value).toBe(station.url);
    expect(iface.Metadata['mpris:artUrl'].value).toBe(station.artworkUrl);
  });

  it('removes a previous song URL when neither the next song nor station has one', () => {
    const iface = initPlayerInterface();
    player.emitNowPlaying({ ...station, url: undefined });
    player.emitTimedMetadata(song);
    player.emitTimedMetadata({ name: 'Next song', artistName: 'Next artist', transition: 'clean' });
    expect(iface.Metadata['xesam:url']).toBeUndefined();
  });

  it('deduplicates unchanged display fields regardless of transition and receipt time', () => {
    initPlayerInterface();
    player.emitNowPlaying(station);
    player.emitTimedMetadata(song);
    vi.advanceTimersByTime(250);
    emissions = [];
    player.emitTimedMetadata({ ...song, transition: 'ambiguous', observedAtMs: Date.now() });
    vi.advanceTimersByTime(250);
    expect(emissions).toEqual([]);
  });

  it('publishes catalogue enrichment even when the song title and artist stay unchanged', () => {
    const iface = initPlayerInterface();
    player.emitNowPlaying(station);
    player.emitTimedMetadata({ ...song, trackId: undefined, playParams: undefined });
    vi.advanceTimersByTime(250);
    emissions = [];
    player.emitTimedMetadata(song);
    vi.advanceTimersByTime(250);
    expect(iface.Metadata['xesam:url'].value).toBe('https://music.apple.com/song/123');
    expect(emissions).toEqual([{ Metadata: iface.Metadata }]);
  });

  it('restores station and normal item metadata and ignores timed songs outside radio', () => {
    const iface = initPlayerInterface();
    player.emitNowPlaying(station);
    player.emitTimedMetadata(song);
    player.emitNowPlaying({ ...station, name: 'Other station', trackId: 'ra.456' });
    expect(iface.Metadata['xesam:title'].value).toBe('Other station');
    expect(iface.Metadata['xesam:album'].value).toBe('Station album');
    player.emitNowPlaying({ trackId: 'normal', name: 'Normal track' });
    vi.advanceTimersByTime(250);
    emissions = [];
    player.emitTimedMetadata(song);
    vi.advanceTimersByTime(250);
    expect(iface.Metadata['xesam:title'].value).toBe('Normal track');
    expect(emissions).toEqual([]);
    player.resetForDocumentReplacement();
    player.emitTimedMetadata(song);
    expect(Object.keys(iface.Metadata)).toEqual(['mpris:trackid']);
  });

  it('applies downloaded station artwork without restoring stale song metadata', async () => {
    let resolveArtwork!: (path: string) => void;
    vi.mocked(downloadArtwork).mockReturnValueOnce(new Promise(resolve => { resolveArtwork = resolve; }));
    const iface = initPlayerInterface();
    player.emitNowPlaying(station);
    player.emitTimedMetadata(song);
    player.emitTimedMetadata({ name: 'Newest song', artistName: 'Newest artist', transition: 'clean' });
    resolveArtwork('/tmp/station.jpg');
    await Promise.resolve();
    expect(iface.Metadata['mpris:artUrl'].value).toBe('file:///tmp/station.jpg');
    expect(iface.Metadata['xesam:title'].value).toBe('Newest song');
    expect(iface.Metadata['xesam:artist'].value).toEqual(['Newest artist']);
    expect(iface.Metadata['xesam:album']).toBeUndefined();
  });

  it('ignores old artwork after returning to the same station ID', async () => {
    let resolveArtwork!: (path: string) => void;
    vi.mocked(downloadArtwork).mockReturnValueOnce(new Promise(resolve => { resolveArtwork = resolve; }));
    const iface = initPlayerInterface();
    player.emitNowPlaying(station);
    player.resetForDocumentReplacement();
    player.emitNowPlaying({ ...station, artworkUrl: 'https://example.com/new-station.jpg' });
    player.emitTimedMetadata(song);
    resolveArtwork('/tmp/old-station.jpg');
    await Promise.resolve();
    expect(iface.Metadata['mpris:artUrl'].value).toBe('https://example.com/new-station.jpg');
    expect(iface.Metadata['xesam:title'].value).toBe('Song');
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

    expect(winContents.send).toHaveBeenCalledWith('player:setVolume', 0.4);
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

  // The safety timeout clears pending echoes so a missing echo cannot suppress a later in-app change indefinitely.
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

  // Seeked and Position use int64. BigInt(String(value)) checks the marshaller's conversion, which rejects fractional values.
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
  // sessionBus() throws synchronously when neither the environment nor the filesystem supplies a bus address.
  // MPRIS handles this expected absence locally and leaves the player without bus listeners.
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
    expect(win.listenerCount('enter-full-screen')).toBe(0);
    expect(win.listenerCount('leave-full-screen')).toBe(0);
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
