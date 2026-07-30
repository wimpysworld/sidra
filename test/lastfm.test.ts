import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'crypto';
import { app, net, shell, Notification } from 'electron';
import log from 'electron-log/main';
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

// createNotification() gates every construction on a D-Bus daemon probe that
// never runs under test, and the gate starts closed on Linux. The stand-in
// mirrors that gate so a test can open or close it, and constructs the same
// electron Notification the real helper does.
const daemon = vi.hoisted(() => ({ available: true }));

vi.mock('../src/notify', async () => {
  const { Notification } = await import('electron');
  return {
    createNotification: vi.fn((options: Electron.NotificationConstructorOptions) =>
      daemon.available ? new Notification(options) : null),
  };
});

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

// A 60 second track, so the scrobble threshold is 30 seconds: well inside the
// playhead a longer track leaves behind.
const SHORT_TRACK: NowPlayingPayload = {
  name: 'Temptation',
  artistName: 'New Order',
  durationInMillis: 60_000,
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
  daemon.available = true;
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

  it('does not scrobble a new track on the playhead the last one left behind', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });

    // 100 seconds of the 400 second track: short of its own 200 second
    // threshold, so it never scrobbles, but well past the next track's.
    player.emitNowPlaying(TRACK);
    player.emitPlaybackState(PlaybackState.Playing);
    play(player, 100_000);

    // The page load announces a different track. It emits no state transition
    // and no position report, so the cached playing flag and the 100 second
    // playhead both still belong to the track that went away. The timer arms
    // for the new track's 30 second threshold and fires having played none of
    // it.
    player.emitNowPlaying(SHORT_TRACK);
    vi.advanceTimersByTime(60_000);

    expect(scrobbles()).toHaveLength(0);
  });

  it('scrobbles a new track once its own playhead reaches the threshold', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });

    player.emitNowPlaying(TRACK);
    player.emitPlaybackState(PlaybackState.Playing);
    play(player, 100_000);

    // The same handover, but this page plays: the new track reports its own
    // playhead from the start, so it earns its scrobble.
    player.emitNowPlaying(SHORT_TRACK);
    player.setPositionUs(0);
    play(player, 40_000);

    const submitted = scrobbles();
    expect(submitted).toHaveLength(1);
    expect(submitted[0].get('track')).toBe('Temptation');
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

  it('keeps the play time already earned when scrobbling is toggled off and on', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });

    player.emitNowPlaying(TRACK);
    player.emitPlaybackState(PlaybackState.Playing);
    play(player, 50_000);

    // The tray toggle, off then on, exactly as buildLastfmSubmenu drives it.
    session.enabled = false;
    lastfm.disable();
    play(player, 60_000);
    session.enabled = true;
    lastfm.enable();

    // The first 50 seconds are banked, so 150 more reach the 200 second
    // threshold. Losing them would push the scrobble out to 200 seconds from
    // here, which is past the end of this test.
    play(player, 150_000);

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

  it('constructs no notification for the forced failure when no daemon is available', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });
    daemon.available = false;
    refuseScrobbles(9);

    playPastThreshold(player);
    await flush();

    // The forced notification bypasses the user preference, not the daemon
    // gate: constructing one with no daemon freezes the window on Linux.
    expect(session.key).toBeNull();
    expect(vi.mocked(Notification)).not.toHaveBeenCalled();
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

  it('keeps a reconnected session when a request signed with the old key is refused', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });

    const pending: Array<(response: Response) => void> = [];
    vi.mocked(net.fetch).mockImplementation(() => new Promise<Response>((resolve) => pending.push(resolve)));

    // The now-playing update and the scrobble are both signed with the key the
    // account is connected with, and both are still awaiting a response.
    playPastThreshold(player);
    expect(pending).toHaveLength(2);

    // The first refusal disconnects the account, as it should.
    pending[0](apiError(9));
    await flush();
    expect(session.key).toBeNull();

    // The user reconnects from the tray and approves a new key. The tray sets
    // the preference before starting the flow, as buildLastfmSubmenu does.
    respondToAuth(() => new Response(JSON.stringify({ session: { key: 'new-key', name: 'wimpy' } })));
    session.enabled = true;
    lastfm.startAuth();
    await flush();
    expect(session.key).toBe('new-key');

    // Only now does the second request fail, still carrying the dead key. It
    // says nothing about the session that replaced it.
    pending[1](apiError(9));
    await flush();

    expect(session.key).toBe('new-key');
    expect(session.enabled).toBe(true);
    // The failure and the reconnection, and nothing from the stale refusal.
    expect(vi.mocked(Notification)).toHaveBeenCalledTimes(2);
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

  it('submits a track once, even when that submission fails', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });
    // 16: a temporary error, the case a retry would exist for.
    refuseScrobbles(16);

    playPastThreshold(player);
    await flush();

    // Pause and resume re-arms the timer past the threshold, which is the one
    // path that used to resubmit a track the API had already refused.
    player.emitPlaybackState(PlaybackState.Paused);
    await vi.advanceTimersByTimeAsync(30_000);
    player.emitPlaybackState(PlaybackState.Playing);
    play(player, 210_000);
    await flush();

    expect(scrobbles()).toHaveLength(1);
  });

  it('reports the HTTP status when a failure carries no JSON body', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });
    vi.mocked(net.fetch).mockImplementation(() => Promise.resolve(new Response('<html>500</html>', { status: 500 })));

    playPastThreshold(player);
    await flush();

    const logged = vi.mocked(log.scope('lastfm').warn).mock.calls.flat().join(' ');
    expect(logged).toContain('HTTP 500');
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
 * Runs the `will-quit` handlers the integration registered, as quitting does.
 * The electron mock records them rather than firing them, and its `app.on` is a
 * plain `vi.fn()`, so the overloaded signature is narrowed to what is stored.
 */
function quit(): void {
  const registered = vi.mocked(app.on).mock.calls as unknown as Array<[string, () => void]>;
  for (const [event, handler] of registered) if (event === 'will-quit') handler();
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

  it('percent-encodes the token it puts in the approval URL', async () => {
    const lastfm = await loadLastfm();
    noSession();
    vi.mocked(net.fetch).mockImplementation((input) =>
      Promise.resolve(
        String(input).includes('auth.getToken')
          ? new Response(JSON.stringify({ token: 'tok&foo=bar#frag' }))
          : apiError(14),
      ),
    );

    lastfm.startAuth();
    await flush();

    // Interpolated, the `&` added a parameter and the `#` truncated the query.
    const opened = new URL(String(vi.mocked(shell.openExternal).mock.calls[0][0]));
    expect(opened.searchParams.get('token')).toBe('tok&foo=bar#frag');
    expect(opened.hash).toBe('');

    lastfm.disconnect();
  });

  it('stops polling for a session when the app quits', async () => {
    const lastfm = await loadLastfm();
    const player = new FakePlayer();
    lastfm.init({ player });
    noSession();
    respondToAuth(() => apiError(14));

    lastfm.startAuth();
    await flush();

    // One auth.getToken and one auth.getSession poll.
    expect(vi.mocked(net.fetch)).toHaveBeenCalledTimes(2);

    quit();
    await vi.advanceTimersByTimeAsync(60_000);

    expect(vi.mocked(net.fetch)).toHaveBeenCalledTimes(2);
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
