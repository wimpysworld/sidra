import log from 'electron-log/main';
import type { ThemeName } from './theme';

const configLog = log.scope('config');

interface StoreSchema {
  storefront: string;
  language: string | null;
  'notifications.enabled': boolean;
  'discord.enabled': boolean;
  theme: ThemeName;
  'autoUpdate.enabled': boolean;
  startPage: 'home' | 'new' | 'radio' | 'all-playlists' | 'last';
  lastPageUrl: string;
  zoomFactor: number;
}

// electron-store v10 is ESM-only; under CommonJS moduleResolution TypeScript
// cannot follow the Conf inheritance chain.  Use require() and type the
// instance manually so the rest of the codebase stays on module:"commonjs".
const Store = require('electron-store').default;

const store: {
  has(key: keyof StoreSchema): boolean;
  get<K extends keyof StoreSchema>(key: K): StoreSchema[K];
  set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void;
} = new Store();

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

export function getDiscordEnabled(): boolean {
  return getConfigValue('discord.enabled', false);
}

export function setDiscordEnabled(enabled: boolean): void {
  store.set('discord.enabled', enabled);
  configLog.info('discord.enabled set:', enabled);
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

export function getStartPage(): 'home' | 'new' | 'radio' | 'all-playlists' | 'last' {
  return getConfigValue('startPage', 'new');
}

export function setStartPage(page: 'home' | 'new' | 'radio' | 'all-playlists' | 'last'): void {
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

