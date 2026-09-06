import type { BrowserWindow } from 'electron';
import * as config from './config';
import { getLoadingText, getTrayStrings, type TrayStrings } from './i18n';
import { MUSIC_SERVICES, allServices, isMusicServiceId, DEFAULT_SERVICE_ID, type AnyStartPageId, type MusicServiceId, type MusicStartPageId, type ClassicalStartPageId } from './musicService';
import { BUNDLED_THEMES, themeLabel, type ThemeName } from './palettes';
import { applyTheme, hasCustomCss, resolveTheme } from './theme';
import { enable as enableDiscord, disable as disableDiscord } from './integrations/discord-presence';
import * as lastfm from './integrations/lastfm';

export type ZoomFactor = 1 | 1.25 | 1.5 | 1.75 | 2;
export type SettingsAction =
  | { type: 'musicService'; value: MusicServiceId }
  | { type: 'startPage'; serviceId: 'music'; value: MusicStartPageId | 'last' }
  | { type: 'startPage'; serviceId: 'classical'; value: ClassicalStartPageId | 'last' }
  | { type: 'theme'; value: ThemeName }
  | { type: 'zoomFactor'; value: ZoomFactor }
  | { type: 'closeToTray' | 'notifications' | 'discord' | 'lastfmEnabled'; value: boolean }
  | { type: 'lastfmConnect' | 'lastfmDisconnect' };

export interface SettingsOption<T> { value: T; label: string }
export interface SettingsState {
  musicService: MusicServiceId;
  startPage: AnyStartPageId | 'last';
  theme: ThemeName;
  zoomFactor: number;
  closeToTray: boolean;
  notifications: boolean;
  discord: boolean;
  lastfm: { available: boolean; connected: boolean; enabled: boolean; username: string };
  options: {
    musicService: SettingsOption<MusicServiceId>[];
    startPage: SettingsOption<AnyStartPageId | 'last'>[];
    theme: SettingsOption<ThemeName>[];
    zoomFactor: SettingsOption<ZoomFactor>[];
  };
  labels: TrayStrings;
  lang: string;
}

export interface SettingsBridge {
  getState(): Promise<SettingsState>;
  apply(action: SettingsAction): Promise<SettingsState>;
  onState(listener: (state: SettingsState) => void): () => void;
}

interface SettingsRuntime {
  getMainWindow: () => BrowserWindow | null;
  applyZoom: (factor: number) => void;
  switchService: (id: MusicServiceId) => void;
  refreshTray: () => void;
}

let runtime: SettingsRuntime | null = null;
const listeners = new Set<(state: SettingsState) => void>();

export function initSettingsActions(callbacks: SettingsRuntime): () => void {
  runtime = callbacks;
  lastfm.setStateChangedCallback(() => {
    callbacks.refreshTray();
    notifySettingsChanged();
  });
  return () => {
    if (runtime !== callbacks) return;
    runtime = null;
    lastfm.setStateChangedCallback(null);
    listeners.clear();
  };
}

export function startPageLabels(strings: TrayStrings): Record<AnyStartPageId | 'last', string> {
  return {
    home: strings.startPageHome, new: strings.startPageNew, radio: strings.startPageRadio,
    'all-playlists': strings.startPageAllPlaylists, browse: strings.startPageBrowse,
    playlists: strings.startPagePlaylists, search: strings.startPageSearch, last: strings.startPageLast,
  };
}

export function getSettingsState(): SettingsState {
  const labels = getTrayStrings();
  const storedService = config.getMusicService();
  const musicService = isMusicServiceId(storedService) ? storedService : DEFAULT_SERVICE_ID;
  const service = MUSIC_SERVICES[musicService];
  const pageLabels = startPageLabels(labels);
  const pages: (AnyStartPageId | 'last')[] = [...service.startPages.map(page => page.id), 'last'];
  const storedPage = config.getStartPageFor(musicService);
  const themes: SettingsOption<ThemeName>[] = [
    { value: 'apple-music', label: labels.styleAppleMusic },
    ...BUNDLED_THEMES.map(theme => ({ value: theme.name, label: theme.label })),
  ];
  if (hasCustomCss()) themes.push({ value: 'custom', label: themeLabel('custom') });
  return {
    musicService, startPage: pages.includes(storedPage) ? storedPage : service.defaultStartPage,
    theme: resolveTheme(), zoomFactor: config.getZoomFactor(),
    closeToTray: config.getCloseToTrayEnabled(), notifications: config.getNotificationsEnabled(),
    discord: config.getDiscordEnabled(),
    lastfm: {
      available: lastfm.isConfigured(), connected: !!config.getLastfmSessionKey(),
      enabled: config.getLastfmEnabled(), username: config.getLastfmUsername() ?? '',
    },
    options: {
      musicService: allServices().map(service => ({ value: service.id, label: service.displayName })),
      startPage: pages.map(value => ({ value, label: pageLabels[value] })),
      theme: themes,
      zoomFactor: [
        { value: 1, label: labels.zoom100 }, { value: 1.25, label: labels.zoom125 },
        { value: 1.5, label: labels.zoom150 }, { value: 1.75, label: labels.zoom175 },
        { value: 2, label: labels.zoom200 },
      ],
    },
    labels, lang: getLoadingText().lang,
  };
}

export function subscribeSettingsChanges(listener: (state: SettingsState) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifySettingsChanged(): void {
  if (!listeners.size) return;
  const state = getSettingsState();
  for (const listener of listeners) listener(state);
}

function isSettingsAction(action: unknown, state: SettingsState): action is SettingsAction {
  if (typeof action !== 'object' || action === null || Array.isArray(action)) return false;
  const data = action as Record<string, unknown>;
  const keys = data.type === 'startPage' ? ['type', 'value', 'serviceId']
    : data.type === 'lastfmConnect' || data.type === 'lastfmDisconnect' ? ['type'] : ['type', 'value'];
  if (Object.keys(data).length !== keys.length || !keys.every(key => Object.hasOwn(data, key))) return false;
  switch (data.type) {
    case 'musicService': return state.options.musicService.some(option => option.value === data.value);
    case 'startPage': return data.serviceId === state.musicService && state.options.startPage.some(option => option.value === data.value);
    case 'theme': return state.options.theme.some(option => option.value === data.value);
    case 'zoomFactor': return state.options.zoomFactor.some(option => option.value === data.value);
    case 'closeToTray': case 'notifications': case 'discord': return typeof data.value === 'boolean';
    case 'lastfmEnabled': return state.lastfm.available && state.lastfm.connected && typeof data.value === 'boolean';
    case 'lastfmConnect': return state.lastfm.available && !state.lastfm.connected;
    case 'lastfmDisconnect': return state.lastfm.available && state.lastfm.connected;
    default: return false;
  }
}

export function applySettingsAction(action: unknown): SettingsState {
  const state = getSettingsState();
  if (!isSettingsAction(action, state)) throw new Error('Invalid settings action');
  if (!runtime) throw new Error('Settings actions are not initialised');
  switch (action.type) {
    case 'musicService':
      if (action.value !== state.musicService) runtime.switchService(action.value);
      break;
    case 'startPage':
      if (action.serviceId === 'music') config.setStartPage(action.value);
      else config.setClassicalStartPage(action.value);
      break;
    case 'theme': config.setTheme(action.value); applyTheme(action.value); break;
    case 'zoomFactor': config.setZoomFactor(action.value); runtime.applyZoom(action.value); break;
    case 'closeToTray': {
      config.setCloseToTrayEnabled(action.value);
      const window = runtime.getMainWindow();
      if (!action.value && window && !window.isVisible()) { window.show(); window.focus(); }
      break;
    }
    case 'notifications': config.setNotificationsEnabled(action.value); break;
    case 'discord': config.setDiscordEnabled(action.value); (action.value ? enableDiscord : disableDiscord)(); break;
    case 'lastfmEnabled': config.setLastfmEnabled(action.value); (action.value ? lastfm.enable : lastfm.disable)(); break;
    case 'lastfmConnect': config.setLastfmEnabled(true); lastfm.startAuth(); break;
    case 'lastfmDisconnect': lastfm.disconnect(); break;
  }
  runtime.refreshTray();
  notifySettingsChanged();
  return getSettingsState();
}
