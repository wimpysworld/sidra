import { app, net, shell, BrowserWindow } from 'electron';
import log from 'electron-log/main';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { getAssetPath } from '../../paths';
import {
  Player,
  NowPlayingPayload,
  PlaybackState,
  PlaybackStatePayload,
  IntegrationContext,
  type TimedMetadataPayload,
} from '../../player';
import {
  getLastfmEnabled,
  getLastfmSessionKey,
  setLastfmSession,
  clearLastfmSession,
  setLastfmEnabled,
  getNotificationsEnabled,
  getPendingScrobbles,
  setPendingScrobbles,
  type PendingScrobble,
} from '../../config';
import { getLastfmConnectedText, getLastfmConnectFailedText } from '../../i18n';
import { errorMessage } from '../../utils';
import { createNotification } from '../../notify';

const lastfmLog = log.scope('lastfm');

let stateChangedCallback: (() => void) | null = null;

/** Sets or clears the UI refresh callback for authentication and disconnects. */
export function setStateChangedCallback(callback: (() => void) | null): void {
  stateChangedCallback = callback;
}

const API_ROOT = 'https://ws.audioscrobbler.com/2.0/';
const AUTH_URL = 'https://www.last.fm/api/auth/';

/**
 * Reads application credentials from SIDRA_LASTFM_API_KEY/SIDRA_LASTFM_API_SECRET,
 * then assets/lastfm-credentials.json, which scripts/inject-lastfm-credentials.cjs generates at build time.
 * These identify Sidra, not the user, and stay outside the public source tree.
 * Missing credentials disable the integration and hide its menu through isConfigured().
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

// 50 is the maximum number of tracks Last.fm accepts in one track.scrobble
// request, so it caps both what the queue holds and what one drain submits.
// Past the cap the oldest play is dropped. A longer queue can still arrive from
// a hand-edited or older config.json, which is why the drain caps the batch
// again rather than trusting this one.
const MAX_PENDING_SCROBBLES = 50;

// A transport that never settles must not lock authentication, lose a live
// scrobble or hold a queued-scrobble drain open for the life of the session.
const REQUEST_TIMEOUT_MS = 30_000;

// Last.fm has no desktop auth callback. Poll until approval or the timeout.
const AUTH_POLL_INTERVAL_MS = 4000;
const AUTH_POLL_TIMEOUT_MS = 120_000;

/**
 * One entry of a track.scrobble result. `ignoredMessage.code` is Last.fm's
 * verdict on that single play: "0" means it was stored, and 1 to 5 mean it was
 * filtered out (artist, track, timestamp too old, timestamp too new, daily
 * limit). The code is a string because Last.fm's JSON transform expresses XML
 * attributes and text nodes as strings.
 */
interface LastfmScrobble {
  ignoredMessage?: { code?: string; '#text'?: string };
}

interface LastfmResponse {
  error?: number;
  message?: string;
  token?: string;
  session?: { name?: string; key?: string };
  // Only track.scrobble answers with this. `@attr` counts the batch, and
  // `scrobble` is a bare object when the result describes a single play and an
  // array when it describes several: the transform groups repeated child nodes
  // into an array and leaves a lone one as an object. The counts arrive as
  // numbers in captured bodies, but that same transform documents attributes as
  // strings, so both are accepted and coerced rather than trusted.
  scrobbles?: {
    '@attr'?: { accepted?: number | string; ignored?: number | string };
    scrobble?: LastfmScrobble | LastfmScrobble[];
  };
}

/** What Last.fm did with a submitted batch: the counts, and the distinct reasons. */
interface ScrobbleOutcome {
  accepted: number;
  ignored: number;
  codes: string[];
}

function toCount(value: number | string | undefined): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Reads accepted and filtered counts from a successful track.scrobble response.
 * Filtering carries no API error, so only these fields reveal rejected plays.
 * Returns null for an absent `scrobbles` field, because missing counts do not mean zero accepted plays.
 */
function readScrobbleOutcome(res: LastfmResponse): ScrobbleOutcome | null {
  const scrobbles = res.scrobbles;
  if (!scrobbles) return null;
  const entries = Array.isArray(scrobbles.scrobble)
    ? scrobbles.scrobble
    : scrobbles.scrobble
      ? [scrobbles.scrobble]
      : [];
  const codes = new Set<string>();
  for (const entry of entries) {
    const code = entry.ignoredMessage?.code;
    // "0" is the code a kept play carries, so it is not a reason for anything.
    if (code && code !== '0') codes.add(code);
  }
  return {
    accepted: toCount(scrobbles['@attr']?.accepted),
    ignored: toCount(scrobbles['@attr']?.ignored),
    codes: [...codes].sort(),
  };
}

// Last.fm error 9, "Invalid session key - Please re-authenticate". Session keys
// never expire on their own, so this is what the user revoking Sidra under their
// account's Applications settings looks like. No retry can recover it.
const INVALID_SESSION_ERROR = 9;

// Service failures (8, 11, 16, 29) and rejected application keys (10, 26) do not
// refuse the play itself, and Last.fm can restore service or keys without user action.
// Batch contents cannot cause these failures, so retain plays in the bounded queue
// until a successful playback request calls flushPendingScrobbles(), never a retry timer.
const RETRIABLE_ERRORS = new Set([8, 10, 11, 16, 26, 29]);

/** An error the Last.fm API reported in its response body, with its code intact. */
class LastfmApiError extends Error {
  constructor(readonly code: number, message: string) {
    super(message);
    this.name = 'LastfmApiError';
  }
}

/**
 * True when the error is Last.fm's final word on the play it was sent. A
 * temporary service error is not, and neither is a transport failure: callers
 * hold the play in both cases, so only the API's own codes need separating.
 */
function isFinalRefusal(err: unknown): boolean {
  return err instanceof LastfmApiError && !RETRIABLE_ERRORS.has(err.code);
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
 * Returns the required play time in milliseconds, or null for tracks of 30 seconds or less.
 * A non-positive duration is unknown and uses the four-minute fallback.
 */
export function scrobbleThresholdMs(durationMs: number): number | null {
  if (durationMs > 0 && durationMs <= MIN_TRACK_LENGTH_MS) return null;
  if (durationMs <= 0) return SCROBBLE_CAP_MS;
  return Math.min(durationMs / 2, SCROBBLE_CAP_MS);
}

async function apiCall(
  params: Record<string, string>,
  post: boolean,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<LastfmResponse> {
  const signed = { ...params, api_sig: signParams(params, API_SECRET) };
  const query = new URLSearchParams({ ...signed, format: 'json' });
  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = post
      ? await net.fetch(API_ROOT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: query.toString(),
          signal: controller.signal,
        })
      : await net.fetch(`${API_ROOT}?${query.toString()}`, { signal: controller.signal });

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
  } finally {
    clearTimeout(abortTimer);
  }
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
let isRadioSong = false;
let radioObservedFromStart = false;
let radioPositionAdvanced = false;
let lastRadioAdvanceAt: number | null = null;
let radioSeekPending = false;
let lastPositionUs: number | null = null;
let lastPositionAt: number | null = null;
let scrobbleTimer: ReturnType<typeof setTimeout> | null = null;
let previousState = 0;
let authInProgress = false;
let authPollTimer: ReturnType<typeof setTimeout> | null = null;
let authGeneration = 0;
// Counts the identity of the stored session, and changes on every disconnect
// and every successful connect. A request captures it when it goes out, so a
// response settling after the account changed can be told from one that still
// belongs to the account connected. Comparing the session key is not enough:
// the same key can come back when the same account reconnects, and the queue is
// emptied in between either way.
let sessionGeneration = 0;
// The generation the drain in flight went out under, or null when none is out.
// Only a drain from the account still connected blocks the next one, because
// two of those would share `trimmedWhileDraining` between them. A stale value
// blocks nothing: that drain can take nothing off the queue it left behind, so
// holding the next account's plays behind it would strand them for as long as
// it stays out, and forever if it never settles.
let drainGeneration: number | null = null;
let trimmedWhileDraining = 0;
let getWindow: () => BrowserWindow | null = () => null;

interface RadioBoundaryTrack extends ActiveTrack {
  timestamp: number;
  generation: number;
}

let pendingRadioBoundary: RadioBoundaryTrack | null | undefined;

/**
 * Shows a Last.fm notification. `force` sends it even when the user has turned
 * notifications off: a connect failure answers an action the user just took in
 * the tray, and without it the menu silently returns to "Connect" with no
 * explanation. Routine confirmations stay gated on the preference. `force` does
 * not bypass the notification daemon gate in `createNotification()`: on a
 * daemon-less Linux session that construction freezes the window.
 */
function notify(body: string, force = false): void {
  if (!force && !getNotificationsEnabled()) return;
  try {
    const notification = createNotification({ title: 'Last.fm', body, silent: true });
    if (!notification) return;
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
 * Adds elapsed time since resume for normal tracks before a pause or disable.
 * Radio time comes from position advances, so wall time never increases its total.
 */
function foldPlayTime(): void {
  if (lastResumeAt === null) return;
  if (isRadioSong) {
    lastResumeAt = null;
    return;
  }
  accumulatedMs += Date.now() - lastResumeAt;
  lastResumeAt = null;
}

/**
 * Cancels any auth flow in progress. Bumping the generation sends every
 * in-flight auth response back at its own guard, so a late one cannot reconnect
 * the user. The poll timer is cleared and `authInProgress` released, so a fresh
 * attempt is not blocked by the one abandoned.
 */
function cancelAuth(): void {
  authGeneration += 1;
  if (authPollTimer) {
    clearTimeout(authPollTimer);
    authPollTimer = null;
  }
  authInProgress = false;
}

/** Validated session and track fields for a playback request. */
interface ActiveTrack {
  sessionKey: string;
  artist: string;
  track: string;
  album: string | null;
  durationMs: number;
}

/**
 * Allows playback requests only with application credentials, an enabled integration, a session and named track metadata.
 * Returns the validated fields so callers need no non-null assertions.
 */
function active(): ActiveTrack | null {
  if (!isConfigured() || !getLastfmEnabled()) return null;
  const sessionKey = getLastfmSessionKey();
  if (!sessionKey || !artist || !track) return null;
  return { sessionKey, artist, track, album, durationMs };
}

/**
 * Disconnects and reports an invalid current session, returning true to prevent duplicate logging.
 * Ignores stale refusals so concurrent failures notify once and cannot disconnect a replacement session.
 * Compares generations because Last.fm can return the same key when an account reconnects.
 */
function handleInvalidSession(err: unknown, generation: number): boolean {
  if (!(err instanceof LastfmApiError) || err.code !== INVALID_SESSION_ERROR) return false;
  if (generation !== sessionGeneration) return true;
  lastfmLog.warn('session rejected by Last.fm; reconnect from the tray to resume scrobbling');
  disconnect();
  notify(getLastfmConnectFailedText(), true);
  return true;
}

/**
 * Persists an undelivered play, retaining the newest MAX_PENDING_SCROBBLES entries across restarts.
 * Counts head trims during the current session's drain so dropSubmitted() does not remove newer plays twice.
 */
function queueScrobble(entry: PendingScrobble): void {
  const queued = [...getPendingScrobbles(), entry];
  const trimmed = Math.max(queued.length - MAX_PENDING_SCROBBLES, 0);
  if (drainGeneration === sessionGeneration) trimmedWhileDraining += trimmed;
  setPendingScrobbles(queued.slice(trimmed));
}

/**
 * Removes the batch just submitted. Entries are only ever appended and only
 * ever trimmed from the head, so the leading `count` are exactly what went out,
 * less anything the trim has already taken. Without that adjustment a full
 * queue loses the play that failed and queued itself mid-drain: the trim drops
 * an entry the drain had submitted, and removing `count` then reaches past the
 * batch into the new play.
 */
function dropSubmitted(count: number): void {
  setPendingScrobbles(getPendingScrobbles().slice(Math.max(count - trimmedWhileDraining, 0)));
}

/**
 * Returns an eligible batch without claiming the drain or changing the queue.
 * Requires an enabled integration and matching session key, since an earlier request can settle after disable or reconnect.
 * Only a current-generation drain blocks another batch, because stale drains cannot remove current entries.
 * Caps each request at Last.fm's 50-play limit, leaving any excess for later playback-triggered drains.
 */
function drainGuard(sessionKey: string): PendingScrobble[] | null {
  if (!getLastfmEnabled()) return null;
  if (drainGeneration === sessionGeneration) return null;
  const batch = getPendingScrobbles().slice(0, MAX_PENDING_SCROBBLES);
  if (batch.length === 0) return null;
  if (getLastfmSessionKey() !== sessionKey) return null;
  return batch;
}

/**
 * Encodes one play as the fields track.scrobble names it by. `suffix` carries
 * the `[index]` a batch needs and is empty for a single play, which is the only
 * difference between the two requests.
 *
 * `track.updateNowPlaying` does not use this: it takes no timestamp, and it
 * reports a duration for any track with one rather than only where the rounded
 * seconds are non-zero.
 */
function trackParams(entry: PendingScrobble, suffix = ''): Record<string, string> {
  const params: Record<string, string> = {
    [`artist${suffix}`]: entry.artist,
    [`track${suffix}`]: entry.track,
    [`timestamp${suffix}`]: String(entry.timestamp),
  };
  if (entry.album) params[`album${suffix}`] = entry.album;
  if (entry.durationSec) params[`duration${suffix}`] = String(entry.durationSec);
  if (entry.chosenByUser !== undefined) params[`chosenByUser${suffix}`] = String(entry.chosenByUser);
  return params;
}

/** Encodes a batch as the indexed parameters one track.scrobble request takes. */
function buildBatchParams(batch: PendingScrobble[], sessionKey: string): Record<string, string> {
  const params: Record<string, string> = { method: 'track.scrobble', api_key: API_KEY, sk: sessionKey };
  batch.forEach((entry, index) => Object.assign(params, trackParams(entry, `[${index}]`)));
  return params;
}

/**
 * Reports what became of a submitted batch and takes it off the queue.
 *
 * The result is thrown away when the account changed while the request was out.
 * `disconnect()` empties the queue, so by the time such a drain settles the
 * entries under it are the next account's plays, and removing the batch length
 * would discard them.
 */
function onDrainSettled(res: LastfmResponse, batch: PendingScrobble[], generation: number): void {
  if (generation !== sessionGeneration) {
    lastfmLog.info('queued scrobbles submitted for an account that has gone:', batch.length);
    return;
  }
  dropSubmitted(batch.length);
  // The batch clears whatever Last.fm made of it, and the codes are reported
  // and then let go rather than held for another attempt: a filtered artist
  // or track, and a timestamp too old or too new, all answer about the play
  // itself and would be filtered again on any resend, while the daily limit
  // needs a queue policy this integration does not have. So the log is the
  // only place the loss is visible at all.
  const outcome = readScrobbleOutcome(res);
  if (!outcome) {
    lastfmLog.info('queued scrobbles submitted:', batch.length);
    return;
  }
  const reasons = outcome.codes.length > 0 ? `; ignored codes: ${outcome.codes.join(', ')}` : '';
  const counts = `Last.fm accepted ${outcome.accepted}, ignored ${outcome.ignored}${reasons}`;
  lastfmLog.info(`queued scrobbles submitted: ${batch.length}; ${counts}`);
}

/** Decides whether a failed batch is gone or still owed, and reports which. */
function onDrainFailed(err: Error, batch: PendingScrobble[], generation: number): void {
  // A refusal is as final for a queued play as it is for a live one, so the
  // batch goes whether or not the session survived it. Keeping a batch the
  // API can only refuse would block every later drain behind it forever.
  if (isFinalRefusal(err)) {
    if (!handleInvalidSession(err, generation)) {
      lastfmLog.warn('queued scrobbles refused, dropped:', err.message);
    }
    // An invalid session clears the queue and advances the generation.
    if (generation === sessionGeneration) dropSubmitted(batch.length);
    return;
  }
  // A transport failure, or a service that answered about itself rather
  // than about these plays. Nothing took them, so the queue stands and the
  // next successful request carries it out. That cannot wedge: no code here
  // can be provoked by the batch, so the condition is the service's and it
  // clears when the service does. Nothing is scheduled either, so the next
  // attempt waits on a request the user's own playback triggers.
  lastfmLog.warn('queued scrobbles not sent, still queued:', err.message);
}

/**
 * Submits the queued plays in one batch: guard, build, dispatch.
 *
 * The drain marks its generation while it is out and clears the marker only
 * once the request settles, which is what keeps a second batch from starting
 * beside this one and sharing `trimmedWhileDraining` with it.
 */
function flushPendingScrobbles(sessionKey: string): void {
  const batch = drainGuard(sessionKey);
  if (!batch) return;
  const generation = sessionGeneration;
  drainGeneration = generation;
  trimmedWhileDraining = 0;

  const params = buildBatchParams(batch, sessionKey);
  apiCall(params, true)
    .then((res) => onDrainSettled(res, batch, generation))
    .catch((err: Error) => onDrainFailed(err, batch, generation))
    .finally(() => {
      // Only this drain's own marker is cleared. A stale drain settling late
      // would otherwise release the live drain's place and let a second one
      // start beside it.
      if (drainGeneration === generation) drainGeneration = null;
    });
}

/**
 * Tells Last.fm what is playing now, on every track start and resume. Its
 * success is also one of the two places a queued backlog goes out, because a
 * request the user's own playback triggered is the only thing that drains it.
 */
function sendNowPlaying(): void {
  const current = active();
  if (!current) return;
  const sessionKey = current.sessionKey;
  const params: Record<string, string> = {
    method: 'track.updateNowPlaying',
    artist: current.artist,
    track: current.track,
    api_key: API_KEY,
    sk: sessionKey,
  };
  if (current.album) params.album = current.album;
  if (current.durationMs > 0) params.duration = String(Math.round(current.durationMs / 1000));

  const generation = sessionGeneration;
  apiCall(params, true)
    .then(() => {
      lastfmLog.debug('event=now-playing status=submitted');
      flushPendingScrobbles(sessionKey);
    })
    .catch((err: Error) => {
      if (handleInvalidSession(err, generation)) return;
      lastfmLog.warn('now playing failed:', err.message);
    });
}

/**
 * Requires live playback and position evidence before a timer can submit a play.
 * Normal tracks need a position report for this track, excluding cached positions from the previous item.
 * Their threshold uses absolute position, because repeat-one can arm before the new loop's first position report.
 * Radio instead requires recent continuous advances and enough accumulated play time, never the station's absolute playhead or stalled wall time.
 */
function playbackReachedThreshold(): boolean {
  const snapshot = playerRef?.playbackSnapshot();
  if (!snapshot?.isPlaying) return false;
  const threshold = scrobbleThresholdMs(durationMs);
  if (threshold === null) return false;
  if (isRadioSong) {
    return radioPositionAdvanced && lastRadioAdvanceAt !== null &&
      Date.now() - lastRadioAdvanceAt <= POSITION_TOLERANCE_MS &&
      accumulatedMs >= threshold;
  }
  if (!positionReported) return false;
  return snapshot.positionUs / 1000 + POSITION_TOLERANCE_MS >= threshold;
}

function submitScrobble(entry: PendingScrobble, sessionKey: string, generation: number): void {
  const params: Record<string, string> = {
    method: 'track.scrobble',
    ...trackParams(entry),
    api_key: API_KEY,
    sk: sessionKey,
  };

  apiCall(params, true)
    .then(() => {
      lastfmLog.info('event=scrobble status=submitted');
      flushPendingScrobbles(sessionKey);
    })
    .catch((err: Error) => {
      if (handleInvalidSession(err, generation)) return;
      if (isFinalRefusal(err)) {
        lastfmLog.warn('scrobble failed, not retried:', err.message);
        return;
      }
      if (generation !== sessionGeneration) {
        lastfmLog.warn('scrobble not queued, the account it belongs to has gone:', err.message);
        return;
      }
      queueScrobble(entry);
      lastfmLog.warn('scrobble queued, the request did not reach Last.fm:', err.message);
    });
}

/**
 * Submits the current track as a play. Reached from the armed timer and from
 * `armScrobbleTimer()` when the threshold is already behind the playhead.
 */
function doScrobble(): void {
  clearScrobbleTimer();
  if (scrobbled) return;
  const current = active();
  if (!current) return;
  if (!playbackReachedThreshold()) {
    lastfmLog.debug('event=scrobble status=skipped reason=threshold-not-reached');
    return;
  }
  scrobbled = true;

  const sessionKey = current.sessionKey;
  const generation = sessionGeneration;
  // The queued entry and the live request are built from one object so the play
  // that goes on the queue cannot drift from the play that was submitted.
  const entry: PendingScrobble = { artist: current.artist, track: current.track, timestamp: trackStartUnix };
  if (current.album) entry.album = current.album;
  if (current.durationMs > 0) entry.durationSec = Math.round(current.durationMs / 1000);
  if (isRadioSong) entry.chosenByUser = 0;

  // Keep scrobbled set after submission, including failures, to prevent resubmission on resume.
  // submitScrobble() queues non-final failures only for the same session.
  // A later playback request drains the queue without a retry timer.
  submitScrobble(entry, sessionKey, generation);
}

/**
 * Waits out the play time the track still owes before it can be scrobbled.
 * `accumulatedMs` already holds the time banked before the last pause, so a
 * resume waits only for the remainder, and a threshold met while paused
 * submits at once rather than waiting a second time.
 */
function armScrobbleTimer(): void {
  clearScrobbleTimer();
  if (scrobbled || !active() || (isRadioSong && pendingRadioBoundary !== undefined)) return;
  const threshold = scrobbleThresholdMs(durationMs);
  if (threshold === null) return;
  const remaining = threshold - accumulatedMs;
  if (remaining <= 0) {
    doScrobble();
    return;
  }
  scrobbleTimer = setTimeout(doScrobble, remaining);
}

function radioBoundaryTrack(): RadioBoundaryTrack | null {
  foldPlayTime();
  const current = active();
  if (!current || !isRadioSong || !radioObservedFromStart || !radioPositionAdvanced || scrobbled ||
      accumulatedMs <= MIN_TRACK_LENGTH_MS || trackStartUnix === 0) {
    return null;
  }
  return {
    ...current,
    timestamp: trackStartUnix,
    generation: sessionGeneration,
  };
}

function adoptRadioTrack(payload: TimedMetadataPayload): void {
  const cleanBoundary = payload.transition === 'clean' && !radioSeekPending;
  const observedAtMs = payload.observedAtMs ?? Date.now();
  if (cleanBoundary && isRadioSong) {
    accumulatedMs = Math.max(0, accumulatedMs - Math.max(0, Date.now() - observedAtMs));
  }
  const outgoing = cleanBoundary ? radioBoundaryTrack() : null;
  const observedFromStart = cleanBoundary;

  resetTrack(payload);
  isRadioSong = true;
  radioObservedFromStart = observedFromStart;
  pendingRadioBoundary = cleanBoundary ? outgoing : undefined;
  radioSeekPending = false;

  if (playerRef?.playbackSnapshot().isPlaying) {
    markPlaybackStarted();
    if (trackStartUnix !== 0) trackStartUnix = Math.floor(observedAtMs / 1000);
  }
}

function invalidateRadioContinuity(): void {
  if (!isRadioSong && pendingRadioBoundary === undefined) return;
  pendingRadioBoundary = undefined;
  radioObservedFromStart = false;
  radioPositionAdvanced = false;
  lastRadioAdvanceAt = null;
  accumulatedMs = 0;
  trackStartUnix = 0;
  lastResumeAt = null;
  clearScrobbleTimer();
  if (playerRef?.playbackSnapshot().isPlaying && active()) {
    trackStartUnix = nowUnix();
    lastResumeAt = Date.now();
    armScrobbleTimer();
  }
}

function confirmRadioBoundary(): void {
  if (pendingRadioBoundary === undefined || !getLastfmEnabled()) return;
  const outgoing = pendingRadioBoundary;
  pendingRadioBoundary = undefined;
  if (outgoing && getLastfmEnabled() && outgoing.generation === sessionGeneration &&
      getLastfmSessionKey() === outgoing.sessionKey) {
    const entry: PendingScrobble = {
      artist: outgoing.artist,
      track: outgoing.track,
      timestamp: outgoing.timestamp,
      chosenByUser: 0,
    };
    if (outgoing.album) entry.album = outgoing.album;
    submitScrobble(entry, outgoing.sessionKey, outgoing.generation);
  }
  armScrobbleTimer();
}

/**
 * Adopts a new track and clears every counter the previous one left behind.
 * `positionReported` goes with them, so the playhead cannot be trusted again
 * until the player reports a position for this track: see
 * `playbackReachedThreshold()`.
 */
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
  isRadioSong = false;
  radioObservedFromStart = false;
  radioPositionAdvanced = false;
  lastRadioAdvanceAt = null;
  pendingRadioBoundary = undefined;
}

/**
 * Marks the moment the current track actually starts or resumes playing.
 * `trackStartUnix` is captured on the first real play transition rather than at
 * metadata change, so the scrobble timestamp reflects when playback began even
 * when a track is selected while paused and played later.
 */
function markPlaybackStarted(): void {
  if (!getLastfmEnabled()) return;
  if (trackStartUnix === 0) trackStartUnix = nowUnix();
  lastResumeAt = Date.now();
  sendNowPlaying();
  armScrobbleTimer();
}

/**
 * Starts scrobbling for playback that is already under way, so turning the
 * feature on mid-track counts that track rather than waiting for the next one.
 */
export function enable(): void {
  if (!isConfigured()) {
    lastfmLog.warn('enabled but no API credentials configured; scrobbling is inert');
    return;
  }
  if (isRadioSong) radioObservedFromStart = false;
  if (playerRef?.playbackSnapshot().isPlaying) {
    markPlaybackStarted();
  }
  lastfmLog.info('scrobbling enabled');
}

/**
 * Stops scrobbling but keeps the track state. The play time banked so far is
 * folded first, so turning the feature back on mid-track resumes the count
 * instead of starting it over.
 */
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
 * Closes a failed auth attempt: the flow is released, the feature switched back
 * off and the user told. The notification is forced past `notifications.enabled`
 * because it answers an action the user just took in the tray, and silence there
 * leaves the menu back at Connect with no explanation.
 */
function failAuth(reason: string, onComplete?: () => void): void {
  authInProgress = false;
  authPollTimer = null;
  lastfmLog.warn(reason);
  setLastfmEnabled(false);
  notify(getLastfmConnectFailedText(), true);
  onComplete?.();
  stateChangedCallback?.();
}

/**
 * Runs the Last.fm desktop auth flow: fetch a token, open the approval page in
 * the browser, then poll auth.getSession until the user approves or it times out.
 * `onComplete` is called once the flow settles so the caller can refresh UI.
 */
export function startAuth(onComplete?: () => void): void {
  if (authInProgress) return;
  if (!isConfigured()) {
    failAuth('cannot authenticate: no API credentials configured', onComplete);
    return;
  }
  authInProgress = true;
  const generation = ++authGeneration;

  apiCall({ method: 'auth.getToken', api_key: API_KEY }, false)
    .then((res) => {
      if (generation !== authGeneration) return;
      const token = res.token;
      if (!token) throw new Error('no token returned');
      // Percent-encode both values so token characters cannot change the query structure.
      const url = new URL(AUTH_URL);
      url.searchParams.set('api_key', API_KEY);
      url.searchParams.set('token', token);
      openInBrowser(url);
      lastfmLog.info('waiting for browser authorisation');
      pollForSession(token, Date.now(), generation, onComplete);
    })
    .catch((err: Error) => {
      if (generation !== authGeneration) return;
      failAuth(`auth.getToken failed: ${err.message}`, onComplete);
    });
}

/**
 * Asks for the session until the user approves the token in their browser.
 * Last.fm offers no callback, so each refusal reschedules the next attempt and
 * the whole flow gives up at `AUTH_POLL_TIMEOUT_MS`. Every response returns at
 * the generation guard once `cancelAuth()` has run, so an abandoned flow cannot
 * connect an account behind the user's back.
 */
function pollForSession(token: string, startedAt: number, generation: number, onComplete?: () => void): void {
  if (generation !== authGeneration) return;
  const remainingMs = AUTH_POLL_TIMEOUT_MS - (Date.now() - startedAt);
  if (remainingMs <= 0) {
    failAuth('authorisation timed out', onComplete);
    return;
  }

  apiCall({ method: 'auth.getSession', api_key: API_KEY, token }, false, Math.min(REQUEST_TIMEOUT_MS, remainingMs))
    .then((res) => {
      if (generation !== authGeneration) return;
      const key = res.session?.key;
      const name = res.session?.name;
      if (key && name) {
        authInProgress = false;
        authPollTimer = null;
        invalidateRadioContinuity();
        setLastfmSession(key, name);
        sessionGeneration += 1;
        lastfmLog.info('authenticated as', name);
        notify(getLastfmConnectedText(name));
        enable();
        onComplete?.();
        stateChangedCallback?.();
        return;
      }
      throw new Error('session not yet authorised');
    })
    .catch(() => {
      if (generation !== authGeneration) return;
      if (Date.now() - startedAt >= AUTH_POLL_TIMEOUT_MS) {
        failAuth('authorisation timed out', onComplete);
        return;
      }
      const delay = Math.min(AUTH_POLL_INTERVAL_MS, AUTH_POLL_TIMEOUT_MS - (Date.now() - startedAt));
      authPollTimer = setTimeout(() => pollForSession(token, startedAt, generation, onComplete), delay);
    });
}

/**
 * Forgets the account: the stored session, the queued plays and the enabled
 * flag all go. Called from the tray, and from `handleInvalidSession()` when
 * Last.fm rejects the key the user revoked at their end.
 */
export function disconnect(): void {
  cancelAuth();
  disable();
  clearLastfmSession();
  // Every request already out was signed for the account that has gone, so its
  // response must not touch the queue the next account fills.
  sessionGeneration += 1;
  invalidateRadioContinuity();
  // The queued plays go with the account. They are the user's listening history
  // held in plain text, and Disconnect is what removes Sidra's copy of that; a
  // queue that outlived the account would also submit those plays to whichever
  // account was connected next.
  setPendingScrobbles([]);
  setLastfmEnabled(false);
  lastfmLog.info('disconnected from Last.fm');
  stateChangedCallback?.();
}

/**
 * Subscribes to track, radio metadata, playback state and position events on every platform.
 * Releases listeners on will-quit and makes no requests without application credentials.
 */
export function init(ctx: IntegrationContext): void {
  playerRef = ctx.player;
  getWindow = ctx.getMainWindow ?? (() => null);
  lastfmLog.info('Last.fm module initialised');
  if (!isConfigured()) {
    lastfmLog.info('no API credentials configured; scrobbling is inert until set');
  }

  const onNowPlayingItemDidChange = (payload: NowPlayingPayload | null): void => {
    resetTrack(payload?.playParams?.kind === 'radioStation' ? null : payload);
    lastPositionUs = null;
    lastPositionAt = null;
    radioSeekPending = false;
    if (playerRef?.playbackSnapshot().isPlaying) {
      markPlaybackStarted();
    }
  };

  const onTimedMetadataDidChange = (payload: TimedMetadataPayload): void => {
    adoptRadioTrack(payload);
  };

  const onPlaybackStateDidChange = (payload: PlaybackStatePayload): void => {
    const wasPlaying = previousState === PlaybackState.Playing;
    const nowPlaying = payload?.state === PlaybackState.Playing;
    previousState = payload?.state ?? 0;

    if (payload?.state === PlaybackState.Seeking) {
      invalidateRadioContinuity();
      radioSeekPending = true;
      lastPositionUs = null;
      lastPositionAt = null;
    }

    if (nowPlaying && !wasPlaying) {
      markPlaybackStarted();
    } else if (!nowPlaying && wasPlaying) {
      foldPlayTime();
      clearScrobbleTimer();
      if (payload?.state !== PlaybackState.Seeking) {
        lastPositionUs = null;
        lastPositionAt = null;
      }
    }
  };

  // Normal tracks mark the playhead as current. Radio counts continuous advances
  // and confirms song boundaries here, since wall time cannot prove stream playback.
  const onPlaybackTimeDidChange = (positionUs: number): void => {
    positionReported = true;
    const now = Date.now();
    if (isRadioSong && lastPositionUs !== null && lastPositionAt !== null) {
      const advanceUs = positionUs - lastPositionUs;
      const reportGapMs = now - lastPositionAt;
      const maximumAdvanceUs = (reportGapMs + POSITION_TOLERANCE_MS) * 1000;
      if (reportGapMs > POSITION_TOLERANCE_MS || advanceUs < 0 || advanceUs > maximumAdvanceUs) {
        invalidateRadioContinuity();
        radioSeekPending = true;
      } else if (advanceUs > 0 && playerRef?.playbackSnapshot().isPlaying) {
        if (lastResumeAt !== null) {
          accumulatedMs += advanceUs / 1000;
        }
        radioPositionAdvanced = true;
        lastRadioAdvanceAt = now;
        confirmRadioBoundary();
        if (pendingRadioBoundary === undefined && !scrobbleTimer && playbackReachedThreshold()) {
          doScrobble();
        }
      }
    }
    lastPositionUs = positionUs;
    lastPositionAt = now;
  };

  ctx.player.on('nowPlayingItemDidChange', onNowPlayingItemDidChange);
  ctx.player.on('timedMetadataDidChange', onTimedMetadataDidChange);
  ctx.player.on('playbackStateDidChange', onPlaybackStateDidChange);
  ctx.player.on('playbackTimeDidChange', onPlaybackTimeDidChange);

  app.on('will-quit', () => {
    clearScrobbleTimer();
    cancelAuth();
    ctx.player.removeListener('nowPlayingItemDidChange', onNowPlayingItemDidChange);
    ctx.player.removeListener('timedMetadataDidChange', onTimedMetadataDidChange);
    ctx.player.removeListener('playbackStateDidChange', onPlaybackStateDidChange);
    ctx.player.removeListener('playbackTimeDidChange', onPlaybackTimeDidChange);
    resetTrack(null);
    previousState = 0;
    lastPositionUs = null;
    lastPositionAt = null;
    radioSeekPending = false;
  });
}
