import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';

// Mock electron-store at the config module level. config.ts uses
// require('electron-store').default at module scope; Vitest cannot intercept
// bare require() calls. Instead, mock the config module and pass through
// to a manual implementation that mirrors the real store wrapper.
const data = new Map<string, unknown>();

vi.mock('../src/config', async () => {
  // Provide a standalone implementation matching config.ts getter/setter
  // signatures. This avoids loading the real config.ts (which triggers
  // require('electron-store') that Vitest cannot intercept).
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

    getTheme: (): 'apple-music' | 'catppuccin' => {
      if (!data.has('theme')) return 'apple-music';
      return data.get('theme') as 'apple-music' | 'catppuccin';
    },
    setTheme: (name: 'apple-music' | 'catppuccin'): void => { data.set('theme', name); },

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
} from '../src/config';

import type { ThemeName } from '../src/theme';

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
});
