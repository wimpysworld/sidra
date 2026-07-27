import { app, net, shell, BrowserWindow, Notification } from 'electron';
import log from 'electron-log/main';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { getAssetPath } from '../../paths';
import { Player, NowPlayingPayload, PlaybackState, PlaybackStatePayload, IntegrationContext } from '../../player';
import {
  getLastfmEnabled,
  getLastfmSessionKey,
  setLastfmSession,
  clearLastfmSession,
  setLastfmEnabled,
  getNotificationsEnabled,
} from '../../config';
import { getLastfmConnectedText, getLastfmConnectFailedText } from '../../i18n';
import { errorMessage } from '../../utils';

const lastfmLog = log.scope('lastfm');

const API_ROOT = 'https://ws.audioscrobbler.com/2.0/';
const AUTH_URL = 'https://www.last.fm/api/auth/';

/**
 * Resolves the app-level Last.fm API credentials. These identify the Sidra
 * application to Last.fm (not the user - each user authenticates their own
 * account via the browser flow). Resolution order:
 *
 * 1. `SIDRA_LASTFM_API_KEY` / `SIDRA_LASTFM_API_SECRET` env vars - for local dev.
 * 2. `assets/lastfm-credentials.json` - written at build time by
 *    `scripts/inject-lastfm-credentials.cjs` from CI secrets, so the real secret
 *    ships only in official builds and never lives in the public source tree.
 *
 * Absent both, the credentials are empty and the integration stays inert (the
 * tray hides the Last.fm menu via `isConfigured()`).
 */
function loadCredentials(): { apiKey: string; apiSecret: string } {
  const envKey = process.env.SIDRA_LASTFM_API_KEY;
  const envSecret = process.env.SIDRA_LASTFM_API_SECRET;
  if (envKey && envSecret) return { apiKey: envKey, apiSecret: envSecret };
  try {
    const parsed = JSON.parse(readFileSync(getAssetPath('assets', 'lastfm-credentials.json'), 'utf8')) as {
      apiKey?: string;
      apiSecret?: string;
    };
    return { apiKey: parsed.apiKey ?? '', apiSecret: parsed.apiSecret ?? '' };
  } catch {
    return { apiKey: '', apiSecret: '' };
  }
}

const { apiKey: API_KEY, apiSecret: API_SECRET } = loadCredentials();

// Last.fm scrobbling rules: a track must be longer than 30 seconds and must have
// played for at least half its duration, or 4 minutes, whichever comes first.
const MIN_TRACK_LENGTH_MS = 30_000;
const SCROBBLE_CAP_MS = 240_000;

// The renderer reports the playhead a few hundred milliseconds behind wall
// time, and the scrobble timer fires on wall time, so an honest play arrives at
// the threshold marginally short. Allow for that before refusing a scrobble.
const POSITION_TOLERANCE_MS = 2000;

// Authentication poll: Last.fm has no callback, so poll auth.getSession until the
// user approves the token in their browser, then give up.
const AUTH_POLL_INTERVAL_MS = 4000;
const AUTH_POLL_TIMEOUT_MS = 120_000;

interface LastfmResponse {
  error?: number;
  message?: string;
  token?: string;
  session?: { name?: string; key?: string };
}

// Last.fm error 9, "Invalid session key - Please re-authenticate". Session keys
// never expire on their own, so this is what the user revoking Sidra under their
// account's Applications settings looks like. No retry can recover it.
const INVALID_SESSION_ERROR = 9;

/** An error the Last.fm API reported in its response body, with its code intact. */
class LastfmApiError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'LastfmApiError';
  }
}

/**
 * True when the app ships with Last.fm API credentials. The tray hides the
 * Last.fm menu entirely when this is false, so users never see a dead feature.
 */
export function isConfigured(): boolean {
  return API_KEY !== '' && API_SECRET !== '';
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Builds the api_sig per the Last.fm spec: sort params by name, concatenate
 * name+value pairs, append the shared secret, then MD5. `format` and `callback`
 * are excluded by the caller (they are added to the request, never signed).
 */
export function signParams(params: Record<string, string>, secret: string): string {
  const keys = Object.keys(params).sort();
  let sigBase = '';
  for (const key of keys) sigBase += key + params[key];
  sigBase += secret;
  return createHash('md5').update(sigBase, 'utf8').digest('hex');
}

/**
 * Returns the play time after which a track should be scrobbled, or null if the
 * track is too short to ever scrobble.
 */
export function scrobbleThresholdMs(durationMs: number): number | null {
  if (durationMs > 0 && durationMs <= MIN_TRACK_LENGTH_MS) return null;
  if (durationMs <= 0) return SCROBBLE_CAP_MS;
  return Math.min(durationMs / 2, SCROBBLE_CAP_MS);
}

async function apiCall(params: Record<string, string>, post: boolean): Promise<LastfmResponse> {
  const signed = { ...params, api_sig: signParams(params, API_SECRET) };
  const query = new URLSearchParams({ ...signed, format: 'json' });

  const response = post
    ? await net.fetch(API_ROOT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: query.toString(),
      })
    : await net.fetch(`${API_ROOT}?${query.toString()}`);

  // The body is read before the status because Last.fm reports its own errors
  // in the body and sends several of them with a non-2xx status: checking the
  // status first would collapse error 9 into a generic failure and leave a
  // revoked session connected. The status only speaks up when the body carries
  // no code, which is what an outage or a proxy error looks like.
  const body = await response.text();
  let json: LastfmResponse;
  try {
    json = JSON.parse(body) as LastfmResponse;
  } catch {
    throw new Error(`Last.fm HTTP ${response.status}: response was not JSON`);
  }
  if (json.error) {
    throw new LastfmApiError(json.error, `Last.fm error ${json.error}: ${json.message ?? 'unknown'}`);
  }
  if (!response.ok) throw new Error(`Last.fm HTTP ${response.status}`);
  return json;
}

// --- Current track state ---
let playerRef: Player | null = null;
let artist: string | null = null;
let track: string | null = null;
let album: string | null = null;
let durationMs = 0;
let trackStartUnix = 0;
let accumulatedMs = 0;
let lastResumeAt: number | null = null;
let scrobbled = false;
let positionReported = false;
let scrobbleTimer: ReturnType<typeof setTimeout> | null = null;
let previousState = 0;
let authInProgress = false;
let authPollTimer: ReturnType<typeof setTimeout> | null = null;
let authGeneration = 0;
let getWindow: () => BrowserWindow | null = () => null;

/**
 * Shows a Last.fm notification. `force` sends it even when the user has turned
 * notifications off: a connect failure answers an action the user just took in
 * the tray, and without it the menu silently returns to "Connect" with no
 * explanation. Routine confirmations stay gated on the preference.
 */
function notify(body: string, force = false): void {
  if (!force && !getNotificationsEnabled()) return;
  try {
    const notification = new Notification({ title: 'Last.fm', body, silent: true });
    notification.on('click', () => {
      const win = getWindow();
      if (win) {
        win.show();
        win.focus();
      }
    });
    notification.show();
  } catch (err: unknown) {
    lastfmLog.warn('notification failed:', errorMessage(err));
  }
}

function clearScrobbleTimer(): void {
  if (scrobbleTimer) {
    clearTimeout(scrobbleTimer);
    scrobbleTimer = null;
  }
}

/**
 * Banks the time played since the last resume. Every path that stops counting
 * play time goes through this, so the running total survives a pause and a
 * disable alike and the scrobble threshold is measured against real listening.
 */
function foldPlayTime(): void {
  if (lastResumeAt === null) return;
  accumulatedMs += Date.now() - lastResumeAt;
  lastResumeAt = null;
}

/**
 * Cancels any in-progress auth flow. Bumping the generation invalidates in-flight
 * `apiCall` promises so a late response cannot reconnect the user, clears the poll
 * timer, and resets `authInProgress` so a fresh attempt is not blocked.
 */
function cancelAuth(): void {
  authGeneration += 1;
  if (authPollTimer) {
    clearTimeout(authPollTimer);
    authPollTimer = null;
  }
  authInProgress = false;
}

function active(): boolean {
  return isConfigured() && getLastfmEnabled() && !!getLastfmSessionKey() && !!artist && !!track;
}

/**
 * Disconnects the account when Last.fm rejects the session key, and reports it.
 * Returns true once the error is handled, so callers skip their own logging.
 *
 * Without this the session stays set, nothing retries, and the tray still shows
 * the account as connected: scrobbling is dead and the UI says otherwise.
 *
 * The rejection only counts against the key the request was signed with, which
 * is why the caller passes it in rather than reading the stored one again. A
 * second request in flight when the first is refused names a key that is gone,
 * so it settles here silently and the user sees one notification. A refusal
 * that arrives after the user has reconnected names the old key too, so it
 * cannot tear down the session that replaced it.
 */
function handleInvalidSession(err: unknown, requestKey: string): boolean {
  if (!(err instanceof LastfmApiError) || err.code !== INVALID_SESSION_ERROR) return false;
  if (getLastfmSessionKey() !== requestKey) return true;
  lastfmLog.warn('session rejected by Last.fm; reconnect from the tray to resume scrobbling');
  disconnect();
  notify(getLastfmConnectFailedText(), true);
  return true;
}

function sendNowPlaying(): void {
  if (!active()) return;
  const sessionKey = getLastfmSessionKey()!;
  const params: Record<string, string> = {
    method: 'track.updateNowPlaying',
    artist: artist!,
    track: track!,
    api_key: API_KEY,
    sk: sessionKey,
  };
  if (album) params.album = album;
  if (durationMs > 0) params.duration = String(Math.round(durationMs / 1000));

  apiCall(params, true)
    .then(() => lastfmLog.debug('now playing:', `${artist} - ${track}`))
    .catch((err: Error) => {
      if (handleInvalidSession(err, sessionKey)) return;
      lastfmLog.warn('now playing failed:', err.message);
    });
}

/**
 * True when live playback confirms the track really reached its scrobble
 * threshold.
 *
 * The scrobble is armed with a wall-clock timer, and a page load cancels
 * nothing: the fresh page emits no playback state transition, so the timer
 * survives it and the cached state in `Player` freezes at its pre-reload values
 * - the playing flag and the playhead each have a single writer, and neither
 * fires on an idle page. Re-reading the snapshot at submission time catches
 * that, because a track abandoned mid-play leaves the playhead short of the
 * threshold.
 *
 * The playhead belongs to the player, not to the track held here, so it is only
 * trusted once a position report has arrived for this track: `positionReported`
 * is cleared with the rest of the track state. Without it, the fresh page after
 * a reload announces a new track while the frozen playhead still carries the
 * previous one's play time, and a short track would be scrobbled off it having
 * never played. An idle page reports no position, so the stale value never
 * counts.
 *
 * The comparison is absolute rather than a delta against the position sampled
 * when the timer was armed. A delta cannot work: a track abandoned after some
 * real playback has moved its playhead, and repeat-one re-arms on the play
 * transition that precedes the first position report of the new loop, so the
 * baseline would be the end of the previous loop.
 */
function playbackReachedThreshold(): boolean {
  if (!positionReported) return false;
  const snapshot = playerRef?.playbackSnapshot();
  if (!snapshot?.isPlaying) return false;
  const threshold = scrobbleThresholdMs(durationMs);
  if (threshold === null) return false;
  return snapshot.positionUs / 1000 + POSITION_TOLERANCE_MS >= threshold;
}

function doScrobble(): void {
  clearScrobbleTimer();
  if (scrobbled || !active()) return;
  if (!playbackReachedThreshold()) {
    lastfmLog.debug('scrobble skipped, playback did not reach the threshold:', `${artist} - ${track}`);
    return;
  }
  scrobbled = true;

  const sessionKey = getLastfmSessionKey()!;
  const params: Record<string, string> = {
    method: 'track.scrobble',
    artist: artist!,
    track: track!,
    timestamp: String(trackStartUnix),
    api_key: API_KEY,
    sk: sessionKey,
  };
  if (album) params.album = album;
  if (durationMs > 0) params.duration = String(Math.round(durationMs / 1000));

  // A failure is final for this track. `scrobbled` stays set, so the track is
  // submitted once and once only. Clearing it re-opened the submission without
  // re-arming anything, so the only way back to a request was the user pausing
  // and resuming; a retry that fires on a failed submission is a retry loop,
  // and the remaining time it would wait comes from `accumulatedMs`, which is
  // only folded at pause and so means nothing mid-play.
  apiCall(params, true)
    .then(() => lastfmLog.info('scrobbled:', `${artist} - ${track}`))
    .catch((err: Error) => {
      if (handleInvalidSession(err, sessionKey)) return;
      lastfmLog.warn('scrobble failed, not retried:', err.message);
    });
}

function armScrobbleTimer(): void {
  clearScrobbleTimer();
  if (scrobbled || !active()) return;
  const threshold = scrobbleThresholdMs(durationMs);
  if (threshold === null) return;
  const remaining = threshold - accumulatedMs;
  if (remaining <= 0) {
    doScrobble();
    return;
  }
  scrobbleTimer = setTimeout(doScrobble, remaining);
}

function resetTrack(payload: NowPlayingPayload | null): void {
  clearScrobbleTimer();
  artist = payload?.artistName ?? null;
  track = payload?.name ?? null;
  album = payload?.albumName ?? null;
  durationMs = payload?.durationInMillis ?? 0;
  trackStartUnix = 0;
  accumulatedMs = 0;
  lastResumeAt = null;
  scrobbled = false;
  positionReported = false;
}

/**
 * Marks the moment the current track actually starts or resumes playing.
 * `trackStartUnix` is captured on the first real play transition rather than at
 * metadata change, so the scrobble timestamp reflects when playback began even
 * when a track is selected while paused and played later.
 */
function markPlaybackStarted(): void {
  if (trackStartUnix === 0) trackStartUnix = nowUnix();
  lastResumeAt = Date.now();
  sendNowPlaying();
  armScrobbleTimer();
}

export function enable(): void {
  if (!isConfigured()) {
    lastfmLog.warn('enabled but no API credentials configured; scrobbling is inert');
    return;
  }
  if (playerRef?.playbackSnapshot().isPlaying) {
    markPlaybackStarted();
  }
  lastfmLog.info('scrobbling enabled');
}

export function disable(): void {
  clearScrobbleTimer();
  foldPlayTime();
  lastfmLog.info('scrobbling disabled');
}

/**
 * Hands a URL to the system browser, checking the protocol first as every other
 * `shell.openExternal` call in the app does.
 */
function openInBrowser(url: URL): void {
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    lastfmLog.warn('refusing to open a non-web URL:', url.protocol);
    return;
  }
  shell.openExternal(url.toString()).catch((err: Error) => lastfmLog.warn('failed to open browser:', err.message));
}

/**
 * Runs the Last.fm desktop auth flow: fetch a token, open the approval page in
 * the browser, then poll auth.getSession until the user approves or it times out.
 * `onComplete` is called once the flow settles so the caller can refresh UI.
 */
export function startAuth(onComplete?: () => void): void {
  if (authInProgress) return;
  if (!isConfigured()) {
    lastfmLog.warn('cannot authenticate: no API credentials configured');
    setLastfmEnabled(false);
    notify(getLastfmConnectFailedText(), true);
    onComplete?.();
    return;
  }
  authInProgress = true;
  const generation = ++authGeneration;

  apiCall({ method: 'auth.getToken', api_key: API_KEY }, false)
    .then((res) => {
      if (generation !== authGeneration) return;
      const token = res.token;
      if (!token) throw new Error('no token returned');
      // URLSearchParams percent-encodes both values. Interpolating them left a
      // token carrying `&` or `#` to rewrite or truncate the query.
      const url = new URL(AUTH_URL);
      url.searchParams.set('api_key', API_KEY);
      url.searchParams.set('token', token);
      openInBrowser(url);
      lastfmLog.info('waiting for browser authorisation');
      pollForSession(token, Date.now(), generation, onComplete);
    })
    .catch((err: Error) => {
      if (generation !== authGeneration) return;
      authInProgress = false;
      lastfmLog.warn('auth.getToken failed:', err.message);
      setLastfmEnabled(false);
      notify(getLastfmConnectFailedText(), true);
      onComplete?.();
    });
}

function pollForSession(token: string, startedAt: number, generation: number, onComplete?: () => void): void {
  apiCall({ method: 'auth.getSession', api_key: API_KEY, token }, false)
    .then((res) => {
      if (generation !== authGeneration) return;
      const key = res.session?.key;
      const name = res.session?.name;
      if (key && name) {
        authInProgress = false;
        authPollTimer = null;
        setLastfmSession(key, name);
        lastfmLog.info('authenticated as', name);
        notify(getLastfmConnectedText(name));
        enable();
        onComplete?.();
        return;
      }
      throw new Error('session not yet authorised');
    })
    .catch(() => {
      if (generation !== authGeneration) return;
      if (Date.now() - startedAt >= AUTH_POLL_TIMEOUT_MS) {
        authInProgress = false;
        authPollTimer = null;
        lastfmLog.warn('authorisation timed out');
        setLastfmEnabled(false);
        notify(getLastfmConnectFailedText(), true);
        onComplete?.();
        return;
      }
      authPollTimer = setTimeout(() => pollForSession(token, startedAt, generation, onComplete), AUTH_POLL_INTERVAL_MS);
    });
}

export function disconnect(): void {
  cancelAuth();
  disable();
  clearLastfmSession();
  setLastfmEnabled(false);
  lastfmLog.info('disconnected from Last.fm');
}

export function init(ctx: IntegrationContext): void {
  playerRef = ctx.player;
  getWindow = ctx.getMainWindow ?? (() => null);
  lastfmLog.info('Last.fm module initialised');
  if (!isConfigured()) {
    lastfmLog.info('no API credentials configured; scrobbling is inert until set');
  }

  const onNowPlayingItemDidChange = (payload: NowPlayingPayload | null): void => {
    resetTrack(payload);
    if (playerRef?.playbackSnapshot().isPlaying) {
      markPlaybackStarted();
    }
  };

  const onPlaybackStateDidChange = (payload: PlaybackStatePayload): void => {
    const wasPlaying = previousState === PlaybackState.Playing;
    const nowPlaying = payload?.state === PlaybackState.Playing;
    previousState = payload?.state ?? 0;

    if (nowPlaying && !wasPlaying) {
      markPlaybackStarted();
    } else if (!nowPlaying && wasPlaying) {
      foldPlayTime();
      clearScrobbleTimer();
    }
  };

  // Stores a flag only, and starts nothing: a debounced send from this event
  // would reset its own timer on every position report and never expire.
  const onPlaybackTimeDidChange = (): void => {
    positionReported = true;
  };

  ctx.player.on('nowPlayingItemDidChange', onNowPlayingItemDidChange);
  ctx.player.on('playbackStateDidChange', onPlaybackStateDidChange);
  ctx.player.on('playbackTimeDidChange', onPlaybackTimeDidChange);

  app.on('will-quit', () => {
    clearScrobbleTimer();
    cancelAuth();
    ctx.player.removeListener('nowPlayingItemDidChange', onNowPlayingItemDidChange);
    ctx.player.removeListener('playbackStateDidChange', onPlaybackStateDidChange);
    ctx.player.removeListener('playbackTimeDidChange', onPlaybackTimeDidChange);
    artist = null;
    track = null;
    album = null;
    durationMs = 0;
    accumulatedMs = 0;
    lastResumeAt = null;
    scrobbled = false;
    positionReported = false;
    previousState = 0;
  });
}
