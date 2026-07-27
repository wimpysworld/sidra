import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { net, shell, Notification } from 'electron';
import { signParams, scrobbleThresholdMs } from '../src/integrations/lastfm';
import { PlaybackState, NowPlayingPayload } from '../src/player';
import { FakePlayer } from './mocks/player';

// The stored session key drives both the request path and the tray's connected
// state, so the mock holds it as state rather than a constant: a test can then
// see clearLastfmSession() take effect the way production does.
const session = vi.hoisted(() => ({ key: 'session-key' as string | null, enabled: true }));

vi.mock('../src/config', () => ({
  getLastfmEnabled: vi.fn(() => session.enabled),
  getLastfmSessionKey: vi.fn(() => session.key),
  setLastfmSession: vi.fn((key: string) => { session.key = key; }),
  clearLastfmSession: vi.fn(() => { session.key = null; }),
  setLastfmEnabled: vi.fn((enabled: boolean) => { session.enabled = enabled; }),
  getNotificationsEnabled: vi.fn(() => true),
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

/** A connected account, an accepting API and a clock under test control. */
function startFromConnected(): void {
  vi.clearAllMocks();
  session.key = 'session-key';
  session.enabled = true;
  vi.mocked(net.fetch).mockImplementation(() => Promise.resolve(new Response('{}')));
  vi.mocked(Notification).mockImplementation(() => ({ on: vi.fn(), show: vi.fn() }) as unknown as Notification);
  vi.useFakeTimers();
  vi.setSystemTime(START);
}

function restoreRealTime(): void {
  vi.useRealTimers();
  vi.unstubAllEnvs();
}

describe('scrobble submission', () => {
  beforeEach(startFromConnected);
  afterEach(restoreRealTime);

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

  it('timestamps a scrobble from the moment playback starts', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });

    // The track is selected while paused and only played a minute later, so
    // the metadata change is not when listening began.
    player.emitNowPlaying(TRACK);
    vi.advanceTimersByTime(60_000);
    player.emitPlaybackState(PlaybackState.Playing);
    play(player, 210_000);

    const submitted = scrobbles();
    expect(submitted).toHaveLength(1);
    expect(submitted[0].get('timestamp')).toBe(String(Number(START_UNIX) + 60));
  });

  it('scrobbles a track once, however often it is paused and resumed after the threshold', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });

    playPastThreshold(player);
    player.emitPlaybackState(PlaybackState.Paused);
    vi.advanceTimersByTime(30_000);
    player.emitPlaybackState(PlaybackState.Playing);
    play(player, 210_000);

    expect(scrobbles()).toHaveLength(1);
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

/** A Last.fm API refusal: HTTP 200 with an error code in the body. */
function apiError(code: number): Response {
  return new Response(JSON.stringify({ error: code, message: 'refused' }));
}

/** Refuses scrobbles with `code` while still accepting now-playing updates. */
function refuseScrobbles(code: number): void {
  vi.mocked(net.fetch).mockImplementation((_input, init) => {
    const method = new URLSearchParams(typeof init?.body === 'string' ? init.body : '').get('method');
    return Promise.resolve(method === 'track.scrobble' ? apiError(code) : new Response('{}'));
  });
}

/** Settles the request promises the timers have started. */
function flush(): Promise<void> {
  return vi.advanceTimersByTimeAsync(0);
}

/** Plays `TRACK` past its scrobble threshold. */
function playPastThreshold(player: FakePlayer): void {
  player.emitNowPlaying(TRACK);
  player.emitPlaybackState(PlaybackState.Playing);
  play(player, 210_000);
}

describe('revoked session', () => {
  beforeEach(startFromConnected);
  afterEach(restoreRealTime);

  it('disconnects the account when the API returns error 9', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });
    refuseScrobbles(9);

    playPastThreshold(player);
    await flush();

    // The tray reads connection state from the session key alone, so clearing
    // it is what returns the menu to the connect action.
    expect(session.key).toBeNull();
    expect(session.enabled).toBe(false);
    expect(vi.mocked(Notification)).toHaveBeenCalledTimes(1);
  });

  it('notifies once when requests already in flight are refused too', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });

    const pending: Array<(response: Response) => void> = [];
    vi.mocked(net.fetch).mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));

    playPastThreshold(player);

    // The now-playing update and the scrobble are both awaiting a response when
    // the revocation lands.
    expect(pending).toHaveLength(2);
    for (const resolve of pending) resolve(apiError(9));
    await flush();

    expect(session.key).toBeNull();
    expect(vi.mocked(Notification)).toHaveBeenCalledTimes(1);
  });

  it('keeps the session through a transient error', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });
    // 16: the service is temporarily unavailable, so the session is still good.
    refuseScrobbles(16);

    playPastThreshold(player);
    await flush();

    expect(session.key).toBe('session-key');
    expect(session.enabled).toBe(true);
    expect(vi.mocked(Notification)).not.toHaveBeenCalled();
  });

  it('keeps the session through a failure with no JSON body', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });
    vi.mocked(net.fetch).mockImplementation(() => Promise.resolve(new Response('<html>502</html>', { status: 502 })));

    playPastThreshold(player);
    await flush();

    expect(session.key).toBe('session-key');
    expect(session.enabled).toBe(true);
    expect(vi.mocked(Notification)).not.toHaveBeenCalled();
  });
});

// Last.fm has no auth callback, so the flow polls auth.getSession on this
// interval until the user approves the token in their browser.
const AUTH_POLL_INTERVAL_MS = 4000;

/** No linked account, as it is before the first successful authentication. */
function noSession(): void {
  session.key = null;
  session.enabled = false;
}

/** Answers auth.getToken with a token, and every auth.getSession with `session`. */
function respondToAuth(sessionResponse: () => Response): void {
  vi.mocked(net.fetch).mockImplementation((input) =>
    Promise.resolve(
      String(input).includes('auth.getToken')
        ? new Response(JSON.stringify({ token: 'auth-token' }))
        : sessionResponse(),
    ),
  );
}

/**
 * These tests import the module through loadLastfm() for the same reason the
 * scrobble tests do: API_KEY and API_SECRET are resolved once at module load,
 * and the statically imported copy has neither, so every request path
 * short-circuits before it reaches the network.
 */
describe('authentication', () => {
  beforeEach(startFromConnected);
  afterEach(restoreRealTime);

  it('opens the browser, then stores and announces the session the user approves', async () => {
    const lastfm = await loadLastfm();
    noSession();
    respondToAuth(() => new Response(JSON.stringify({ session: { key: 'new-key', name: 'wimpy' } })));

    lastfm.startAuth();
    await flush();

    expect(vi.mocked(shell.openExternal)).toHaveBeenCalledWith(expect.stringContaining('token=auth-token'));
    expect(session.key).toBe('new-key');
    expect(vi.mocked(Notification)).toHaveBeenCalledTimes(1);
  });

  it('stops polling for a session once the account is disconnected', async () => {
    const lastfm = await loadLastfm();
    noSession();
    // 14: the token is not yet authorised, which is every poll until the user
    // approves it, so the flow keeps polling.
    respondToAuth(() => apiError(14));

    lastfm.startAuth();
    await flush();
    await vi.advanceTimersByTimeAsync(AUTH_POLL_INTERVAL_MS);

    // One auth.getToken and two auth.getSession polls.
    expect(vi.mocked(net.fetch)).toHaveBeenCalledTimes(3);

    lastfm.disconnect();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(vi.mocked(net.fetch)).toHaveBeenCalledTimes(3);
  });
});
