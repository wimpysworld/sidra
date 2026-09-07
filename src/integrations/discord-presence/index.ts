import { app } from 'electron';
import log from 'electron-log/main';
import { Client, SetActivity, StatusDisplayType } from '@xhayper/discord-rpc';
import { ActivityType } from 'discord-api-types/v10';
import { Player, NowPlayingPayload, PlaybackState, PlaybackStatePayload, IntegrationContext, getShareUrl } from '../../player';
import { getDiscordEnabled, getMusicService } from '../../config';
import { getService } from '../../musicService';
import { createPauseTimer } from '../../pauseTimer';
import { getDiscordArtistText, getDiscordPlayOnText } from '../../i18n';

const discordLog = log.scope('discord');

const CLIENT_ID = '1485248818688688318';
const DEBOUNCE_MS = 1000;
const PAUSE_TIMEOUT_MS = 30_000;
const RECONNECT_BASE_MS = 2000;
const RECONNECT_CAP_MS = 60_000;
const CLEAR_ACTIVITY_TIMEOUT_MS = 2000;
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

function clearTrackMetadata(): void {
  trackName = null;
  artistName = null;
  albumName = null;
  artworkUrl = undefined;
  durationMs = 0;
  trackUrl = undefined;
}

// init() assigns playerRef before creating a client. Internal request functions
// take Player directly so only enable()/disable() need a nullable reference.
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

// Remove listeners before destroy(), whose transport close emits 'disconnected'
// and can otherwise start another reconnect timer.
// Wait for clearActivity() before closing its transport, but bound the wait:
// a silent peer or closed socket can leave that RPC unresolved after the one-shot close listener expires.
// destroyOnce() prevents duplicate destruction when the timeout and RPC both settle.
// The try/catch also contains synchronous destroy() failures.
function retireClient(retiring: Client, clearActivity: boolean): void {
  retiring.removeAllListeners();

  let destroyed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const destroyOnce = (): void => {
    if (destroyed) return;
    destroyed = true;
    if (timer) clearTimeout(timer);
    try {
      retiring.destroy().catch(() => {});
    } catch {
      // Keep client disposal failures from interrupting the caller.
    }
  };

  if (!clearActivity || !retiring.user) {
    destroyOnce();
    return;
  }

  timer = setTimeout(destroyOnce, CLEAR_ACTIVITY_TIMEOUT_MS);
  void retiring.user.clearActivity().catch(() => {}).then(destroyOnce);
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

// Share login failure handling. Reconnect supplies a fresh client, while other
// callers supply the current one, so a failed instance is not reused for retries.
function loginOrRetry(player: Player, target: Client, context: string): void {
  target.login().catch((err: Error) => {
    discordLog.warn(`${context} failed:`, err.message);
    scheduleReconnect(player);
  });
}

// Schedule activity only for a connected, enabled client. Otherwise log in and
// let 'ready' schedule the update, unless a reconnect timer already owns the attempt.
function scheduleUpdate(player: Player): void {
  if (!getDiscordEnabled() || !client) return;

  if (!client.isConnected) {
    if (!reconnectTimer) {
      discordLog.debug('not connected, attempting login');
      loginOrRetry(player, client, 'login');
    }
    return;
  }

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

// scheduleUpdate() checks the connection before arming the debounce.
// disable() cancels pending work so it cannot send after the toggle turns off.
function sendActivity(player: Player): void {
  if (!client) return;

  if (!trackName) {
    discordLog.debug('no track metadata, clearing activity');
    client.user?.clearActivity().catch(() => {});
    return;
  }

  const details = padMin(truncate(trackName, MAX_STRING_LEN), MIN_STRING_LEN);
  const state = padMin(truncate(getDiscordArtistText(artistName), MAX_STRING_LEN), MIN_STRING_LEN);

  const largeImageKey = (artworkUrl && artworkUrl.length <= MAX_IMAGE_URL_LEN)
    ? artworkUrl
    : 'sidra_logo';
  const largeImageText = albumName
    ? truncate(albumName, MAX_STRING_LEN)
    : undefined;

  const buttons: Array<{ label: string; url: string }> = [
    { label: app.getName(), url: 'https://github.com/wimpysworld/sidra' },
  ];
  if (trackUrl) {
    const displayName = getService(getMusicService()).displayName;
    buttons.push({ label: getDiscordPlayOnText(displayName), url: trackUrl });
  }

  const activity: SetActivity = {
    type: ActivityType.Listening,
    statusDisplayType: StatusDisplayType.DETAILS,
    details,
    state,
    largeImageKey,
    largeImageText,
    smallImageKey: 'sidra_logo',
    smallImageText: app.getName(),
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

/** Connects an idle presence client when the tray toggle turns on. */
export function enable(): void {
  const player = playerRef;
  if (!player || !client) return;
  if (!client.isConnected) {
    discordLog.info('enabling Discord presence');
    loginOrRetry(player, client, 'enable login');
  }
}

/** Clears presence and cancels activity and reconnect timers when the tray toggle turns off. */
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

  // Named listeners let will-quit remove the same function references.
  const onNowPlayingItemDidChange = (payload: NowPlayingPayload | null): void => {
    if (!payload) {
      clearTrackMetadata();
    } else {
      trackName = payload.name ?? null;
      artistName = payload.artistName ?? null;
      albumName = payload.albumName ?? null;
      artworkUrl = payload.artworkUrl;
      durationMs = payload.durationInMillis ?? 0;
      // getShareUrl() rebuilds the link from the catalogue id when payload.url
      // is absent, which it always is on a library item.
      trackUrl = getShareUrl(payload);
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

    // Quitting removes presence. Destroy immediately without waiting for a clearActivity() RPC.
    if (client) {
      retireClient(client, false);
      client = undefined;
    }

    player.removeListener('nowPlayingItemDidChange', onNowPlayingItemDidChange);
    player.removeListener('playbackStateDidChange', onPlaybackStateDidChange);

    clearTrackMetadata();
    previousState = 0;
    retryCount = 0;
  });
}
