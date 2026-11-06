import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'fastPlaylistQueue.js'),
  'utf-8',
);

const PLAYLIST = 'p.large';
const SHUFFLE_SONGS = 1;

interface Track {
  id: string;
  type: string;
  attributes: { playParams?: { id: string } };
}

function track(id: string, playable = true): Track {
  return {
    id,
    type: 'library-songs',
    attributes: playable ? { playParams: { id } } : {},
  };
}

interface QueueRequest {
  items?: Track[];
  playlists?: string[];
  startWith?: string | { id: string; type: string };
  context?: unknown;
  url?: string;
}

/** Records MusicKit calls, and serves a playlist from memory as the API would. */
function fakeMusicKit(tracks: Track[]) {
  const originalSetQueue = vi.fn(async (request: QueueRequest) => {
    const startWith = request?.startWith;
    if (typeof startWith === 'string') mk.nowPlayingItem = { id: startWith };
    return 'queue';
  });
  const music = vi.fn(async (url: string, params?: { limit?: number; offset?: number }) => {
    const song = /\/v1\/me\/library\/songs\/(.+)$/.exec(url);
    if (song) return { data: { data: tracks.filter((t) => t.id === song[1]) } };
    if (url.endsWith('/tracks')) {
      const offset = params?.offset ?? 0;
      const limit = params?.limit ?? 100;
      return {
        data: {
          data: tracks.slice(offset, offset + limit),
          meta: { total: tracks.length },
        },
      };
    }
    return { data: { data: [{ attributes: { lastModifiedDate: mk.modified } }] } };
  });
  const mk = {
    modified: '2026-11-01',
    shuffleMode: 0,
    queue: { length: 1 },
    nowPlayingItem: null as { id: string } | null,
    api: { music },
    setQueue: originalSetQueue as unknown as (request: unknown) => Promise<unknown>,
    setStationQueue: vi.fn(async () => 'station'),
    play: vi.fn(async () => undefined),
    playLater: vi.fn(async () => undefined),
    unauthorize: vi.fn(async () => undefined),
  };
  return { mk, originalSetQueue, music };
}

function runScript(mk: unknown, pathname = '/eg/home', extra: Record<string, unknown> = {}) {
  const window: Record<string, unknown> = {
    MusicKit: { getInstance: () => mk },
    location: { pathname },
  };
  vm.runInNewContext(source, {
    window,
    setInterval,
    setTimeout,
    structuredClone,
    console: { warn: vi.fn() },
    Date,
    Math,
    Map,
    Set,
    WeakSet,
    Promise,
    Array,
    Object,
    Error,
    Boolean,
    ...extra,
  });
  return window;
}

function manyTracks(count: number): Track[] {
  return Array.from({ length: count }, (_, i) => track(`i.${i}`));
}

/** A small IndexedDB stand-in with the two stores the script uses. */
interface ListRecord {
  id: string;
  version?: string;
  order?: string[];
  used?: Record<string, number>;
}

function fakeIndexedDB(upgradeFrom?: number) {
  const store = new Map<string, ListRecord>();
  const songs = new Map<string, Track>();
  const request = <T>(run: () => T) => {
    const pending: { result?: T; onsuccess?: () => void; onerror?: () => void } = {};
    queueMicrotask(() => {
      pending.result = run();
      pending.onsuccess?.();
    });
    return pending;
  };
  const objectStore = {
    get: (id: string) => request(() => store.get(id)),
    getAll: () => request(() => [...store.values()]),
    put: vi.fn((entry: ListRecord) =>
      request(() => {
        store.set(entry.id, structuredClone(entry));
        return entry.id;
      }),
    ),
    clear: () => request(() => store.clear()),
    getAllKeys: () => request(() => [...store.keys()]),
    delete: vi.fn((id: string) => request(() => store.delete(id))),
  };
  const songStore = {
    get: (id: string) => request(() => songs.get(id)),
    getAll: () => request(() => [...songs.values()]),
    put: vi.fn((item: Track) =>
      request(() => {
        songs.set(item.id, structuredClone(item));
        return item.id;
      }),
    ),
    clear: () => request(() => songs.clear()),
    delete: vi.fn((id: string) => request(() => songs.delete(id))),
  };
  const createObjectStore = vi.fn();
  const upgradeClear = vi.fn();
  const db = {
    createObjectStore,
    transaction: (_names: string[], _mode: string) => ({
      objectStore: (name: string) => (name === 'songs' ? songStore : objectStore),
    }),
    close: () => undefined,
  };
  const open = vi.fn((_name: string, _version: number) => {
    const pending: {
      result: typeof db;
      onsuccess?: () => void;
      onupgradeneeded?: (event?: { oldVersion: number }) => void;
      transaction?: { objectStore: () => { clear: () => void } };
    } = { result: db };
    pending.transaction = { objectStore: () => ({ clear: upgradeClear }) };
    queueMicrotask(() => {
      pending.onupgradeneeded?.(upgradeFrom === undefined ? undefined : { oldVersion: upgradeFrom });
      pending.onsuccess?.();
    });
    return pending;
  });
  return { store, songs, open, createObjectStore, objectStore, songStore, upgradeClear };
}

const USAGE_KEY = '__usage';
const DAY_MS = 24 * 60 * 60 * 1000;

type FakeStorage = ReturnType<typeof fakeIndexedDB>;

function savedLists(indexedDB: FakeStorage) {
  return [...indexedDB.store.keys()].filter((key) => key !== USAGE_KEY);
}

/** Puts a playlist into storage the way the script saves one. */
function seedList(indexedDB: FakeStorage, id: string, version: string, items: Track[], usedAt = Date.now()) {
  indexedDB.store.set(id, { id, version, order: items.map((item) => item.id) });
  for (const item of items) indexedDB.songs.set(item.id, structuredClone(item));
  const usage = indexedDB.store.get(USAGE_KEY) ?? { id: USAGE_KEY, used: {} };
  usage.used = { ...usage.used, [id]: usedAt };
  indexedDB.store.set(USAGE_KEY, usage);
}

function savedItems(indexedDB: FakeStorage, id: string) {
  return indexedDB.store.get(id)?.order?.map((songId) => indexedDB.songs.get(songId));
}

function playlistRequest(startWith?: { id: string; type: string }) {
  return {
    context: { featureName: 'library / playlist_detail' },
    playlists: [PLAYLIST],
    parameters: { l: 'en-GB' },
    ...(startWith ? { startWith } : {}),
  };
}

/** Let the script's install poll and any background work finish. */
async function settle(ms = 1100) {
  await vi.advanceTimersByTimeAsync(ms);
}

describe('fastPlaylistQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const tracks = [
    track('i.0'),
    track('i.1'),
    track('i.unplayable', false),
    track('i.3'),
    track('i.4'),
  ];

  async function primedWith(indexedDB: ReturnType<typeof fakeIndexedDB>) {
    const fake = fakeMusicKit(tracks);
    runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
    await settle();
    fake.music.mockClear();
    return fake;
  }

  async function primed() {
    const fake = fakeMusicKit(tracks);
    runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`);
    await settle();
    fake.music.mockClear();
    return fake;
  }

  it('prepares the track list when a playlist page opens', async () => {
    const fake = fakeMusicKit(tracks);
    runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`);
    await settle();
    expect(fake.music).toHaveBeenCalled();
  });

  it('starts a chosen song from the saved list without waiting on any page request', async () => {
    const { mk, originalSetQueue, music } = await primed();
    await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));

    const sent = originalSetQueue.mock.calls[0]?.[0];
    expect(sent?.playlists).toBeUndefined();
    expect(sent?.startWith).toBe('i.3');
    expect(sent?.context).toEqual({ featureName: 'library / playlist_detail' });
    expect(music.mock.calls.some(([url, params]) => url.endsWith('/tracks') && params?.limit === 100)).toBe(false);
  });

  it('leaves unplayable tracks out so later queue positions do not shift', async () => {
    const { mk, originalSetQueue } = await primed();
    await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
    expect(originalSetQueue.mock.calls[0]?.[0].items?.map((t) => t.id)).toEqual([
      'i.0',
      'i.1',
      'i.3',
      'i.4',
    ]);
  });

  it('starts the Play button at the first playable track', async () => {
    const { mk, originalSetQueue } = await primed();
    await mk.setQueue(playlistRequest({ id: PLAYLIST, type: 'playlists' }));
    expect(originalSetQueue.mock.calls[0]?.[0].startWith).toBe('i.0');
  });

  it('uses the standard queue for a chosen song while shuffle is on', async () => {
    const { mk, originalSetQueue } = await primed();
    mk.shuffleMode = SHUFFLE_SONGS;
    const request = playlistRequest({ id: 'i.4', type: 'songs' });
    await mk.setQueue(request);
    expect(originalSetQueue).toHaveBeenCalledWith(request);
    expect(mk.shuffleMode).toBe(SHUFFLE_SONGS);
  });

  it('lets MusicKit shuffle the saved list without touching the shuffle setting', async () => {
    const { mk, originalSetQueue } = await primed();
    mk.shuffleMode = SHUFFLE_SONGS;
    const modes: number[] = [];
    originalSetQueue.mockImplementationOnce(async () => {
      modes.push(mk.shuffleMode);
      return 'queue';
    });

    await mk.setQueue(playlistRequest({ id: PLAYLIST, type: 'playlists' }));

    const sent = originalSetQueue.mock.calls[0]?.[0];
    expect(sent?.items).toHaveLength(4);
    expect(sent?.startWith).toBeUndefined();
    expect(modes).toEqual([SHUFFLE_SONGS]);
    expect(mk.shuffleMode).toBe(SHUFFLE_SONGS);
  });

  it("leaves starting playback to Apple's page", async () => {
    const { mk } = await primed();
    await mk.setQueue(playlistRequest({ id: PLAYLIST, type: 'playlists' }));
    expect(mk.play).not.toHaveBeenCalled();
  });

  it('uses the standard queue for a song missing from the saved list', async () => {
    const { mk, originalSetQueue } = await primed();
    const request = playlistRequest({ id: 'i.added-elsewhere', type: 'songs' });
    await mk.setQueue(request);
    expect(originalSetQueue).toHaveBeenCalledWith(request);
  });

  it('plays one song first and queues the rest behind it when nothing is saved', async () => {
    const { mk, originalSetQueue } = fakeMusicKit(tracks);
    runScript(mk);
    await settle();

    const started = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
    await settle(10);
    await started;
    expect(originalSetQueue.mock.calls[0]?.[0].items?.map((t) => t.id)).toEqual(['i.1']);

    await settle(10);
    const later = mk.playLater.mock.calls as unknown as [{ items: Track[] }][];
    expect(later[0]?.[0].items.map((t) => t.id)).toEqual(['i.3', 'i.4']);
  });

  it('does not queue remaining tracks over something the user started since', async () => {
    const { mk, music } = fakeMusicKit(tracks);
    runScript(mk);
    await settle();

    // Hold the track list back, so the new request arrives while the fill is still pending.
    const answer = music.getMockImplementation();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    music.mockImplementation(async (url, params) => {
      if (!url.includes('/songs/')) await held;
      return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
    });

    const started = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
    await settle(1);
    await started;
    await mk.setQueue({ url: 'https://music.apple.com/eg/album/1' });
    release();
    await settle(10);
    expect(music).toHaveBeenCalledWith(expect.stringContaining('/tracks'), expect.anything());
    expect(mk.playLater).not.toHaveBeenCalled();
  });

  it('falls back to the standard queue when the API fails', async () => {
    const { mk, originalSetQueue, music } = fakeMusicKit(tracks);
    runScript(mk);
    await settle();
    music.mockRejectedValue(new Error('offline'));

    const request = playlistRequest({ id: 'i.1', type: 'songs' });
    await mk.setQueue(request);
    expect(originalSetQueue).toHaveBeenCalledWith(request);
  });

  it.each([
    ['an album', { albums: ['1'] }],
    ['a catalogue playlist', { playlists: ['pl.abc'] }],
    ['a URL', { url: 'https://music.apple.com/eg/album/1' }],
    ['several playlists', { playlists: ['p.a', 'p.b'] }],
    ['an option it does not understand', { playlists: [PLAYLIST], seekTime: 30 }],
  ])('passes %s straight through', async (_label, request) => {
    const { mk, originalSetQueue } = fakeMusicKit(tracks);
    runScript(mk);
    await settle();
    await mk.setQueue(request);
    expect(originalSetQueue).toHaveBeenCalledWith(request);
  });

  it('leaves a request not to start playing to the standard queue', async () => {
    const { mk, originalSetQueue } = await primed();
    mk.shuffleMode = SHUFFLE_SONGS;
    const request = { ...playlistRequest({ id: PLAYLIST, type: 'playlists' }), startPlaying: false };
    await mk.setQueue(request);
    expect(originalSetQueue).toHaveBeenCalledWith(request);
    expect(mk.play).not.toHaveBeenCalled();
  });

  it('keeps other copies of a duplicate when filling a shuffled queue', async () => {
    const duplicated = [track('i.0'), track('i.dup'), track('i.2'), track('i.dup')];
    const { mk } = fakeMusicKit(duplicated);
    runScript(mk);
    await settle();
    mk.shuffleMode = SHUFFLE_SONGS;
    vi.spyOn(Math, 'random').mockReturnValue(0.3);

    await mk.setQueue(playlistRequest({ id: PLAYLIST, type: 'playlists' }));
    await settle(10);

    const later = mk.playLater.mock.calls as unknown as [{ items: Track[] }][];
    expect(later[0]?.[0].items.map((t) => t.id).sort()).toEqual(['i.0', 'i.2', 'i.dup']);
  });

  it('retries filling the queue after a failure', async () => {
    const { mk, music } = fakeMusicKit(tracks);
    runScript(mk);
    await settle();
    const answer = music.getMockImplementation();
    let failing = true;
    music.mockImplementation(async (url, params) => {
      if (failing && !url.includes('/songs/')) throw new Error('offline');
      return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
    });

    const started = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
    await settle(10);
    await started;
    expect(mk.playLater).not.toHaveBeenCalled();

    failing = false;
    await settle(2100);
    const later = mk.playLater.mock.calls as unknown as [{ items: Track[] }][];
    expect(later[0]?.[0].items.map((t) => t.id)).toEqual(['i.3', 'i.4']);
  });

  it('retries when adding the remaining tracks fails', async () => {
    const { mk } = fakeMusicKit(tracks);
    runScript(mk);
    await settle();
    mk.playLater.mockRejectedValueOnce(new Error('rejected'));

    const started = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
    await settle(10);
    await started;
    await settle(2100);

    expect(mk.playLater).toHaveBeenCalledTimes(2);
  });

  it('falls back to the standard queue when MusicKit builds an empty queue', async () => {
    const { mk, originalSetQueue } = await primed();
    mk.queue = { length: 0 };
    const request = playlistRequest({ id: 'i.3', type: 'songs' });
    await mk.setQueue(request);
    expect(originalSetQueue).toHaveBeenLastCalledWith(request);
    expect(originalSetQueue).toHaveBeenCalledTimes(2);
  });

  it('falls back to the standard queue when the fast queue fails', async () => {
    const { mk, originalSetQueue } = await primed();
    originalSetQueue.mockRejectedValueOnce(new Error('rejected'));
    const request = playlistRequest({ id: PLAYLIST, type: 'playlists' });
    await mk.setQueue(request);
    expect(originalSetQueue).toHaveBeenLastCalledWith(request);
    expect(originalSetQueue).toHaveBeenCalledTimes(2);
  });

  it('forgets saved lists on sign-out', async () => {
    const { mk, originalSetQueue } = await primed();
    await mk.unauthorize();

    const started = mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
    await settle(1);
    await started;

    expect(originalSetQueue.mock.calls[0]?.[0].items?.map((t) => t.id)).toEqual(['i.3']);
  });

  describe('which requests it handles', () => {
    it.each([
      ['no options', undefined],
      ['null options', null],
      ['text instead of options', 'p.large'],
      ['an empty playlist list', { playlists: [] }],
      ['playlists that are not a list', { playlists: PLAYLIST }],
      ['a playlist ID that is not text', { playlists: [1] }],
      ['a number as the start', { playlists: [PLAYLIST], startWith: 2 }],
      ['text as the start', { playlists: [PLAYLIST], startWith: 'i.1' }],
      ['null as the start', { playlists: [PLAYLIST], startWith: null }],
      ['a start ID that is not text', { playlists: [PLAYLIST], startWith: { id: 1, type: 'songs' } }],
      ['a start of another type', { playlists: [PLAYLIST], startWith: { id: 'a.1', type: 'albums' } }],
      ['ready-made items', { items: [track('i.0')] }],
      ['ready-made items beside a playlist', { playlists: [PLAYLIST], items: [] }],
      ['a single song', { song: '123' }],
      ['startPlaying false', { playlists: [PLAYLIST], startPlaying: false }],
    ])('passes %s straight through', async (_label, request) => {
      const { mk, originalSetQueue, music } = fakeMusicKit(tracks);
      runScript(mk);
      await settle();
      await mk.setQueue(request);
      expect(originalSetQueue).toHaveBeenCalledWith(request);
      expect(music).not.toHaveBeenCalled();
    });

    it('handles a playlist request with no start at all', async () => {
      const { mk, originalSetQueue } = await primed();
      await mk.setQueue({ playlists: [PLAYLIST] });
      expect(originalSetQueue.mock.calls[0]?.[0].startWith).toBe('i.0');
    });

    it('keeps startPlaying true, the context and the parameters', async () => {
      const { mk, originalSetQueue } = await primed();
      await mk.setQueue({ ...playlistRequest({ id: 'i.3', type: 'songs' }), startPlaying: true });
      const sent = originalSetQueue.mock.calls[0]?.[0] as Record<string, unknown>;
      expect(sent.startPlaying).toBe(true);
      expect(sent.parameters).toEqual({ l: 'en-GB' });
      expect(sent.playlists).toBeUndefined();
    });
  });

  describe('fetching a playlist', () => {
    it('collects every page in playlist order', async () => {
      const long = manyTracks(350);
      const { mk, originalSetQueue } = fakeMusicKit(long);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle();
      await mk.setQueue(playlistRequest({ id: PLAYLIST, type: 'playlists' }));
      expect(originalSetQueue.mock.calls[0]?.[0].items?.map((t) => t.id)).toEqual(long.map((t) => t.id));
    });

    it('never asks for more than four pages at once', async () => {
      const { mk, music } = fakeMusicKit(manyTracks(1787));
      const answer = music.getMockImplementation();
      let active = 0;
      let peak = 0;
      music.mockImplementation(async (url, params) => {
        const paging = (params?.limit ?? 0) === 100;
        if (paging) peak = Math.max(peak, (active += 1));
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (paging) active -= 1;
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle(2000);
      expect(peak).toBe(4);
    });

    it('makes one page request for a playlist of exactly one page', async () => {
      const { mk, music } = fakeMusicKit(manyTracks(100));
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle();
      const pages = music.mock.calls.filter(([url, params]) => url.endsWith('/tracks') && params?.limit === 100);
      expect(pages).toHaveLength(1);
    });

    it('treats a playlist with no playable tracks as nothing to speed up', async () => {
      const { mk, originalSetQueue } = fakeMusicKit([track('i.a', false), track('i.b', false)]);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle();
      const request = playlistRequest({ id: PLAYLIST, type: 'playlists' });
      await mk.setQueue(request);
      expect(originalSetQueue).toHaveBeenCalledWith(request);
    });

    it('starts on the first playable track when the first track is unplayable', async () => {
      const { mk, originalSetQueue } = fakeMusicKit([track('i.a', false), track('i.b'), track('i.c')]);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle();
      await mk.setQueue(playlistRequest({ id: PLAYLIST, type: 'playlists' }));
      expect(originalSetQueue.mock.calls[0]?.[0].startWith).toBe('i.b');
    });
  });

  describe('keeping the saved list current', () => {
    const trackPages = (music: ReturnType<typeof fakeMusicKit>['music']) =>
      music.mock.calls.filter(([url, params]) => url.endsWith('/tracks') && params?.limit === 100).length;

    it('checks for changes on every play, with two small requests and no track pages', async () => {
      const { mk, music, originalSetQueue } = await primed();
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      expect(music).toHaveBeenCalledTimes(2);
      expect(trackPages(music)).toBe(0);
      expect(originalSetQueue.mock.calls[0]?.[0].items).toHaveLength(4);
    });
    it('checks after a minute and fetches nothing more when unchanged', async () => {
      const { mk, music } = await primed();
      await settle(61000);
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await settle(10);
      expect(music).toHaveBeenCalledTimes(2);
      expect(trackPages(music)).toBe(0);
    });

    it('uses the standard queue for a play right after the modified date changes', async () => {
      const { mk, music, originalSetQueue } = await primed();
      mk.modified = '2026-11-02';
      const request = playlistRequest({ id: 'i.3', type: 'songs' });
      await mk.setQueue(request);
      expect(originalSetQueue).toHaveBeenCalledOnce();
      expect(originalSetQueue).toHaveBeenCalledWith(request);
      await settle(10);
      expect(trackPages(music)).toBe(1);
    });

    it('uses the refreshed list for the play after a change', async () => {
      const { mk, originalSetQueue } = await primed();
      mk.modified = '2026-11-02';
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await settle(10);
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      expect(originalSetQueue.mock.calls[1]?.[0].items).toHaveLength(4);
      expect(originalSetQueue.mock.calls[1]?.[0].playlists).toBeUndefined();
    });
    it('never queues a track that was just removed, from the total alone', async () => {
      const list = [track('i.0'), track('i.1'), track('i.2')];
      const { mk, originalSetQueue } = fakeMusicKit(list);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle();
      list.pop();

      const request = playlistRequest({ id: PLAYLIST, type: 'playlists' });
      await mk.setQueue(request);
      expect(originalSetQueue).toHaveBeenLastCalledWith(request);
      await settle(10);
      await mk.setQueue(request);
      expect(originalSetQueue.mock.lastCall?.[0].items?.map((t) => t.id)).toEqual(['i.0', 'i.1']);
    });

    it('never misses a track that was just added', async () => {
      const list = [track('i.0'), track('i.1')];
      const { mk, originalSetQueue } = fakeMusicKit(list);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle();
      list.push(track('i.2'));
      const request = playlistRequest({ id: PLAYLIST, type: 'playlists' });
      await mk.setQueue(request);
      expect(originalSetQueue).toHaveBeenLastCalledWith(request);
    });

    it('catches a change a few seconds after the last play', async () => {
      const { mk, originalSetQueue } = await primed();
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await settle(3000);
      mk.modified = '2026-11-02';
      const request = playlistRequest({ id: 'i.3', type: 'songs' });
      await mk.setQueue(request);
      expect(originalSetQueue).toHaveBeenLastCalledWith(request);
    });

    it('keeps using the saved list when the check cannot be made', async () => {
      const { mk, music, originalSetQueue } = await primed();
      music.mockRejectedValue(new Error('offline'));
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      expect(originalSetQueue.mock.calls[0]?.[0].items).toHaveLength(4);
    });

    it('does not start an older play when a newer one arrives during the check', async () => {
      const { mk, music, originalSetQueue } = await primed();
      const answer = music.getMockImplementation();
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      music.mockImplementationOnce(async (url, params) => {
        await held;
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      const older = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
      await settle(1);
      const newer = mk.setQueue({ albums: ['1'] });
      release();
      await settle(10);
      await Promise.all([older, newer]);
      expect(originalSetQueue).toHaveBeenCalledOnce();
      expect(originalSetQueue).toHaveBeenCalledWith({ albums: ['1'] });
    });
    it('uses Apple route for an added song and includes it once refreshed', async () => {
      const list = [track('i.0'), track('i.1')];
      const { mk, originalSetQueue } = fakeMusicKit(list);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle();
      list.push(track('i.new'));

      const request = playlistRequest({ id: 'i.new', type: 'songs' });
      await mk.setQueue(request);
      expect(originalSetQueue).toHaveBeenLastCalledWith(request);

      await mk.setQueue(request);
      await settle(10);
      await mk.setQueue(request);
      expect(originalSetQueue.mock.lastCall?.[0].items?.map((t) => t.id)).toEqual(['i.0', 'i.1', 'i.new']);
    });

    it('keeps the old list when a refresh fails', async () => {
      const { mk, music, originalSetQueue } = await primed();
      await settle(61000);
      music.mockRejectedValue(new Error('offline'));
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await settle(10);
      expect(originalSetQueue.mock.calls[0]?.[0].startWith).toBe('i.3');
      await mk.setQueue(playlistRequest({ id: 'i.4', type: 'songs' }));
      expect(originalSetQueue.mock.calls[1]?.[0].startWith).toBe('i.4');
    });

    it('shares one fetch between opening a page and pressing play', async () => {
      const { mk, music } = fakeMusicKit(manyTracks(5));
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle();
      expect(trackPages(music)).toBe(1);
      const started = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
      await settle(10);
      await started;
      expect(trackPages(music)).toBe(1);
    });

    it('gives MusicKit a copy, so it cannot change the saved list', async () => {
      const { mk, originalSetQueue } = await primed();
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      const first = originalSetQueue.mock.calls[0]?.[0].items;
      if (first?.[0]) first[0].id = 'i.changed-by-musickit';
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      expect(originalSetQueue.mock.calls[1]?.[0].items?.[0]?.id).toBe('i.0');
    });
  });

  describe('saving between launches', () => {
    it('reads the list back after a restart without fetching tracks', async () => {
      const indexedDB = fakeIndexedDB();
      const before = fakeMusicKit(tracks);
      runScript(before.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle();
      expect(savedItems(indexedDB, PLAYLIST)).toHaveLength(4);

      const after = fakeMusicKit(tracks);
      runScript(after.mk, '/eg/home', { indexedDB });
      await settle();
      await after.mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await settle(10);
      expect(after.originalSetQueue.mock.calls[0]?.[0].items).toHaveLength(4);
      expect(after.music.mock.calls.some(([url, params]) => url.endsWith('/tracks') && params?.limit === 100)).toBe(false);
    });

    it('still works when storage throws', async () => {
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      const indexedDB = {
        open: () => {
          throw new Error('blocked');
        },
      };
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle();
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      expect(originalSetQueue.mock.calls[0]?.[0].items).toHaveLength(4);
    });

    it('deletes saved lists from storage on sign-out', async () => {
      const indexedDB = fakeIndexedDB();
      const { mk } = fakeMusicKit(tracks);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle();
      expect(savedLists(indexedDB)).toHaveLength(1);
      await mk.unauthorize();
      await settle(10);
      expect(indexedDB.store.size).toBe(0);
      expect(mk.unauthorize).toBeDefined();
    });

    it('does not save a list that finishes fetching after sign-out', async () => {
      const indexedDB = fakeIndexedDB();
      const { mk, music } = fakeMusicKit(tracks);
      const answer = music.getMockImplementation();
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      music.mockImplementation(async (url, params) => {
        await held;
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle();
      await mk.unauthorize();
      release();
      await settle(10);
      expect(savedLists(indexedDB)).toHaveLength(0);
    });

    it('still signs out with the original arguments and result', async () => {
      const { mk } = fakeMusicKit(tracks);
      const original = vi.fn(async (..._args: unknown[]) => 'signed out');
      Object.assign(mk, { unauthorize: original });
      runScript(mk);
      await settle();
      const unauthorize = mk.unauthorize as unknown as (...args: unknown[]) => Promise<unknown>;
      await expect(unauthorize('argument')).resolves.toBe('signed out');
      expect(original).toHaveBeenCalledWith('argument');
    });
  });

  describe('starting with no saved list', () => {
    it('adds nothing when the chosen song is the last track', async () => {
      const { mk } = fakeMusicKit(tracks);
      runScript(mk);
      await settle();
      const started = mk.setQueue(playlistRequest({ id: 'i.4', type: 'songs' }));
      await settle(10);
      await started;
      await settle(10);
      expect(mk.playLater).not.toHaveBeenCalled();
    });

    it('starts Play on the first playable track and queues the rest in order', async () => {
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      runScript(mk);
      await settle();
      await mk.setQueue(playlistRequest({ id: PLAYLIST, type: 'playlists' }));
      await settle(10);
      expect(originalSetQueue.mock.calls[0]?.[0].startWith).toBe('i.0');
      const later = mk.playLater.mock.calls as unknown as [{ items: Track[] }][];
      expect(later[0]?.[0].items.map((t) => t.id)).toEqual(['i.1', 'i.3', 'i.4']);
    });

    it('shuffles the remainder and keeps every other track once', async () => {
      const long = manyTracks(250);
      const { mk, originalSetQueue } = fakeMusicKit(long);
      runScript(mk);
      await settle();
      mk.shuffleMode = SHUFFLE_SONGS;
      await mk.setQueue(playlistRequest({ id: PLAYLIST, type: 'playlists' }));
      await settle(10);

      const first = originalSetQueue.mock.calls[0]?.[0].items?.[0]?.id;
      expect(originalSetQueue.mock.calls[0]?.[0].startWith).toBeUndefined();
      expect(mk.shuffleMode).toBe(SHUFFLE_SONGS);
      const later = mk.playLater.mock.calls as unknown as [{ items: Track[] }][];
      const ids = later[0]?.[0].items.map((t) => t.id) ?? [];
      expect(ids).toHaveLength(249);
      expect(ids).not.toContain(first);
      expect(new Set(ids).size).toBe(249);
      expect(ids).not.toEqual(long.map((t) => t.id).filter((id) => id !== first));
    });

    it('gives up after three failed attempts to fill the queue', async () => {
      const { mk, music } = fakeMusicKit(tracks);
      runScript(mk);
      await settle();
      const answer = music.getMockImplementation();
      music.mockImplementation(async (url, params) => {
        if (!url.includes('/songs/')) throw new Error('offline');
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      const started = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
      await settle(10);
      await started;
      await settle(30000);
      const checks = music.mock.calls.filter(([url]) => url.endsWith(PLAYLIST)).length;
      expect(checks).toBe(3);
      expect(mk.playLater).not.toHaveBeenCalled();
    });

    it('stops retrying once something else starts', async () => {
      const { mk, music } = fakeMusicKit(tracks);
      runScript(mk);
      await settle();
      const answer = music.getMockImplementation();
      music.mockImplementation(async (url, params) => {
        if (!url.includes('/songs/')) throw new Error('offline');
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      const started = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
      await settle(10);
      await started;
      await (mk.setStationQueue as unknown as (options: unknown) => Promise<unknown>)({ url: 'station' });
      await settle(30000);
      expect(music.mock.calls.filter(([url]) => url.endsWith(PLAYLIST))).toHaveLength(1);
    });

    it('does not start an old request when a newer one arrives during the fetch', async () => {
      const { mk, music, originalSetQueue } = fakeMusicKit(tracks);
      runScript(mk);
      await settle();
      const answer = music.getMockImplementation();
      let release = () => {};
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      music.mockImplementationOnce(async (url, params) => {
        await held;
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });

      const older = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
      await settle(1);
      const newer = { url: 'https://music.apple.com/eg/album/1' };
      await mk.setQueue(newer);
      release();
      await settle(10);
      await older;

      expect(originalSetQueue).toHaveBeenCalledTimes(1);
      expect(originalSetQueue).toHaveBeenCalledWith(newer);
    });
  });

  describe('failures', () => {
    it('does not fall back over a newer request', async () => {
      const { mk, music, originalSetQueue } = fakeMusicKit(tracks);
      runScript(mk);
      await settle();
      let fail = () => {};
      music.mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            fail = () => reject(new Error('offline'));
          }),
      );
      const older = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
      await settle(1);
      const newer = { albums: ['1'] };
      await mk.setQueue(newer);
      fail();
      await settle(1);
      await older;
      expect(originalSetQueue).toHaveBeenCalledTimes(1);
    });

    it('passes the error on if the standard queue fails too', async () => {
      const { mk, originalSetQueue } = await primed();
      originalSetQueue.mockRejectedValue(new Error('rejected'));
      await expect(mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }))).rejects.toThrow('rejected');
    });
  });

  describe('installing', () => {
    it('does nothing until MusicKit exists', async () => {
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      const window = runScript(mk);
      delete window.MusicKit;
      await settle();
      expect(mk.setQueue).toBe(originalSetQueue);
    });

    it('survives getInstance throwing during MusicKit start-up', async () => {
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      const window = runScript(mk);
      window.MusicKit = {
        getInstance: () => {
          throw new Error('starting');
        },
      };
      await settle();
      expect(mk.setQueue).toBe(originalSetQueue);
      window.MusicKit = { getInstance: () => mk };
      await settle();
      expect(mk.setQueue).not.toBe(originalSetQueue);
    });

    it('wraps one instance once however long it runs', async () => {
      const { mk } = fakeMusicKit(tracks);
      runScript(mk);
      await settle();
      const wrapped = mk.setQueue;
      await settle(5000);
      expect(mk.setQueue).toBe(wrapped);
    });

    it('runs only once when the script is injected again', async () => {
      const { mk } = fakeMusicKit(tracks);
      const window = runScript(mk);
      await settle();
      const wrapped = mk.setQueue;
      vm.runInNewContext(source, { window, setInterval, setTimeout, structuredClone, console, Date, Math, Map, Set, WeakSet, Promise, Array, Object, Error, Boolean });
      await settle(2000);
      expect(mk.setQueue).toBe(wrapped);
    });

    it('works on a MusicKit without optional methods', async () => {
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      const bare = mk as Partial<typeof mk>;
      delete bare.setStationQueue;
      delete bare.unauthorize;
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle();
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      expect(originalSetQueue.mock.calls[0]?.[0].startWith).toBe('i.3');
    });

    it('checks a page once and ignores pages that are not library playlists', async () => {
      const { mk, music } = fakeMusicKit(tracks);
      const window = runScript(mk, '/eg/album/some-album/123');
      await settle(3000);
      expect(music).not.toHaveBeenCalled();
      (window.location as { pathname: string }).pathname = '/eg/playlist/some-playlist/pl.abc';
      await settle(3000);
      expect(music).not.toHaveBeenCalled();
      (window.location as { pathname: string }).pathname = `/eg/library/playlist/${PLAYLIST}`;
      await settle(1100);
      const calls = music.mock.calls.length;
      expect(calls).toBeGreaterThan(0);
      await settle(5000);
      expect(music.mock.calls.length).toBe(calls);
    });

    it('keeps working when preparing a playlist fails', async () => {
      const { mk, music, originalSetQueue } = fakeMusicKit(tracks);
      music.mockRejectedValue(new Error('offline'));
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle();
      const request = playlistRequest({ id: 'i.3', type: 'songs' });
      await mk.setQueue(request);
      expect(originalSetQueue).toHaveBeenCalledWith(request);
    });
  });

  it('is packaged with the app', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')) as {
      build: { asarUnpack: string[] };
    };
    expect(pkg.build.asarUnpack).toContain('assets/fastPlaylistQueue.js');
  });

  it('reads no DOM and never starts playback itself', () => {
    expect(source).not.toMatch(/\bdocument\.|querySelector/);
    expect(source).not.toMatch(/\.play\(/);
    expect(source).not.toMatch(/shuffleMode\s*=[^=]/);
  });

  describe('never repeating a request', () => {
    it('sends one request when the fast queue works', async () => {
      const { mk, originalSetQueue } = await primed();
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await settle(60000);
      expect(originalSetQueue).toHaveBeenCalledOnce();
    });

    it('sends one request while filling the rest fails every time', async () => {
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      runScript(mk);
      await settle();
      mk.playLater.mockRejectedValue(new Error('rejected'));
      const started = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
      await settle(10);
      await started;
      await settle(30000);
      expect(originalSetQueue).toHaveBeenCalledOnce();
      expect(mk.playLater).toHaveBeenCalledTimes(3);
    });

    it('gives up quietly when the remaining tracks cannot be copied', async () => {
      const unclonable = { ...track('i.2'), attributes: { playParams: { id: 'i.2' }, fn: () => 1 } };
      const { mk, originalSetQueue } = fakeMusicKit([track('i.0'), track('i.1'), unclonable as Track]);
      runScript(mk);
      await settle();
      const started = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
      await settle(10);
      await started;
      await settle(30000);
      expect(originalSetQueue).toHaveBeenCalledOnce();
      expect(mk.playLater).not.toHaveBeenCalled();
    });

    it('does not send the original request again when it fails for a missing song', async () => {
      const { mk, originalSetQueue } = await primed();
      originalSetQueue.mockRejectedValue(new Error('apple failed'));
      await expect(
        mk.setQueue(playlistRequest({ id: 'i.added-elsewhere', type: 'songs' })),
      ).rejects.toThrow('apple failed');
      expect(originalSetQueue).toHaveBeenCalledOnce();
    });

    it('does not send the original request again when it fails for a song during shuffle', async () => {
      const { mk, originalSetQueue } = await primed();
      mk.shuffleMode = SHUFFLE_SONGS;
      originalSetQueue.mockRejectedValue(new Error('apple failed'));
      await expect(mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }))).rejects.toThrow(
        'apple failed',
      );
      expect(originalSetQueue).toHaveBeenCalledOnce();
    });

    it('sends the original request once after the fast request fails', async () => {
      const { mk, originalSetQueue } = await primed();
      originalSetQueue.mockRejectedValueOnce(new Error('rejected'));
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      expect(originalSetQueue).toHaveBeenCalledTimes(2);
      expect(originalSetQueue.mock.calls[1]?.[0].playlists).toEqual([PLAYLIST]);
    });

    it('sends the original request once after an empty queue, and no more', async () => {
      const { mk, originalSetQueue } = await primed();
      mk.queue = { length: 0 };
      originalSetQueue.mockResolvedValueOnce('empty').mockRejectedValue(new Error('apple failed'));
      await expect(mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }))).rejects.toThrow(
        'apple failed',
      );
      expect(originalSetQueue).toHaveBeenCalledTimes(2);
    });

    it('sends the original request once when there is no playable start song', async () => {
      const { mk, originalSetQueue } = fakeMusicKit([track('i.a', false), track('i.b')]);
      runScript(mk);
      await settle();
      const request = playlistRequest({ id: 'i.a', type: 'songs' });
      await mk.setQueue(request);
      expect(originalSetQueue).toHaveBeenCalledOnce();
      expect(originalSetQueue).toHaveBeenCalledWith(request);
    });

    it('sends the original request once when the start song does not exist', async () => {
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      runScript(mk);
      await settle();
      const request = playlistRequest({ id: 'i.ghost', type: 'songs' });
      await mk.setQueue(request);
      expect(originalSetQueue).toHaveBeenCalledOnce();
      expect(originalSetQueue).toHaveBeenCalledWith(request);
    });
  });

  describe('page boundaries', () => {
    it.each([1, 2, 99, 100, 101, 199, 200, 201, 250, 1000, 1787])(
      'fetches %i tracks in the right number of pages and keeps their order',
      async (count) => {
        const list = manyTracks(count);
        const { mk, music, originalSetQueue } = fakeMusicKit(list);
        runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
        await settle(2000);
        const pages = music.mock.calls.filter(([url, params]) => url.endsWith('/tracks') && params?.limit === 100);
        expect(pages).toHaveLength(Math.ceil(count / 100));
        await mk.setQueue(playlistRequest({ id: PLAYLIST, type: 'playlists' }));
        expect(originalSetQueue.mock.calls[0]?.[0].items?.map((t) => t.id)).toEqual(list.map((t) => t.id));
      },
    );

    it('uses only the first page when the total is missing', async () => {
      const list = manyTracks(250);
      const { mk, music, originalSetQueue } = fakeMusicKit(list);
      const answer = music.getMockImplementation();
      music.mockImplementation((async (url: string, params?: { limit?: number; offset?: number }) => {
        const result = (await answer?.(url, params)) as { data: { data: unknown[]; meta?: unknown } };
        return { data: { data: result.data.data, meta: undefined } };
      }) as never);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle(2000);
      await mk.setQueue(playlistRequest({ id: PLAYLIST, type: 'playlists' }));
      expect(originalSetQueue.mock.calls[0]?.[0].items).toHaveLength(100);
    });

    it('treats an empty playlist as nothing to speed up', async () => {
      const { mk, originalSetQueue } = fakeMusicKit([]);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle();
      const request = playlistRequest({ id: PLAYLIST, type: 'playlists' });
      await mk.setQueue(request);
      expect(originalSetQueue).toHaveBeenCalledWith(request);
    });

    it('starts a one-track playlist and queues nothing behind it', async () => {
      const { mk, originalSetQueue } = fakeMusicKit([track('i.only')]);
      runScript(mk);
      await settle();
      await mk.setQueue(playlistRequest({ id: PLAYLIST, type: 'playlists' }));
      await settle(10);
      expect(originalSetQueue.mock.calls[0]?.[0].items?.map((t) => t.id)).toEqual(['i.only']);
      expect(mk.playLater).not.toHaveBeenCalled();
    });
  });

  describe('chosen songs in the saved list', () => {
    it.each([
      ['first', 'i.0'],
      ['middle', 'i.3'],
      ['last', 'i.4'],
    ])('starts on the %s song with the whole list queued', async (_label, id) => {
      const { mk, originalSetQueue } = await primed();
      await mk.setQueue(playlistRequest({ id, type: 'songs' }));
      const sent = originalSetQueue.mock.calls[0]?.[0];
      expect(sent?.startWith).toBe(id);
      expect(sent?.items).toHaveLength(4);
    });

    it('uses the standard queue for a playlist that repeats a song, so no copy is lost', async () => {
      const list = [track('i.dup'), track('i.1'), track('i.dup'), track('i.3')];
      const { mk, originalSetQueue } = fakeMusicKit(list);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle();
      const request = playlistRequest({ id: 'i.dup', type: 'songs' });
      await mk.setQueue(request);
      expect(originalSetQueue).toHaveBeenCalledOnce();
      expect(originalSetQueue).toHaveBeenCalledWith(request);
    });

    it.each([
      ['Play', playlistRequest({ id: PLAYLIST, type: 'playlists' }), 0],
      ['Shuffle', playlistRequest({ id: PLAYLIST, type: 'playlists' }), SHUFFLE_SONGS],
    ])('uses the standard queue for %s on a playlist that repeats a song', async (_label, request, mode) => {
      const list = [track('i.0'), track('i.1'), track('i.1')];
      const { mk, originalSetQueue } = fakeMusicKit(list);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle();
      mk.shuffleMode = mode;
      await mk.setQueue(request);
      expect(originalSetQueue).toHaveBeenCalledWith(request);
      expect(originalSetQueue).toHaveBeenCalledOnce();
    });

    it('does not mistake different songs for repeats', async () => {
      const { mk, originalSetQueue } = await primed();
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      expect(originalSetQueue.mock.calls[0]?.[0].items).toHaveLength(4);
    });

    it('starts the Shuffle button with no start song and every track queued', async () => {
      const { mk, originalSetQueue } = await primed();
      mk.shuffleMode = SHUFFLE_SONGS;
      await mk.setQueue(playlistRequest({ id: PLAYLIST, type: 'playlists' }));
      const sent = originalSetQueue.mock.calls[0]?.[0];
      expect(sent?.startWith).toBeUndefined();
      expect(sent?.items).toHaveLength(4);
    });

    it('re-checks a playlist page only once a minute', async () => {
      const { mk, music } = fakeMusicKit(tracks);
      const window = runScript(mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle(2000);
      const first = music.mock.calls.length;
      const location = window.location as { pathname: string };
      location.pathname = '/eg/home';
      await settle(1100);
      location.pathname = `/eg/library/playlist/${PLAYLIST}`;
      await settle(1100);
      expect(music.mock.calls.length).toBe(first);
      location.pathname = '/eg/home';
      await settle(60000);
      location.pathname = `/eg/library/playlist/${PLAYLIST}`;
      await settle(1100);
      expect(music.mock.calls.length).toBeGreaterThan(first);
    });
    it('keeps each playlist on its own timer', async () => {
      const { mk, music } = await primed();
      await mk.setQueue({ ...playlistRequest({ id: 'i.3', type: 'songs' }), playlists: ['p.other'] });
      await settle(10);
      const urls = music.mock.calls.map(([url]) => url);
      expect(urls.some((url) => url.includes('/p.other'))).toBe(true);
      expect(urls.some((url) => url.includes(`/${PLAYLIST}`))).toBe(false);
    });

    it('retries filling at two and four seconds, then stops', async () => {
      const { mk, music } = fakeMusicKit(tracks);
      runScript(mk);
      await settle();
      const answer = music.getMockImplementation();
      music.mockImplementation(async (url, params) => {
        if (!url.includes('/songs/')) throw new Error('offline');
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      const checks = () => music.mock.calls.filter(([url]) => url.endsWith(PLAYLIST)).length;
      const started = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
      await settle(10);
      await started;
      expect(checks()).toBe(1);
      await settle(1980);
      expect(checks()).toBe(1);
      await settle(20);
      expect(checks()).toBe(2);
      await settle(2000);
      expect(checks()).toBe(3);
      await settle(60000);
      expect(checks()).toBe(3);
    });
  });

  describe('a failed refresh', () => {
    it('keeps using the old list when a refresh fails and nothing changed', async () => {
      const { mk, music, originalSetQueue } = await primed();
      const answer = music.getMockImplementation();
      music.mockImplementation(async (url, params) => {
        if (url.endsWith('/tracks') && params?.limit === 100) throw new Error('page failed');
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await mk.setQueue(playlistRequest({ id: 'i.4', type: 'songs' }));
      expect(originalSetQueue.mock.calls[1]?.[0].items).toHaveLength(4);
    });

    it('uses the standard queue until a failed refresh succeeds', async () => {
      const { mk, music, originalSetQueue } = await primed();
      mk.modified = 'changed';
      const answer = music.getMockImplementation();
      let failing = true;
      music.mockImplementation(async (url, params) => {
        if (failing && url.endsWith('/tracks') && params?.limit === 100) throw new Error('page failed');
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      const request = playlistRequest({ id: 'i.3', type: 'songs' });
      await mk.setQueue(request);
      await settle(10);
      await mk.setQueue(request);
      expect(originalSetQueue.mock.calls.every(([sent]) => sent === request)).toBe(true);
      failing = false;
      await settle(2000);
      await mk.setQueue(request);
      expect(originalSetQueue.mock.lastCall?.[0].items).toHaveLength(4);
    });

    it('does not replace the saved list with a partial one', async () => {
      const indexedDB = fakeIndexedDB();
      const { mk, music } = fakeMusicKit(manyTracks(350));
      const answer = music.getMockImplementation();
      music.mockImplementation(async (url, params) => {
        if (url.endsWith('/tracks') && params?.offset === 200) throw new Error('page failed');
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle(2000);
      expect(savedLists(indexedDB)).toHaveLength(0);
    });

    it('retries a first fetch that failed, so the list is saved without waiting for a play', async () => {
      const { mk, music } = fakeMusicKit(tracks);
      music.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
      const indexedDB = fakeIndexedDB();
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle(3000);
      expect(savedItems(indexedDB, PLAYLIST)).toHaveLength(4);
    });
  });

  describe('saved data that is wrong', () => {
    it('treats a saved entry with no items as nothing saved', async () => {
      const indexedDB = fakeIndexedDB();
      indexedDB.store.set(PLAYLIST, { id: PLAYLIST, version: 'old' } as never);
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      runScript(mk, '/eg/home', { indexedDB });
      await settle();
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await settle(10);
      expect(originalSetQueue).toHaveBeenCalledOnce();
      expect(originalSetQueue.mock.calls[0]?.[0].items?.map((t) => t.id)).toEqual(['i.3']);
    });

    it('treats a saved entry with an empty list as nothing saved', async () => {
      const indexedDB = fakeIndexedDB();
      indexedDB.store.set(PLAYLIST, { id: PLAYLIST, version: 'old', order: [] });
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      runScript(mk, '/eg/home', { indexedDB });
      await settle();
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await settle(10);
      expect(originalSetQueue.mock.calls[0]?.[0].items?.map((t) => t.id)).toEqual(['i.3']);
    });

    it('uses a saved list from an earlier launch when it is still current', async () => {
      const indexedDB = fakeIndexedDB();
      seedList(indexedDB, PLAYLIST, '2026-11-01:5', [track('i.7'), track('i.8')]);
      const { mk, originalSetQueue, music } = fakeMusicKit(tracks);
      runScript(mk, '/eg/home', { indexedDB });
      await settle();
      await mk.setQueue(playlistRequest({ id: 'i.8', type: 'songs' }));
      expect(originalSetQueue.mock.calls[0]?.[0].items?.map((t) => t.id)).toEqual(['i.7', 'i.8']);
      expect(music.mock.calls.some(([url]) => url.includes('/songs/'))).toBe(false);
    });

    it('uses the standard queue for a saved list from an earlier launch that has changed', async () => {
      const indexedDB = fakeIndexedDB();
      seedList(indexedDB, PLAYLIST, 'old', [track('i.7'), track('i.8')]);
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      runScript(mk, '/eg/home', { indexedDB });
      await settle();
      const request = playlistRequest({ id: 'i.8', type: 'songs' });
      await mk.setQueue(request);
      expect(originalSetQueue).toHaveBeenCalledWith(request);
    });
    it('replaces an old saved list once the playlist is seen to have changed', async () => {
      const indexedDB = fakeIndexedDB();
      seedList(indexedDB, PLAYLIST, 'old', [track('i.7')]);
      const { mk } = fakeMusicKit(tracks);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle(2000);
      expect(savedItems(indexedDB, PLAYLIST)).toHaveLength(4);
      expect(indexedDB.store.get(PLAYLIST)?.version).toBe('2026-11-01:5');
    });
  });

  describe('keeping storage small', () => {
    const open = async (indexedDB: FakeStorage, path = '/eg/library/playlist/p.new', fake = fakeMusicKit(tracks)) => {
      const window = runScript(fake.mk, path, { indexedDB });
      await settle(2000);
      return { ...fake, window };
    };
    const songBytes = (indexedDB: FakeStorage) => JSON.stringify([...indexedDB.songs.values()]).length;

    it('keeps at most twenty lists, dropping the least recently used', async () => {
      const indexedDB = fakeIndexedDB();
      for (let n = 0; n < 25; n += 1) seedList(indexedDB, `p.${n}`, 'v', [track(`s.${n}`)], Date.now() - n * 1000);
      await open(indexedDB);
      const kept = savedLists(indexedDB);
      expect(kept).toHaveLength(20);
      expect(kept).toContain('p.new');
      expect(kept).toContain('p.0');
      expect(kept).not.toContain('p.24');
      expect(kept).not.toContain('p.23');
    });

    it('keeps a new list even when every older list is more recent', async () => {
      const indexedDB = fakeIndexedDB();
      for (let n = 0; n < 25; n += 1) seedList(indexedDB, `p.${n}`, 'v', [track(`s.${n}`)], Date.now() + 10 * DAY_MS);
      await open(indexedDB);
      expect(savedLists(indexedDB)).toContain('p.new');
      expect(savedLists(indexedDB)).toHaveLength(20);
    });

    it('drops lists not used for thirty days, and keeps newer ones', async () => {
      const indexedDB = fakeIndexedDB();
      seedList(indexedDB, 'p.0', 'v', [track('s.0')], Date.now() - 1 * DAY_MS);
      seedList(indexedDB, 'p.1', 'v', [track('s.1')], Date.now() - 29 * DAY_MS);
      seedList(indexedDB, 'p.2', 'v', [track('s.2')], Date.now() - 31 * DAY_MS);
      await open(indexedDB);
      const kept = savedLists(indexedDB);
      expect(kept).toContain('p.0');
      expect(kept).toContain('p.1');
      expect(kept).not.toContain('p.2');
    });

    it('drops a list that has no use recorded', async () => {
      const indexedDB = fakeIndexedDB();
      indexedDB.store.set('p.old', { id: 'p.old', version: 'v', order: ['s.old'] });
      indexedDB.songs.set('s.old', track('s.old'));
      await open(indexedDB);
      expect(savedLists(indexedDB)).not.toContain('p.old');
      expect(indexedDB.songs.has('s.old')).toBe(false);
    });

    it('never treats the usage record as a playlist', async () => {
      const indexedDB = fakeIndexedDB();
      for (let n = 0; n < 20; n += 1) seedList(indexedDB, `p.${n}`, 'v', [track(`s.${n}`)]);
      await open(indexedDB);
      expect(indexedDB.store.has(USAGE_KEY)).toBe(true);
      expect(savedLists(indexedDB)).toHaveLength(20);
    });

    it('counts playing a list as using it, so it outlives a newer unplayed one', async () => {
      const indexedDB = fakeIndexedDB();
      for (let n = 0; n < 20; n += 1) seedList(indexedDB, `p.${n}`, '2026-11-01:5', [track('i.0'), track('i.1')], Date.now() - (n + 1) * DAY_MS);
      const { mk } = await open(indexedDB, '/eg/home');
      await mk.setQueue({ ...playlistRequest({ id: 'i.0', type: 'songs' }), playlists: ['p.19'] });
      await settle(70000);
      await open(indexedDB, '/eg/library/playlist/p.new');
      expect(savedLists(indexedDB)).toContain('p.19');
    });

    it('writes the usage record at most once a minute while playing', async () => {
      const indexedDB = fakeIndexedDB();
      const { mk } = await primedWith(indexedDB);
      const before = indexedDB.objectStore.put.mock.calls.length;
      for (let n = 0; n < 5; n += 1) await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await settle(10);
      expect(indexedDB.objectStore.put.mock.calls.length).toBe(before);
    });

    it('never rewrites a list or a song when it is only played', async () => {
      const indexedDB = fakeIndexedDB();
      const { mk } = await primedWith(indexedDB);
      indexedDB.objectStore.put.mockClear();
      indexedDB.songStore.put.mockClear();
      await settle(61000);
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await settle(10);
      expect(indexedDB.objectStore.put.mock.calls.every(([entry]) => entry.id === USAGE_KEY)).toBe(true);
      expect(indexedDB.songStore.put).not.toHaveBeenCalled();
    });

    it('remembers use across a restart', async () => {
      const indexedDB = fakeIndexedDB();
      await primedWith(indexedDB);
      const saved = indexedDB.store.get(USAGE_KEY);
      expect(Object.keys(saved?.used ?? {})).toEqual([PLAYLIST]);
    });

    it('stores songs exactly as MusicKit returned them', async () => {
      const indexedDB = fakeIndexedDB();
      await primedWith(indexedDB);
      expect(savedItems(indexedDB, PLAYLIST)).toEqual(tracks.filter((t) => t.attributes.playParams));
    });

    it('stores a playlist as an ordered list of song IDs', async () => {
      const indexedDB = fakeIndexedDB();
      await primedWith(indexedDB);
      expect(indexedDB.store.get(PLAYLIST)?.order).toEqual(['i.0', 'i.1', 'i.3', 'i.4']);
      expect(indexedDB.store.get(PLAYLIST)).not.toHaveProperty('items');
    });

    it('keeps a song once however many saved playlists use it', async () => {
      const indexedDB = fakeIndexedDB();
      for (const id of ['p.a', 'p.b', 'p.c']) {
        const fake = fakeMusicKit(tracks);
        runScript(fake.mk, `/eg/library/playlist/${id}`, { indexedDB });
        await settle(2000);
      }
      expect(savedLists(indexedDB).sort()).toEqual(['p.a', 'p.b', 'p.c']);
      expect(indexedDB.songs.size).toBe(4);
    });

    describe('changing a saved playlist', () => {
      const setup = async (before?: (indexedDB: FakeStorage) => void) => {
        const list = [track('i.0'), track('i.1'), track('i.2'), track('i.3')];
        const indexedDB = fakeIndexedDB();
        before?.(indexedDB);
        const fake = fakeMusicKit(list);
        const window = runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
        await settle(2000);
        indexedDB.objectStore.put.mockClear();
        indexedDB.objectStore.delete.mockClear();
        indexedDB.songStore.put.mockClear();
        indexedDB.songStore.delete.mockClear();
        const refreshAfterChange = async (changed = true) => {
          if (changed) fake.mk.modified = `changed-${Math.random()}`;
          const location = window.location as { pathname: string };
          location.pathname = '/eg/home';
          await settle(61000);
          location.pathname = `/eg/library/playlist/${PLAYLIST}`;
          await settle(2000);
        };
        return { indexedDB, list, ...fake, refreshAfterChange };
      };
      const songPuts = (indexedDB: FakeStorage) => indexedDB.songStore.put.mock.calls.map(([item]) => item.id);
      const songDeletes = (indexedDB: FakeStorage) => indexedDB.songStore.delete.mock.calls.map(([id]) => id);

      it('writes only the new song and the order when a song is added', async () => {
        const { indexedDB, list, refreshAfterChange } = await setup();
        list.push(track('i.new'));
        await refreshAfterChange();
        expect(songPuts(indexedDB)).toEqual(['i.new']);
        expect(songDeletes(indexedDB)).toEqual([]);
        expect(indexedDB.store.get(PLAYLIST)?.order).toEqual(['i.0', 'i.1', 'i.2', 'i.3', 'i.new']);
      });

      it('deletes only the removed song and rewrites the order when a song is removed', async () => {
        const { indexedDB, list, refreshAfterChange } = await setup();
        const removed = list.splice(1, 1);
        await refreshAfterChange();
        expect(songPuts(indexedDB)).toEqual([]);
        expect(songDeletes(indexedDB)).toEqual(['i.1']);
        expect(indexedDB.songs.has('i.1')).toBe(false);
        expect(indexedDB.store.get(PLAYLIST)?.order).toEqual(['i.0', 'i.2', 'i.3']);
      });

      it('writes no song when a playlist is only reordered', async () => {
        const { indexedDB, list, refreshAfterChange } = await setup();
        list.reverse();
        await refreshAfterChange();
        expect(songPuts(indexedDB)).toEqual([]);
        expect(songDeletes(indexedDB)).toEqual([]);
        expect(indexedDB.store.get(PLAYLIST)?.order).toEqual(['i.3', 'i.2', 'i.1', 'i.0']);
      });

      it('rewrites only a song whose details changed', async () => {
        const { indexedDB, list, refreshAfterChange } = await setup();
        const original = list[2] as Track;
        list[2] = { ...original, attributes: { ...original.attributes, name: 'renamed' } } as Track;
        await refreshAfterChange();
        expect(songPuts(indexedDB)).toEqual(['i.2']);
      });

      it('keeps a removed song that another saved playlist still uses', async () => {
        const { indexedDB, list, refreshAfterChange } = await setup((storage) =>
          seedList(storage, 'p.other', 'v', [track('i.1')]),
        );
        const removed = list.splice(1, 1);
        await refreshAfterChange();
        expect(songDeletes(indexedDB)).toEqual([]);
      });

      it('uses the patched playlist for the next play', async () => {
        const { list, mk, originalSetQueue, refreshAfterChange } = await setup();
        const removed = list.splice(1, 1);
        await refreshAfterChange();
        await mk.setQueue(playlistRequest({ id: 'i.0', type: 'songs' }));
        expect(originalSetQueue.mock.lastCall?.[0].items?.map((t) => t.id)).toEqual(['i.0', 'i.2', 'i.3']);
      });

      it('does not write anything when nothing changed', async () => {
        const { indexedDB, refreshAfterChange } = await setup();
        await refreshAfterChange(false);
        expect(indexedDB.songStore.put).not.toHaveBeenCalled();
        expect(indexedDB.songStore.delete).not.toHaveBeenCalled();
        expect(indexedDB.objectStore.put.mock.calls.every(([entry]) => entry.id === USAGE_KEY)).toBe(true);
      });
    });

    describe('the size limit', () => {
      const big = (id: string, count: number, size: number) =>
        Array.from({ length: count }, (_, n) => ({
          ...track(`${id}.${n}`),
          attributes: { playParams: { id: `${id}.${n}` }, filler: 'x'.repeat(size) },
        })) as Track[];

      it('does not save a playlist larger than the limit, and still plays it', async () => {
        const indexedDB = fakeIndexedDB();
        const fake = fakeMusicKit(big('huge', 80, 100_000));
        runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
        await settle(5000);
        expect(savedLists(indexedDB)).toHaveLength(0);
        expect(indexedDB.songs.size).toBe(0);
        const request = playlistRequest({ id: PLAYLIST, type: 'playlists' });
        await fake.mk.setQueue(request);
        expect(fake.originalSetQueue.mock.calls.at(-1)?.[0]).toBeDefined();
      });

      it('removes the old saved copy when a playlist grows past the limit', async () => {
        const indexedDB = fakeIndexedDB();
        const list = big('grow', 3, 100);
        const fake = fakeMusicKit(list);
        const window = runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
        await settle(2000);
        expect(savedLists(indexedDB)).toEqual([PLAYLIST]);
        list.push(...big('more', 60, 100_000));
        const location = window.location as { pathname: string };
        location.pathname = '/eg/home';
        await settle(61000);
        location.pathname = `/eg/library/playlist/${PLAYLIST}`;
        await settle(5000);
        expect(savedLists(indexedDB)).toHaveLength(0);
        expect(indexedDB.songs.size).toBe(0);
      });

      it('keeps total song storage under the limit by dropping the oldest playlists', async () => {
        const indexedDB = fakeIndexedDB();
        for (let n = 0; n < 8; n += 1) {
          const fake = fakeMusicKit(big(`s${n}`, 10, 100_000));
          runScript(fake.mk, `/eg/library/playlist/p.${n}`, { indexedDB });
          await settle(3000);
        }
        expect(songBytes(indexedDB)).toBeLessThanOrEqual(5 * 1024 * 1024);
        expect(savedLists(indexedDB)).toContain('p.7');
        expect(savedLists(indexedDB)).not.toContain('p.0');
        expect(savedLists(indexedDB).length).toBeLessThan(8);
      });

      it('leaves no songs behind once their playlists are dropped', async () => {
        const indexedDB = fakeIndexedDB();
        for (let n = 0; n < 8; n += 1) {
          const fake = fakeMusicKit(big(`s${n}`, 10, 100_000));
          runScript(fake.mk, `/eg/library/playlist/p.${n}`, { indexedDB });
          await settle(3000);
        }
        const used = new Set(savedLists(indexedDB).flatMap((id) => indexedDB.store.get(id)?.order ?? []));
        expect([...indexedDB.songs.keys()].every((id) => used.has(id))).toBe(true);
        expect(used.size).toBe(indexedDB.songs.size);
      });
    });

    describe('cleaning up saved data', () => {
      it('drops a saved playlist whose songs are missing', async () => {
        const indexedDB = fakeIndexedDB();
        indexedDB.store.set(PLAYLIST, { id: PLAYLIST, version: 'v', order: ['i.0', 'i.gone'] });
        indexedDB.songs.set('i.0', track('i.0'));
        const { mk, originalSetQueue } = fakeMusicKit(tracks);
        runScript(mk, '/eg/home', { indexedDB });
        await settle();
        const request = playlistRequest({ id: 'i.0', type: 'songs' });
        await mk.setQueue(request);
        await settle(10);
        expect(originalSetQueue.mock.calls[0]?.[0].items?.map((t) => t.id)).toEqual(['i.0']);
        await settle(2000);
        expect(indexedDB.store.get(PLAYLIST)?.order).toEqual(['i.0', 'i.1', 'i.3', 'i.4']);
      });

      it('deletes a saved playlist record it cannot use', async () => {
        const indexedDB = fakeIndexedDB();
        indexedDB.store.set('p.broken', { id: 'p.broken', version: 'v' });
        await open(indexedDB);
        expect(indexedDB.store.has('p.broken')).toBe(false);
      });

      it('deletes songs that no saved playlist uses, on start', async () => {
        const indexedDB = fakeIndexedDB();
        seedList(indexedDB, 'p.a', '2026-11-01:5', [track('i.0')]);
        indexedDB.songs.set('s.orphan', track('s.orphan'));
        await open(indexedDB, '/eg/library/playlist/p.a');
        expect(indexedDB.songs.has('s.orphan')).toBe(false);
        expect(indexedDB.songs.has('i.0')).toBe(true);
      });

      it('forgets use recorded for playlists that are no longer saved', async () => {
        const indexedDB = fakeIndexedDB();
        seedList(indexedDB, 'p.a', 'v', [track('s.a')]);
        const usage = indexedDB.store.get(USAGE_KEY);
        if (usage) usage.used = { ...usage.used, 'p.gone': Date.now() };
        const { mk } = await open(indexedDB, '/eg/home');
        await mk.setQueue({ ...playlistRequest({ id: 's.a', type: 'songs' }), playlists: ['p.a'] });
        await settle(70000);
        await mk.setQueue({ ...playlistRequest({ id: 's.a', type: 'songs' }), playlists: ['p.a'] });
        await settle(10);
        expect(Object.keys(indexedDB.store.get(USAGE_KEY)?.used ?? {})).not.toContain('p.gone');
      });

      it('clears songs as well as playlists on sign-out', async () => {
        const indexedDB = fakeIndexedDB();
        const { mk } = await open(indexedDB);
        expect(indexedDB.songs.size).toBeGreaterThan(0);
        await mk.unauthorize();
        await settle(10);
        expect(indexedDB.songs.size).toBe(0);
        expect(indexedDB.store.size).toBe(0);
      });

      it('does not wait forever when storage is blocked by another connection', async () => {
        const fake = fakeMusicKit(tracks);
        const indexedDB = {
          open: () => {
            const pending: { onblocked?: () => void } = {};
            queueMicrotask(() => pending.onblocked?.());
            return pending;
          },
        };
        runScript(fake.mk, '/eg/home', { indexedDB });
        await settle();
        const started = fake.mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
        await settle(10);
        await started;
        expect(fake.originalSetQueue).toHaveBeenCalledOnce();
      });

      it('clears version 1 data when the storage is upgraded', async () => {
        const indexedDB = fakeIndexedDB(1);
        const fake = fakeMusicKit(tracks);
        runScript(fake.mk, '/eg/library/playlist/p.a', { indexedDB });
        await settle(2000);
        expect(indexedDB.upgradeClear).toHaveBeenCalled();
      });

      it('leaves data alone when the storage is created fresh', async () => {
        const indexedDB = fakeIndexedDB();
        const fake = fakeMusicKit(tracks);
        runScript(fake.mk, '/eg/library/playlist/p.a', { indexedDB });
        await settle(2000);
        expect(indexedDB.upgradeClear).not.toHaveBeenCalled();
      });
    });
  });

  describe('retries', () => {
    const pageCalls = (music: ReturnType<typeof fakeMusicKit>['music'], offset?: number) =>
      music.mock.calls.filter(([url, params]) => url.endsWith('/tracks') && params?.limit === 100 && (offset === undefined || params?.offset === offset)).length;
    const failPages = (music: ReturnType<typeof fakeMusicKit>['music'], failures: () => boolean) => {
      const answer = music.getMockImplementation();
      music.mockImplementation(async (url, params) => {
        if (url.endsWith('/tracks') && params?.limit === 100 && failures()) throw new Error('busy');
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
    };

    it('retries a page that fails once, and saves the whole list', async () => {
      const indexedDB = fakeIndexedDB();
      const { mk, music } = fakeMusicKit(manyTracks(350));
      let failed = false;
      failPages(music, () => (failed ? false : (failed = true)));
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle(4000);
      expect(savedItems(indexedDB, PLAYLIST)).toHaveLength(350);
    });

    it('waits 0.5 s, then 1 s, and tries a page three times at most', async () => {
      const { mk, music } = fakeMusicKit(manyTracks(350));
      failPages(music, () => true);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB: fakeIndexedDB() });
      await settle(1000);
      expect(pageCalls(music, 0)).toBe(1);
      await settle(400);
      expect(pageCalls(music, 0)).toBe(1);
      await settle(200);
      expect(pageCalls(music, 0)).toBe(2);
      await settle(800);
      expect(pageCalls(music, 0)).toBe(2);
      await settle(200);
      expect(pageCalls(music, 0)).toBe(3);
      await settle(30000);
      expect(pageCalls(music, 0)).toBe(3);
    });

    it('keeps the old list when every attempt fails', async () => {
      const indexedDB = fakeIndexedDB();
      const { mk, music, originalSetQueue } = await primedWith(indexedDB);
      mk.modified = 'changed';
      failPages(music, () => true);
      const request = playlistRequest({ id: 'i.3', type: 'songs' });
      await mk.setQueue(request);
      await settle(5000);
      expect(savedItems(indexedDB, PLAYLIST)).toHaveLength(4);
      expect(originalSetQueue).toHaveBeenCalledWith(request);
    });

    it('retries the change check in the background', async () => {
      const { mk, music } = fakeMusicKit(tracks);
      const indexedDB = fakeIndexedDB();
      music.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'));
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle(2500);
      expect(savedItems(indexedDB, PLAYLIST)).toHaveLength(4);
    });

    it('does not retry the check made before a play, so a play is never held up', async () => {
      const { mk, music, originalSetQueue } = await primed();
      music.mockRejectedValue(new Error('offline'));
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      expect(music).toHaveBeenCalledTimes(2);
      expect(originalSetQueue.mock.calls[0]?.[0].items).toHaveLength(4);
    });

    it('stops retrying once you sign out', async () => {
      const { mk, music } = fakeMusicKit(manyTracks(350));
      failPages(music, () => true);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB: fakeIndexedDB() });
      await settle(1100);
      await mk.unauthorize();
      await settle(30000);
      expect(pageCalls(music, 0)).toBe(1);
    });

    it('retries a save that fails, until it succeeds', async () => {
      const indexedDB = fakeIndexedDB();
      let failures = 2;
      const put = indexedDB.objectStore.put.getMockImplementation();
      indexedDB.objectStore.put.mockImplementation(((entry: ListRecord) => {
        if (entry.id !== USAGE_KEY && failures > 0) {
          failures -= 1;
          const pending: { onerror?: () => void } = {};
          queueMicrotask(() => pending.onerror?.());
          return pending;
        }
        return put?.(entry);
      }) as never);
      const { mk } = fakeMusicKit(tracks);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle(5000);
      expect(failures).toBe(0);
      expect(savedItems(indexedDB, PLAYLIST)).toHaveLength(4);
    });

    it('gives up on a save after three attempts, and keeps using memory', async () => {
      const indexedDB = fakeIndexedDB();
      indexedDB.objectStore.put.mockImplementation((() => {
        const pending: { onerror?: () => void } = {};
        queueMicrotask(() => pending.onerror?.());
        return pending;
      }) as never);
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle(30000);
      expect(indexedDB.objectStore.put.mock.calls.filter(([entry]) => entry.id === PLAYLIST)).toHaveLength(3);
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      expect(originalSetQueue.mock.calls[0]?.[0].items).toHaveLength(4);
    });

    it('never lets a retried older save overwrite a newer one', async () => {
      const indexedDB = fakeIndexedDB();
      const list = [track('i.0'), track('i.1')];
      const { mk, originalSetQueue } = fakeMusicKit(list);
      const window = runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle(2000);
      const put = indexedDB.objectStore.put.getMockImplementation();
      let failFirst = true;
      indexedDB.objectStore.put.mockImplementation(((entry: ListRecord) => {
        if (entry.id === PLAYLIST && failFirst) {
          failFirst = false;
          const pending: { onerror?: () => void } = {};
          queueMicrotask(() => pending.onerror?.());
          return pending;
        }
        return put?.(entry);
      }) as never);
      const location = window.location as { pathname: string };
      list.push(track('i.2'));
      mk.modified = 'a';
      location.pathname = '/eg/home';
      await settle(61000);
      location.pathname = `/eg/library/playlist/${PLAYLIST}`;
      await settle(1100);
      list.push(track('i.3'));
      mk.modified = 'b';
      void originalSetQueue;
      await mk.setQueue(playlistRequest({ id: 'i.0', type: 'songs' }));
      await settle(10000);
      expect(indexedDB.store.get(PLAYLIST)?.order).toEqual(['i.0', 'i.1', 'i.2', 'i.3']);
    });

    it('drops a save that was waiting to retry when you signed out', async () => {
      const indexedDB = fakeIndexedDB();
      const { mk } = fakeMusicKit(tracks);
      const put = indexedDB.objectStore.put.getMockImplementation();
      let failFirst = true;
      indexedDB.objectStore.put.mockImplementation(((entry: ListRecord) => {
        if (entry.id === PLAYLIST && failFirst) {
          failFirst = false;
          const pending: { onerror?: () => void } = {};
          queueMicrotask(() => pending.onerror?.());
          return pending;
        }
        return put?.(entry);
      }) as never);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle(1200);
      expect(failFirst).toBe(false);
      await mk.unauthorize();
      await settle(30000);
      expect(indexedDB.store.size).toBe(0);
      expect(indexedDB.songs.size).toBe(0);
      expect(indexedDB.objectStore.put.mock.calls.filter(([entry]) => entry.id === PLAYLIST)).toHaveLength(1);
    });

    it('does not hold up filling the queue while a save is slow', async () => {
      const indexedDB = fakeIndexedDB();
      indexedDB.objectStore.put.mockImplementation((() => ({})) as never);
      const { mk } = fakeMusicKit(tracks);
      runScript(mk, '/eg/home', { indexedDB });
      await settle();
      const started = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
      await settle(10);
      await started;
      await settle(10);
      expect(mk.playLater).toHaveBeenCalledOnce();
    });
  });

  describe('storage failures', () => {
    it('uses memory when opening storage fails with an error event', async () => {
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      const indexedDB = {
        open: () => {
          const pending: { onerror?: () => void } = {};
          queueMicrotask(() => pending.onerror?.());
          return pending;
        },
      };
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle(2000);
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      expect(originalSetQueue.mock.calls[0]?.[0].items).toHaveLength(4);
    });

    it('uses memory when saving fails', async () => {
      const fake = fakeIndexedDB();
      fake.objectStore.put.mockImplementation((() => {
        const pending: { onerror?: () => void } = {};
        queueMicrotask(() => pending.onerror?.());
        return pending;
      }) as never);
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB: fake });
      await settle(2000);
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      expect(originalSetQueue.mock.calls[0]?.[0].items).toHaveLength(4);
    });

    it('creates the store with the playlist ID as key', async () => {
      const indexedDB = fakeIndexedDB();
      const { mk } = fakeMusicKit(tracks);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle(2000);
      expect(indexedDB.open).toHaveBeenCalledWith('sidra-fast-queue', 2);
      expect(indexedDB.createObjectStore).toHaveBeenCalledWith('playlists', { keyPath: 'id' });
      expect(indexedDB.createObjectStore).toHaveBeenCalledWith('songs', { keyPath: 'id' });
    });

    it('never leaves a playlist click waiting when a storage request throws', async () => {
      const fake = fakeIndexedDB();
      fake.objectStore.get = () => {
        throw new Error('blocked');
      };
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      runScript(mk, '/eg/home', { indexedDB: fake });
      await settle();
      const started = mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await settle(10);
      await started;
      expect(originalSetQueue).toHaveBeenCalledOnce();
    });

    it('never leaves a playlist click waiting when opening a transaction throws', async () => {
      const fake = fakeIndexedDB();
      const open = fake.open;
      fake.open = vi.fn((name: string, version: number) => {
        const pending = open(name, version);
        pending.result.transaction = () => {
          throw new Error('closing');
        };
        return pending;
      });
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      runScript(mk, '/eg/home', { indexedDB: fake });
      await settle();
      const started = mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await settle(10);
      await started;
      expect(originalSetQueue).toHaveBeenCalledOnce();
    });

    it('still signs out when clearing storage fails', async () => {
      const fake = fakeIndexedDB();
      fake.objectStore.clear = () => {
        throw new Error('blocked');
      };
      const { mk } = fakeMusicKit(tracks);
      const original = vi.fn(async () => 'signed out');
      Object.assign(mk, { unauthorize: original });
      runScript(mk, '/eg/home', { indexedDB: fake });
      await settle();
      await expect((mk.unauthorize as unknown as () => Promise<string>)()).resolves.toBe('signed out');
    });
  });

  describe('signing out', () => {
    it('lets the original sign-out failure through', async () => {
      const { mk } = fakeMusicKit(tracks);
      Object.assign(mk, { unauthorize: vi.fn(async () => Promise.reject(new Error('denied'))) });
      runScript(mk);
      await settle();
      await expect((mk.unauthorize as unknown as () => Promise<void>)()).rejects.toThrow('denied');
    });

    it('stops filling the queue after sign-out', async () => {
      const { mk, music } = fakeMusicKit(tracks);
      runScript(mk);
      await settle();
      const answer = music.getMockImplementation();
      music.mockImplementation(async (url, params) => {
        if (!url.includes('/songs/')) throw new Error('offline');
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      const started = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
      await settle(10);
      await started;
      await mk.unauthorize();
      music.mockImplementation(answer as never);
      await settle(30000);
      expect(mk.playLater).not.toHaveBeenCalled();
    });

    it('starts from nothing saved after sign-out and saves again after sign-in', async () => {
      const indexedDB = fakeIndexedDB();
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      runScript(mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle(2000);
      await mk.unauthorize();
      await settle(10);
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await settle(10);
      expect(originalSetQueue.mock.calls[0]?.[0].items?.map((t) => t.id)).toEqual(['i.3']);
      expect(savedItems(indexedDB, PLAYLIST)).toHaveLength(4);
    });

    it('wraps sign-out on a replaced instance too', async () => {
      const indexedDB = fakeIndexedDB();
      const first = fakeMusicKit(tracks);
      const second = fakeMusicKit(tracks);
      const window = runScript(first.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB });
      await settle(2000);
      window.MusicKit = { getInstance: () => second.mk };
      await settle(2000);
      expect(savedLists(indexedDB)).toHaveLength(1);
      await second.mk.unauthorize();
      await settle(10);
      expect(indexedDB.store.size).toBe(0);
    });
  });

  describe('overlapping requests', () => {
    it('lets the newest of two quick requests win', async () => {
      const indexedDB = fakeIndexedDB();
      seedList(indexedDB, PLAYLIST, '2026-11-01:5', tracks.filter((t) => t.attributes.playParams));
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      runScript(mk, '/eg/home', { indexedDB });
      await settle();
      const older = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
      const newer = mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await settle(10);
      await Promise.all([older, newer]);
      expect(originalSetQueue).toHaveBeenCalledOnce();
      expect(originalSetQueue.mock.calls[0]?.[0].startWith).toBe('i.3');
    });

    it('lets an album started during a playlist start win', async () => {
      const indexedDB = fakeIndexedDB();
      seedList(indexedDB, PLAYLIST, '2026-11-01:5', [track('i.0'), track('i.1')]);
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      runScript(mk, '/eg/home', { indexedDB });
      await settle();
      const older = mk.setQueue(playlistRequest({ id: 'i.1', type: 'songs' }));
      const album = mk.setQueue({ albums: ['1'] });
      await settle(10);
      await Promise.all([older, album]);
      expect(originalSetQueue).toHaveBeenCalledOnce();
      expect(originalSetQueue).toHaveBeenCalledWith({ albums: ['1'] });
    });

    it('passes station queues through and ends an older fill', async () => {
      const { mk } = fakeMusicKit(tracks);
      const original = mk.setStationQueue;
      runScript(mk);
      await settle();
      const result = await (mk.setStationQueue as unknown as (options: unknown) => Promise<string>)({ station: 'ra.1' });
      expect(result).toBe('station');
      expect(original).toHaveBeenCalledWith({ station: 'ra.1' });
    });

    it('keeps working when called without its owner', async () => {
      const { mk, originalSetQueue } = await primed();
      const detached = mk.setQueue;
      await detached(playlistRequest({ id: 'i.3', type: 'songs' }));
      expect(originalSetQueue.mock.calls[0]?.[0].startWith).toBe('i.3');
    });
  });

  describe('starting with no saved list, more cases', () => {
    it('queues the whole list after a start song that is not in it', async () => {
      const { mk, music } = fakeMusicKit(tracks);
      const answer = music.getMockImplementation();
      music.mockImplementation(async (url, params) => {
        if (url.endsWith('/songs/i.ghost')) return { data: { data: [track('i.ghost')] } };
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      runScript(mk);
      await settle();
      const started = mk.setQueue(playlistRequest({ id: 'i.ghost', type: 'songs' }));
      await settle(10);
      await started;
      await settle(10);
      const later = mk.playLater.mock.calls as unknown as [{ items: Track[] }][];
      expect(later[0]?.[0].items.map((t) => t.id)).toEqual(['i.0', 'i.1', 'i.3', 'i.4']);
    });

    it('starts Play on the first song and keeps playlist order for the rest', async () => {
      const { mk, originalSetQueue } = fakeMusicKit(manyTracks(30));
      runScript(mk);
      await settle();
      await mk.setQueue(playlistRequest({ id: PLAYLIST, type: 'playlists' }));
      await settle(10);
      expect(originalSetQueue.mock.calls[0]?.[0].startWith).toBe('i.0');
      const later = mk.playLater.mock.calls as unknown as [{ items: Track[] }][];
      expect(later[0]?.[0].items.map((t) => t.id)).toEqual(manyTracks(30).slice(1).map((t) => t.id));
    });

    it('starts a chosen song once and queues only the songs after it', async () => {
      const { mk, originalSetQueue } = fakeMusicKit(manyTracks(10));
      runScript(mk);
      await settle();
      await mk.setQueue(playlistRequest({ id: 'i.6', type: 'songs' }));
      await settle(10);
      expect(originalSetQueue).toHaveBeenCalledOnce();
      const later = mk.playLater.mock.calls as unknown as [{ items: Track[] }][];
      expect(later[0]?.[0].items.map((t) => t.id)).toEqual(['i.7', 'i.8', 'i.9']);
    });

    it('uses the standard queue when MusicKit has no queue to inspect', async () => {
      const { mk, originalSetQueue } = await primed();
      Object.assign(mk, { queue: undefined });
      await mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      expect(originalSetQueue).toHaveBeenCalledOnce();
    });
  });

  describe('opening playlist pages', () => {
    it.each([
      ['with a storefront', '/eg/library/playlist/p.abc'],
      ['with another storefront', '/gb/library/playlist/p.abc'],
      ['with no storefront', '/library/playlist/p.abc'],
      ['with a trailing slash', '/eg/library/playlist/p.abc/'],
    ])('prepares the list %s', async (_label, pathname) => {
      const { mk, music } = fakeMusicKit(tracks);
      runScript(mk, pathname);
      await settle(2000);
      expect(music.mock.calls.some(([url]) => url.includes('/playlists/p.abc'))).toBe(true);
    });

    it.each([
      ['a catalogue playlist', '/eg/playlist/some-name/pl.abc'],
      ['an album', '/eg/album/some-name/123'],
      ['the home page', '/eg/home'],
      ['the library songs page', '/eg/library/songs'],
      ['all playlists', '/eg/library/all-playlists'],
      ['a library playlist folder', '/eg/library/playlist-folder/x'],
    ])('leaves %s alone', async (_label, pathname) => {
      const { mk, music } = fakeMusicKit(tracks);
      runScript(mk, pathname);
      await settle(2000);
      expect(music).not.toHaveBeenCalled();
    });

    it('prepares each playlist as the page changes and never repeats within a minute', async () => {
      const { mk, music } = fakeMusicKit(tracks);
      const window = runScript(mk, '/eg/library/playlist/p.one');
      await settle(2000);
      const location = window.location as { pathname: string };
      location.pathname = '/eg/library/playlist/p.two';
      await settle(2000);
      const afterTwo = music.mock.calls.length;
      location.pathname = '/eg/library/playlist/p.one';
      await settle(2000);
      expect(music.mock.calls.length).toBe(afterTwo);
      const urls = music.mock.calls.map(([url]) => url);
      expect(urls.some((url) => url.includes('/p.one'))).toBe(true);
      expect(urls.some((url) => url.includes('/p.two'))).toBe(true);
    });

    it('does nothing when MusicKit has no instance yet', async () => {
      const { mk, originalSetQueue } = fakeMusicKit(tracks);
      const window = runScript(mk);
      window.MusicKit = { getInstance: () => null };
      await settle(3000);
      expect(mk.setQueue).toBe(originalSetQueue);
    });
  });

  describe('replacing the MusicKit instance', () => {
    it('keeps the first instance working and wraps the second separately', async () => {
      const first = fakeMusicKit(tracks);
      const second = fakeMusicKit(tracks);
      const window = runScript(first.mk, `/eg/library/playlist/${PLAYLIST}`);
      await settle(2000);
      window.MusicKit = { getInstance: () => second.mk };
      await settle(2000);
      await first.mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      await second.mk.setQueue(playlistRequest({ id: 'i.3', type: 'songs' }));
      expect(first.originalSetQueue.mock.calls[0]?.[0].items).toHaveLength(4);
      expect(second.originalSetQueue.mock.calls[0]?.[0].items).toBeDefined();
    });

    it('does not wrap an instance with no setQueue', async () => {
      const first = fakeMusicKit(tracks);
      const bare = { ...fakeMusicKit(tracks).mk } as Partial<ReturnType<typeof fakeMusicKit>['mk']>;
      delete bare.setQueue;
      const window = runScript(first.mk);
      await settle();
      window.MusicKit = { getInstance: () => bare };
      await settle(2000);
      expect(bare.setQueue).toBeUndefined();
    });
  });

  it('wraps a replaced MusicKit instance', async () => {
    const first = fakeMusicKit(tracks);
    const second = fakeMusicKit(tracks);
    const window = runScript(first.mk);
    await settle();
    window.MusicKit = { getInstance: () => second.mk };
    await settle();
    await second.mk.setQueue(playlistRequest({ id: PLAYLIST, type: 'playlists' }));
    expect(second.originalSetQueue.mock.calls[0]?.[0].items).toBeDefined();
  });
});
