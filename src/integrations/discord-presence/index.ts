import { app } from 'electron';
import log from 'electron-log/main';
import { Client, SetActivity, StatusDisplayType } from '@xhayper/discord-rpc';
import { ActivityType } from 'discord-api-types/v10';
import { Player, NowPlayingPayload, PlaybackState, PlaybackStatePayload, IntegrationContext } from '../../player';
import { getDiscordEnabled, getMusicService } from '../../config';
import { getService } from '../../musicService';
import { createPauseTimer } from '../../pauseTimer';

const discordLog = log.scope('discord');

const CLIENT_ID = '1485248818688688318';
const DEBOUNCE_MS = 1000;
const PAUSE_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_CAP_MS = 60_000;
const MAX_STRING_LEN = 128;
const MIN_STRING_LEN = 2;
const MAX_IMAGE_URL_LEN = 256;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '\u2026';
}

// Discord rejects an activity string shorter than MIN_STRING_LEN, and the
// refusal costs the whole update, so a one-character track title is padded
// with zero-width spaces instead.
function padMin(s: string, min: number): string {
  while (s.length < min) {
    s += '\u200b';
  }
  return s;
}

// Track metadata cache
let trackName: string | null = null;
let artistName: string | null = null;
let albumName: string | null = null;
let artworkUrl: string | undefined = undefined;
let durationMs = 0;
let trackUrl: string | undefined = undefined;

// Playback state. init() assigns playerRef before it builds the only client, so
// nothing can reach the send path without one. Every call below enable()/disable()
// carries the Player as an argument, so tsc checks it rather than an assertion.
let playerRef: Player | null = null;
let previousState = 0;

// Timers
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;

let client: Client | undefined;

const pauseTimeout = createPauseTimer(PAUSE_TIMEOUT_MS, () => {
  discordLog.debug('pause timeout reached, clearing activity');
  client?.user?.clearActivity().catch(() => {});
});

function createClient(player: Player): Client {
  const created = new Client({ clientId: CLIENT_ID });

  created.on('ready', () => {
    discordLog.info('connected to Discord');
    retryCount = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    scheduleUpdate(player);
  });

  created.on('disconnected', () => {
    discordLog.info('disconnected from Discord');
    scheduleReconnect(player);
  });

  return created;
}

// Ends a client that is being discarded. removeAllListeners() must run before
// destroy(): destroy() closes the transport, whose close handler emits
// 'disconnected' on the old client, and that stray event would arm a second
// backoff chain.
//
// clearActivity() is an RPC round trip on the transport destroy() closes, and
// destroy() neither flushes the socket nor waits for Discord's reply, so the
// destroy is chained onto the clear rather than called beside it. A dead
// Discord still reaches the destroy: the transport close handler rejects every
// pending request.
function retireClient(retiring: Client, clearActivity: boolean): void {
  retiring.removeAllListeners();
  const cleared = clearActivity && retiring.user
    ? retiring.user.clearActivity().catch(() => {})
    : Promise.resolve();
  cleared.then(() => retiring.destroy().catch(() => {}));
}

// Client.connect() leaks a 'connected' listener on both failure paths, and a
// transport rejection leaves connectionPromise set to a rejected promise, so a
// reused instance never retries. Discarding the instance is the only remedy
// available to a consumer.
function replaceClient(player: Player, clearActivity = false): Client {
  if (client) {
    retireClient(client, clearActivity);
  }
  client = createClient(player);
  return client;
}

// One failure policy for every login attempt: warn with the site that made it,
// then hand the retry to the backoff chain. The client is a parameter because
// the reconnect path logs in on a fresh one while the other sites use the live
// one, and logging in twice on the same instance is what replaceClient() exists
// to prevent.
function loginOrRetry(player: Player, target: Client, context: string): void {
  target.login().catch((err: Error) => {
    discordLog.warn(`${context} failed:`, err.message);
    scheduleReconnect(player);
  });
}

function scheduleUpdate(player: Player): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    sendActivity(player);
  }, DEBOUNCE_MS);
}

function disconnectClient(player: Player): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pauseTimeout.cancel();
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  retryCount = 0;

  replaceClient(player, true);
  discordLog.info('disconnected from Discord (disabled via toggle)');
}

function sendActivity(player: Player): void {
  if (!client) return;

  if (!getDiscordEnabled()) {
    if (client.isConnected || reconnectTimer || debounceTimer) {
      disconnectClient(player);
    }
    return;
  }

  if (!client.isConnected) {
    discordLog.debug('not connected, attempting login');
    loginOrRetry(player, client, 'login');
    return;
  }

  if (!trackName) {
    discordLog.debug('no track metadata, skipping activity update');
    return;
  }

  const details = padMin(truncate(trackName, MAX_STRING_LEN), MIN_STRING_LEN);
  const state = padMin(truncate(`by ${artistName ?? 'Unknown Artist'}`, MAX_STRING_LEN), MIN_STRING_LEN);

  const largeImageKey = (artworkUrl && artworkUrl.length <= MAX_IMAGE_URL_LEN)
    ? artworkUrl
    : 'sidra_logo';
  const largeImageText = albumName
    ? truncate(albumName, MAX_STRING_LEN)
    : undefined;

  const buttons: Array<{ label: string; url: string }> = [
    { label: 'Sidra', url: 'https://github.com/wimpysworld/sidra' },
  ];
  if (trackUrl) {
    const displayName = getService(getMusicService()).displayName;
    buttons.push({ label: `Play on ${displayName}`, url: trackUrl });
  }

  const activity: SetActivity = {
    type: ActivityType.Listening,
    statusDisplayType: StatusDisplayType.DETAILS,
    details,
    state,
    largeImageKey,
    largeImageText,
    smallImageKey: 'sidra_logo',
    smallImageText: 'Sidra',
    buttons,
  };

  // Discord draws the progress bar from absolute timestamps, so the start is
  // back-dated by the current playhead and the end sits one duration past it.
  const snap = player.playbackSnapshot();
  if (snap.isPlaying && durationMs > 0) {
    const currentPositionMs = snap.positionUs / 1000;
    const now = Date.now();
    activity.startTimestamp = new Date(now - currentPositionMs);
    activity.endTimestamp = new Date(now - currentPositionMs + durationMs);
  }

  client.user?.setActivity(activity).then(() => {
    discordLog.debug('activity updated:', trackName);
  }).catch((err: Error) => {
    discordLog.warn('failed to set activity:', err.message);
  });
}

function scheduleReconnect(player: Player): void {
  if (!getDiscordEnabled()) return;
  if (reconnectTimer) return;

  const delay = Math.min(RECONNECT_BASE_MS * 2 ** retryCount, RECONNECT_CAP_MS);
  retryCount++;
  discordLog.info(`scheduling reconnect in ${delay}ms (attempt ${retryCount})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (client?.isConnected) return;
    discordLog.info('attempting reconnect');
    loginOrRetry(player, replaceClient(player), 'reconnect');
  }, delay);
}

/** Turns presence on from the tray toggle; connects if the client is idle. */
export function enable(): void {
  const player = playerRef;
  if (!player || !client) return;
  if (!client.isConnected) {
    discordLog.info('enabling Discord presence');
    loginOrRetry(player, client, 'enable login');
  }
}

/** Turns presence off from the tray toggle; clears the activity and drops every timer. */
export function disable(): void {
  const player = playerRef;
  if (!player || !client) return;
  disconnectClient(player);
}

/** Starts the presence client and mirrors player events into a Discord activity. */
export function init(ctx: IntegrationContext): void {
  const { player } = ctx;
  playerRef = player;
  discordLog.info('discord presence module initialised');

  client = createClient(player);

  if (getDiscordEnabled()) {
    loginOrRetry(player, client, 'initial login');
  }

  // Named listener references for removeListener in will-quit
  const onNowPlayingItemDidChange = (payload: NowPlayingPayload | null): void => {
    if (!payload) {
      trackName = null;
      artistName = null;
      albumName = null;
      artworkUrl = undefined;
      durationMs = 0;
      trackUrl = undefined;
    } else {
      trackName = payload.name ?? null;
      artistName = payload.artistName ?? null;
      albumName = payload.albumName ?? null;
      artworkUrl = payload.artworkUrl;
      durationMs = payload.durationInMillis ?? 0;
      trackUrl = payload.url;
    }

    // A track change supersedes an earlier pause, so the pending clear-activity
    // timer must not fire over the new track
    pauseTimeout.cancel();

    scheduleUpdate(player);
  };

  const onPlaybackStateDidChange = (payload: PlaybackStatePayload): void => {
    const wasPlaying = previousState === PlaybackState.Playing;
    const nowPlaying = payload?.state === PlaybackState.Playing;
    previousState = payload?.state ?? 0;

    if (nowPlaying) {
      pauseTimeout.cancel();
    }

    if (!nowPlaying && wasPlaying) {
      pauseTimeout.start();
    }

    scheduleUpdate(player);
  };

  player.on('nowPlayingItemDidChange', onNowPlayingItemDidChange);
  player.on('playbackStateDidChange', onPlaybackStateDidChange);

  app.on('will-quit', () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    pauseTimeout.destroy();
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    // Quitting removes the presence anyway, so the activity is not cleared: that
    // is an RPC round trip the destroy would have to wait on, and the process is
    // ending underneath it.
    if (client) {
      retireClient(client, false);
      client = undefined;
    }

    player.removeListener('nowPlayingItemDidChange', onNowPlayingItemDidChange);
    player.removeListener('playbackStateDidChange', onPlaybackStateDidChange);

    trackName = null;
    artistName = null;
    albumName = null;
    artworkUrl = undefined;
    durationMs = 0;
    trackUrl = undefined;
    previousState = 0;
    retryCount = 0;
  });
}
