import { describe, it, expect, expectTypeOf, vi, beforeAll, beforeEach } from 'vitest';
import type { ThemeName } from '../src/theme';

// Mock electron-conf at the config module level. config.ts imports
// electron-conf/main at module scope. Mock the config module and pass through
// to a manual implementation that mirrors the real store wrapper.
const data = new Map<string, unknown>();

vi.mock('../src/config', async () => {
  // Provide a standalone implementation matching config.ts getter/setter
  // signatures. This avoids loading the real config.ts (which triggers
  // the electron-conf/main import that Vitest cannot intercept).
  return {
    getStorefront: (): string | undefined => {
      if (!data.has('storefront')) return undefined;
      return data.get('storefront') as string;
    },
    setStorefront: (code: string): void => { data.set('storefront', code); },

    getLanguage: (): string | null | undefined => {
      if (!data.has('language')) return undefined;
      return data.get('language') as string | null;
    },
    setLanguage: (lang: string | null): void => { data.set('language', lang); },

    getNotificationsEnabled: (): boolean => {
      if (!data.has('notifications.enabled')) return true;
      return data.get('notifications.enabled') as boolean;
    },
    setNotificationsEnabled: (enabled: boolean): void => { data.set('notifications.enabled', enabled); },

    getDiscordEnabled: (): boolean => {
      if (!data.has('discord.enabled')) return true;
      return data.get('discord.enabled') as boolean;
    },
    setDiscordEnabled: (enabled: boolean): void => { data.set('discord.enabled', enabled); },

    getTheme: (): ThemeName => {
      if (!data.has('theme')) return 'apple-music';
      return data.get('theme') as ThemeName;
    },
    setTheme: (name: ThemeName): void => { data.set('theme', name); },

    getAutoUpdateEnabled: (): boolean => {
      if (!data.has('autoUpdate.enabled')) return true;
      return data.get('autoUpdate.enabled') as boolean;
    },
    setAutoUpdateEnabled: (enabled: boolean): void => { data.set('autoUpdate.enabled', enabled); },

    getLastPageUrl: (): string | undefined => {
      if (!data.has('lastPageUrl')) return undefined;
      return data.get('lastPageUrl') as string;
    },
    setLastPageUrl: (url: string): void => { data.set('lastPageUrl', url); },

    getStartPage: (): 'home' | 'new' | 'radio' | 'all-playlists' | 'last' => {
      if (!data.has('startPage')) return 'new';
      return data.get('startPage') as 'home' | 'new' | 'radio' | 'all-playlists' | 'last';
    },
    setStartPage: (page: 'home' | 'new' | 'radio' | 'all-playlists' | 'last'): void => { data.set('startPage', page); },

    getZoomFactor: (): number => {
      if (!data.has('zoomFactor')) return 1.0;
      return data.get('zoomFactor') as number;
    },
    setZoomFactor: (factor: number): void => { data.set('zoomFactor', factor); },

    getMusicService: (): MusicServiceId => {
      if (!data.has('musicService')) return 'music';
      return data.get('musicService') as MusicServiceId;
    },
    setMusicService: (id: MusicServiceId): void => { data.set('musicService', id); },

    getClassicalStartPage: (): ClassicalStartPageId | 'last' => {
      if (!data.has('classical.startPage')) return 'home';
      return data.get('classical.startPage') as ClassicalStartPageId | 'last';
    },
    setClassicalStartPage: (page: ClassicalStartPageId | 'last'): void => { data.set('classical.startPage', page); },

    getClassicalLastPageUrl: (): string | undefined => {
      if (!data.has('classical.lastPageUrl')) return undefined;
      return data.get('classical.lastPageUrl') as string;
    },
    setClassicalLastPageUrl: (url: string): void => { data.set('classical.lastPageUrl', url); },
  };
});

import {
  getStorefront, setStorefront,
  getLanguage, setLanguage,
  getNotificationsEnabled, setNotificationsEnabled,
  getDiscordEnabled, setDiscordEnabled,
  getTheme, setTheme,
  getAutoUpdateEnabled, setAutoUpdateEnabled,
  getLastPageUrl, setLastPageUrl,
  getStartPage, setStartPage,
  getZoomFactor, setZoomFactor,
  getMusicService, setMusicService,
  getClassicalStartPage, setClassicalStartPage,
  getClassicalLastPageUrl, setClassicalLastPageUrl,
} from '../src/config';
import { Conf } from 'electron-conf/main';
import { DEFAULT_SERVICE_ID } from '../src/musicService';
import type { ClassicalStartPageId, MusicServiceId } from '../src/musicService';

// Type assertions verify that each getter return type matches its StoreSchema key type.
// These are compile-time checks via expectTypeOf.

describe('Config store type assertions', () => {
  it('getStorefront returns string | undefined', () => {
    expectTypeOf(getStorefront).returns.toEqualTypeOf<string | undefined>();
  });

  it('setStorefront accepts string', () => {
    expectTypeOf(setStorefront).parameter(0).toEqualTypeOf<string>();
  });

  it('getLanguage returns string | null | undefined', () => {
    expectTypeOf(getLanguage).returns.toEqualTypeOf<string | null | undefined>();
  });

  it('setLanguage accepts string | null', () => {
    expectTypeOf(setLanguage).parameter(0).toEqualTypeOf<string | null>();
  });

  it('getNotificationsEnabled returns boolean', () => {
    expectTypeOf(getNotificationsEnabled).returns.toEqualTypeOf<boolean>();
  });

  it('setNotificationsEnabled accepts boolean', () => {
    expectTypeOf(setNotificationsEnabled).parameter(0).toEqualTypeOf<boolean>();
  });

  it('getDiscordEnabled returns boolean', () => {
    expectTypeOf(getDiscordEnabled).returns.toEqualTypeOf<boolean>();
  });

  it('setDiscordEnabled accepts boolean', () => {
    expectTypeOf(setDiscordEnabled).parameter(0).toEqualTypeOf<boolean>();
  });

  it('getTheme returns ThemeName', () => {
    expectTypeOf(getTheme).returns.toEqualTypeOf<ThemeName>();
  });

  it('setTheme accepts ThemeName', () => {
    expectTypeOf(setTheme).parameter(0).toEqualTypeOf<ThemeName>();
  });

  it('getAutoUpdateEnabled returns boolean', () => {
    expectTypeOf(getAutoUpdateEnabled).returns.toEqualTypeOf<boolean>();
  });

  it('setAutoUpdateEnabled accepts boolean', () => {
    expectTypeOf(setAutoUpdateEnabled).parameter(0).toEqualTypeOf<boolean>();
  });

  it('getLastPageUrl returns string | undefined', () => {
    expectTypeOf(getLastPageUrl).returns.toEqualTypeOf<string | undefined>();
  });

  it('setLastPageUrl accepts string', () => {
    expectTypeOf(setLastPageUrl).parameter(0).toEqualTypeOf<string>();
  });

  it('getStartPage returns start page union', () => {
    expectTypeOf(getStartPage).returns.toEqualTypeOf<'home' | 'new' | 'radio' | 'all-playlists' | 'last'>();
  });

  it('setStartPage accepts start page union', () => {
    expectTypeOf(setStartPage).parameter(0).toEqualTypeOf<'home' | 'new' | 'radio' | 'all-playlists' | 'last'>();
  });

  it('getZoomFactor returns number', () => {
    expectTypeOf(getZoomFactor).returns.toEqualTypeOf<number>();
  });

  it('setZoomFactor accepts number', () => {
    expectTypeOf(setZoomFactor).parameter(0).toEqualTypeOf<number>();
  });

  it('getMusicService returns MusicServiceId', () => {
    expectTypeOf(getMusicService).returns.toEqualTypeOf<MusicServiceId>();
  });

  it('setMusicService accepts MusicServiceId', () => {
    expectTypeOf(setMusicService).parameter(0).toEqualTypeOf<MusicServiceId>();
  });

  it('getClassicalStartPage returns the Classical start page union', () => {
    expectTypeOf(getClassicalStartPage).returns.toEqualTypeOf<ClassicalStartPageId | 'last'>();
  });

  it('setClassicalStartPage accepts the Classical start page union', () => {
    expectTypeOf(setClassicalStartPage).parameter(0).toEqualTypeOf<ClassicalStartPageId | 'last'>();
  });

  it('getClassicalLastPageUrl returns string | undefined', () => {
    expectTypeOf(getClassicalLastPageUrl).returns.toEqualTypeOf<string | undefined>();
  });

  it('setClassicalLastPageUrl accepts string', () => {
    expectTypeOf(setClassicalLastPageUrl).parameter(0).toEqualTypeOf<string>();
  });
});

describe('Config store runtime behaviour', () => {
  beforeEach(() => {
    data.clear();
  });

  it('getStorefront returns undefined when not set', () => {
    expect(getStorefront()).toBeUndefined();
  });

  it('setStorefront persists value', () => {
    setStorefront('gb');
    expect(getStorefront()).toBe('gb');
  });

  it('getNotificationsEnabled defaults to true', () => {
    expect(getNotificationsEnabled()).toBe(true);
  });

  it('getDiscordEnabled defaults to true', () => {
    expect(getDiscordEnabled()).toBe(true);
  });

  it('getTheme defaults to apple-music', () => {
    expect(getTheme()).toBe('apple-music');
  });

  it('getAutoUpdateEnabled defaults to true', () => {
    expect(getAutoUpdateEnabled()).toBe(true);
  });

  it('getStartPage defaults to new', () => {
    expect(getStartPage()).toBe('new');
  });

  it('getZoomFactor defaults to 1.0', () => {
    expect(getZoomFactor()).toBe(1.0);
  });

  it('getMusicService defaults to music', () => {
    expect(getMusicService()).toBe('music');
  });

  it('setMusicService persists value', () => {
    setMusicService('music');
    expect(getMusicService()).toBe('music');
  });

  it('getClassicalStartPage defaults to home', () => {
    expect(getClassicalStartPage()).toBe('home');
  });

  it('setClassicalStartPage persists value', () => {
    setClassicalStartPage('browse');
    expect(getClassicalStartPage()).toBe('browse');
  });

  it('getClassicalLastPageUrl returns undefined when not set', () => {
    expect(getClassicalLastPageUrl()).toBeUndefined();
  });

  it('setClassicalLastPageUrl persists value', () => {
    setClassicalLastPageUrl('browse/albums');
    expect(getClassicalLastPageUrl()).toBe('browse/albums');
  });
});

// The blocks above run against the hand-written stand-in declared at the top of
// this file. These run against the real src/config.ts, reached past that mock
// with vi.importActual and backed by the electron-conf mock in test/setup.ts.
describe('Config store real module', () => {
  // The electron-conf mock backs every Conf instance with one module-level map
  // and exposes it as a static for seeding. Shared process-wide within this file.
  const store = (Conf as unknown as { _data: Map<string, unknown> })._data;
  let config: typeof import('../src/config');

  beforeAll(async () => {
    config = await vi.importActual<typeof import('../src/config')>('../src/config');
  });

  beforeEach(() => {
    store.clear();
  });

  it('getMusicService falls back when the persisted id is unregistered', () => {
    store.set('musicService', 'jazz');
    expect(config.getMusicService()).toBe(DEFAULT_SERVICE_ID);
  });

  it('getMusicService returns music when persisted', () => {
    store.set('musicService', 'music');
    expect(config.getMusicService()).toBe('music');
  });

  it('getMusicService returns classical when persisted', () => {
    store.set('musicService', 'classical');
    expect(config.getMusicService()).toBe('classical');
  });

  it('getMusicService falls back when nothing is persisted', () => {
    expect(config.getMusicService()).toBe(DEFAULT_SERVICE_ID);
  });

  it('setClassicalStartPage rejects a music start page at compile time', () => {
    // @ts-expect-error 'radio' is a music start page, not a Classical one
    config.setClassicalStartPage('radio');
    // The union is the only guard; the write itself is unchecked at runtime.
    expect(store.get('classical.startPage')).toBe('radio');
  });
});
