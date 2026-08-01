import { app, net, shell, BrowserWindow } from 'electron';
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
  getPendingScrobbles,
  setPendingScrobbles,
  type PendingScrobble,
} from '../../config';
import { getLastfmConnectedText, getLastfmConnectFailedText } from '../../i18n';
import { errorMessage } from '../../utils';
import { createNotification } from '../../notify';

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

// 50 is the maximum number of tracks Last.fm accepts in one track.scrobble
// request, so it caps both what the queue holds and what one drain submits.
// Past the cap the oldest play is dropped. A longer queue can still arrive from
// a hand-edited or older config.json, which is why the drain caps the batch
// again rather than trusting this one.
const MAX_PENDING_SCROBBLES = 50;

// How long a drain request is given before it is aborted. A drain marks its
// generation while it is out and clears the marker only once the request
// settles, so a connection that hangs rather than failing would hold that
// marker for the life of the session and every later drain would return at the
// guard with the queue never going out again. The abort ends the request, which
// fails it the way a dropped connection does: the batch stays queued and the
// marker clears. It is not a retry - nothing is re-issued and nothing is
// re-armed, so the batch still waits for a drain the user's own playback
// triggers. Only the drain is bounded; every other request settles on its own.
const DRAIN_TIMEOUT_MS = 30_000;

// Authentication poll: Last.fm has no callback, so poll auth.getSession until the
// user approves the token in their browser, then give up.
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
 * Reads what Last.fm actually stored out of a track.scrobble body, or null when
 * the body carries no `scrobbles` field at all.
 *
 * Filtering is not an error. A batch Last.fm kept nothing from still answers
 * `status: ok` with no `error` field, so it settles on the success path and
 * cannot be told from a batch stored whole unless the body is read. That is the
 * only reason this exists.
 *
 * The null return is what keeps a body without the field reported exactly as it
 * always was: reading an absent field as zero accepted would report a loss for
 * every response that merely does not carry the counts.
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

// The Last.fm codes that answer about something other than the play. Two
// classes sit here. The state of the service: 8 "Operation failed - Most likely
// the backend service failed. Please try again.", 11 "Service Offline - This
// service is temporarily offline. Try again later.", 16 "The service is
// temporarily unavailable, please try again." and 29 "Rate Limit Exceded". The
// state of Sidra's own application credential: 10 "Invalid API key - You must
// be granted a valid key by last.fm" and 26 "API Key Suspended - This
// application is not allowed to make requests to the web services", which the
// track.scrobble page words as "Suspended API key - Access for your account has
// been suspended, please contact Last.fm". Neither is anything the user can
// fix, and Last.fm can restore a rejected key server-side exactly as it can
// lift a suspension: `active()` gates every request on `isConfigured()`, so a
// build shipped without credentials never makes a request at all and code 10
// can only mean a key that is present was rejected. None of the six means the
// play was seen and refused, so the play is held exactly as one the network
// never delivered is. Every other code answers about this play and is final.
//
// None of them can be provoked by the contents of a batch either, which is what
// keeps a held batch from blocking the queue: the condition belongs to the
// service or to the credential, and it clears when that does. While the
// credential is rejected no request can succeed, so the queue neither drains
// nor blocks anything; `queueScrobble()` evicts oldest-first, so it stays a
// rolling window of the newest 50 plays. No timer retries either: a drain only
// rides on the success path of a request the user's playback triggered. See
// `flushPendingScrobbles()`.
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
 * Returns the play time after which a track should be scrobbled, or null if the
 * track is too short to ever scrobble.
 */
export function scrobbleThresholdMs(durationMs: number): number | null {
  if (durationMs > 0 && durationMs <= MIN_TRACK_LENGTH_MS) return null;
  if (durationMs <= 0) return SCROBBLE_CAP_MS;
  return Math.min(durationMs / 2, SCROBBLE_CAP_MS);
}

async function apiCall(params: Record<string, string>, post: boolean, signal?: AbortSignal): Promise<LastfmResponse> {
  const signed = { ...params, api_sig: signParams(params, API_SECRET) };
  const query = new URLSearchParams({ ...signed, format: 'json' });

  const response = post
    ? await net.fetch(API_ROOT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: query.toString(),
        signal,
      })
    : await net.fetch(`${API_ROOT}?${query.toString()}`, { signal });

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

/**
 * The single gate every request path checks: credentials in the build, the
 * feature on, an account connected, and a track worth naming. A build without
 * credentials therefore never reaches Last.fm at all.
 */
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
 * The rejection only counts against the session the request went out under,
 * which is why the caller passes in the generation it captured rather than
 * reading anything stored again here. A second request in flight when the first
 * is refused belongs to a session that is already gone, so it settles here
 * silently and the user sees one notification. A refusal that arrives after the
 * user has reconnected belongs to the old session too, so it cannot tear down
 * the session that replaced it.
 *
 * The generation is the gate rather than the session key because Last.fm hands
 * back the same key when the same account reconnects. Comparing keys let such a
 * refusal pass as current: it disconnected the session the user had just
 * established and emptied the queue with it. The generation moves at both
 * writers of the stored key, so an equal generation means the session that sent
 * the request is still the one connected.
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
 * Holds a play the network stopped from reaching Last.fm. The queue is
 * persisted, so it survives the restart that a dropped connection often ends
 * in, and the newest entries win once it is full: an old play is the one the
 * user is least likely to miss.
 *
 * A trim made while a drain is in flight is counted, because it takes an entry
 * off the head that the drain has already submitted and is about to remove
 * again. Only a drain from the session still connected counts: one from an
 * account that has gone removes nothing, so a trim against it would be
 * subtracted from a batch that is never dropped.
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
 * Submits the queued plays in one batch, capped at the 50 Last.fm accepts in a
 * single track.scrobble request. Anything past that stays on the queue and goes
 * out with the next drain: nothing here is scheduled, so a longer queue clears
 * over as many requests as the user's own playback triggers. Sending it whole
 * would be refused, losing the backlog to a final error and resending the same
 * over-long batch forever when the request never reached Last.fm at all.
 *
 * The session key is passed in by the caller and checked against the stored one
 * because a drain signed with a key the user has since replaced belongs to
 * nobody.
 *
 * The result is thrown away when the account changes while the request is out.
 * `disconnect()` empties the queue, so by the time such a drain settles the
 * entries under it are the next account's plays, and removing the batch length
 * would discard them.
 */
function flushPendingScrobbles(sessionKey: string): void {
  // Off is an instruction to stop sending. Nothing cancels a request already
  // out, so one that left while the feature was on can settle after the toggle
  // and carry the whole queue to Last.fm from here. The check belongs in the
  // drain rather than at its callers, so every path into it is covered. The
  // plays stay queued: the user consented to them when they played them, and
  // they go out if the feature is turned back on.
  if (!getLastfmEnabled()) return;
  // A drain from a generation that has moved on is left where it is: it never
  // reaches `dropSubmitted()`, so it cannot collide with this one, and `null`
  // never matches a generation.
  if (drainGeneration === sessionGeneration) return;
  const batch = getPendingScrobbles().slice(0, MAX_PENDING_SCROBBLES);
  if (batch.length === 0) return;
  if (getLastfmSessionKey() !== sessionKey) return;
  const generation = sessionGeneration;
  drainGeneration = generation;
  trimmedWhileDraining = 0;

  const params: Record<string, string> = { method: 'track.scrobble', api_key: API_KEY, sk: sessionKey };
  batch.forEach((entry, index) => {
    params[`artist[${index}]`] = entry.artist;
    params[`track[${index}]`] = entry.track;
    params[`timestamp[${index}]`] = String(entry.timestamp);
    if (entry.album) params[`album[${index}]`] = entry.album;
    if (entry.durationSec) params[`duration[${index}]`] = String(entry.durationSec);
  });

  const controller = new AbortController();
  const abortTimer = setTimeout(() => controller.abort(), DRAIN_TIMEOUT_MS);

  apiCall(params, true, controller.signal)
    .then((res) => {
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
    })
    .catch((err: Error) => {
      // A refusal is as final for a queued play as it is for a live one, so the
      // batch goes whether or not the session survived it. Keeping a batch the
      // API can only refuse would block every later drain behind it forever.
      if (isFinalRefusal(err)) {
        if (!handleInvalidSession(err, generation)) {
          lastfmLog.warn('queued scrobbles refused, dropped:', err.message);
        }
        // `handleInvalidSession()` may have disconnected, which empties the
        // queue and moves the generation on; either way the batch is gone.
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
    })
    .finally(() => {
      clearTimeout(abortTimer);
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

  const generation = sessionGeneration;
  apiCall(params, true)
    .then(() => {
      lastfmLog.debug('now playing:', `${artist} - ${track}`);
      flushPendingScrobbles(sessionKey);
    })
    .catch((err: Error) => {
      if (handleInvalidSession(err, generation)) return;
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

/**
 * Submits the current track as a play. Reached from the armed timer and from
 * `armScrobbleTimer()` when the threshold is already behind the playhead.
 */
function doScrobble(): void {
  clearScrobbleTimer();
  if (scrobbled || !active()) return;
  if (!playbackReachedThreshold()) {
    lastfmLog.debug('scrobble skipped, playback did not reach the threshold:', `${artist} - ${track}`);
    return;
  }
  scrobbled = true;

  const sessionKey = getLastfmSessionKey()!;
  const generation = sessionGeneration;
  // The queued entry and the live request are built from one object so the play
  // that goes on the queue cannot drift from the play that was submitted.
  const entry: PendingScrobble = { artist: artist!, track: track!, timestamp: trackStartUnix };
  if (album) entry.album = album;
  if (durationMs > 0) entry.durationSec = Math.round(durationMs / 1000);

  const params: Record<string, string> = {
    method: 'track.scrobble',
    artist: entry.artist,
    track: entry.track,
    timestamp: String(entry.timestamp),
    api_key: API_KEY,
    sk: sessionKey,
  };
  if (entry.album) params.album = entry.album;
  if (entry.durationSec) params.duration = String(entry.durationSec);

  // A refusal is final for this track. `scrobbled` stays set, so the track is
  // submitted once and once only. Clearing it re-opened the submission without
  // re-arming anything, so the only way back to a request was the user pausing
  // and resuming; a retry that fires on a failed submission is a retry loop,
  // and the remaining time it would wait comes from `accumulatedMs`, which is
  // only folded at pause and so means nothing mid-play.
  //
  // A transport failure says nothing about the track: Last.fm never saw it. So
  // does a temporary service error, which answers about the service and leaves
  // the play unrecorded. The play goes on the queue instead, and leaves with the
  // next request playback triggers. `scrobbled` still stays set, because a
  // queued play counts as submitted and nothing here re-arms. It is only queued
  // while the account that listened is still connected: the queue is drained
  // under whichever key is stored when it goes out, so queuing past a
  // disconnect would hand this play to the next account.
  apiCall(params, true)
    .then(() => {
      lastfmLog.info('scrobbled:', `${artist} - ${track}`);
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
 * Waits out the play time the track still owes before it can be scrobbled.
 * `accumulatedMs` already holds the time banked before the last pause, so a
 * resume waits only for the remainder, and a threshold met while paused
 * submits at once rather than waiting a second time.
 */
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

/**
 * Starts scrobbling for playback that is already under way, so turning the
 * feature on mid-track counts that track rather than waiting for the next one.
 */
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

/**
 * Asks for the session until the user approves the token in their browser.
 * Last.fm offers no callback, so each refusal reschedules the next attempt and
 * the whole flow gives up at `AUTH_POLL_TIMEOUT_MS`. Every response returns at
 * the generation guard once `cancelAuth()` has run, so an abandoned flow cannot
 * connect an account behind the user's back.
 */
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
        sessionGeneration += 1;
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
  // The queued plays go with the account. They are the user's listening history
  // held in plain text, and Disconnect is what removes Sidra's copy of that; a
  // queue that outlived the account would also submit those plays to whichever
  // account was connected next.
  setPendingScrobbles([]);
  setLastfmEnabled(false);
  lastfmLog.info('disconnected from Last.fm');
}

/**
 * Subscribes to the three player events scrobbling needs, and releases them on
 * `will-quit`. The module runs on every platform and stays inert without
 * credentials, so no gate keeps it out of a build.
 */
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
    resetTrack(null);
    previousState = 0;
  });
}
