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
    const startWith = request.startWith;
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
    queue: 'existing queue',
    nowPlayingItem: null as { id: string } | null,
    api: { music },
    setQueue: originalSetQueue as unknown as (request: unknown) => Promise<unknown>,
    setStationQueue: vi.fn(async () => 'station'),
    play: vi.fn(async () => undefined),
    playLater: vi.fn(async () => undefined),
  };
  return { mk, originalSetQueue, music };
}

function runScript(mk: unknown, pathname = '/eg/home') {
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
    // Storage is optional, so these tests run from memory alone.
  });
  return window;
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

  async function primed() {
    const fake = fakeMusicKit(tracks);
    runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`);
    await settle();
    fake.music.mockClear();
    return fake;
  }

  it('prepares the track list when a playlist page opens', async () => {
    const { music } = fakeMusicKit(tracks);
    const fake = fakeMusicKit(tracks);
    runScript(fake.mk, `/eg/library/playlist/${PLAYLIST}`);
    await settle();
    expect(fake.music).toHaveBeenCalled();
    expect(music).not.toHaveBeenCalled();
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

  it('turns shuffle on only after the chosen song is current', async () => {
    const { mk, originalSetQueue } = await primed();
    mk.shuffleMode = SHUFFLE_SONGS;
    let modeDuringQueue = -1;
    originalSetQueue.mockImplementationOnce(async (request: QueueRequest) => {
      modeDuringQueue = mk.shuffleMode;
      mk.nowPlayingItem = { id: String(request.startWith) };
      return 'queue';
    });

    const started = mk.setQueue(playlistRequest({ id: 'i.4', type: 'songs' }));
    await settle(100);
    await started;

    expect(modeDuringQueue).toBe(0);
    expect(mk.shuffleMode).toBe(SHUFFLE_SONGS);
    expect(mk.nowPlayingItem?.id).toBe('i.4');
    expect(mk.play).toHaveBeenCalled();
  });

  it('starts the Shuffle button on a random track and keeps shuffle on', async () => {
    const { mk, originalSetQueue } = await primed();
    mk.shuffleMode = SHUFFLE_SONGS;
    vi.spyOn(Math, 'random').mockReturnValue(0.99);

    const started = mk.setQueue(playlistRequest({ id: PLAYLIST, type: 'playlists' }));
    await settle(100);
    await started;

    expect(originalSetQueue.mock.calls[0]?.[0].startWith).toBe('i.4');
    expect(mk.shuffleMode).toBe(SHUFFLE_SONGS);
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
