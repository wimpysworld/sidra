import fs from 'fs';
import { Conf } from 'electron-conf/main';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as config from '../src/config';
import { getSettingsState } from '../src/settings';
import { customThemePath, getThemeCss, invalidateCustomThemeCache, resolveTheme } from '../src/theme';
import { customThemeFixture } from './mocks/customTheme';

vi.mock('../src/integrations/discord-presence', () => ({ enable: vi.fn(), disable: vi.fn() }));
vi.mock('../src/integrations/lastfm', () => ({ isConfigured: () => false }));

beforeEach(() => {
  (Conf as unknown as { _data: Map<string, unknown> })._data.clear();
  invalidateCustomThemeCache();
});
afterEach(() => vi.restoreAllMocks());

describe('Custom Theme in Settings', () => {
  it.each(['music', 'classical'] as const)('uses the same valid JSON palette and one option for %s', service => {
    const fixture = customThemeFixture();
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValue(fixture.json);
    config.setMusicService(service);
    config.setTheme('custom');
    const state = getSettingsState();
    expect(state.theme).toBe('custom');
    expect(state.options.theme.filter(option => option.value === 'custom')).toEqual([{ value: 'custom', label: 'Custom Theme' }]);
    expect(getThemeCss(resolveTheme())).toBe(fixture.css);
    expect(read).toHaveBeenCalledWith(customThemePath(), 'utf-8');
  });

  it('removes an invalid option without changing the stored selection and restores it after repair', () => {
    const read = vi.spyOn(fs, 'readFileSync').mockReturnValue('body { color:red; }');
    config.setTheme('custom');
    expect(getSettingsState().theme).toBe('apple-music');
    expect(getSettingsState().options.theme.some(option => option.value === 'custom')).toBe(false);
    expect(config.getTheme()).toBe('custom');
    read.mockReturnValue(customThemeFixture().json);
    invalidateCustomThemeCache();
    expect(getSettingsState().theme).toBe('custom');
    expect(getSettingsState().options.theme.filter(option => option.value === 'custom')).toHaveLength(1);
    config.setTheme('nord');
    expect(getSettingsState().theme).toBe('nord');
  });
});
