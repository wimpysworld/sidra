import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { net } from 'electron';
import { signParams, scrobbleThresholdMs } from '../src/integrations/lastfm';
import { PlaybackState, NowPlayingPayload } from '../src/player';
import { FakePlayer } from './mocks/player';

vi.mock('../src/config', () => ({
  getLastfmEnabled: vi.fn(() => true),
  getLastfmSessionKey: vi.fn(() => 'session-key'),
  setLastfmSession: vi.fn(),
  clearLastfmSession: vi.fn(),
  setLastfmEnabled: vi.fn(),
  getNotificationsEnabled: vi.fn(() => false),
  getMusicService: vi.fn(() => 'music'),
}));

vi.mock('../src/i18n', () => ({
  getLastfmConnectedText: vi.fn(() => 'Connected'),
  getLastfmConnectFailedText: vi.fn(() => 'Could not connect'),
}));

describe('signParams', () => {
  it('sorts params by name, concatenates name+value, appends secret, then MD5', () => {
    const expected = createHash('md5').update('a1b2secret', 'utf8').digest('hex');
    expect(signParams({ b: '2', a: '1' }, 'secret')).toBe(expected);
  });

  it('is independent of insertion order', () => {
    const secret = 'shh';
    const a = signParams({ method: 'auth.getToken', api_key: 'k' }, secret);
    const b = signParams({ api_key: 'k', method: 'auth.getToken' }, secret);
    expect(a).toBe(b);
  });
});

describe('scrobbleThresholdMs', () => {
  it('returns null for tracks shorter than 30 seconds', () => {
    expect(scrobbleThresholdMs(20_000)).toBeNull();
  });

  it('returns null for tracks of exactly 30 seconds', () => {
    expect(scrobbleThresholdMs(30_000)).toBeNull();
  });

  it('returns null for sub-30-second tracks that would round up to 30', () => {
    expect(scrobbleThresholdMs(29_600)).toBeNull();
  });

  it('returns half the duration for typical tracks', () => {
    expect(scrobbleThresholdMs(180_000)).toBe(90_000);
  });

  it('caps at 4 minutes for long tracks', () => {
    expect(scrobbleThresholdMs(1_200_000)).toBe(240_000);
  });

  it('falls back to the 4 minute cap when duration is unknown', () => {
    expect(scrobbleThresholdMs(0)).toBe(240_000);
  });
});

// A 400 second track, so the scrobble threshold is 200 seconds.
const TRACK: NowPlayingPayload = {
  name: 'Blue Monday',
  artistName: 'New Order',
  albumName: 'Power, Corruption & Lies',
  durationInMillis: 400_000,
};

const START = new Date('2026-01-01T00:00:00Z');
const START_UNIX = String(Math.floor(START.getTime() / 1000));

/**
 * Loads a fresh copy of the integration with credentials present. API_KEY and
 * API_SECRET resolve once at module load, so a statically imported module reads
 * empty credentials and every request path short-circuits.
 */
async function loadLastfm(): Promise<typeof import('../src/integrations/lastfm')> {
  vi.resetModules();
  vi.stubEnv('SIDRA_LASTFM_API_KEY', 'test-key');
  vi.stubEnv('SIDRA_LASTFM_API_SECRET', 'test-secret');
  return import('../src/integrations/lastfm');
}

/** The parameters of every track.scrobble request submitted so far. */
function scrobbles(): URLSearchParams[] {
  return vi
    .mocked(net.fetch)
    .mock.calls.map(([, init]) => new URLSearchParams(typeof init?.body === 'string' ? init.body : ''))
    .filter((params) => params.get('method') === 'track.scrobble');
}

/**
 * Plays for `ms`, moving the playhead in step with the clock. The position is
 * advanced before the clock so the scrobble timer sees a playhead that has
 * reached the threshold, as it would with real playback.
 */
function play(player: FakePlayer, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    player.advancePositionMs(1000);
    vi.advanceTimersByTime(1000);
  }
}

describe('scrobble submission', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(net.fetch).mockImplementation(() => Promise.resolve(new Response('{}')));
    vi.useFakeTimers();
    vi.setSystemTime(START);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('does not scrobble a track abandoned by a page load', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });

    player.emitNowPlaying(TRACK);
    player.emitPlaybackState(PlaybackState.Playing);
    play(player, 30_000);

    // The page load replaces the renderer without emitting a state transition,
    // so nothing cancels the armed timer and the cached snapshot stays frozen
    // at playing, 30 seconds in.
    vi.advanceTimersByTime(600_000);

    expect(scrobbles()).toHaveLength(0);
  });

  it('scrobbles once when a track plays past its threshold', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });

    player.emitNowPlaying(TRACK);
    player.emitPlaybackState(PlaybackState.Playing);
    play(player, 210_000);

    const submitted = scrobbles();
    expect(submitted).toHaveLength(1);
    expect(submitted[0].get('artist')).toBe('New Order');
    expect(submitted[0].get('track')).toBe('Blue Monday');
    expect(submitted[0].get('timestamp')).toBe(START_UNIX);
  });

  it('scrobbles once across a pause and a long gap', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });

    player.emitNowPlaying(TRACK);
    player.emitPlaybackState(PlaybackState.Playing);
    play(player, 100_000);

    player.emitPlaybackState(PlaybackState.Paused);
    vi.advanceTimersByTime(600_000);
    player.emitPlaybackState(PlaybackState.Playing);
    play(player, 110_000);

    const submitted = scrobbles();
    expect(submitted).toHaveLength(1);
    expect(submitted[0].get('timestamp')).toBe(START_UNIX);
  });

  it('scrobbles each pass of a repeated track with its own timestamp', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });

    player.emitNowPlaying(TRACK);
    player.emitPlaybackState(PlaybackState.Playing);
    play(player, 400_000);

    // Repeat-one re-emits the same item and returns the playhead to the start.
    player.setPositionUs(0);
    player.emitNowPlaying(TRACK);
    play(player, 210_000);

    const submitted = scrobbles();
    expect(submitted).toHaveLength(2);
    expect(submitted[0].get('timestamp')).toBe(START_UNIX);
    expect(submitted[1].get('timestamp')).toBe(String(Number(START_UNIX) + 400));
  });
});
