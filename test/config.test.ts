import { describe, it, expect, expectTypeOf, beforeEach } from 'vitest';
import type { ThemeName } from '../src/theme';

// No mock of ../src/config here, deliberately. A hand-written stand-in would
// sit at this point in the file and every runtime assertion below would read
// that stand-in's own defaults back out, so a real defect in src/config.ts
// would pass. electron-conf/main is mocked globally in test/setup.ts, so the
// real module loads and runs unmodified.
import {
  getStorefront, setStorefront,
  getLanguage, setLanguage,
  getNotificationsEnabled, setNotificationsEnabled,
  getDiscordEnabled, setDiscordEnabled,
  getCloseToTrayEnabled, setCloseToTrayEnabled,
  getLastfmEnabled,
  getLastfmSessionKey, getLastfmUsername,
  setLastfmSession, clearLastfmSession,
  getPendingScrobbles, setPendingScrobbles,
  getTheme, setTheme,
  getAutoUpdateEnabled, setAutoUpdateEnabled,
  getLastPageUrl, setLastPageUrl,
  getStartPage, setStartPage,
  getZoomFactor, setZoomFactor,
  getMusicService, setMusicService,
  getClassicalStartPage, setClassicalStartPage,
  getClassicalLastPageUrl, setClassicalLastPageUrl,
  getStartPageFor, getLastPageUrlFor, setLastPageUrlFor,
} from '../src/config';
import type { PendingScrobble } from '../src/config';
import { Conf } from 'electron-conf/main';
import { DEFAULT_SERVICE_ID } from '../src/musicService';
import type { AnyStartPageId, ClassicalStartPageId, MusicServiceId } from '../src/musicService';

// Each assertion pins a getter return type or a setter parameter type against
// its StoreSchema key type, so a key whose type drifts fails at the boundary
// rather than at whichever caller happens to read it. expectTypeOf checks
// nothing at run time: Vitest transpiles without type-checking, so these only
// fail under `npx tsc -p tsconfig.test.json --noEmit`, which `just lint` runs.

describe('Config store type assertions', () => {
  it('getStorefront returns string | undefined', () => {
    expectTypeOf(getStorefront).returns.toEqualTypeOf<string | undefined>();
  });

  it('setStorefront accepts string', () => {
    expectTypeOf(setStorefront).parameter(0).toEqualTypeOf<string>();
  });

  it('getLanguage returns string | null | undefined', () => {
    expectTypeOf(getLanguage).returns.toEqualTypeOf<string | null | undefined>();
  });

  it('setLanguage accepts string | null', () => {
    expectTypeOf(setLanguage).parameter(0).toEqualTypeOf<string | null>();
  });

  it('getNotificationsEnabled returns boolean', () => {
    expectTypeOf(getNotificationsEnabled).returns.toEqualTypeOf<boolean>();
  });

  it('setNotificationsEnabled accepts boolean', () => {
    expectTypeOf(setNotificationsEnabled).parameter(0).toEqualTypeOf<boolean>();
  });

  it('getDiscordEnabled returns boolean', () => {
    expectTypeOf(getDiscordEnabled).returns.toEqualTypeOf<boolean>();
  });

  it('setDiscordEnabled accepts boolean', () => {
    expectTypeOf(setDiscordEnabled).parameter(0).toEqualTypeOf<boolean>();
  });

  it('getTheme returns ThemeName', () => {
    expectTypeOf(getTheme).returns.toEqualTypeOf<ThemeName>();
  });

  it('setTheme accepts ThemeName', () => {
    expectTypeOf(setTheme).parameter(0).toEqualTypeOf<ThemeName>();
  });

  it('getAutoUpdateEnabled returns boolean', () => {
    expectTypeOf(getAutoUpdateEnabled).returns.toEqualTypeOf<boolean>();
  });

  it('setAutoUpdateEnabled accepts boolean', () => {
    expectTypeOf(setAutoUpdateEnabled).parameter(0).toEqualTypeOf<boolean>();
  });

  it('getLastPageUrl returns string | undefined', () => {
    expectTypeOf(getLastPageUrl).returns.toEqualTypeOf<string | undefined>();
  });

  it('setLastPageUrl accepts string', () => {
    expectTypeOf(setLastPageUrl).parameter(0).toEqualTypeOf<string>();
  });

  it('getStartPage returns start page union', () => {
    expectTypeOf(getStartPage).returns.toEqualTypeOf<'home' | 'new' | 'radio' | 'all-playlists' | 'last'>();
  });

  it('setStartPage accepts start page union', () => {
    expectTypeOf(setStartPage).parameter(0).toEqualTypeOf<'home' | 'new' | 'radio' | 'all-playlists' | 'last'>();
  });

  it('getZoomFactor returns number', () => {
    expectTypeOf(getZoomFactor).returns.toEqualTypeOf<number>();
  });

  it('setZoomFactor accepts number', () => {
    expectTypeOf(setZoomFactor).parameter(0).toEqualTypeOf<number>();
  });

  it('getMusicService returns MusicServiceId', () => {
    expectTypeOf(getMusicService).returns.toEqualTypeOf<MusicServiceId>();
  });

  it('setMusicService accepts MusicServiceId', () => {
    expectTypeOf(setMusicService).parameter(0).toEqualTypeOf<MusicServiceId>();
  });

  it('getClassicalStartPage returns the Classical start page union', () => {
    expectTypeOf(getClassicalStartPage).returns.toEqualTypeOf<ClassicalStartPageId | 'last'>();
  });

  it('setClassicalStartPage accepts the Classical start page union', () => {
    expectTypeOf(setClassicalStartPage).parameter(0).toEqualTypeOf<ClassicalStartPageId | 'last'>();
  });

  it('getClassicalLastPageUrl returns string | undefined', () => {
    expectTypeOf(getClassicalLastPageUrl).returns.toEqualTypeOf<string | undefined>();
  });

  it('setClassicalLastPageUrl accepts string', () => {
    expectTypeOf(setClassicalLastPageUrl).parameter(0).toEqualTypeOf<string>();
  });

  it('getStartPageFor takes a MusicServiceId and returns the wide start page union', () => {
    expectTypeOf(getStartPageFor).parameter(0).toEqualTypeOf<MusicServiceId>();
    expectTypeOf(getStartPageFor).returns.toEqualTypeOf<AnyStartPageId | 'last'>();
  });

  it('getLastPageUrlFor takes a MusicServiceId and returns string | undefined', () => {
    expectTypeOf(getLastPageUrlFor).parameter(0).toEqualTypeOf<MusicServiceId>();
    expectTypeOf(getLastPageUrlFor).returns.toEqualTypeOf<string | undefined>();
  });

  it('setLastPageUrlFor takes a MusicServiceId and a string', () => {
    expectTypeOf(setLastPageUrlFor).parameter(0).toEqualTypeOf<MusicServiceId>();
    expectTypeOf(setLastPageUrlFor).parameter(1).toEqualTypeOf<string>();
  });

  it('getPendingScrobbles returns PendingScrobble[]', () => {
    expectTypeOf(getPendingScrobbles).returns.toEqualTypeOf<PendingScrobble[]>();
  });

  it('setPendingScrobbles accepts PendingScrobble[]', () => {
    expectTypeOf(setPendingScrobbles).parameter(0).toEqualTypeOf<PendingScrobble[]>();
  });
});

describe('Config store runtime behaviour', () => {
  // The electron-conf mock backs every Conf instance with one module-level map
  // and exposes it as a static for seeding. Shared process-wide within this file.
  const store = (Conf as unknown as { _data: Map<string, unknown> })._data;

  beforeEach(() => {
    store.clear();
  });

  it('getStorefront returns undefined when not set', () => {
    expect(getStorefront()).toBeUndefined();
  });

  it('setStorefront persists value', () => {
    setStorefront('gb');
    expect(getStorefront()).toBe('gb');
  });

  it('getNotificationsEnabled defaults to true', () => {
    expect(getNotificationsEnabled()).toBe(true);
  });

  it('getDiscordEnabled defaults to false', () => {
    expect(getDiscordEnabled()).toBe(false);
  });

  it('getTheme defaults to apple-music', () => {
    expect(getTheme()).toBe('apple-music');
  });

  it('getAutoUpdateEnabled defaults to true', () => {
    expect(getAutoUpdateEnabled()).toBe(true);
  });

  it('getStartPage defaults to new', () => {
    expect(getStartPage()).toBe('new');
  });

  it('getZoomFactor defaults to 1.0', () => {
    expect(getZoomFactor()).toBe(1.0);
  });

  it('getMusicService falls back to music when nothing is persisted', () => {
    expect(getMusicService()).toBe('music');
    expect(getMusicService()).toBe(DEFAULT_SERVICE_ID);
  });

  it('setMusicService persists value', () => {
    // Writes the non-default id, so a setter that never reached the store would fail here.
    setMusicService('classical');
    expect(getMusicService()).toBe('classical');
  });

  it('getMusicService falls back when the persisted id is unregistered', () => {
    store.set('musicService', 'jazz');
    expect(getMusicService()).toBe(DEFAULT_SERVICE_ID);
  });

  it('getMusicService returns music when persisted', () => {
    store.set('musicService', 'music');
    expect(getMusicService()).toBe('music');
  });

  it('getMusicService returns classical when persisted', () => {
    store.set('musicService', 'classical');
    expect(getMusicService()).toBe('classical');
  });

  it('getClassicalStartPage defaults to home', () => {
    expect(getClassicalStartPage()).toBe('home');
  });

  it('getClassicalStartPage returns the persisted value', () => {
    store.set('classical.startPage', 'search');
    expect(getClassicalStartPage()).toBe('search');
  });

  it('setClassicalStartPage persists value', () => {
    setClassicalStartPage('browse');
    expect(getClassicalStartPage()).toBe('browse');
  });

  it('setClassicalStartPage rejects a music start page at compile time', () => {
    // @ts-expect-error 'radio' is a music start page, not a Classical one
    setClassicalStartPage('radio');
    // The union is the only guard; the write itself is unchecked at runtime.
    expect(store.get('classical.startPage')).toBe('radio');
  });

  it('getClassicalLastPageUrl returns undefined when not set', () => {
    expect(getClassicalLastPageUrl()).toBeUndefined();
  });

  it('setClassicalLastPageUrl persists value', () => {
    setClassicalLastPageUrl('browse/albums');
    expect(getClassicalLastPageUrl()).toBe('browse/albums');
  });

  it('each last page reader reads its own service key', () => {
    // Different values on purpose: with both keys equal, a reader pointed at the
    // wrong key still returns the right answer and the test proves nothing.
    setLastPageUrl('https://music.apple.com/gb/new');
    setClassicalLastPageUrl('https://classical.music.apple.com/gb/browse/catalog');
    expect(getLastPageUrl()).toBe('https://music.apple.com/gb/new');
    expect(getClassicalLastPageUrl()).toBe('https://classical.music.apple.com/gb/browse/catalog');
  });

  it('language and storefront readers each read their own key', () => {
    // Two different values on purpose: with both keys equal, a reader pointed at
    // the other key still returns the right answer and proves nothing.
    store.set('storefront', 'gb');
    store.set('language', 'cy');
    expect(getStorefront()).toBe('gb');
    expect(getLanguage()).toBe('cy');
  });

  it('setLanguage persists to the language key and leaves storefront alone', () => {
    setLanguage('fr-CA');
    expect(getLanguage()).toBe('fr-CA');
    expect(getStorefront()).toBeUndefined();
  });

  it('setLanguage persists null and reads back as null', () => {
    // The signature allows null, meaning "no override"; a stored null must stay
    // distinguishable from a key that was never written.
    setLanguage(null);
    expect(getLanguage()).toBeNull();
  });

  it('getCloseToTrayEnabled defaults to false', () => {
    expect(getCloseToTrayEnabled()).toBe(false);
  });

  it('close-to-tray and Discord readers each read their own key', () => {
    // Opposite values, so a reader crossed onto the other key inverts its answer.
    store.set('closeToTray.enabled', true);
    store.set('discord.enabled', false);
    expect(getCloseToTrayEnabled()).toBe(true);
    expect(getDiscordEnabled()).toBe(false);
  });

  it('setCloseToTrayEnabled persists to the close-to-tray key only', () => {
    setCloseToTrayEnabled(true);
    expect(getCloseToTrayEnabled()).toBe(true);
    expect(getDiscordEnabled()).toBe(false);
  });

  it('getLastfmEnabled defaults to false', () => {
    expect(getLastfmEnabled()).toBe(false);
  });

  it('Last.fm session key and username readers each read their own key', () => {
    store.set('lastfm.sessionKey', 'sk-0123456789abcdef');
    store.set('lastfm.username', 'wimpysworld');
    expect(getLastfmSessionKey()).toBe('sk-0123456789abcdef');
    expect(getLastfmUsername()).toBe('wimpysworld');
  });

  it('setLastfmSession writes each argument to its own key', () => {
    // Clearly different values, so swapping the two arguments fails here.
    setLastfmSession('sk-0123456789abcdef', 'wimpysworld');
    expect(getLastfmSessionKey()).toBe('sk-0123456789abcdef');
    expect(getLastfmUsername()).toBe('wimpysworld');
  });

  it('clearLastfmSession sets both keys to null rather than removing them', () => {
    setLastfmSession('sk-0123456789abcdef', 'wimpysworld');
    clearLastfmSession();
    // Null, not undefined: the readers use the has-check variant, so a cleared
    // key and an absent key are different states. Asserting falsiness alone
    // would pass against a clear that did nothing at all.
    expect(getLastfmSessionKey()).toBeNull();
    expect(getLastfmUsername()).toBeNull();
  });

  it('getPendingScrobbles defaults to an empty queue', () => {
    expect(getPendingScrobbles()).toEqual([]);
  });

  it('setPendingScrobbles round-trips a queue', () => {
    const queue: PendingScrobble[] = [
      { artist: 'Underworld', track: 'Born Slippy', timestamp: 1700000000, album: 'Second Toughest', durationSec: 566 },
      { artist: 'Orbital', track: 'Halcyon', timestamp: 1700000600 },
    ];
    setPendingScrobbles(queue);
    expect(getPendingScrobbles()).toEqual(queue);
  });

  it('getPendingScrobbles returns an empty queue when the persisted value is not an array', () => {
    store.set('lastfm.pendingScrobbles', 'not-a-queue');
    expect(getPendingScrobbles()).toEqual([]);
  });

  it('getPendingScrobbles drops a malformed entry and keeps the valid one', () => {
    // A hand-edited or corrupted config must not produce a request the API can only refuse.
    store.set('lastfm.pendingScrobbles', [
      { artist: 'Orbital', track: 'Halcyon', timestamp: 1700000600 },
      { artist: 'Orbital', track: 'Chime', timestamp: 'yesterday' },
    ]);
    expect(getPendingScrobbles()).toEqual([{ artist: 'Orbital', track: 'Halcyon', timestamp: 1700000600 }]);
  });

  it('getPendingScrobbles keeps a valid entry with both optional fields absent', () => {
    // The guard must not be so strict that it discards the user's real history:
    // album and duration are optional and a play without either is normal.
    const entry = { artist: 'Orbital', track: 'Halcyon', timestamp: 1700000600 };
    store.set('lastfm.pendingScrobbles', [entry]);
    expect(getPendingScrobbles()).toEqual([entry]);
  });

  it('getPendingScrobbles keeps a valid entry with both optional fields present', () => {
    const entry = {
      artist: 'Underworld',
      track: 'Born Slippy',
      timestamp: 1700000000,
      album: 'Second Toughest',
      durationSec: 566,
    };
    store.set('lastfm.pendingScrobbles', [entry]);
    expect(getPendingScrobbles()).toEqual([entry]);
  });

  it('getPendingScrobbles drops an entry whose album is not a string', () => {
    // A malformed optional field is stringified into the batch parameters and
    // Last.fm refuses the whole batch, so one bad entry costs every queued play.
    store.set('lastfm.pendingScrobbles', [
      { artist: 'Orbital', track: 'Chime', timestamp: 1700000600, album: 42 },
    ]);
    expect(getPendingScrobbles()).toEqual([]);
  });

  it('getPendingScrobbles drops an entry whose durationSec is not an integer', () => {
    store.set('lastfm.pendingScrobbles', [
      { artist: 'Orbital', track: 'Chime', timestamp: 1700000600, durationSec: 312.5 },
    ]);
    expect(getPendingScrobbles()).toEqual([]);
  });

  it('getPendingScrobbles drops an entry whose durationSec is zero or negative', () => {
    store.set('lastfm.pendingScrobbles', [
      { artist: 'Orbital', track: 'Chime', timestamp: 1700000600, durationSec: 0 },
      { artist: 'Orbital', track: 'Chime', timestamp: 1700000601, durationSec: -312 },
    ]);
    expect(getPendingScrobbles()).toEqual([]);
  });

  it('getPendingScrobbles drops an entry with an empty artist or track', () => {
    store.set('lastfm.pendingScrobbles', [
      { artist: '', track: 'Chime', timestamp: 1700000600 },
      { artist: 'Orbital', track: '', timestamp: 1700000601 },
    ]);
    expect(getPendingScrobbles()).toEqual([]);
  });

  it('getPendingScrobbles drops an entry whose timestamp is not a positive integer', () => {
    store.set('lastfm.pendingScrobbles', [
      { artist: 'Orbital', track: 'Chime', timestamp: 1700000600.5 },
      { artist: 'Orbital', track: 'Chime', timestamp: -1700000600 },
      { artist: 'Orbital', track: 'Chime', timestamp: 0 },
    ]);
    expect(getPendingScrobbles()).toEqual([]);
  });

  it('getPendingScrobbles drops an entry timestamped in the future and keeps the valid one', () => {
    // Last.fm ignores a future scrobble without an API error, so the flush reads
    // success and drops the whole batch, taking the valid plays beside it. The
    // millisecond value is what a hand-edited store most often holds.
    store.set('lastfm.pendingScrobbles', [
      { artist: 'Orbital', track: 'Halcyon', timestamp: 1700000600 },
      { artist: 'Orbital', track: 'Chime', timestamp: 4102444800 },
      { artist: 'Underworld', track: 'Born Slippy', timestamp: 1700000000000 },
    ]);
    expect(getPendingScrobbles()).toEqual([{ artist: 'Orbital', track: 'Halcyon', timestamp: 1700000600 }]);
  });

  it('setStartPage persists to the music start page key, not the Classical one', () => {
    setStartPage('radio');
    expect(getStartPage()).toBe('radio');
    expect(getClassicalStartPage()).toBe('home');
  });

  it('setZoomFactor persists to the zoom key and leaves the start page alone', () => {
    setZoomFactor(1.25);
    expect(getZoomFactor()).toBe(1.25);
    expect(getStartPage()).toBe('new');
  });

  // SERVICE_PAGE_ACCESSORS is the only place a service id maps to its stored keys,
  // so every case below asserts on both ids at once. A test that named one service
  // would still pass with the two rows of that table swapped.

  it('getStartPageFor returns each service default when nothing is persisted', () => {
    // The two defaults differ, so swapping the rows of the table inverts both answers.
    expect(getStartPageFor('music')).toBe('new');
    expect(getStartPageFor('classical')).toBe('home');
  });

  it('getStartPageFor reads each service its own start page key', () => {
    // Ids from different services on purpose: with one id stored under both keys,
    // a reader pointed at the wrong key still returns the right answer.
    store.set('startPage', 'radio');
    store.set('classical.startPage', 'search');
    expect(getStartPageFor('music')).toBe('radio');
    expect(getStartPageFor('classical')).toBe('search');
  });

  it('getStartPageFor returns an unregistered stored id unchanged', () => {
    // Config reports what is stored and validates nothing. A store written by an
    // older build still holds the removed Classical 'library' id, and the fallback
    // to the service default happens in buildAppleMusicURL, which matches the id
    // against the service's own startPages. test/storefront.test.ts covers that.
    store.set('classical.startPage', 'library');
    store.set('startPage', 'browse');
    expect(getStartPageFor('classical')).toBe('library');
    expect(getStartPageFor('music')).toBe('browse');
  });

  it('getStartPageFor returns the stored last marker for either service', () => {
    store.set('startPage', 'last');
    store.set('classical.startPage', 'last');
    expect(getStartPageFor('music')).toBe('last');
    expect(getStartPageFor('classical')).toBe('last');
  });

  it('getLastPageUrlFor returns undefined for either service when nothing is persisted', () => {
    // Absence is a state of its own: buildAppleMusicURL falls through to the
    // service default only because the getter reports undefined rather than ''.
    expect(getLastPageUrlFor('music')).toBeUndefined();
    expect(getLastPageUrlFor('classical')).toBeUndefined();
  });

  it('getLastPageUrlFor reads each service its own last page key', () => {
    store.set('lastPageUrl', 'new');
    store.set('classical.lastPageUrl', 'browse/albums');
    expect(getLastPageUrlFor('music')).toBe('new');
    expect(getLastPageUrlFor('classical')).toBe('browse/albums');
  });

  it('setLastPageUrlFor writes the music key and leaves the Classical one unset', () => {
    // Asserts on the raw keys, so the stored key name is pinned here and not
    // merely round-tripped through a getter that could be crossed the same way.
    setLastPageUrlFor('music', 'library/all-playlists/');
    expect(store.get('lastPageUrl')).toBe('library/all-playlists/');
    expect(store.has('classical.lastPageUrl')).toBe(false);
  });

  it('setLastPageUrlFor writes the Classical key and leaves the music one unset', () => {
    setLastPageUrlFor('classical', 'browse/playlists');
    expect(store.get('classical.lastPageUrl')).toBe('browse/playlists');
    expect(store.has('lastPageUrl')).toBe(false);
  });

  it('setLastPageUrlFor round-trips through the matching reader for both services', () => {
    setLastPageUrlFor('music', 'new');
    setLastPageUrlFor('classical', 'search?term=elgar');
    expect(getLastPageUrlFor('music')).toBe('new');
    expect(getLastPageUrlFor('classical')).toBe('search?term=elgar');
  });
});
