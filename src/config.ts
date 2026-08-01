/**
 * Typed wrapper around electron-conf and the single place persistent state is
 * read or written; nothing else touches the store directly. Each key gets a
 * getter/setter pair, and the schema carries no defaults: a default lives in
 * the getter that needs one, so keys such as storefront can still report
 * "never set" and drive the fallback chain in src/storefront.ts.
 */
import { Conf } from 'electron-conf/main';
import log from 'electron-log/main';
import type { ThemeName } from './theme';
import {
  DEFAULT_SERVICE_ID,
  isMusicServiceId,
  type AnyStartPageId,
  type ClassicalStartPageId,
  type MusicServiceId,
  type MusicStartPageId,
} from './musicService';

const configLog = log.scope('config');

export interface PendingScrobble {
  artist: string;
  track: string;
  timestamp: number;
  album?: string;
  durationSec?: number;
}

interface StoreSchema {
  storefront: string;
  language: string | null;
  'notifications.enabled': boolean;
  'discord.enabled': boolean;
  'closeToTray.enabled': boolean;
  'lastfm.enabled': boolean;
  'lastfm.sessionKey': string | null;
  'lastfm.username': string | null;
  'lastfm.pendingScrobbles': PendingScrobble[];
  theme: ThemeName;
  'autoUpdate.enabled': boolean;
  startPage: MusicStartPageId | 'last';
  lastPageUrl: string;
  'classical.startPage': ClassicalStartPageId | 'last';
  'classical.lastPageUrl': string;
  zoomFactor: number;
  musicService: MusicServiceId;
}

const store = new Conf<StoreSchema>();

/** Reads a key, or the caller's default when the user has never set it. */
function getConfigValue<K extends keyof StoreSchema>(key: K, defaultValue: StoreSchema[K]): StoreSchema[K] {
  if (!store.has(key)) return defaultValue;
  return store.get(key);
}

/**
 * Reads a key and returns undefined when it has never been set, for the keys
 * where absence means something: an unset storefront defers to the system
 * locale, while a stored null is the user's own choice.
 */
function getConfigValueOptional<K extends keyof StoreSchema>(key: K): StoreSchema[K] | undefined {
  if (!store.has(key)) return undefined;
  return store.get(key);
}

/**
 * Writes a key and logs it. The message is derived from the typed key, so a
 * rename cannot leave a stale key name in the log text.
 */
function setConfigValue<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void {
  store.set(key, value);
  configLog.info(`${key} set:`, value);
}

export function getStorefront(): string | undefined {
  return getConfigValueOptional('storefront');
}

export function setStorefront(code: string): void {
  setConfigValue('storefront', code);
}

export function getLanguage(): string | null | undefined {
  return getConfigValueOptional('language');
}

export function setLanguage(lang: string | null): void {
  setConfigValue('language', lang);
}

export function getNotificationsEnabled(): boolean {
  return getConfigValue('notifications.enabled', true);
}

export function setNotificationsEnabled(enabled: boolean): void {
  setConfigValue('notifications.enabled', enabled);
}

export function getCloseToTrayEnabled(): boolean {
  return getConfigValue('closeToTray.enabled', false);
}

export function setCloseToTrayEnabled(enabled: boolean): void {
  setConfigValue('closeToTray.enabled', enabled);
}

export function getDiscordEnabled(): boolean {
  return getConfigValue('discord.enabled', false);
}

export function setDiscordEnabled(enabled: boolean): void {
  setConfigValue('discord.enabled', enabled);
}

export function getLastfmEnabled(): boolean {
  return getConfigValue('lastfm.enabled', false);
}

export function setLastfmEnabled(enabled: boolean): void {
  setConfigValue('lastfm.enabled', enabled);
}

export function getLastfmSessionKey(): string | null | undefined {
  return getConfigValueOptional('lastfm.sessionKey');
}

export function getLastfmUsername(): string | null | undefined {
  return getConfigValueOptional('lastfm.username');
}

export function setLastfmSession(sessionKey: string, username: string): void {
  store.set('lastfm.sessionKey', sessionKey);
  store.set('lastfm.username', username);
  configLog.info('lastfm session set for user:', username);
}

export function clearLastfmSession(): void {
  store.set('lastfm.sessionKey', null);
  store.set('lastfm.username', null);
  configLog.info('lastfm session cleared');
}

/**
 * The store is hand-editable JSON on disk, so every field is checked, optional
 * ones included: `flushPendingScrobbles()` stringifies whatever survives into
 * one batch, and Last.fm refuses the batch whole, so a single malformed entry
 * costs every queued play. The ranges match what the integration produces - a
 * Unix second and a rounded track length, both positive integers. A second later
 * than now is refused because Last.fm ignores such a scrobble without an API
 * error, so the flush reads success and drops the batch with the valid plays in it.
 */
function isPendingScrobble(value: unknown): value is PendingScrobble {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<PendingScrobble>;
  return typeof entry.artist === 'string' && entry.artist.length > 0
    && typeof entry.track === 'string' && entry.track.length > 0
    && typeof entry.timestamp === 'number'
    && Number.isInteger(entry.timestamp) && entry.timestamp > 0
    && entry.timestamp <= Math.floor(Date.now() / 1000)
    && (entry.album === undefined || typeof entry.album === 'string')
    && (entry.durationSec === undefined
      || (typeof entry.durationSec === 'number'
        && Number.isInteger(entry.durationSec) && entry.durationSec > 0));
}

export function getPendingScrobbles(): PendingScrobble[] {
  const stored: unknown = getConfigValue('lastfm.pendingScrobbles', []);
  if (!Array.isArray(stored)) {
    configLog.warn('lastfm.pendingScrobbles is not an array - discarding');
    return [];
  }
  const entries = stored.filter(isPendingScrobble);
  if (entries.length !== stored.length) {
    // Never log the dropped entries: track titles are the user's listening history.
    configLog.warn('lastfm.pendingScrobbles dropped malformed entries:', stored.length - entries.length);
  }
  return entries;
}

export function setPendingScrobbles(entries: PendingScrobble[]): void {
  store.set('lastfm.pendingScrobbles', entries);
  configLog.info('lastfm.pendingScrobbles set, queued:', entries.length);
}

export function getTheme(): ThemeName {
  return getConfigValue('theme', 'apple-music');
}

export function setTheme(name: ThemeName): void {
  setConfigValue('theme', name);
}

export function getAutoUpdateEnabled(): boolean {
  return getConfigValue('autoUpdate.enabled', true);
}

export function setAutoUpdateEnabled(enabled: boolean): void {
  setConfigValue('autoUpdate.enabled', enabled);
}

export function getLastPageUrl(): string | undefined {
  return getConfigValueOptional('lastPageUrl');
}

export function setLastPageUrl(url: string): void {
  setConfigValue('lastPageUrl', url);
}

export function getStartPage(): MusicStartPageId | 'last' {
  return getConfigValue('startPage', 'new');
}

export function setStartPage(page: MusicStartPageId | 'last'): void {
  setConfigValue('startPage', page);
}

export function getZoomFactor(): number {
  return getConfigValue('zoomFactor', 1.0);
}

export function setZoomFactor(factor: number): void {
  setConfigValue('zoomFactor', factor);
}

export function getMusicService(): MusicServiceId {
  const id = getConfigValue('musicService', DEFAULT_SERVICE_ID);
  if (!isMusicServiceId(id)) {
    configLog.warn('musicService not registered:', id, '- falling back to:', DEFAULT_SERVICE_ID);
    return DEFAULT_SERVICE_ID;
  }
  return id;
}

export function setMusicService(id: MusicServiceId): void {
  setConfigValue('musicService', id);
}

export function getClassicalStartPage(): ClassicalStartPageId | 'last' {
  return getConfigValue('classical.startPage', 'home');
}

export function setClassicalStartPage(page: ClassicalStartPageId | 'last'): void {
  setConfigValue('classical.startPage', page);
}

export function getClassicalLastPageUrl(): string | undefined {
  return getConfigValueOptional('classical.lastPageUrl');
}

export function setClassicalLastPageUrl(url: string): void {
  setConfigValue('classical.lastPageUrl', url);
}

/**
 * Service-keyed views of the pairs above, so a caller holding a MusicServiceId
 * reads and writes without branching on it. This table is the only place a
 * service id maps to its stored keys, and the Record annotation makes a new
 * service a compile error here rather than a missed branch at a call site.
 */
const SERVICE_PAGE_ACCESSORS: Record<MusicServiceId, {
  getStartPage: () => AnyStartPageId | 'last';
  getLastPageUrl: () => string | undefined;
  setLastPageUrl: (url: string) => void;
}> = {
  music: {
    getStartPage,
    getLastPageUrl,
    setLastPageUrl,
  },
  classical: {
    getStartPage: getClassicalStartPage,
    getLastPageUrl: getClassicalLastPageUrl,
    setLastPageUrl: setClassicalLastPageUrl,
  },
};

/**
 * Stored start page for a service. The union covers both services, because the
 * caller's id is a variable: a caller that knows which service it means takes
 * the narrower pair above. Reading wide is safe - the id is matched against the
 * service's own startPages, and one from the wrong service matches nothing and
 * falls back to that service's default.
 */
export function getStartPageFor(id: MusicServiceId): AnyStartPageId | 'last' {
  return SERVICE_PAGE_ACCESSORS[id].getStartPage();
}

export function getLastPageUrlFor(id: MusicServiceId): string | undefined {
  return SERVICE_PAGE_ACCESSORS[id].getLastPageUrl();
}

export function setLastPageUrlFor(id: MusicServiceId, url: string): void {
  SERVICE_PAGE_ACCESSORS[id].setLastPageUrl(url);
}

