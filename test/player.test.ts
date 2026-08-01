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

import { PlaybackState, Player, getShareUrl, type PlayerEvents } from '../src/player';

/** The shipped hook, read so the command contract is checked against real source. */
const HOOK_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'musicKitHook.js'),
  'utf-8',
);

describe('PlaybackState', () => {
  // The hook and every integration read these numbers, so each one is pinned.
  const STATE_TABLE: ReadonlyArray<readonly [keyof typeof PlaybackState, number]> = [
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

  it.each(STATE_TABLE)('%s is %i', (name, value) => {
    expect(PlaybackState[name]).toBe(value);
  });

  it('has exactly 10 states', () => {
    expect(Object.keys(PlaybackState)).toHaveLength(10);
  });
});

describe('PlayerEvents', () => {
  it('keys match Player handler event names', () => {
    type EventKeys = keyof PlayerEvents;
    type ExpectedKeys =
      | 'playbackStateDidChange'
      | 'nowPlayingItemDidChange'
      | 'playbackTimeDidChange'
      | 'repeatModeDidChange'
      | 'shuffleModeDidChange'
      | 'volumeDidChange';

    expectTypeOf<EventKeys>().toEqualTypeOf<ExpectedKeys>();
  });
});

/** Every handle* method is named after the event it receives. */
type HandlerName = `handle${Capitalize<keyof PlayerEvents>}`;

/**
 * Calls a handler chosen by a table row. The row types keep the name and the
 * payload correlated, but a union of rows leaves the compiler unable to pair
 * one with the other at the call site, so the cast is confined to here.
 */
function invokeHandler(player: Player, handler: HandlerName, payload: unknown): void {
  (player[handler] as (this: Player, payload: unknown) => void).call(player, payload);
}

describe('Player event forwarding', () => {
  // Each row pairs an event with its handler and a payload the event declares,
  // so a mismatched handler or a payload of the wrong type fails tsc.
  type ForwardingCase = {
    [K in keyof PlayerEvents]: readonly [
      event: K,
      handler: `handle${Capitalize<K>}`,
      payload: PlayerEvents[K][0],
    ];
  }[keyof PlayerEvents];

  const FORWARDING_TABLE: readonly ForwardingCase[] = [
    [
      'playbackStateDidChange',
      'handlePlaybackStateDidChange',
      { status: true, state: PlaybackState.Playing },
    ],
    [
      'nowPlayingItemDidChange',
      'handleNowPlayingItemDidChange',
      { name: 'Track', artistName: 'Artist' },
    ],
    ['playbackTimeDidChange', 'handlePlaybackTimeDidChange', 42000],
    ['repeatModeDidChange', 'handleRepeatModeDidChange', 2],
    ['shuffleModeDidChange', 'handleShuffleModeDidChange', 1],
    ['volumeDidChange', 'handleVolumeDidChange', 0.75],
  ];

  it.each(FORWARDING_TABLE)('emits %s with its payload', (event, handler, payload) => {
    const player = new Player();
    const listener = vi.fn();
    player.on(event, listener);

    invokeHandler(player, handler, payload);

    expect(listener).toHaveBeenCalledWith(payload);
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

// Every handle* method takes its argument straight off an IPC channel, where
// nothing is typed, so a malformed payload must be dropped rather than emitted:
// integrations read these events as though the declared type held.
describe('Player handle* payload validation', () => {
  // The payload is deliberately untyped here: these are the values the declared
  // type rules out, and the handler must drop each one.
  type ValidationCase = {
    [K in keyof PlayerEvents]: readonly [
      event: K,
      handler: `handle${Capitalize<K>}`,
      payload: unknown,
    ];
  }[keyof PlayerEvents];

  const VALIDATION_TABLE: readonly ValidationCase[] = [
    ['playbackStateDidChange', 'handlePlaybackStateDidChange', 'invalid'],
    ['playbackStateDidChange', 'handlePlaybackStateDidChange', { status: true }],
    ['playbackStateDidChange', 'handlePlaybackStateDidChange', { status: true, state: 'playing' }],
    ['nowPlayingItemDidChange', 'handleNowPlayingItemDidChange', 'invalid'],
    ['nowPlayingItemDidChange', 'handleNowPlayingItemDidChange', [1, 2, 3]],
    ['playbackTimeDidChange', 'handlePlaybackTimeDidChange', 'not-a-number'],
    ['playbackTimeDidChange', 'handlePlaybackTimeDidChange', undefined],
    ['repeatModeDidChange', 'handleRepeatModeDidChange', 'repeat'],
    ['shuffleModeDidChange', 'handleShuffleModeDidChange', 'shuffle'],
    ['volumeDidChange', 'handleVolumeDidChange', 'loud'],
    ['volumeDidChange', 'handleVolumeDidChange', { volume: 0.5 }],
  ];

  it.each(VALIDATION_TABLE)('$1 ignores $2', (event, handler, payload) => {
    const player = new Player();
    const listener = vi.fn();
    player.on(event, listener);

    invokeHandler(player, handler, payload);

    expect(listener).not.toHaveBeenCalled();
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
});

describe('Channel contract', () => {
  it('SendChannel matches expected renderer-to-main channels', () => {
    type ExpectedSend =
      | 'playbackStateDidChange'
      | 'nowPlayingItemDidChange'
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
