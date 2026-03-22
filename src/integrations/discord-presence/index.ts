import log from 'electron-log/main';
import { Client } from '@xhayper/discord-rpc';
import { ActivityType } from 'discord-api-types/v10';
import { Player } from '../../player';
import { getDiscordEnabled } from '../../config';

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

// Playback state
let isPlaying = false;
let currentPositionUs = 0;

// Timers
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pauseTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let retryCount = 0;

let client: Client;

function scheduleUpdate(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
  }
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    sendActivity();
  }, DEBOUNCE_MS);
}

function sendActivity(): void {
  if (!getDiscordEnabled()) {
    discordLog.debug('discord disabled, clearing activity');
    client.user?.clearActivity().catch(() => {});
    return;
  }

  if (!client.isConnected) {
    discordLog.debug('not connected, skipping activity update');
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
    buttons.push({ label: 'Play on Apple Music', url: trackUrl });
  }

  const activity: Record<string, unknown> = {
    type: ActivityType.Listening,
    details,
    state,
    largeImageKey,
    largeImageText,
    smallImageKey: 'sidra_logo',
    smallImageText: 'Sidra',
    buttons,
  };

  if (isPlaying && durationMs > 0) {
    const currentPositionMs = currentPositionUs / 1000;
    const now = Date.now();
    activity.startTimestamp = new Date(now - currentPositionMs);
    activity.endTimestamp = new Date(now - currentPositionMs + durationMs);
  }

  client.user?.setActivity(activity as Parameters<typeof client.user.setActivity>[0]).then(() => {
    discordLog.debug('activity updated:', trackName);
  }).catch((err: Error) => {
    discordLog.warn('failed to set activity:', err.message);
  });
}

function scheduleReconnect(): void {
  if (reconnectTimer) return;

  const delay = Math.min(RECONNECT_BASE_MS * 2 ** retryCount, RECONNECT_CAP_MS);
  retryCount++;
  discordLog.info(`scheduling reconnect in ${delay}ms (attempt ${retryCount})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    discordLog.info('attempting reconnect');
    client.login().catch((err: Error) => {
      discordLog.warn('reconnect failed:', err.message);
      scheduleReconnect();
    });
  }, delay);
}

export function init(player: Player): void {
  discordLog.info('discord presence module initialised');

  client = new Client({ clientId: CLIENT_ID });

  client.on('ready', () => {
    discordLog.info('connected to Discord');
    retryCount = 0;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    scheduleUpdate();
  });

  client.on('disconnected', () => {
    discordLog.info('disconnected from Discord');
    scheduleReconnect();
  });

  client.login().catch((err: Error) => {
    discordLog.warn('initial login failed:', err.message);
    scheduleReconnect();
  });

  player.on('nowPlayingItemDidChange', (payload: unknown) => {
    const p = payload as {
      name?: string;
      artistName?: string;
      albumName?: string;
      artworkUrl?: string;
      durationInMillis?: number;
      url?: string;
    } | null;

    if (!p) {
      trackName = null;
      artistName = null;
      albumName = null;
      artworkUrl = undefined;
      durationMs = 0;
      trackUrl = undefined;
    } else {
      trackName = p.name ?? null;
      artistName = p.artistName ?? null;
      albumName = p.albumName ?? null;
      artworkUrl = p.artworkUrl;
      durationMs = p.durationInMillis ?? 0;
      trackUrl = p.url;
    }

    // Cancel pause timer on new track
    if (pauseTimer) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }

    scheduleUpdate();
  });

  player.on('playbackStateDidChange', (payload: unknown) => {
    const p = payload as { state: number } | null;
    const wasPlaying = isPlaying;
    // MusicKit PlaybackStates: 2 = playing
    isPlaying = p?.state === 2;

    if (isPlaying && pauseTimer) {
      clearTimeout(pauseTimer);
      pauseTimer = null;
    }

    if (!isPlaying && wasPlaying) {
      // Start pause timeout
      pauseTimer = setTimeout(() => {
        pauseTimer = null;
        discordLog.debug('pause timeout reached, clearing activity');
        client.user?.clearActivity().catch(() => {});
      }, PAUSE_TIMEOUT_MS);
    }

    scheduleUpdate();
  });

  player.on('playbackTimeDidChange', (payload: unknown) => {
    // Payload is microseconds (number)
    if (typeof payload === 'number') {
      currentPositionUs = payload;
    }
    // Do not call scheduleUpdate() here: playbackTimeDidChange fires
    // continuously and would perpetually reset the debounce timer,
    // preventing sendActivity() from ever executing.
  });
}
