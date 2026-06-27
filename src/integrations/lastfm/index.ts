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
const MIN_TRACK_LENGTH_SEC = 30;
const SCROBBLE_CAP_MS = 240_000;

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
export function scrobbleThresholdMs(durationSec: number): number | null {
  if (durationSec > 0 && durationSec < MIN_TRACK_LENGTH_SEC) return null;
  if (durationSec <= 0) return SCROBBLE_CAP_MS;
  return Math.min((durationSec * 1000) / 2, SCROBBLE_CAP_MS);
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

  const json = (await response.json()) as LastfmResponse;
  if (json.error) {
    throw new Error(`Last.fm error ${json.error}: ${json.message ?? 'unknown'}`);
  }
  return json;
}

// --- Current track state ---
let playerRef: Player | null = null;
let artist: string | null = null;
let track: string | null = null;
let album: string | null = null;
let durationSec = 0;
let trackStartUnix = 0;
let accumulatedMs = 0;
let lastResumeAt: number | null = null;
let scrobbled = false;
let scrobbleTimer: ReturnType<typeof setTimeout> | null = null;
let previousState = 0;
let authInProgress = false;
let getWindow: () => BrowserWindow | null = () => null;

function notify(body: string): void {
  if (!getNotificationsEnabled()) return;
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

function active(): boolean {
  return isConfigured() && getLastfmEnabled() && !!getLastfmSessionKey() && !!artist && !!track;
}

function sendNowPlaying(): void {
  if (!active()) return;
  const params: Record<string, string> = {
    method: 'track.updateNowPlaying',
    artist: artist!,
    track: track!,
    api_key: API_KEY,
    sk: getLastfmSessionKey()!,
  };
  if (album) params.album = album;
  if (durationSec > 0) params.duration = String(durationSec);

  apiCall(params, true)
    .then(() => lastfmLog.debug('now playing:', `${artist} - ${track}`))
    .catch((err: Error) => lastfmLog.warn('now playing failed:', err.message));
}

function doScrobble(): void {
  clearScrobbleTimer();
  if (scrobbled || !active()) return;
  scrobbled = true;

  const params: Record<string, string> = {
    method: 'track.scrobble',
    artist: artist!,
    track: track!,
    timestamp: String(trackStartUnix),
    api_key: API_KEY,
    sk: getLastfmSessionKey()!,
  };
  if (album) params.album = album;
  if (durationSec > 0) params.duration = String(durationSec);

  apiCall(params, true)
    .then(() => lastfmLog.info('scrobbled:', `${artist} - ${track}`))
    .catch((err: Error) => {
      scrobbled = false;
      lastfmLog.warn('scrobble failed:', err.message);
    });
}

function armScrobbleTimer(): void {
  clearScrobbleTimer();
  if (scrobbled || !active()) return;
  const threshold = scrobbleThresholdMs(durationSec);
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
  durationSec = payload?.durationInMillis ? Math.round(payload.durationInMillis / 1000) : 0;
  trackStartUnix = nowUnix();
  accumulatedMs = 0;
  lastResumeAt = null;
  scrobbled = false;
}

export function enable(): void {
  if (!isConfigured()) {
    lastfmLog.warn('enabled but no API credentials configured; scrobbling is inert');
    return;
  }
  if (playerRef?.playbackSnapshot().isPlaying) {
    lastResumeAt = Date.now();
    sendNowPlaying();
    armScrobbleTimer();
  }
  lastfmLog.info('scrobbling enabled');
}

export function disable(): void {
  clearScrobbleTimer();
  lastResumeAt = null;
  lastfmLog.info('scrobbling disabled');
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
    notify(getLastfmConnectFailedText());
    onComplete?.();
    return;
  }
  authInProgress = true;

  apiCall({ method: 'auth.getToken', api_key: API_KEY }, false)
    .then((res) => {
      const token = res.token;
      if (!token) throw new Error('no token returned');
      const url = `${AUTH_URL}?api_key=${API_KEY}&token=${token}`;
      shell.openExternal(url).catch((err: Error) => lastfmLog.warn('failed to open browser:', err.message));
      lastfmLog.info('waiting for browser authorisation');
      pollForSession(token, Date.now(), onComplete);
    })
    .catch((err: Error) => {
      authInProgress = false;
      lastfmLog.warn('auth.getToken failed:', err.message);
      setLastfmEnabled(false);
      notify(getLastfmConnectFailedText());
      onComplete?.();
    });
}

function pollForSession(token: string, startedAt: number, onComplete?: () => void): void {
  apiCall({ method: 'auth.getSession', api_key: API_KEY, token }, false)
    .then((res) => {
      const key = res.session?.key;
      const name = res.session?.name;
      if (key && name) {
        authInProgress = false;
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
      if (Date.now() - startedAt >= AUTH_POLL_TIMEOUT_MS) {
        authInProgress = false;
        lastfmLog.warn('authorisation timed out');
        setLastfmEnabled(false);
        notify(getLastfmConnectFailedText());
        onComplete?.();
        return;
      }
      setTimeout(() => pollForSession(token, startedAt, onComplete), AUTH_POLL_INTERVAL_MS);
    });
}

export function disconnect(): void {
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
      lastResumeAt = Date.now();
      sendNowPlaying();
      armScrobbleTimer();
    }
  };

  const onPlaybackStateDidChange = (payload: PlaybackStatePayload): void => {
    const wasPlaying = previousState === PlaybackState.Playing;
    const nowPlaying = payload?.state === PlaybackState.Playing;
    previousState = payload?.state ?? 0;

    if (nowPlaying && !wasPlaying) {
      lastResumeAt = Date.now();
      sendNowPlaying();
      armScrobbleTimer();
    } else if (!nowPlaying && wasPlaying) {
      if (lastResumeAt !== null) {
        accumulatedMs += Date.now() - lastResumeAt;
        lastResumeAt = null;
      }
      clearScrobbleTimer();
    }
  };

  ctx.player.on('nowPlayingItemDidChange', onNowPlayingItemDidChange);
  ctx.player.on('playbackStateDidChange', onPlaybackStateDidChange);

  app.on('will-quit', () => {
    clearScrobbleTimer();
    ctx.player.removeListener('nowPlayingItemDidChange', onNowPlayingItemDidChange);
    ctx.player.removeListener('playbackStateDidChange', onPlaybackStateDidChange);
    artist = null;
    track = null;
    album = null;
    durationSec = 0;
    accumulatedMs = 0;
    lastResumeAt = null;
    scrobbled = false;
    previousState = 0;
  });
}
