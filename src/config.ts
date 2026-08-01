import log from 'electron-log/main';
import type { ThemeName } from './theme';
import {
  DEFAULT_SERVICE_ID,
  isMusicServiceId,
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

import { Conf } from 'electron-conf/main';

const store = new Conf<StoreSchema>();

function getConfigValue<K extends keyof StoreSchema>(key: K, defaultValue: StoreSchema[K]): StoreSchema[K] {
  if (!store.has(key)) return defaultValue;
  return store.get(key);
}

function getConfigValueOptional<K extends keyof StoreSchema>(key: K): StoreSchema[K] | undefined {
  if (!store.has(key)) return undefined;
  return store.get(key);
}

export function getStorefront(): string | undefined {
  return getConfigValueOptional('storefront');
}

export function setStorefront(code: string): void {
  store.set('storefront', code);
  configLog.info('storefront set:', code);
}

export function getLanguage(): string | null | undefined {
  return getConfigValueOptional('language');
}

export function setLanguage(lang: string | null): void {
  store.set('language', lang);
  configLog.info('language set:', lang);
}

export function getNotificationsEnabled(): boolean {
  return getConfigValue('notifications.enabled', true);
}

export function setNotificationsEnabled(enabled: boolean): void {
  store.set('notifications.enabled', enabled);
  configLog.info('notifications.enabled set:', enabled);
}

export function getCloseToTrayEnabled(): boolean {
  return getConfigValue('closeToTray.enabled', false);
}

export function setCloseToTrayEnabled(enabled: boolean): void {
  store.set('closeToTray.enabled', enabled);
  configLog.info('closeToTray.enabled set:', enabled);
}

export function getDiscordEnabled(): boolean {
  return getConfigValue('discord.enabled', false);
}

export function setDiscordEnabled(enabled: boolean): void {
  store.set('discord.enabled', enabled);
  configLog.info('discord.enabled set:', enabled);
}

export function getLastfmEnabled(): boolean {
  return getConfigValue('lastfm.enabled', false);
}

export function setLastfmEnabled(enabled: boolean): void {
  store.set('lastfm.enabled', enabled);
  configLog.info('lastfm.enabled set:', enabled);
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
  store.set('theme', name);
  configLog.info('theme set:', name);
}

export function getAutoUpdateEnabled(): boolean {
  return getConfigValue('autoUpdate.enabled', true);
}

export function setAutoUpdateEnabled(enabled: boolean): void {
  store.set('autoUpdate.enabled', enabled);
  configLog.info('autoUpdate.enabled set:', enabled);
}

export function getLastPageUrl(): string | undefined {
  return getConfigValueOptional('lastPageUrl');
}

export function setLastPageUrl(url: string): void {
  store.set('lastPageUrl', url);
  configLog.info('lastPageUrl set:', url);
}

export function getStartPage(): MusicStartPageId | 'last' {
  return getConfigValue('startPage', 'new');
}

export function setStartPage(page: MusicStartPageId | 'last'): void {
  store.set('startPage', page);
  configLog.info('startPage set:', page);
}

export function getZoomFactor(): number {
  return getConfigValue('zoomFactor', 1.0);
}

export function setZoomFactor(factor: number): void {
  store.set('zoomFactor', factor);
  configLog.info('zoomFactor set:', factor);
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
  store.set('musicService', id);
  configLog.info('musicService set:', id);
}

export function getClassicalStartPage(): ClassicalStartPageId | 'last' {
  return getConfigValue('classical.startPage', 'home');
}

export function setClassicalStartPage(page: ClassicalStartPageId | 'last'): void {
  store.set('classical.startPage', page);
  configLog.info('classical.startPage set:', page);
}

export function getClassicalLastPageUrl(): string | undefined {
  return getConfigValueOptional('classical.lastPageUrl');
}

export function setClassicalLastPageUrl(url: string): void {
  store.set('classical.lastPageUrl', url);
  configLog.info('classical.lastPageUrl set:', url);
}

