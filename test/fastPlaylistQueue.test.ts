import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const source = fs.readFileSync(
  path.join(__dirname, '..', 'assets', 'fastPlaylistQueue.js'),
  'utf-8',
);

const PLAYLIST = 'p.large';
const OTHER = 'p.other';
const SHUFFLE_SONGS = 1;
const DAY_MS = 24 * 60 * 60 * 1000;
const MB = 1024 * 1024;

interface Track {
  id: string;
  type: string;
  attributes: { playParams?: { id: string }; name?: string };
}

function track(id: string, playable = true, name?: string): Track {
  return {
    id,
    type: 'library-songs',
    attributes: { ...(playable ? { playParams: { id } } : {}), ...(name ? { name } : {}) },
  };
}

function manyTracks(count: number): Track[] {
  return Array.from({ length: count }, (_, i) => track(`i.${i}`));
}

interface QueueRequest {
  items?: Track[];
  playlists?: string[];
  startWith?: string | { id: string; type: string };
  context?: unknown;
  url?: string;
}

interface MetaRecord {
  id: string;
  version: string;
  saved: number;
  size: number;
}

interface ListRecord {
  id: string;
  items?: Track[];
}

/** A small IndexedDB stand-in: stores, transactions that commit or abort, and failure switches. */
function fakeIndexedDB(existingStores: string[] = []) {
  const meta = new Map<string, MetaRecord>();
  const lists = new Map<string, ListRecord>();
  const control = { abortNext: 0, openError: false, blocked: false, hang: false, openFailures: 0, blockedOnce: false, abortCalls: 0, throwOnListsPut: false };
  const puts = { meta: 0, lists: 0 };
  const created: string[] = [];
  const deleted: string[] = [];

  function transaction() {
    let pending = 0;
    let done = false;
    const aborted = control.abortNext > 0;
    if (aborted) control.abortNext -= 1;
    const tx: { oncomplete?: () => void; onabort?: () => void; onerror?: () => void } = {};
    const finish = () =>
      queueMicrotask(() => {
        if (pending > 0 || done) return;
        done = true;
        if (aborted) tx.onabort?.();
        else tx.oncomplete?.();
      });
    const request = <T>(run: () => T) => {
      const req: { result?: T; onsuccess?: () => void } = {};
      pending += 1;
      queueMicrotask(() => {
        if (!aborted) {
          req.result = run();
          req.onsuccess?.();
        }
        pending -= 1;
        finish();
      });
      return req;
    };
    const store = <V extends { id: string }>(map: Map<string, V>, name: 'meta' | 'lists') => ({
      get: (id: string) => request(() => structuredClone(map.get(id))),
      getAll: () => request(() => [...map.values()].map((value) => structuredClone(value))),
      put: (value: V) => {
        if (name === 'lists' && control.throwOnListsPut) {
          control.throwOnListsPut = false;
          throw new Error('DataCloneError');
        }
        return request(() => {
          puts[name] += 1;
          map.set(value.id, structuredClone(value));
          return value.id;
        });
      },
      delete: (id: string) => request(() => void map.delete(id)),
      clear: () => request(() => map.clear()),
    });
    const stores = { meta: store(meta, 'meta'), lists: store(lists, 'lists') };
    Object.assign(tx, {
      objectStore: (name: 'meta' | 'lists') => stores[name],
      abort: () => void (control.abortCalls += 1),
    });
    finish();
    return tx;
  }

  const db = {
    objectStoreNames: [...existingStores],
    createObjectStore: (name: string) => void created.push(name),
    deleteObjectStore: (name: string) => void deleted.push(name),
    transaction,
    close: vi.fn(),
    onversionchange: undefined as undefined | (() => void),
    onclose: undefined as undefined | (() => void),
  };
  const open = vi.fn(() => {
    const request: {
      result: typeof db;
      onsuccess?: () => void;
      onerror?: () => void;
      onblocked?: () => void;
      onupgradeneeded?: () => void;
    } = { result: db };
    queueMicrotask(() => {
      if (control.hang) return;
      if (control.openFailures > 0) {
        control.openFailures -= 1;
        return request.onerror?.();
      }
      if (control.blockedOnce) {
        control.blockedOnce = false;
        return request.onblocked?.();
      }
      if (control.openError) return request.onerror?.();
      if (control.blocked) return request.onblocked?.();
      request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  });
  return { api: { open }, open, db, meta, lists, control, puts, created, deleted };
}

type FakeDB = ReturnType<typeof fakeIndexedDB>;

function seed(fake: FakeDB, id: string, version: string, items: Track[], usedAt = Date.now()) {
  const size = JSON.stringify(items).length;
  fake.meta.set(id, { id, version, saved: usedAt, size });
  fake.lists.set(id, { id, items: structuredClone(items) });
}

/** Records MusicKit calls and serves a playlist from memory as Apple's API would. */
function fakeMusicKit(initial: Track[]) {
  const state = { tracks: initial, modified: '2026-11-01', omitTotal: false, next: false };
  const music = vi.fn(async (url: string, params?: { limit?: number; offset?: number }) => {
    if (url.endsWith('/tracks')) {
      const offset = params?.offset ?? 0;
      const limit = params?.limit ?? 100;
      const body: { data: Track[]; meta?: { total: number }; next?: string } = {
        data: state.tracks.slice(offset, offset + limit),
      };
      if (!state.omitTotal) body.meta = { total: state.tracks.length };
      if (state.next && offset + limit < state.tracks.length) body.next = 'more';
      return { data: body };
    }
    return { data: { data: [{ attributes: { lastModifiedDate: state.modified } }] } };
  });
  const original = vi.fn(async (_request: unknown): Promise<unknown> => 'queue');
  const station = vi.fn(async (_request: unknown): Promise<unknown> => 'station');
  const signOut = vi.fn(async (..._args: unknown[]): Promise<unknown> => 'signed out');
  const mk = {
    shuffleMode: 0,
    queue: { length: 1 } as { length: number } | undefined,
    api: { music },
    setQueue: original as (request: unknown) => Promise<unknown>,
    setStationQueue: station as (request: unknown) => Promise<unknown>,
    play: vi.fn(async () => undefined),
    playLater: vi.fn(async () => undefined),
    unauthorize: signOut as (...args: unknown[]) => Promise<unknown>,
  };
  return { mk, original, music, state, station, signOut };
}

function runScript(
  mk: unknown,
  pathname = '/eg/home',
  extra: Record<string, unknown> = {},
  warn = vi.fn(),
) {
  const window: Record<string, unknown> = {
    MusicKit: { getInstance: () => mk },
    location: { pathname },
  };
  vm.runInNewContext(source, {
    window,
    setInterval,
    setTimeout,
    structuredClone,
    console: { warn },
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
    JSON,
    TextEncoder,
    ...extra,
  });
  return { window, warn };
}

function playlistRequest(startWith?: { id: string; type: string }, id = PLAYLIST) {
  return {
    context: { featureName: 'library / playlist_detail' },
    playlists: [id],
    parameters: { l: 'en-GB' },
    ...(startWith ? { startWith } : {}),
  };
}

const song = (id: string) => playlistRequest({ id, type: 'songs' });
const playButton = () => playlistRequest({ id: PLAYLIST, type: 'playlists' });

/** Let the install poll and any background work finish. */
async function settle(ms = 1100) {
  await vi.advanceTimersByTimeAsync(ms);
}

function pageCalls(music: ReturnType<typeof fakeMusicKit>['music']) {
  return music.mock.calls.filter(([url, params]) => url.endsWith('/tracks') && params?.limit === 100);
}

function sentIds(original: ReturnType<typeof fakeMusicKit>['original'], call = 0) {
  return (original.mock.calls[call]?.[0] as QueueRequest).items?.map((t) => t.id);
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

describe('fastPlaylistQueue', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  const tracks = [track('i.0'), track('i.1'), track('i.unplayable', false), track('i.3'), track('i.4')];

  /** A running script on a playlist page, with the page's list already saved. */
  async function primed(list = tracks) {
    const fake = fakeMusicKit(list);
    const db = fakeIndexedDB();
    runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB: db.api });
    await settle();
    fake.music.mockClear();
    return { ...fake, db };
  }

  /** A running script on the home page, so nothing is prepared or saved before a play. */
  async function cold(list: Track[] = tracks) {
    const fake = fakeMusicKit(list);
    const db = fakeIndexedDB();
    const run = runScript(fake.mk, '/eg/home', { indexedDB: db.api });
    await settle();
    return { ...fake, db, ...run };
  }

  describe('a saved playlist', () => {
    it('is prepared and saved when its page opens', async () => {
      const { db, music } = await primed();
      expect(pageCalls(music)).toHaveLength(0);
      expect(db.meta.get(PLAYLIST)?.version).toBe('2026-11-01:5');
      expect(db.lists.get(PLAYLIST)?.items?.map((t) => t.id)).toEqual(['i.0', 'i.1', 'i.3', 'i.4']);
    });

    it('starts a chosen song with the whole list queued and no page request', async () => {
      const { mk, original, music } = await primed();
      await mk.setQueue(song('i.3'));

      expect(original).toHaveBeenCalledOnce();
      const sent = original.mock.calls[0]?.[0] as QueueRequest;
      expect(sent.playlists).toBeUndefined();
      expect(sent.startWith).toBe('i.3');
      expect(sent.context).toEqual({ featureName: 'library / playlist_detail' });
      expect(sent.items?.map((t) => t.id)).toEqual(['i.0', 'i.1', 'i.3', 'i.4']);
      expect(pageCalls(music)).toHaveLength(0);
    });

    it('checks for changes with two small requests on every play', async () => {
      const { mk, music } = await primed();
      await mk.setQueue(song('i.1'));
      await mk.setQueue(song('i.4'));
      expect(music.mock.calls.filter(([, params]) => params?.limit === 1)).toHaveLength(2);
      expect(music.mock.calls).toHaveLength(4);
    });

    it('starts the Play button at the first playable track', async () => {
      const { mk, original } = await primed();
      await mk.setQueue(playButton());
      expect((original.mock.calls[0]?.[0] as QueueRequest).startWith).toBe('i.0');
    });

    it('lets MusicKit shuffle for the Shuffle button without touching the shuffle setting', async () => {
      const { mk, original } = await primed();
      mk.shuffleMode = SHUFFLE_SONGS;
      await mk.setQueue(playButton());
      const sent = original.mock.calls[0]?.[0] as QueueRequest;
      expect(sent.items).toHaveLength(4);
      expect(sent.startWith).toBeUndefined();
      expect(mk.shuffleMode).toBe(SHUFFLE_SONGS);
    });

    it('uses the standard request for a chosen song while shuffle is on', async () => {
      const { mk, original } = await primed();
      mk.shuffleMode = SHUFFLE_SONGS;
      const request = song('i.4');
      await mk.setQueue(request);
      expect(original).toHaveBeenCalledOnce();
      expect(original).toHaveBeenCalledWith(request);
    });

    it('uses the standard request for a song that is not in the list', async () => {
      const { mk, original } = await primed();
      const request = song('i.added-elsewhere');
      await mk.setQueue(request);
      expect(original).toHaveBeenCalledOnce();
      expect(original).toHaveBeenCalledWith(request);
    });

    it('gives MusicKit a copy it can change without changing the saved list', async () => {
      const { mk, original, db } = await primed();
      await mk.setQueue(song('i.1'));
      (original.mock.calls[0]?.[0] as QueueRequest).items?.splice(0);
      await mk.setQueue(song('i.1'));
      expect(sentIds(original, 1)).toEqual(['i.0', 'i.1', 'i.3', 'i.4']);
      expect(db.lists.get(PLAYLIST)?.items).toHaveLength(4);
    });

    it('never starts playback or reads the page', () => {
      expect(source).not.toMatch(/\bdocument\./);
      expect(source).not.toMatch(/\.play\(/);
      expect(source).not.toMatch(/shuffleMode\s*=[^=]/);
      expect(source).not.toMatch(/playLater/);
    });
  });

  describe('a playlist that has not been saved', () => {
    it('queues the complete list in order and starts on the chosen song', async () => {
      const list = manyTracks(250);
      const { mk, original, music } = await cold(list);
      await mk.setQueue(song('i.120'));

      expect(original).toHaveBeenCalledOnce();
      const sent = original.mock.calls[0]?.[0] as QueueRequest;
      expect(sent.items?.map((t) => t.id)).toEqual(list.map((t) => t.id));
      expect(sent.startWith).toBe('i.120');
      expect(pageCalls(music)).toHaveLength(3);
      expect(mk.playLater).not.toHaveBeenCalled();
    });

    it('can start Shuffle on any track because MusicKit gets the complete list', async () => {
      const list = manyTracks(1787);
      const { mk, original } = await cold(list);
      mk.shuffleMode = SHUFFLE_SONGS;
      await mk.setQueue(playButton());
      const sent = original.mock.calls[0]?.[0] as QueueRequest;
      expect(sent.items).toHaveLength(1787);
      expect(sent.startWith).toBeUndefined();
    });

    it('starts Play on the first playable track when the first track is unplayable', async () => {
      const { mk, original } = await cold([track('i.0', false), track('i.1'), track('i.2')]);
      await mk.setQueue(playButton());
      const sent = original.mock.calls[0]?.[0] as QueueRequest;
      expect(sent.startWith).toBe('i.1');
      expect(sent.items?.map((t) => t.id)).toEqual(['i.1', 'i.2']);
    });

    it('shares one fetch between opening the page and pressing play', async () => {
      const list = manyTracks(250);
      const fake = fakeMusicKit(list);
      const db = fakeIndexedDB();
      const gate = deferred();
      const answer = fake.music.getMockImplementation();
      fake.music.mockImplementation(async (url, params) => {
        if (params?.limit === 100) await gate.promise;
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB: db.api });
      await settle();
      const started = fake.mk.setQueue(playButton());
      await settle(10);
      gate.resolve();
      await started;
      expect(pageCalls(fake.music)).toHaveLength(3);
      expect(fake.original).toHaveBeenCalledOnce();
    });

    it('saves the list it fetched, so the next play fetches no pages', async () => {
      const { mk, music, db } = await cold(manyTracks(250));
      await mk.setQueue(song('i.1'));
      await settle(10);
      expect(db.lists.get(PLAYLIST)?.items).toHaveLength(250);
      music.mockClear();
      await mk.setQueue(song('i.2'));
      expect(pageCalls(music)).toHaveLength(0);
    });
  });

  describe('a playlist that repeats a song', () => {
    const repeated = [track('i.0'), track('i.1'), track('i.0'), track('i.2')];

    it('uses the standard request once on the first play, with nothing queued by the script', async () => {
      const { mk, original } = await cold(repeated);
      const request = song('i.1');
      await mk.setQueue(request);
      expect(original).toHaveBeenCalledOnce();
      expect(original).toHaveBeenCalledWith(request);
      expect(mk.playLater).not.toHaveBeenCalled();
    });

    it('keeps using the standard request on later plays and on Shuffle', async () => {
      const { mk, original } = await cold(repeated);
      await mk.setQueue(song('i.1'));
      mk.shuffleMode = SHUFFLE_SONGS;
      const request = playButton();
      await mk.setQueue(request);
      expect(original).toHaveBeenCalledTimes(2);
      expect(original).toHaveBeenLastCalledWith(request);
    });

    it('does not mistake different songs for repeats', async () => {
      const { mk, original } = await cold([track('i.0'), track('i.1')]);
      await mk.setQueue(playButton());
      expect((original.mock.calls[0]?.[0] as QueueRequest).items).toHaveLength(2);
    });
  });

  describe('completeness', () => {
    it('does not use or save a paginated list when the total is missing', async () => {
      const fake = await cold(manyTracks(250));
      fake.state.omitTotal = true;
      fake.state.next = true;
      const request = playButton();
      await fake.mk.setQueue(request);
      expect(fake.original).toHaveBeenCalledOnce();
      expect(fake.original).toHaveBeenCalledWith(request);
      expect(fake.db.lists.size).toBe(0);
      expect(fake.warn).toHaveBeenCalled();
    });

    it('does not use or save a list that has fewer tracks than the total', async () => {
      const fake = await cold(manyTracks(250));
      const answer = fake.music.getMockImplementation();
      fake.music.mockImplementation(async (url, params) => {
        const result = (await answer?.(url, params)) as { data: { data: Track[] } };
        if (params?.offset === 100) result.data.data = result.data.data.slice(0, 10);
        return result as never;
      });
      const request = playButton();
      await fake.mk.setQueue(request);
      expect(fake.original).toHaveBeenCalledOnce();
      expect(fake.original).toHaveBeenCalledWith(request);
      expect(fake.db.lists.size).toBe(0);
    });

    it('retries a page that fails once, and still uses the fast request', async () => {
      const fake = await cold(manyTracks(250));
      const answer = fake.music.getMockImplementation();
      let failed = false;
      fake.music.mockImplementation(async (url, params) => {
        if (params?.offset === 100 && !failed) {
          failed = true;
          throw new Error('429');
        }
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      await fake.mk.setQueue(playButton());
      expect(sentIds(fake.original)).toHaveLength(250);
      expect(fake.original).toHaveBeenCalledOnce();
    });

    it('retries the change check once, and still uses the saved list', async () => {
      const { mk, original, music } = await primed();
      let failed = false;
      const answer = music.getMockImplementation();
      music.mockImplementation(async (url, params) => {
        if (!failed && !url.endsWith('/tracks')) {
          failed = true;
          throw new Error('503');
        }
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      await mk.setQueue(song('i.1'));
      expect(original).toHaveBeenCalledOnce();
      expect(sentIds(original)).toEqual(['i.0', 'i.1', 'i.3', 'i.4']);
      expect(pageCalls(music)).toHaveLength(0);
    });

    it('uses the standard request when the change check fails twice', async () => {
      const { mk, original, music } = await primed();
      music.mockImplementation(async (url: string) => {
        if (!url.endsWith('/tracks')) throw new Error('503');
        return { data: { data: [], meta: { total: 0 } } } as never;
      });
      const request = song('i.1');
      await mk.setQueue(request);
      expect(original).toHaveBeenCalledOnce();
      expect(original).toHaveBeenCalledWith(request);
    });

    it.each([429, 500])('retries a page that answers with HTTP %i as an error body', async (status) => {
      const fake = await cold(manyTracks(250));
      const answer = fake.music.getMockImplementation();
      let failed = false;
      fake.music.mockImplementation(async (url, params) => {
        if (params?.offset === 100 && !failed) {
          failed = true;
          return { data: { errors: [{ status: String(status) }] } } as never;
        }
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      await fake.mk.setQueue(playButton());
      expect(sentIds(fake.original)).toHaveLength(250);
      expect(fake.db.lists.get(PLAYLIST)?.items).toHaveLength(250);
    });

    it('uses the standard request when a page keeps answering with an error body', async () => {
      const fake = await cold(manyTracks(250));
      const answer = fake.music.getMockImplementation();
      fake.music.mockImplementation(async (url, params) => {
        if (params?.offset === 200) return { data: { errors: [{ status: '429' }] } } as never;
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      const request = playButton();
      await fake.mk.setQueue(request);
      expect(fake.original).toHaveBeenCalledOnce();
      expect(fake.original).toHaveBeenCalledWith(request);
      expect(fake.db.lists.size).toBe(0);
    });

    it('retries the change check when it answers with an error body', async () => {
      const { mk, original, music } = await primed();
      const answer = music.getMockImplementation();
      let failed = false;
      music.mockImplementation(async (url, params) => {
        if (!failed && url.endsWith('/tracks')) {
          failed = true;
          return { data: { errors: [{ status: '429' }] } } as never;
        }
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      await mk.setQueue(song('i.1'));
      expect(sentIds(original)).toEqual(['i.0', 'i.1', 'i.3', 'i.4']);
      expect(pageCalls(music)).toHaveLength(0);
    });

    it('uses the standard request when a page fails twice', async () => {
      const fake = await cold(manyTracks(250));
      const answer = fake.music.getMockImplementation();
      fake.music.mockImplementation(async (url, params) => {
        if (params?.offset === 200) throw new Error('500');
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      const request = playButton();
      await fake.mk.setQueue(request);
      expect(fake.original).toHaveBeenCalledOnce();
      expect(fake.original).toHaveBeenCalledWith(request);
      expect(fake.db.lists.size).toBe(0);
    });

    it('does not queue or save a list when a page comes back as an error body that was meant to hold one track', async () => {
      const fake = await cold(manyTracks(101));
      const answer = fake.music.getMockImplementation();
      fake.music.mockImplementation(async (url, params) => {
        if (params?.offset === 100) return { data: { errors: [{ status: '404' }] } } as never;
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      const request = playButton();
      await fake.mk.setQueue(request);
      expect(fake.original).toHaveBeenCalledOnce();
      expect(fake.original).toHaveBeenCalledWith(request);
      expect(fake.db.lists.size).toBe(0);
    });

    it('does not trust a playlist that has no modified date', async () => {
      const fake = await cold(tracks);
      const answer = fake.music.getMockImplementation();
      fake.music.mockImplementation(async (url, params) => {
        if (!url.endsWith('/tracks')) return { data: { data: [{ attributes: {} }] } } as never;
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      const request = song('i.1');
      await fake.mk.setQueue(request);
      expect(fake.original).toHaveBeenCalledOnce();
      expect(fake.original).toHaveBeenCalledWith(request);
      expect(fake.db.lists.size).toBe(0);
    });

    it('stops asking for more pages once one page has failed twice', async () => {
      const fake = await cold(manyTracks(1800));
      const answer = fake.music.getMockImplementation();
      fake.music.mockImplementation(async (url, params) => {
        if (params?.offset === 100) throw new Error('500');
        await new Promise((resolve) => setTimeout(resolve, 50));
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      const started = fake.mk.setQueue(playButton());
      await settle(1000);
      await started;
      expect(pageCalls(fake.music).length).toBeLessThan(14);
    });

    it('accepts a single page with no total, since nothing follows it', async () => {
      const fake = await cold([track('i.0'), track('i.1')]);
      fake.state.omitTotal = true;
      await fake.mk.setQueue(playButton());
      expect((fake.original.mock.calls[0]?.[0] as QueueRequest).items).toHaveLength(2);
    });

    it.each([1, 99, 100, 101, 200, 201, 250, 1787])(
      'fetches %i tracks in the right number of pages, in order, eight at a time at most',
      async (count) => {
        const list = manyTracks(count);
        const fake = fakeMusicKit(list);
        let running = 0;
        let peak = 0;
        const answer = fake.music.getMockImplementation();
        fake.music.mockImplementation(async (url, params) => {
          running += 1;
          peak = Math.max(peak, running);
          await Promise.resolve();
          running -= 1;
          return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
        });
        runScript(fake.mk, '/eg/home', { indexedDB: fakeIndexedDB().api });
        await settle();
        await fake.mk.setQueue(playButton());
        expect(pageCalls(fake.music)).toHaveLength(Math.ceil(count / 100));
        expect(sentIds(fake.original)).toEqual(list.map((t) => t.id));
        expect(peak).toBeLessThanOrEqual(8);
      },
    );
  });

  describe('a playlist that changed', () => {
    it('plays the refreshed list straight away and saves it', async () => {
      const { mk, original, state, db, music } = await primed();
      state.tracks = [track('i.0'), track('i.1'), track('i.9'), track('i.3'), track('i.4')];
      state.modified = '2026-11-02';
      await mk.setQueue(song('i.9'));

      expect(original).toHaveBeenCalledOnce();
      expect(sentIds(original)).toEqual(['i.0', 'i.1', 'i.9', 'i.3', 'i.4']);
      expect((original.mock.calls[0]?.[0] as QueueRequest).startWith).toBe('i.9');
      expect(pageCalls(music)).toHaveLength(1);
      await settle(10);
      expect(db.meta.get(PLAYLIST)?.version).toBe('2026-11-02:5');
      expect(db.lists.get(PLAYLIST)?.items?.map((t) => t.id)).toContain('i.9');
    });

    it('never queues a track that was removed', async () => {
      const { mk, original, state } = await primed();
      state.tracks = [track('i.0'), track('i.1')];
      await mk.setQueue(song('i.1'));
      expect(sentIds(original)).toEqual(['i.0', 'i.1']);
    });

    it('notices a change in the total even when the date is the same', async () => {
      const { mk, original, state } = await primed();
      state.tracks = [...tracks, track('i.5')];
      await mk.setQueue(song('i.5'));
      expect(sentIds(original)).toContain('i.5');
    });
  });

  describe('requests it leaves alone', () => {
    it.each([
      ['no options', undefined],
      ['null options', null],
      ['text instead of options', 'p.large'],
      ['an empty playlist list', { playlists: [] }],
      ['playlists that are not a list', { playlists: 'p.large' }],
      ['several playlists', { playlists: ['p.a', 'p.b'] }],
      ['a playlist ID that is not text', { playlists: [5] }],
      ['a catalogue playlist', { playlists: ['pl.abc'] }],
      ['an album', { album: 'l.abc' }],
      ['a URL', { url: 'https://music.apple.com/gb/album/x/1' }],
      ['ready-made items', { playlists: [PLAYLIST], items: [] }],
      ['an option it does not understand', { playlists: [PLAYLIST], repeat: true }],
      ['a start of another type', { playlists: [PLAYLIST], startWith: { id: 'i.1', type: 'albums' } }],
      ['a start that is null', { playlists: [PLAYLIST], startWith: null }],
      ['a start ID that is not text', { playlists: [PLAYLIST], startWith: { id: 1, type: 'songs' } }],
      ['text as the start', { playlists: [PLAYLIST], startWith: 'i.1' }],
    ])('passes %s straight through', async (_name, request) => {
      const { mk, original, music } = await cold();
      await mk.setQueue(request);
      expect(original).toHaveBeenCalledOnce();
      expect(original).toHaveBeenCalledWith(request);
      expect(music).not.toHaveBeenCalled();
    });

    it('passes startPlaying false straight through', async () => {
      const { mk, original, music } = await cold();
      const request = { ...playlistRequest(), startPlaying: false };
      await mk.setQueue(request);
      expect(original).toHaveBeenCalledWith(request);
      expect(music).not.toHaveBeenCalled();
    });

    it('keeps startPlaying true and the context and parameters of a handled request', async () => {
      const { mk, original } = await primed();
      await mk.setQueue({ ...playButton(), startPlaying: true });
      const sent = original.mock.calls[0]?.[0] as QueueRequest & { startPlaying?: boolean; parameters?: unknown };
      expect(sent.startPlaying).toBe(true);
      expect(sent.parameters).toEqual({ l: 'en-GB' });
    });
  });

  describe('failures use the standard request, once', () => {
    it('when the list cannot be fetched', async () => {
      const { mk, original, music, warn } = await cold();
      music.mockRejectedValue(new Error('offline'));
      const request = song('i.1');
      await mk.setQueue(request);
      expect(original).toHaveBeenCalledOnce();
      expect(original).toHaveBeenCalledWith(request);
      expect(warn).toHaveBeenCalled();
    });

    it('when the fast request throws, and does not repeat it', async () => {
      const { mk, original } = await primed();
      original.mockRejectedValueOnce(new Error('bad items'));
      const request = song('i.1');
      await expect(mk.setQueue(request)).resolves.toBe('queue');
      expect(original).toHaveBeenCalledTimes(2);
      expect(original).toHaveBeenLastCalledWith(request);
    });

    it('when the fast request builds an empty queue', async () => {
      const { mk, original } = await primed();
      original.mockImplementationOnce(async () => {
        mk.queue = { length: 0 };
        return 'empty';
      });
      original.mockImplementationOnce(async () => {
        mk.queue = { length: 3 };
        return 'queue';
      });
      await expect(mk.setQueue(song('i.1'))).resolves.toBe('queue');
      expect(original).toHaveBeenCalledTimes(2);
    });

    it('passes the error on when the standard request fails too', async () => {
      const { mk, original } = await primed();
      original.mockRejectedValue(new Error('down'));
      await expect(mk.setQueue(song('i.1'))).rejects.toThrow('down');
      expect(original).toHaveBeenCalledTimes(2);
    });

    it('sends the standard request once when the list has no playable track', async () => {
      const { mk, original } = await cold([track('i.0', false)]);
      await mk.setQueue(playButton());
      expect(original).toHaveBeenCalledOnce();
    });

    it("sends the standard request once for an empty playlist, as Apple's API answers it", async () => {
      const { mk, original, music } = await cold();
      music.mockImplementation(async (url: string) =>
        url.endsWith('/tracks')
          ? ({ data: { errors: [{ title: 'No related resources' }] } } as never)
          : ({ data: { data: [{ attributes: { lastModifiedDate: 'x' } }] } } as never),
      );
      await mk.setQueue(playButton());
      expect(original).toHaveBeenCalledOnce();
      expect(original).toHaveBeenCalledWith(playButton());
    });

    it('sends the standard request once for an empty playlist', async () => {
      const { mk, original } = await cold([]);
      await mk.setQueue(playButton());
      expect(original).toHaveBeenCalledOnce();
    });

    it('works with a MusicKit that has no queue to inspect', async () => {
      const { mk, original } = await primed();
      mk.queue = undefined;
      await mk.setQueue(song('i.1'));
      expect(original).toHaveBeenCalledOnce();
    });
  });

  describe('overlapping requests', () => {
    it('lets the newest of two quick requests win', async () => {
      const { mk, original } = await primed();
      const first = mk.setQueue(song('i.1'));
      const second = mk.setQueue(song('i.4'));
      await Promise.all([first, second]);
      expect(original).toHaveBeenCalledOnce();
      expect((original.mock.calls[0]?.[0] as QueueRequest).startWith).toBe('i.4');
    });

    it('lets a station or an album started during a playlist start win', async () => {
      const { mk, original, station } = await primed();
      const first = mk.setQueue(song('i.1'));
      void mk.setStationQueue({ station: 'ra.1' });
      await first;
      expect(original).not.toHaveBeenCalled();
      expect(station).toHaveBeenCalledOnce();

      const second = mk.setQueue(song('i.1'));
      await mk.setQueue({ album: 'l.1' });
      await second;
      expect(original).toHaveBeenCalledOnce();
      expect(original).toHaveBeenCalledWith({ album: 'l.1' });
    });

    it('sends nothing more when an older request that was already sent finishes last', async () => {
      const { mk, original } = await primed();
      const gate = deferred();
      original.mockImplementationOnce(async () => {
        await gate.promise;
        return 'older';
      });
      const older = mk.setQueue(song('i.1'));
      await settle(10);
      const newer = mk.setQueue(song('i.4'));
      await expect(newer).resolves.toBe('queue');
      gate.resolve();
      await expect(older).resolves.toBe('older');
      await settle(10);
      expect(original).toHaveBeenCalledTimes(2);
      expect((original.mock.calls[0]?.[0] as QueueRequest).startWith).toBe('i.1');
      expect((original.mock.calls[1]?.[0] as QueueRequest).startWith).toBe('i.4');
    });

    it('uses the standard request for a chosen song when shuffle is switched on while the list loads', async () => {
      const fake = await cold(manyTracks(250));
      const gate = deferred();
      const answer = fake.music.getMockImplementation();
      fake.music.mockImplementation(async (url, params) => {
        if (params?.limit === 100) await gate.promise;
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      const request = song('i.120');
      const started = fake.mk.setQueue(request);
      await settle(10);
      fake.mk.shuffleMode = SHUFFLE_SONGS;
      gate.resolve();
      await started;
      expect(fake.original).toHaveBeenCalledOnce();
      expect(fake.original).toHaveBeenCalledWith(request);
    });

    it('leaves out the start song for Play when shuffle is switched on while the list loads', async () => {
      const fake = await cold(manyTracks(250));
      const gate = deferred();
      const answer = fake.music.getMockImplementation();
      fake.music.mockImplementation(async (url, params) => {
        if (params?.limit === 100) await gate.promise;
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      const started = fake.mk.setQueue(playButton());
      await settle(10);
      fake.mk.shuffleMode = SHUFFLE_SONGS;
      gate.resolve();
      await started;
      const sent = fake.original.mock.calls[0]?.[0] as QueueRequest;
      expect(sent.items).toHaveLength(250);
      expect(sent.startWith).toBeUndefined();
    });

    it('uses the standard request when MusicKit has no api to fetch with', async () => {
      const fake = fakeMusicKit(tracks);
      const bare = { ...fake.mk } as Record<string, unknown>;
      delete bare.api;
      runScript(bare, '/eg/home', { indexedDB: fakeIndexedDB().api });
      await settle();
      const request = song('i.1');
      await (bare.setQueue as (r: unknown) => Promise<unknown>)(request);
      expect(fake.original).toHaveBeenCalledOnce();
      expect(fake.original).toHaveBeenCalledWith(request);
    });

    it('does not fall back over a newer request', async () => {
      const { mk, original } = await primed();
      const gate = deferred();
      original.mockImplementationOnce(async () => {
        await gate.promise;
        throw new Error('late failure');
      });
      const older = mk.setQueue(song('i.1'));
      await settle(10);
      const newer = mk.setQueue({ album: 'l.1' });
      gate.resolve();
      await Promise.all([older, newer]);
      expect(original).toHaveBeenCalledTimes(2);
      expect(original).toHaveBeenLastCalledWith({ album: 'l.1' });
    });
  });

  describe('opening pages', () => {
    it.each([
      ['/eg/library/playlist/pl.abc', 0],
      ['/eg/album/x/123', 0],
      ['/eg/home', 0],
      ['/eg/library/songs', 0],
      ['/eg/library/playlist/folder', 0],
      ['/eg/library/playlist/p.abc/', 1],
      ['/library/playlist/p.abc', 1],
    ])('%s prepares %i playlists', async (pathname, expected) => {
      const fake = fakeMusicKit(tracks);
      runScript(fake.mk, pathname, { indexedDB: fakeIndexedDB().api });
      await settle();
      expect(pageCalls(fake.music).length > 0 ? 1 : 0).toBe(expected);
    });

    it('prepares each playlist as the page changes, and a page only once', async () => {
      const fake = fakeMusicKit(tracks);
      const { window } = runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB: fakeIndexedDB().api });
      await settle();
      const first = fake.music.mock.calls.length;
      await settle(3000);
      expect(fake.music.mock.calls.length).toBe(first);
      (window.location as { pathname: string }).pathname = `/eg/library/playlist/${OTHER}`;
      await settle();
      expect(fake.music.mock.calls.some(([url]) => url.includes(OTHER))).toBe(true);
    });

    it('stops preparing a playlist that is too large to save', async () => {
      const big = Array.from({ length: 100 }, (_, i) => track(`i.${i}`, true, 'x'.repeat(60 * 1024)));
      const fake = fakeMusicKit(big);
      const db = fakeIndexedDB();
      const { window } = runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB: db.api });
      await settle();
      expect(db.lists.size).toBe(0);
      const fetched = pageCalls(fake.music).length;
      (window.location as { pathname: string }).pathname = '/eg/home';
      await settle();
      (window.location as { pathname: string }).pathname = `/eg/library/playlist/${PLAYLIST}`;
      await settle();
      expect(pageCalls(fake.music)).toHaveLength(fetched);
    });

    it('does nothing until MusicKit exists, and survives getInstance throwing', async () => {
      const fake = fakeMusicKit(tracks);
      const window: Record<string, unknown> = { location: { pathname: '/eg/home' } };
      vm.runInNewContext(source, { window, setInterval, setTimeout, console: { warn: vi.fn() }, Date, Map, Set, WeakSet, Promise, Array, Object, Error, Boolean, JSON });
      await settle();
      window.MusicKit = {
        getInstance: () => {
          throw new Error('not ready');
        },
      };
      await settle();
      window.MusicKit = { getInstance: () => fake.mk };
      await settle();
      await fake.mk.setQueue({ album: 'l.1' });
      expect(fake.original).toHaveBeenCalledOnce();
    });

    it('wraps one instance once, and a replaced instance separately', async () => {
      const first = fakeMusicKit(tracks);
      const { window } = runScript(first.mk, '/eg/home', { indexedDB: fakeIndexedDB().api });
      await settle();
      await settle();
      await first.mk.setQueue({ album: 'l.1' });
      expect(first.original).toHaveBeenCalledOnce();

      const second = fakeMusicKit(tracks);
      window.MusicKit = { getInstance: () => second.mk };
      await settle();
      await second.mk.setQueue(song('i.1'));
      expect(second.original).toHaveBeenCalledOnce();
      expect((second.original.mock.calls[0]?.[0] as QueueRequest).items).toBeDefined();
    });

    it('runs only once when the script is injected again', async () => {
      const fake = fakeMusicKit(tracks);
      const window: Record<string, unknown> = { MusicKit: { getInstance: () => fake.mk }, location: { pathname: '/eg/home' } };
      const context = { window, setInterval, setTimeout, structuredClone, console: { warn: vi.fn() }, Date, Math, Map, Set, WeakSet, Promise, Array, Object, Error, Boolean, JSON, TextEncoder, indexedDB: fakeIndexedDB().api };
      vm.runInNewContext(source, context);
      vm.runInNewContext(source, context);
      await settle();
      await fake.mk.setQueue({ album: 'l.1' });
      expect(fake.original).toHaveBeenCalledOnce();
    });

    it('works on a MusicKit without optional methods', async () => {
      const fake = fakeMusicKit(tracks);
      const bare = { ...fake.mk } as Record<string, unknown>;
      delete bare.setStationQueue;
      delete bare.unauthorize;
      runScript(bare, '/eg/home', { indexedDB: fakeIndexedDB().api });
      await settle();
      await (bare.setQueue as (r: unknown) => Promise<unknown>)({ album: 'l.1' });
      expect(fake.original).toHaveBeenCalledOnce();
    });
  });

  describe('saved data across launches', () => {
    it('is read after a restart without fetching any track page', async () => {
      const db = fakeIndexedDB();
      const first = fakeMusicKit(tracks);
      runScript(first.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB: db.api });
      await settle();

      const second = fakeMusicKit(tracks);
      runScript(second.mk, '/eg/home', { indexedDB: db.api });
      await settle();
      await second.mk.setQueue(song('i.3'));
      expect(pageCalls(second.music)).toHaveLength(0);
      expect(sentIds(second.original)).toEqual(['i.0', 'i.1', 'i.3', 'i.4']);
    });

    it('treats a saved entry with no items as nothing saved', async () => {
      const db = fakeIndexedDB();
      db.meta.set(PLAYLIST, { id: PLAYLIST, version: '2026-11-01:5', saved: Date.now(), size: 10 });
      db.lists.set(PLAYLIST, { id: PLAYLIST });
      const fake = fakeMusicKit(tracks);
      runScript(fake.mk, '/eg/home', { indexedDB: db.api });
      await settle();
      await fake.mk.setQueue(song('i.1'));
      expect(pageCalls(fake.music)).toHaveLength(1);
      expect(sentIds(fake.original)).toEqual(['i.0', 'i.1', 'i.3', 'i.4']);
    });

    it('treats an entry whose version differs as changed', async () => {
      const db = fakeIndexedDB();
      seed(db, PLAYLIST, 'old:99', [track('i.old')]);
      const fake = fakeMusicKit(tracks);
      runScript(fake.mk, '/eg/home', { indexedDB: db.api });
      await settle();
      await fake.mk.setQueue(song('i.1'));
      expect(sentIds(fake.original)).not.toContain('i.old');
    });

    it('opens storage in the new format, dropping any older stores', async () => {
      const db = fakeIndexedDB(['playlists', 'songs']);
      const fake = fakeMusicKit(tracks);
      runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB: db.api });
      await settle();
      expect(db.open).toHaveBeenCalledWith('sidra-fast-queue', 3);
      expect(db.deleted).toEqual(['playlists', 'songs']);
      expect(db.created).toEqual(['meta', 'lists']);
    });

    it('opens the database once however many plays there are', async () => {
      const { mk, db } = await primed();
      await mk.setQueue(song('i.1'));
      await mk.setQueue(song('i.3'));
      expect(db.open).toHaveBeenCalledOnce();
    });

    it('opens the database again after the browser closes it, as when site data is cleared', async () => {
      const { mk, db } = await primed();
      db.meta.clear();
      db.lists.clear();
      db.db.onclose?.();
      await mk.setQueue(song('i.1'));
      await settle(10);
      expect(db.open).toHaveBeenCalledTimes(2);
      expect(db.meta.get(PLAYLIST)?.version).toBe('2026-11-01:5');
      expect(db.lists.get(PLAYLIST)?.items).toHaveLength(4);
    });

    it('lets another connection upgrade the database, then opens it again', async () => {
      const { mk, db } = await primed();
      db.db.onversionchange?.();
      expect(db.db.close).toHaveBeenCalled();
      await mk.setQueue(song('i.1'));
      expect(db.open).toHaveBeenCalledTimes(2);
      expect(db.meta.get(PLAYLIST)?.saved).toBeGreaterThan(0);
    });
  });

  describe('keeping storage small', () => {
    it('keeps at most twenty playlists, dropping the least recently used', async () => {
      const db = fakeIndexedDB();
      const now = Date.now();
      for (let i = 0; i < 20; i += 1) seed(db, `p.old${i}`, 'v', [track(`i.${i}`)], now - (i + 1) * 1000);
      const fake = fakeMusicKit(tracks);
      runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB: db.api });
      await settle();
      expect(db.meta.size).toBe(20);
      expect(db.meta.has(PLAYLIST)).toBe(true);
      expect(db.meta.has('p.old19')).toBe(false);
      expect(db.lists.has('p.old19')).toBe(false);
      expect(db.meta.has('p.old0')).toBe(true);
    });

    it('keeps a new playlist even when every older one is more recent', async () => {
      const db = fakeIndexedDB();
      for (let i = 0; i < 20; i += 1) seed(db, `p.old${i}`, 'v', [track(`i.${i}`)], Date.now() + 60000);
      const fake = fakeMusicKit(tracks);
      runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB: db.api });
      await settle();
      expect(db.meta.has(PLAYLIST)).toBe(true);
      expect(db.meta.size).toBe(20);
    });

    it('drops playlists not used for thirty days as soon as saved data loads', async () => {
      const db = fakeIndexedDB();
      seed(db, 'p.expired', 'v', [track('i.x')], Date.now() - 40 * DAY_MS);
      seed(db, PLAYLIST, '2026-11-01:5', tracks.filter((t) => t.attributes.playParams));
      const fake = fakeMusicKit(tracks);
      runScript(fake.mk, '/eg/home', { indexedDB: db.api });
      await settle();
      await fake.mk.setQueue(song('i.1'));
      await settle(10);
      expect(db.meta.has('p.expired')).toBe(false);
      expect(db.lists.has('p.expired')).toBe(false);
      expect(db.meta.has(PLAYLIST)).toBe(true);
      expect(fake.original).toHaveBeenCalledOnce();
      expect(pageCalls(fake.music)).toHaveLength(0);
    });

    it('drops a playlist whose use was never recorded', async () => {
      const db = fakeIndexedDB();
      db.meta.set('p.nouse', { id: 'p.nouse', version: 'v', size: 10 } as MetaRecord);
      db.lists.set('p.nouse', { id: 'p.nouse', items: [] });
      const fake = fakeMusicKit(tracks);
      runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB: db.api });
      await settle();
      expect(db.meta.has('p.nouse')).toBe(false);
    });

    it('keeps the saved total under five megabytes, dropping the oldest first', async () => {
      const db = fakeIndexedDB();
      const now = Date.now();
      for (const [id, age] of [['p.a', 1], ['p.b', 2], ['p.c', 3]] as const) {
        db.meta.set(id, { id, version: 'v', saved: now - age * 1000, size: 2 * MB });
        db.lists.set(id, { id, items: [] });
      }
      const fake = fakeMusicKit(tracks);
      runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB: db.api });
      await settle();
      expect([...db.meta.keys()].sort()).toEqual(['p.a', 'p.b', PLAYLIST]);
      expect([...db.lists.keys()].sort()).toEqual(['p.a', 'p.b', PLAYLIST]);
    });

    it('does not save a playlist larger than the limit, and still plays it', async () => {
      const big = Array.from({ length: 100 }, (_, i) => track(`i.${i}`, true, 'x'.repeat(60 * 1024)));
      const { mk, original, db } = await cold(big);
      await mk.setQueue(playButton());
      await settle(10);
      expect(db.lists.size).toBe(0);
      expect((original.mock.calls[0]?.[0] as QueueRequest).items).toHaveLength(100);
    });

    it('renews a playlist when it is saved again, so it outlives older ones', async () => {
      const db = fakeIndexedDB();
      const now = Date.now();
      for (let i = 0; i < 19; i += 1) seed(db, `p.old${i}`, 'v', [track(`i.${i}`)], now - (i + 1) * 1000);
      seed(db, PLAYLIST, 'stale', [track('i.old')], now - 100 * 1000);
      const fake = fakeMusicKit(tracks);
      runScript(fake.mk, '/eg/home', { indexedDB: db.api });
      await settle();
      await fake.mk.setQueue(song('i.1'));
      await settle(10);
      await fake.mk.setQueue(playlistRequest(undefined, OTHER));
      await settle(10);
      expect(db.meta.has(OTHER)).toBe(true);
      expect(db.meta.has(PLAYLIST)).toBe(true);
      expect(db.meta.has('p.old18')).toBe(false);
      expect(db.meta.size).toBe(20);
    });

    it('counts the size in bytes, so non-Latin text cannot slip past the limit', async () => {
      const wide = Array.from({ length: 100 }, (_, i) => track(`i.${i}`, true, '\u0639'.repeat(30000)));
      const { mk, original, db } = await cold(wide);
      await mk.setQueue(playButton());
      await settle(10);
      expect((original.mock.calls[0]?.[0] as QueueRequest).items).toHaveLength(100);
      expect(db.lists.size).toBe(0);
    });

    it('treats a record dated far in the future as expired, so a clock change cannot keep it', async () => {
      const db = fakeIndexedDB();
      seed(db, 'p.future', 'v', [track('i.x')], Date.now() + 40 * DAY_MS);
      const fake = fakeMusicKit(tracks);
      runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB: db.api });
      await settle();
      expect(db.meta.has('p.future')).toBe(false);
    });
  });

  describe('signing out', () => {
    it('deletes the saved data and still signs out with the original arguments and result', async () => {
      const { mk, db, signOut } = await primed();
      expect(db.meta.size).toBe(1);
      const result = await mk.unauthorize('a', 2);
      await settle(10);
      expect(result).toBe('signed out');
      expect(signOut).toHaveBeenCalledWith('a', 2);
      expect(db.meta.size).toBe(0);
      expect(db.lists.size).toBe(0);
    });

    it('tries the clear again when the transaction aborts', async () => {
      const { mk, db } = await primed();
      db.control.abortNext = 1;
      void mk.unauthorize();
      await settle(10);
      expect(db.meta.size).toBe(1);
      await settle(600);
      expect(db.meta.size).toBe(0);
      expect(db.lists.size).toBe(0);
    });

    it('gives up after three failed clears and says so', async () => {
      const { mk, db } = await primed();
      const warn = vi.fn();
      db.control.abortNext = 3;
      // The script's own warn is the one handed to runScript, so read it from a fresh run.
      const fake = fakeMusicKit(tracks);
      const own = fakeIndexedDB();
      seed(own, PLAYLIST, 'v', tracks);
      runScript(fake.mk, '/eg/home', { indexedDB: own.api }, warn);
      await settle();
      own.control.abortNext = 3;
      void fake.mk.unauthorize();
      await settle(5000);
      expect(own.meta.size).toBe(1);
      expect(warn).toHaveBeenCalledWith('[Sidra] failed to delete saved playlist tracks');
      expect(mk).toBeDefined();
    });

    it.each([
      ['fails', { openFailures: 1 }],
      ['is blocked', { blockedOnce: true }],
    ])('still deletes the saved data when the first open %s', async (_name, control) => {
      const db = fakeIndexedDB();
      seed(db, PLAYLIST, '2026-11-01:5', tracks.filter((t) => t.attributes.playParams));
      Object.assign(db.control, control);
      const fake = fakeMusicKit(tracks);
      runScript(fake.mk, '/eg/home', { indexedDB: db.api });
      await settle();
      await fake.mk.setQueue(song('i.1'));
      expect(db.meta.size).toBe(1);
      await fake.mk.unauthorize();
      await settle(2000);
      expect(db.meta.size).toBe(0);
      expect(db.lists.size).toBe(0);
    });

    it('does not let a request after sign-out join the old account\'s fetch', async () => {
      const fake = await cold(manyTracks(250));
      const gate = deferred();
      const answer = fake.music.getMockImplementation();
      fake.music.mockImplementation(async (url, params) => {
        if (params?.limit === 100) await gate.promise;
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      const older = fake.mk.setQueue(playButton());
      await settle(10);
      void fake.mk.unauthorize();
      const newer = fake.mk.setQueue(playButton());
      await settle(10);
      gate.resolve();
      await Promise.all([older, newer]);
      expect(fake.music.mock.calls.filter(([, p]) => p?.limit === 100 && p?.offset === 0)).toHaveLength(2);
    });

    it('does not retry a clear that committed', async () => {
      const { mk, db } = await primed();
      const open = db.open.mock.calls.length;
      void mk.unauthorize();
      await settle(5000);
      expect(db.open.mock.calls.length).toBe(open);
      expect(db.meta.size).toBe(0);
    });

    it('does not queue or reuse the old account\'s tracks for a request already in flight', async () => {
      const { mk, original, db } = await primed();
      const started = mk.setQueue(song('i.1'));
      void mk.unauthorize();
      await started;
      await settle(10);
      expect(original).not.toHaveBeenCalled();
      expect(db.meta.size).toBe(0);
    });

    it('does not save a list that finishes fetching after sign-out', async () => {
      const fake = fakeMusicKit(manyTracks(250));
      const db = fakeIndexedDB();
      const gate = deferred();
      const answer = fake.music.getMockImplementation();
      fake.music.mockImplementation(async (url, params) => {
        if (params?.limit === 100) await gate.promise;
        return answer?.(url, params) as ReturnType<NonNullable<typeof answer>>;
      });
      runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`, { indexedDB: db.api });
      await settle();
      void fake.mk.unauthorize();
      await settle(10);
      gate.resolve();
      await settle(10);
      expect(db.meta.size).toBe(0);
      expect(db.lists.size).toBe(0);
    });

    it('saves again for the next account after the clear', async () => {
      const { mk, db, state } = await primed();
      await mk.unauthorize();
      await settle(10);
      expect(db.meta.size).toBe(0);
      state.modified = 'next-account';
      await mk.setQueue(song('i.1'));
      await settle(10);
      expect(db.meta.get(PLAYLIST)?.version).toBe('next-account:5');
    });
  });

  describe('when storage does not work', () => {
    it.each([
      ['is missing', {}],
      ['fails to open', { openError: true }],
      ['is blocked', { blocked: true }],
    ])('still plays the fetched list when storage %s', async (_name, control) => {
      const fake = fakeMusicKit(tracks);
      const db = fakeIndexedDB();
      Object.assign(db.control, control);
      runScript(fake.mk, '/eg/home', 'is missing' === _name ? {} : { indexedDB: db.api });
      await settle();
      await fake.mk.setQueue(song('i.1'));
      expect(fake.original).toHaveBeenCalledOnce();
      expect(sentIds(fake.original)).toEqual(['i.0', 'i.1', 'i.3', 'i.4']);
      await fake.mk.unauthorize();
      expect(fake.signOut).toHaveBeenCalledOnce();
    });

    it('survives a transaction that aborts while saving', async () => {
      const fake = fakeMusicKit(tracks);
      const db = fakeIndexedDB();
      runScript(fake.mk, '/eg/home', { indexedDB: db.api });
      await settle();
      db.control.abortNext = 5;
      await fake.mk.setQueue(song('i.1'));
      await settle(10);
      expect(fake.original).toHaveBeenCalledOnce();
      expect(db.meta.size).toBe(0);
    });

    it('holds a play up for a few seconds at most when storage never answers', async () => {
      const fake = fakeMusicKit(tracks);
      const db = fakeIndexedDB();
      db.control.hang = true;
      runScript(fake.mk, '/eg/home', { indexedDB: db.api });
      await settle();
      const started = fake.mk.setQueue(song('i.1'));
      await settle(3100);
      await started;
      expect(fake.original).toHaveBeenCalledOnce();
      expect(sentIds(fake.original)).toEqual(['i.0', 'i.1', 'i.3', 'i.4']);
    });

    it('still signs out when storage never answers', async () => {
      const fake = fakeMusicKit(tracks);
      const db = fakeIndexedDB();
      db.control.hang = true;
      runScript(fake.mk, '/eg/home', { indexedDB: db.api });
      await settle();
      await fake.mk.unauthorize();
      await settle(10000);
      expect(fake.signOut).toHaveBeenCalledOnce();
    });

    it('aborts a transaction whose work throws, so nothing half-written can commit', async () => {
      const fake = fakeMusicKit(tracks);
      const db = fakeIndexedDB();
      runScript(fake.mk, '/eg/home', { indexedDB: db.api });
      await settle();
      db.control.throwOnListsPut = true;
      await fake.mk.setQueue(song('i.1'));
      await settle(10);
      expect(fake.original).toHaveBeenCalledOnce();
      expect(db.control.abortCalls).toBe(1);
    });

    it('survives indexedDB.open throwing', async () => {
      const fake = fakeMusicKit(tracks);
      runScript(fake.mk, '/eg/home', {
        indexedDB: {
          open: () => {
            throw new Error('denied');
          },
        },
      });
      await settle();
      await fake.mk.setQueue(song('i.1'));
      expect(fake.original).toHaveBeenCalledOnce();
    });
  });

  describe('packaging', () => {
    it('is listed in asarUnpack', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf-8')) as {
        build: { asarUnpack: string[] };
      };
      expect(pkg.build.asarUnpack).toContain('assets/fastPlaylistQueue.js');
    });
  });
});
