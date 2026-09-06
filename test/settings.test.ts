import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Conf } from 'electron-conf/main';
import type { BrowserWindow } from 'electron';
import * as config from '../src/config';
import { applySettingsAction, getSettingsState, initSettingsActions, notifySettingsChanged, subscribeSettingsChanges } from '../src/settings';
import { applyTheme, hasCustomTheme } from '../src/theme';
import * as lastfm from '../src/integrations/lastfm';
import { enable as enableDiscord } from '../src/integrations/discord-presence';

vi.mock('../src/theme', () => ({
  applyTheme: vi.fn(), hasCustomTheme: vi.fn(() => false),
  resolveTheme: () => config.getTheme(),
}));
vi.mock('../src/integrations/discord-presence', () => ({ enable: vi.fn(), disable: vi.fn() }));
vi.mock('../src/integrations/lastfm', () => ({
  isConfigured: vi.fn(() => true), enable: vi.fn(), disable: vi.fn(), startAuth: vi.fn(), disconnect: vi.fn(),
  setStateChangedCallback: vi.fn(),
}));

const applyZoom = vi.fn();
const refreshTray = vi.fn();
const switchService = vi.fn((id: 'music' | 'classical') => config.setMusicService(id));
const window = { isVisible: () => false, show: vi.fn(), focus: vi.fn() };
let dispose: () => void;

beforeEach(() => {
  (Conf as unknown as { _data: Map<string, unknown> })._data.clear();
  vi.clearAllMocks();
  vi.mocked(hasCustomTheme).mockReturnValue(false);
  vi.mocked(lastfm.isConfigured).mockReturnValue(true);
  dispose = initSettingsActions({ getMainWindow: () => window as unknown as BrowserWindow, applyZoom, switchService, refreshTray });
});
afterEach(() => dispose());

describe('settings actions', () => {
  it('reads defaults and excludes account credentials from state', () => {
    config.setLastfmSession('private-session', 'listener');
    const state = getSettingsState();
    expect(state).toMatchObject({ musicService: 'music', startPage: 'new', theme: 'apple-music', zoomFactor: 1 });
    expect(state.lastfm).toEqual({ available: true, connected: true, enabled: false, username: 'listener' });
    expect(JSON.stringify(state)).not.toContain('private-session');
  });

  it('persists before runtime effects and publishes the new state', () => {
    vi.mocked(enableDiscord).mockImplementationOnce(() => expect(config.getDiscordEnabled()).toBe(true));
    applyZoom.mockImplementationOnce(() => expect(config.getZoomFactor()).toBe(1.5));
    vi.mocked(applyTheme).mockImplementationOnce(() => expect(config.getTheme()).toBe('nord'));
    const listener = vi.fn();
    const unsubscribe = subscribeSettingsChanges(listener);
    applySettingsAction({ type: 'discord', value: true });
    applySettingsAction({ type: 'zoomFactor', value: 1.5 });
    applySettingsAction({ type: 'theme', value: 'nord' });
    applySettingsAction({ type: 'notifications', value: false });
    expect(listener).toHaveBeenLastCalledWith(expect.objectContaining({ discord: true, zoomFactor: 1.5, theme: 'nord', notifications: false }));
    unsubscribe();
    notifySettingsChanged();
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it('shows a hidden player when close to tray is disabled', () => {
    config.setCloseToTrayEnabled(true);
    applySettingsAction({ type: 'closeToTray', value: false });
    expect(config.getCloseToTrayEnabled()).toBe(false);
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it('switches once and preserves independent start pages', () => {
    applySettingsAction({ type: 'startPage', serviceId: 'music', value: 'radio' });
    applySettingsAction({ type: 'musicService', value: 'classical' });
    applySettingsAction({ type: 'musicService', value: 'classical' });
    expect(switchService).toHaveBeenCalledOnce();
    expect(getSettingsState().startPage).toBe('home');
    applySettingsAction({ type: 'startPage', serviceId: 'classical', value: 'search' });
    expect(config.getStartPage()).toBe('radio');
    expect(config.getClassicalStartPage()).toBe('search');
    expect(() => applySettingsAction({ type: 'startPage', serviceId: 'music', value: 'home' })).toThrow();
  });

  it.each([
    null, [], {}, { type: 'arbitrary' }, { type: 'notifications', value: 1 },
    { type: 'zoomFactor', value: 1.1 }, { type: 'zoomFactor', value: NaN },
    { type: 'musicService', value: 'other' }, { type: 'theme', value: 'custom' },
    { type: 'theme', value: 'other' }, { type: 'startPage', serviceId: 'music', value: 'search' },
    { type: 'notifications', value: true, extra: true }, { type: 'lastfmDisconnect' },
    { type: 'lastfmEnabled', value: true },
  ])('rejects unavailable or malformed actions: %j', action => {
    expect(() => applySettingsAction(action)).toThrow('Invalid settings action');
    expect(refreshTray).not.toHaveBeenCalled();
    expect(config.getTheme()).toBe('apple-music');
  });

  it('translates the Custom Theme option without changing its stored value', async () => {
    vi.resetModules();
    const { app } = await import('electron');
    const language = vi.spyOn(app, 'getPreferredSystemLanguages').mockReturnValue(['fr']);
    const theme = await import('../src/theme');
    vi.mocked(theme.hasCustomTheme).mockReturnValue(true);
    try {
      const { getSettingsState: freshState } = await import('../src/settings');
      expect(freshState().options.theme).toContainEqual({ value: 'custom', label: 'Thème personnalisé' });
    } finally {
      language.mockRestore();
      vi.resetModules();
    }
  });

  it('accepts Custom Theme only while it is available', () => {
    vi.mocked(hasCustomTheme).mockReturnValue(true);
    applySettingsAction({ type: 'theme', value: 'custom' });
    expect(config.getTheme()).toBe('custom');
    vi.mocked(hasCustomTheme).mockReturnValue(false);
    expect(() => applySettingsAction({ type: 'theme', value: 'custom' })).toThrow();
  });

  it('gates Last.fm and keeps its setter before authentication', () => {
    vi.mocked(lastfm.isConfigured).mockReturnValue(false);
    expect(() => applySettingsAction({ type: 'lastfmConnect' })).toThrow();
    vi.mocked(lastfm.isConfigured).mockReturnValue(true);
    vi.mocked(lastfm.startAuth).mockImplementationOnce(() => expect(config.getLastfmEnabled()).toBe(true));
    applySettingsAction({ type: 'lastfmConnect' });
    expect(lastfm.startAuth).toHaveBeenCalledOnce();
    config.setLastfmSession('key', 'listener');
    applySettingsAction({ type: 'lastfmEnabled', value: false });
    expect(lastfm.disable).toHaveBeenCalledOnce();
    applySettingsAction({ type: 'lastfmDisconnect' });
    expect(lastfm.disconnect).toHaveBeenCalledOnce();
  });

  it('publishes asynchronous Last.fm changes without a tray and stops on teardown', () => {
    const listener = vi.fn();
    subscribeSettingsChanges(listener);
    const callback = vi.mocked(lastfm.setStateChangedCallback).mock.calls.at(-1)?.[0];
    config.setLastfmSession('key', 'listener');
    callback?.();
    expect(listener).toHaveBeenCalledWith(expect.objectContaining({ lastfm: expect.objectContaining({ connected: true }) }));
    dispose();
    expect(lastfm.setStateChangedCallback).toHaveBeenLastCalledWith(null);
    notifySettingsChanged();
    expect(listener).toHaveBeenCalledOnce();
  });
});
