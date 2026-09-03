import fs from 'node:fs';
import path from 'node:path';

import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';

import type { MusicServiceId } from '../src/musicService';

// getShareUrl() falls back to the persisted service, so the fallback is only
// observable when the test can move it away from the default.
const { state } = vi.hoisted(() => ({ state: { service: 'music' as MusicServiceId } }));

vi.mock('../src/config', () => ({
  getMusicService: vi.fn(() => state.service),
}));

import {
  PlaybackState,
  Player,
  getShareUrl,
  isTerminalPlaybackState,
  type NowPlayingPayload,
  type PlayerEvents,
  type TimedMetadataInput,
} from '../src/player';

/** The shipped hook, read so the command contract is checked against real source. */
const HOOK_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'musicKitHook.js'),
  'utf-8',
);

// The numbers are MusicKit's, not Sidra's, so each one is pinned rather than
// left to whatever the enum happens to declare.
describe('PlaybackState', () => {
  const STATE_VALUES: ReadonlyArray<readonly [keyof typeof PlaybackState, number]> = [
    ['None', 0],
    ['Loading', 1],
    ['Playing', 2],
    ['Paused', 3],
    ['Stopped', 4],
    ['Ended', 5],
    ['Seeking', 6],
    ['Waiting', 7],
    ['Stalled', 8],
    ['Completed', 9],
  ];

  it.each(STATE_VALUES)('%s is %i', (name, value) => {
    expect(PlaybackState[name]).toBe(value);
  });

  it('has exactly 10 states', () => {
    expect(Object.keys(PlaybackState)).toHaveLength(10);
  });
});

describe('isTerminalPlaybackState', () => {
  // Typed against the table, so a state added to src/player.ts without a
  // verdict here fails tsc rather than passing untested.
  const TERMINAL_BY_STATE: Record<keyof typeof PlaybackState, boolean> = {
    None: true,
    Loading: false,
    Playing: false,
    Paused: false,
    Stopped: true,
    Ended: true,
    Seeking: false,
    Waiting: false,
    Stalled: false,
    Completed: true,
  };

  it.each(Object.entries(TERMINAL_BY_STATE))('%s is %s', (name, terminal) => {
    expect(isTerminalPlaybackState(PlaybackState[name as keyof typeof PlaybackState])).toBe(terminal);
  });

  it('covers every declared state', () => {
    expect(Object.keys(TERMINAL_BY_STATE).sort()).toEqual(Object.keys(PlaybackState).sort());
  });

  it('rejects a value outside the table', () => {
    expect(isTerminalPlaybackState(99)).toBe(false);
  });
});

describe('PlayerEvents', () => {
  it('keys match Player handler event names', () => {
    type EventKeys = keyof PlayerEvents;
    type ExpectedKeys =
      | 'playbackStateDidChange'
      | 'nowPlayingItemDidChange'
      | 'timedMetadataDidChange'
      | 'playbackTimeDidChange'
      | 'repeatModeDidChange'
      | 'shuffleModeDidChange'
      | 'volumeDidChange';

    expectTypeOf<EventKeys>().toEqualTypeOf<ExpectedKeys>();
  });
});

describe('Player event forwarding', () => {
  it('emits playbackStateDidChange with payload', () => {
    const player = new Player();
    const listener = vi.fn();
    player.on('playbackStateDidChange', listener);

    const payload = { status: true, state: PlaybackState.Playing };
    player.handlePlaybackStateDidChange(payload);

    expect(listener).toHaveBeenCalledWith(payload);
  });

  it('emits nowPlayingItemDidChange with payload', () => {
    const player = new Player();
    const listener = vi.fn();
    player.on('nowPlayingItemDidChange', listener);

    const payload = {
      name: 'Track',
      artistName: 'Artist',
      albumName: 'Album',
      artworkUrl: 'https://is1-ssl.mzstatic.com/image/thumb/track/512x512.jpg',
      durationInMillis: 240_000,
      url: 'https://music.apple.com/gb/song/track/1',
      genreNames: ['Electronic'],
      trackId: '1',
      trackNumber: 2,
      discNumber: 1,
      composerName: 'Composer',
      releaseDate: '2026-08-02',
      playParams: { catalogId: '1', globalId: 'global-1', kind: 'song', isLibrary: true },
      sourceHost: 'music.apple.com',
    };
    player.handleNowPlayingItemDidChange(payload);

    expect(listener).toHaveBeenCalledWith(payload);
  });

  it('emits playbackTimeDidChange with position', () => {
    const player = new Player();
    const listener = vi.fn();
    player.on('playbackTimeDidChange', listener);

    player.handlePlaybackTimeDidChange(42000);

    expect(listener).toHaveBeenCalledWith(42000);
  });

  it('emits validated timedMetadataDidChange payloads', () => {
    const player = new Player();
    const listener = vi.fn();
    player.on('timedMetadataDidChange', listener);
    const payload = {
      name: 'Track',
      artistName: 'Artist',
      albumName: 'Album',
      trackId: '123',
      playParams: { catalogId: '123', kind: 'song' },
    } satisfies TimedMetadataInput;

    player.handleNowPlayingItemDidChange({ name: 'Station', playParams: { kind: 'radioStation' } });

    player.handleTimedMetadataDidChange(payload);

    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ ...payload, transition: 'initial' }));
  });

  it('emits repeatModeDidChange with mode', () => {
    const player = new Player();
    const listener = vi.fn();
    player.on('repeatModeDidChange', listener);

    player.handleRepeatModeDidChange(2);

    expect(listener).toHaveBeenCalledWith(2);
  });

  it('emits shuffleModeDidChange with mode', () => {
    const player = new Player();
    const listener = vi.fn();
    player.on('shuffleModeDidChange', listener);

    player.handleShuffleModeDidChange(1);

    expect(listener).toHaveBeenCalledWith(1);
  });

  it('emits volumeDidChange with volume', () => {
    const player = new Player();
    const listener = vi.fn();
    player.on('volumeDidChange', listener);

    player.handleVolumeDidChange(0.75);

    expect(listener).toHaveBeenCalledWith(0.75);
  });
});

describe('Player playbackSnapshot', () => {
  it('returns initial snapshot before any events', () => {
    const player = new Player();
    expect(player.playbackSnapshot()).toEqual({ isPlaying: false, positionUs: 0, state: 0 });
  });

  it('reflects playing state after playbackStateDidChange', () => {
    const player = new Player();
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });
    expect(player.playbackSnapshot()).toEqual({ isPlaying: true, positionUs: 0, state: 2 });
  });

  it('reflects position after playbackTimeDidChange', () => {
    const player = new Player();
    player.handlePlaybackTimeDidChange(42000);
    expect(player.playbackSnapshot().positionUs).toBe(42000);
  });

  it('reflects paused state while preserving position', () => {
    const player = new Player();
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });
    player.handlePlaybackTimeDidChange(42000);
    player.handlePlaybackStateDidChange({ status: false, state: PlaybackState.Paused });
    expect(player.playbackSnapshot()).toEqual({ isPlaying: false, positionUs: 42000, state: 3 });
  });

  it('resets state but preserves position on null payload', () => {
    const player = new Player();
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });
    player.handlePlaybackTimeDidChange(42000);
    player.handlePlaybackStateDidChange(null);
    expect(player.playbackSnapshot()).toEqual({ isPlaying: false, positionUs: 42000, state: 0 });
  });
});

describe('Player document replacement reset', () => {
  it('resets the snapshot before emitting the two reset events in order', () => {
    const player = new Player();
    player.handlePlaybackStateDidChange({ status: true, state: PlaybackState.Playing });
    player.handlePlaybackTimeDidChange(42_000);

    const events: Array<[keyof PlayerEvents, unknown]> = [];
    const snapshots: ReturnType<Player['playbackSnapshot']>[] = [];
    player.on('playbackStateDidChange', payload => {
      events.push(['playbackStateDidChange', payload]);
      snapshots.push(player.playbackSnapshot());
    });
    player.on('nowPlayingItemDidChange', payload => {
      events.push(['nowPlayingItemDidChange', payload]);
      snapshots.push(player.playbackSnapshot());
    });
    player.on('playbackTimeDidChange', payload => events.push(['playbackTimeDidChange', payload]));
    player.on('volumeDidChange', payload => events.push(['volumeDidChange', payload]));
    player.on('repeatModeDidChange', payload => events.push(['repeatModeDidChange', payload]));
    player.on('shuffleModeDidChange', payload => events.push(['shuffleModeDidChange', payload]));

    player.resetForDocumentReplacement();

    expect(events).toEqual([
      ['playbackStateDidChange', { status: false, state: PlaybackState.None }],
      ['nowPlayingItemDidChange', null],
    ]);
    expect(snapshots).toEqual([
      { isPlaying: false, positionUs: 0, state: PlaybackState.None },
      { isPlaying: false, positionUs: 0, state: PlaybackState.None },
    ]);
  });
});

// Every handle* method takes its argument straight off an IPC channel, where
// nothing is typed, so a malformed payload must be dropped rather than emitted:
// integrations read these events as though the declared type held.
describe('Player handle* payload validation', () => {
  /** The public payload handlers. A new one widens this union. */
  type HandlerMethod = Extract<keyof Player, `handle${string}`>;
  /** Each handler emits the event its own name carries, minus the handle prefix. */
  type EventOf<M extends string> = M extends `handle${infer Event}` ? Uncapitalize<Event> : never;

  const eventOf = <M extends HandlerMethod>(method: M): EventOf<M> => {
    const event = method.slice('handle'.length);
    return (event[0].toLowerCase() + event.slice(1)) as EventOf<M>;
  };

  // eventOf() only finds a real listener while every handler owns an event of
  // that name, so the naming rule it relies on is checked rather than assumed.
  it('every handler name maps onto a declared event', () => {
    expectTypeOf<EventOf<HandlerMethod>>().toEqualTypeOf<keyof PlayerEvents>();
  });

  const BAD_PAYLOADS: ReadonlyArray<readonly [HandlerMethod, string, unknown]> = [
    ['handlePlaybackStateDidChange', 'string payload', 'invalid'],
    ['handlePlaybackStateDidChange', 'payload missing state field', { status: true }],
    ['handlePlaybackStateDidChange', 'payload with non-number state', { status: true, state: 'playing' }],
    ['handleNowPlayingItemDidChange', 'string payload', 'invalid'],
    ['handleNowPlayingItemDidChange', 'array payload', [1, 2, 3]],
    ['handleTimedMetadataDidChange', 'incomplete payload', { name: 'Track' }],
    ['handlePlaybackTimeDidChange', 'string payload', 'not-a-number'],
    ['handlePlaybackTimeDidChange', 'undefined payload', undefined],
    ['handleRepeatModeDidChange', 'string payload', 'repeat'],
    ['handleShuffleModeDidChange', 'string payload', 'shuffle'],
    ['handleVolumeDidChange', 'string payload', 'loud'],
    ['handleVolumeDidChange', 'object payload', { volume: 0.5 }],
  ];

  it.each(BAD_PAYLOADS)('%s ignores %s', (method, _description, payload) => {
    const player = new Player();
    const listener = vi.fn();
    player.on(eventOf(method), listener);

    // The cast is the point of the test: this argument arrives untyped over IPC.
    (player[method] as (p: unknown) => void)(payload);

    expect(listener).not.toHaveBeenCalled();
  });

  const BAD_METADATA: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
    ['non-string name', { name: 123 }],
    ['non-string artist', { artistName: false }],
    ['non-string album', { albumName: {} }],
    ['non-string URL', { url: 123 }],
    ['HTTP metadata URL', { url: 'http://music.apple.com/gb/song/track/1' }],
    ['non-Apple metadata URL', { url: 'https://example.com/song/track/1' }],
    ['non-string track id', { trackId: 123 }],
    ['non-string composer', { composerName: [] }],
    ['non-string release date', { releaseDate: 2026 }],
    ['negative duration', { durationInMillis: -1 }],
    ['fractional duration', { durationInMillis: 1.5 }],
    ['duration unsafe after conversion to microseconds', {
      durationInMillis: Math.floor(Number.MAX_SAFE_INTEGER / 1_000) + 1,
    }],
    ['negative track number', { trackNumber: -1 }],
    ['fractional disc number', { discNumber: 1.5 }],
    ['track number outside D-Bus int32 range', { trackNumber: 2_147_483_648 }],
    ['non-array genres', { genreNames: 'Electronic' }],
    ['non-string genre', { genreNames: ['Electronic', 123] }],
    ['null playParams', { playParams: null }],
    ['array playParams', { playParams: [] }],
    ['non-string playParams catalog id', { playParams: { catalogId: 123 } }],
    ['non-string playParams global id', { playParams: { globalId: false } }],
    ['non-string playParams kind', { playParams: { kind: 123 } }],
    ['non-boolean playParams library flag', { playParams: { isLibrary: 'yes' } }],
    ['HTTP artwork URL', { artworkUrl: 'http://is1-ssl.mzstatic.com/image.jpg' }],
    ['non-Apple artwork host', { artworkUrl: 'https://example.com/image.jpg' }],
    ['Apple hostname suffix', { artworkUrl: 'https://mzstatic.com.attacker.test/image.jpg' }],
    ['malformed artwork URL', { artworkUrl: 'not a URL' }],
    ['non-string source host', { sourceHost: 123 }],
    ['unknown source host', { sourceHost: 'attacker.test' }],
  ];

  it.each(BAD_METADATA)('handleNowPlayingItemDidChange drops %s', (_description, payload) => {
    const player = new Player();
    const listener = vi.fn();
    player.on('nowPlayingItemDidChange', listener);
    const validField = Object.hasOwn(payload, 'name')
      ? { artistName: 'Artist' }
      : { name: 'Track' };

    player.handleNowPlayingItemDidChange({ ...validField, ...payload });

    expect(listener).toHaveBeenCalledWith(validField);
  });

  it('drops unknown metadata fields and emits known fields', () => {
    const player = new Player();
    const listener = vi.fn();
    player.on('nowPlayingItemDidChange', listener);

    player.handleNowPlayingItemDidChange({ name: 'Track', extra: true });

    expect(listener).toHaveBeenCalledWith({ name: 'Track' });
  });

  it.each([
    ['unknown field', { name: 'Track', artistName: 'Artist', blob: [] }],
    ['blank title', { name: ' ', artistName: 'Artist' }],
    ['untrimmed artist', { name: 'Track', artistName: ' Artist ' }],
    ['station kind', { name: 'Track', artistName: 'Artist', trackId: '1', playParams: { catalogId: '1', kind: 'radioStation' } }],
    ['extra nested key', { name: 'Track', artistName: 'Artist', trackId: '1', playParams: { catalogId: '1', kind: 'song', isLibrary: false } }],
    ['mismatched IDs', { name: 'Track', artistName: 'Artist', trackId: '1', playParams: { catalogId: '2', kind: 'song' } }],
    ['trackId without playParams', { name: 'Track', artistName: 'Artist', trackId: '1' }],
    ['playParams without trackId', { name: 'Track', artistName: 'Artist', playParams: { catalogId: '1', kind: 'song' } }],
  ])('handleTimedMetadataDidChange rejects %s', (_description, payload) => {
    const player = new Player();
    const listener = vi.fn();
    player.on('timedMetadataDidChange', listener);
    player.handleNowPlayingItemDidChange({ name: 'Station', playParams: { kind: 'radioStation' } });

    player.handleTimedMetadataDidChange(payload);

    expect(listener).not.toHaveBeenCalled();
  });

  const timedPayload = (overrides: Partial<TimedMetadataInput> = {}): TimedMetadataInput => ({
    name: 'Track',
    artistName: 'Artist',
    ...overrides,
  });

  it.each([
    ['name', timedPayload({ name: 'a'.repeat(512) })],
    ['artistName', timedPayload({ artistName: 'a'.repeat(512) })],
    ['albumName', timedPayload({ albumName: 'a'.repeat(512) })],
    ['catalogue identity', timedPayload({
      trackId: '1'.repeat(128),
      playParams: { catalogId: '1'.repeat(128), kind: 'song' },
    })],
  ])('accepts the timed metadata %s maximum', (_description, payload) => {
    const player = new Player();
    const listener = vi.fn();
    player.on('timedMetadataDidChange', listener);
    player.handleNowPlayingItemDidChange({ name: 'Station', playParams: { kind: 'radioStation' } });

    player.handleTimedMetadataDidChange(payload);

    expect(listener).toHaveBeenCalledOnce();
  });

  it.each([
    ['name', timedPayload({ name: 'a'.repeat(513) })],
    ['artistName', timedPayload({ artistName: 'a'.repeat(513) })],
    ['albumName', timedPayload({ albumName: 'a'.repeat(513) })],
    ['trackId', timedPayload({ trackId: '1'.repeat(129), playParams: { catalogId: '1'.repeat(129), kind: 'song' } })],
    ['playParams.catalogId', timedPayload({ trackId: '1'.repeat(129), playParams: { catalogId: '1'.repeat(129), kind: 'song' } })],
    ['transition', { name: 'Track', artistName: 'Artist', transition: 'unknown' }],
  ])('rejects a timed metadata %s above its limit', (_description, payload) => {
    const player = new Player();
    const listener = vi.fn();
    player.on('timedMetadataDidChange', listener);
    player.handleNowPlayingItemDidChange({ name: 'Station', playParams: { kind: 'radioStation' } });

    player.handleTimedMetadataDidChange(payload);

    expect(listener).not.toHaveBeenCalled();
  });

  it.each([
    ['C0', '\u0001'],
    ['DEL', '\u007f'],
    ['C1', '\u0085'],
    ['bidirectional', '\u202e'],
  ])('rejects %s controls from every timed text and ID field', (_description, control) => {
    const invalidPayloads: unknown[] = [
      timedPayload({ name: `Track${control}` }),
      timedPayload({ artistName: `Artist${control}` }),
      timedPayload({ albumName: `Album${control}` }),
      timedPayload({
        trackId: `1${control}`,
        playParams: { catalogId: `1${control}`, kind: 'song' },
      }),
    ];

    for (const payload of invalidPayloads) {
      const player = new Player();
      const listener = vi.fn();
      player.on('timedMetadataDidChange', listener);
      player.handleNowPlayingItemDidChange({ name: 'Station', playParams: { kind: 'radioStation' } });
      player.handleTimedMetadataDidChange(payload);
      expect(listener).not.toHaveBeenCalled();
    }
  });

  it('requires a current validated radioStation queue item', () => {
    const player = new Player();
    const listener = vi.fn();
    player.on('timedMetadataDidChange', listener);

    player.handleTimedMetadataDidChange(timedPayload());
    player.handleNowPlayingItemDidChange({ name: 'Track', playParams: { kind: 'song' } });
    player.handleTimedMetadataDidChange(timedPayload());
    player.handleNowPlayingItemDidChange({
      name: 'Station',
      playParams: { kind: 'radioStation', unexpected: true },
    });
    player.handleTimedMetadataDidChange(timedPayload());

    expect(listener).not.toHaveBeenCalled();
  });

  it('suppresses direct IPC replays and coalesces a burst of unique songs', () => {
    vi.useFakeTimers();
    try {
      const player = new Player();
      const listener = vi.fn();
      player.on('timedMetadataDidChange', listener);
      player.handleNowPlayingItemDidChange({ name: 'Station', playParams: { kind: 'radioStation' } });

      player.handleTimedMetadataDidChange(timedPayload({ name: 'A' }));
      for (let i = 0; i < 20; i += 1) player.handleTimedMetadataDidChange(timedPayload({ name: 'A' }));
      player.handleTimedMetadataDidChange(timedPayload({ name: 'B' }));
      player.handleTimedMetadataDidChange(timedPayload({ name: 'C' }));
      player.handleTimedMetadataDidChange(timedPayload({ name: 'D' }));

      expect(listener).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1499);
      expect(listener).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(listener).toHaveBeenCalledTimes(2);
      expect(listener.mock.calls[1][0]).toEqual(expect.objectContaining({ name: 'D', transition: 'clean' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('derives an ambiguous transition after incomplete direct IPC metadata', () => {
    vi.useFakeTimers();
    try {
      const player = new Player();
      const listener = vi.fn();
      player.on('timedMetadataDidChange', listener);
      player.handleNowPlayingItemDidChange({ name: 'Station', playParams: { kind: 'radioStation' } });

      player.handleTimedMetadataDidChange(timedPayload());
      vi.advanceTimersByTime(1500);
      player.handleTimedMetadataDidChange(null);
      player.handleTimedMetadataDidChange(timedPayload());
      vi.advanceTimersByTime(1500);

      expect(listener.mock.calls.map(([payload]) => payload.transition)).toEqual(['initial', 'ambiguous']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not turn an A to B to A burst into a false boundary', () => {
    vi.useFakeTimers();
    try {
      const player = new Player();
      const listener = vi.fn();
      player.on('timedMetadataDidChange', listener);
      player.handleNowPlayingItemDidChange({ name: 'Station', playParams: { kind: 'radioStation' } });

      player.handleTimedMetadataDidChange(timedPayload({ name: 'A' }));
      player.handleTimedMetadataDidChange(timedPayload({ name: 'B' }));
      player.handleTimedMetadataDidChange(timedPayload({ name: 'A' }));
      vi.advanceTimersByTime(1500);

      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(expect.objectContaining({ name: 'A', transition: 'initial' }));
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels queued metadata across services and starts the next station as initial', () => {
    vi.useFakeTimers();
    try {
      const player = new Player();
      const listener = vi.fn();
      player.on('timedMetadataDidChange', listener);
      player.handleNowPlayingItemDidChange({ name: 'Station 1', playParams: { kind: 'radioStation' } });
      player.handleTimedMetadataDidChange(timedPayload({ name: 'A' }));
      player.handleTimedMetadataDidChange(timedPayload({ name: 'B' }));

      player.handleNowPlayingItemDidChange({ name: 'Normal', playParams: { kind: 'song' } });
      player.handleTimedMetadataDidChange(timedPayload({ name: 'Rejected' }));
      player.handleNowPlayingItemDidChange({ name: 'Station 2', playParams: { kind: 'radioStation' } });
      player.handleTimedMetadataDidChange(timedPayload({ name: 'C' }));
      vi.advanceTimersByTime(1500);

      expect(listener.mock.calls.map(([payload]) => [payload.name, payload.transition]))
        .toEqual([['A', 'initial'], ['C', 'initial']]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the timed metadata rate limit across queue-item resets', () => {
    vi.useFakeTimers();
    try {
      const player = new Player();
      const listener = vi.fn();
      player.on('timedMetadataDidChange', listener);
      player.handleNowPlayingItemDidChange({ name: 'Station 0', playParams: { kind: 'radioStation' } });
      player.handleTimedMetadataDidChange(timedPayload({ name: 'A' }));

      for (let i = 1; i <= 20; i += 1) {
        player.handleNowPlayingItemDidChange({ name: `Station ${i}`, playParams: { kind: 'radioStation' } });
        player.handleTimedMetadataDidChange(timedPayload({ name: `Song ${i}` }));
      }

      expect(listener).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1499);
      expect(listener).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(1);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the first receipt time when a pending identity gains catalogue data', () => {
    const startMs = new Date('2026-01-01T00:00:00Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(startMs);
    try {
      const player = new Player();
      const listener = vi.fn();
      player.on('timedMetadataDidChange', listener);
      player.handleNowPlayingItemDidChange({ name: 'Station', playParams: { kind: 'radioStation' } });
      player.handleTimedMetadataDidChange(timedPayload({ name: 'A' }));
      vi.advanceTimersByTime(100);
      player.handleTimedMetadataDidChange(timedPayload({ name: 'B' }));
      vi.advanceTimersByTime(400);
      player.handleTimedMetadataDidChange(timedPayload({
        name: 'B',
        trackId: '123',
        playParams: { catalogId: '123', kind: 'song' },
      }));
      vi.advanceTimersByTime(1000);

      expect(listener.mock.calls[1][0]).toEqual(expect.objectContaining({
        name: 'B',
        trackId: '123',
        observedAtMs: startMs + 100,
      }));
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('SidraHook contract', () => {
  it('keyof SidraHook matches the expected command method names', () => {
    type HookKeys = keyof SidraHook;
    type ExpectedKeys =
      | 'play'
      | 'pause'
      | 'playPause'
      | 'next'
      | 'previous'
      | 'seek'
      | 'setVolume'
      | 'setRepeat'
      | 'setShuffle';

    expectTypeOf<HookKeys>().toEqualTypeOf<ExpectedKeys>();
  });

  it('AMWrapperBridge.ipcRenderer includes send', () => {
    type IpcKeys = keyof AMWrapperBridge['ipcRenderer'];
    expectTypeOf<IpcKeys>().toEqualTypeOf<'send'>();
  });

  it('COMMANDS in musicKitHook.js matches keyof SidraHook', () => {
    // Exhaustive over SidraHook: renaming, adding or removing a method in
    // src/types/hook.d.ts without changing this list is a compile error.
    const hookMethods = {
      play: true,
      pause: true,
      playPause: true,
      next: true,
      previous: true,
      seek: true,
      setVolume: true,
      setRepeat: true,
      setShuffle: true,
    } satisfies Record<keyof SidraHook, true>;

    // Read the shipped hook rather than a parallel constant, so the two can
    // never drift apart unnoticed.
    const block = /const COMMANDS = new Set\(\[([^\]]*)\]\)/.exec(HOOK_SOURCE);
    expect(block, 'COMMANDS set not found in assets/musicKitHook.js').not.toBeNull();

    const commands = [...block![1].matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(commands).toEqual(Object.keys(hookMethods).sort());
  });

  it('now-playing fields in musicKitHook.js match NowPlayingPayload', () => {
    const payloadFields = {
      name: true,
      artistName: true,
      albumName: true,
      artworkUrl: true,
      durationInMillis: true,
      url: true,
      genreNames: true,
      trackId: true,
      trackNumber: true,
      discNumber: true,
      composerName: true,
      releaseDate: true,
      playParams: true,
      sourceHost: true,
    } satisfies Record<keyof NowPlayingPayload, true>;

    const block = /sendToMain\('nowPlayingItemDidChange', \{\n([\s\S]*?)^ {8}\}\);/m.exec(HOOK_SOURCE);
    expect(block, 'now-playing payload not found in assets/musicKitHook.js').not.toBeNull();

    const fields = [...block![1].matchAll(/^ {10}([A-Za-z]\w*):/gm)].map((match) => match[1]).sort();
    expect(fields).toEqual(Object.keys(payloadFields).sort());
  });
});

describe('Channel contract', () => {
  it('SendChannel matches expected renderer-to-main channels', () => {
    type ExpectedSend =
      | 'playbackStateDidChange'
      | 'nowPlayingItemDidChange'
      | 'timedMetadataDidChange'
      | 'playbackTimeDidChange'
      | 'repeatModeDidChange'
      | 'shuffleModeDidChange'
      | 'volumeDidChange'
      | 'nav:back'
      | 'nav:forward'
      | 'nav:reload';

    expectTypeOf<SendChannel>().toEqualTypeOf<ExpectedSend>();
  });

  it('ReceiveChannel matches expected main-to-renderer channels', () => {
    type ExpectedReceive =
      | 'player:play'
      | 'player:pause'
      | 'player:playPause'
      | 'player:next'
      | 'player:previous'
      | 'player:seek'
      | 'player:setVolume'
      | 'player:setRepeat'
      | 'player:setShuffle';

    expectTypeOf<ReceiveChannel>().toEqualTypeOf<ExpectedReceive>();
  });

  it('SidraCommandMessage has the expected shape', () => {
    type MsgType = SidraCommandMessage['type'];
    type MsgChannel = SidraCommandMessage['channel'];

    expectTypeOf<MsgType>().toEqualTypeOf<'sidra:command'>();
    expectTypeOf<MsgChannel>().toEqualTypeOf<ReceiveChannel>();
  });
});

describe('getShareUrl', () => {
  beforeEach(() => {
    state.service = 'music';
  });

  it('returns payload.url when present', () => {
    expect(getShareUrl({ url: 'https://music.apple.com/album/123?i=456' })).toBe(
      'https://music.apple.com/album/123?i=456',
    );
  });

  it('returns catalogId URL when payload.url is absent', () => {
    expect(getShareUrl({ playParams: { catalogId: '999' } })).toBe(
      'https://music.apple.com/song/999',
    );
  });

  it('returns globalId URL when both payload.url and catalogId are absent', () => {
    expect(getShareUrl({ playParams: { globalId: 'abc' } })).toBe(
      'https://music.apple.com/song/abc',
    );
  });

  it('prefers payload.url over playParams ids', () => {
    expect(
      getShareUrl({ url: 'https://example.com', playParams: { catalogId: '1', globalId: '2' } }),
    ).toBe('https://example.com');
  });

  it('prefers catalogId over globalId', () => {
    expect(getShareUrl({ playParams: { catalogId: '1', globalId: '2' } })).toBe(
      'https://music.apple.com/song/1',
    );
  });

  it('returns undefined when no URL source is available', () => {
    expect(getShareUrl({})).toBeUndefined();
  });

  it('returns undefined when playParams exists but has no ids', () => {
    expect(getShareUrl({ playParams: { kind: 'song', isLibrary: true } })).toBeUndefined();
  });

  // MPRIS OpenUri navigates to either service without calling switchService(),
  // so the window can sit on Classical while config still names music.
  it('uses the payload host when it names Classical and config names music', () => {
    expect(
      getShareUrl({ sourceHost: 'classical.music.apple.com', playParams: { catalogId: '42' } }),
    ).toBe('https://classical.music.apple.com/song/42');
  });

  // switchService() persists the new id before it navigates, and the tray rebuild
  // in between reads the previous service's payload, which is the reverse mismatch.
  it('uses the payload host when it names music and config names Classical', () => {
    state.service = 'classical';
    expect(
      getShareUrl({ sourceHost: 'music.apple.com', playParams: { globalId: 'abc' } }),
    ).toBe('https://music.apple.com/song/abc');
  });

  // A payload from a hook older than this field must keep its previous result
  // rather than losing the URL.
  it('falls back to the persisted service when the payload carries no host', () => {
    state.service = 'classical';
    expect(getShareUrl({ playParams: { catalogId: '42' } })).toBe(
      'https://classical.music.apple.com/song/42',
    );
  });

  // An unexpected host names no service, and guessing an origin from it would
  // build a URL for a host Sidra does not know.
  it('falls back to the persisted service when the payload host is unknown', () => {
    expect(
      getShareUrl({ sourceHost: 'beta.music.apple.com', playParams: { catalogId: '42' } }),
    ).toBe('https://music.apple.com/song/42');
  });
});
