import log from 'electron-log/main';

const configLog = log.scope('config');

interface StoreSchema {
  storefront: string;
  language: string | null;
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
