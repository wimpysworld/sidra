import log from 'electron-log/main';

const configLog = log.scope('config');

interface StoreSchema {
  storefront: string;
  language: string | null;
  'notifications.enabled': boolean;
  'discord.enabled': boolean;
  'catppuccin.enabled': boolean;
  'autoUpdate.enabled': boolean;
  startPage: 'home' | 'new' | 'radio' | 'all-playlists' | 'last';
  lastPageUrl: string;
  zoomFactor: number;
}

// electron-store v10 is ESM-only; under CommonJS moduleResolution TypeScript
// cannot follow the Conf inheritance chain.  Use require() and type the
// instance manually so the rest of the codebase stays on module:"commonjs".
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Store = require('electron-store').default;

const store: {
  has(key: keyof StoreSchema): boolean;
  get<K extends keyof StoreSchema>(key: K): StoreSchema[K];
  set<K extends keyof StoreSchema>(key: K, value: StoreSchema[K]): void;
} = new Store();

export function getStorefront(): string | undefined {
  if (!store.has('storefront')) {
    return undefined;
  }
  return store.get('storefront');
}

export function setStorefront(code: string): void {
  store.set('storefront', code);
  configLog.info('storefront set:', code);
}

export function getLanguage(): string | null | undefined {
  if (!store.has('language')) {
    return undefined;
  }
  return store.get('language');
}

export function setLanguage(lang: string | null): void {
  store.set('language', lang);
  configLog.info('language set:', lang);
}

export function getNotificationsEnabled(): boolean {
  if (!store.has('notifications.enabled')) {
    return true;  // default on
  }
  return store.get('notifications.enabled');
}

export function setNotificationsEnabled(enabled: boolean): void {
  store.set('notifications.enabled', enabled);
  configLog.info('notifications.enabled set:', enabled);
}

export function getDiscordEnabled(): boolean {
  if (!store.has('discord.enabled')) {
    return true;  // default on
  }
  return store.get('discord.enabled');
}

export function setDiscordEnabled(enabled: boolean): void {
  store.set('discord.enabled', enabled);
  configLog.info('discord.enabled set:', enabled);
}

export function getCatppuccinEnabled(): boolean {
  if (!store.has('catppuccin.enabled')) {
    return false;  // default off
  }
  return store.get('catppuccin.enabled');
}

export function setCatppuccinEnabled(enabled: boolean): void {
  store.set('catppuccin.enabled', enabled);
  configLog.info('catppuccin.enabled set:', enabled);
}

export function getAutoUpdateEnabled(): boolean {
  if (!store.has('autoUpdate.enabled')) {
    return true;  // default on
  }
  return store.get('autoUpdate.enabled');
}

export function setAutoUpdateEnabled(enabled: boolean): void {
  store.set('autoUpdate.enabled', enabled);
  configLog.info('autoUpdate.enabled set:', enabled);
}

export function getLastPageUrl(): string | undefined {
  if (!store.has('lastPageUrl')) {
    return undefined;
  }
  return store.get('lastPageUrl');
}

export function setLastPageUrl(url: string): void {
  store.set('lastPageUrl', url);
  configLog.info('lastPageUrl set:', url);
}

export function getStartPage(): 'home' | 'new' | 'radio' | 'all-playlists' | 'last' {
  if (!store.has('startPage')) {
    return 'new';
  }
  return store.get('startPage');
}

export function setStartPage(page: 'home' | 'new' | 'radio' | 'all-playlists' | 'last'): void {
  store.set('startPage', page);
  configLog.info('startPage set:', page);
}

export function getZoomFactor(): number {
  if (!store.has('zoomFactor')) {
    return 1.0;  // default 100%
  }
  return store.get('zoomFactor');
}

export function setZoomFactor(factor: number): void {
  store.set('zoomFactor', factor);
  configLog.info('zoomFactor set:', factor);
}

