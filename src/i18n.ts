import fs from 'fs';
import { app } from 'electron';
import log from 'electron-log/main';
import { getAssetPath, getProductInfo } from './paths';

const i18nLog = log.scope('i18n');

// --- Load translation records from JSON ---

type TranslationFile = Record<string, Record<string, string>>;

// A missing or malformed file is fatal on purpose. Falling back to the English
// records would hide the most common cause, a locale file left out of the
// asarUnpack list, behind a UI that looks almost right.
function loadLocaleFile(filename: string): TranslationFile {
  const filePath = getAssetPath('assets', 'locales', filename);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TranslationFile;
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error);
    i18nLog.error(`failed to load locale file ${filePath}: ${reason}`);
    throw new Error(
      `${app.getName()} could not load the locale file ${filePath}: ${reason}. ` +
      'Every file in assets/locales/ must be listed individually under asarUnpack in package.json.',
    );
  }
}

// Load synchronously because the splash needs its translation before the first window renders.
const loadingData = loadLocaleFile('loading.json');
const trayData = loadLocaleFile('tray.json');
const aboutData = loadLocaleFile('about.json');
const updateData = loadLocaleFile('update.json');

// --- Translation records, re-exported so importers name a record, not a file ---

/** Translations for loading, keyed by BCP 47 language tag. */
export const LOADING_TEXT: Record<string, string> = loadingData.LOADING_TEXT;

/** Translations for about, keyed by BCP 47 language tag. */
export const ABOUT_TEXT: Record<string, string> = trayData.ABOUT_TEXT;
/** Translations for quit, keyed by BCP 47 language tag. */
export const QUIT_TEXT: Record<string, string> = trayData.QUIT_TEXT;
/** Translations for notifications, keyed by BCP 47 language tag. */
export const NOTIFICATIONS_TEXT: Record<string, string> = trayData.NOTIFICATIONS_TEXT;
/** Translations for discord, keyed by BCP 47 language tag. */
export const DISCORD_TEXT: Record<string, string> = trayData.DISCORD_TEXT;
/** Translations for discord play on, keyed by BCP 47 language tag. */
export const DISCORD_PLAY_ON_TEXT: Record<string, string> = trayData.DISCORD_PLAY_ON_TEXT;
/** Translations for discord by artist, keyed by BCP 47 language tag. */
export const DISCORD_BY_ARTIST_TEXT: Record<string, string> = trayData.DISCORD_BY_ARTIST_TEXT;
/** Translations for unknown artist, keyed by BCP 47 language tag. */
export const UNKNOWN_ARTIST_TEXT: Record<string, string> = trayData.UNKNOWN_ARTIST_TEXT;
/** Translations for lastfm connect, keyed by BCP 47 language tag. */
export const LASTFM_CONNECT_TEXT: Record<string, string> = trayData.LASTFM_CONNECT_TEXT;
/** Translations for lastfm connected, keyed by BCP 47 language tag. */
export const LASTFM_CONNECTED_TEXT: Record<string, string> = trayData.LASTFM_CONNECTED_TEXT;
/** Translations for lastfm connect failed, keyed by BCP 47 language tag. */
export const LASTFM_CONNECT_FAILED_TEXT: Record<string, string> = trayData.LASTFM_CONNECT_FAILED_TEXT;
/** Translations for lastfm disconnect, keyed by BCP 47 language tag. */
export const LASTFM_DISCONNECT_TEXT: Record<string, string> = trayData.LASTFM_DISCONNECT_TEXT;
/** Translations for start page, keyed by BCP 47 language tag. */
export const START_PAGE_TEXT: Record<string, string> = trayData.START_PAGE_TEXT;
/** Translations for start page home, keyed by BCP 47 language tag. */
export const START_PAGE_HOME_TEXT: Record<string, string> = trayData.START_PAGE_HOME_TEXT;
/** Translations for start page new, keyed by BCP 47 language tag. */
export const START_PAGE_NEW_TEXT: Record<string, string> = trayData.START_PAGE_NEW_TEXT;
/** Translations for start page radio, keyed by BCP 47 language tag. */
export const START_PAGE_RADIO_TEXT: Record<string, string> = trayData.START_PAGE_RADIO_TEXT;
/** Translations for start page all playlists, keyed by BCP 47 language tag. */
export const START_PAGE_ALL_PLAYLISTS_TEXT: Record<string, string> = trayData.START_PAGE_ALL_PLAYLISTS_TEXT;
/** Translations for start page last, keyed by BCP 47 language tag. */
export const START_PAGE_LAST_TEXT: Record<string, string> = trayData.START_PAGE_LAST_TEXT;
/** Translations for on, keyed by BCP 47 language tag. */
export const ON_TEXT: Record<string, string> = trayData.ON_TEXT;
/** Translations for off, keyed by BCP 47 language tag. */
export const OFF_TEXT: Record<string, string> = trayData.OFF_TEXT;
/** Translations for style, keyed by BCP 47 language tag. */
export const STYLE_TEXT: Record<string, string> = trayData.STYLE_TEXT;
/** Translations for style custom, keyed by BCP 47 language tag. */
export const STYLE_CUSTOM_TEXT: Record<string, string> = trayData.STYLE_CUSTOM_TEXT;
/** Translations for zoom, keyed by BCP 47 language tag. */
export const ZOOM_TEXT: Record<string, string> = trayData.ZOOM_TEXT;
/** Translations for previous, keyed by BCP 47 language tag. */
export const PREVIOUS_TEXT: Record<string, string> = trayData.PREVIOUS_TEXT;
/** Translations for play, keyed by BCP 47 language tag. */
export const PLAY_TEXT: Record<string, string> = trayData.PLAY_TEXT;
/** Translations for pause, keyed by BCP 47 language tag. */
export const PAUSE_TEXT: Record<string, string> = trayData.PAUSE_TEXT;
/** Translations for next, keyed by BCP 47 language tag. */
export const NEXT_TEXT: Record<string, string> = trayData.NEXT_TEXT;
/** Translations for volume, keyed by BCP 47 language tag. */
export const VOLUME_TEXT: Record<string, string> = trayData.VOLUME_TEXT;
/** Translations for mute, keyed by BCP 47 language tag. */
export const MUTE_TEXT: Record<string, string> = trayData.MUTE_TEXT;
/** Translations for share, keyed by BCP 47 language tag. */
export const SHARE_TEXT: Record<string, string> = trayData.SHARE_TEXT;
/** Translations for hide window, keyed by BCP 47 language tag. */
export const HIDE_WINDOW_TEXT: Record<string, string> = trayData.HIDE_WINDOW_TEXT;
/** Translations for show window, keyed by BCP 47 language tag. */
export const SHOW_WINDOW_TEXT: Record<string, string> = trayData.SHOW_WINDOW_TEXT;
/** Translations for close to tray, keyed by BCP 47 language tag. */
export const CLOSE_TO_TRAY_TEXT: Record<string, string> = trayData.CLOSE_TO_TRAY_TEXT;
/** Translations for player, keyed by BCP 47 language tag. */
export const PLAYER_TEXT: Record<string, string> = trayData.PLAYER_TEXT;
/** Translations for start page browse, keyed by BCP 47 language tag. */
export const START_PAGE_BROWSE_TEXT: Record<string, string> = trayData.START_PAGE_BROWSE_TEXT;
/** Translations for start page library, keyed by BCP 47 language tag. */
export const START_PAGE_LIBRARY_TEXT: Record<string, string> = trayData.START_PAGE_LIBRARY_TEXT;
/** Translations for start page playlists, keyed by BCP 47 language tag. */
export const START_PAGE_PLAYLISTS_TEXT: Record<string, string> = trayData.START_PAGE_PLAYLISTS_TEXT;
/** Translations for start page search, keyed by BCP 47 language tag. */
export const START_PAGE_SEARCH_TEXT: Record<string, string> = trayData.START_PAGE_SEARCH_TEXT;
/** Translations for not playing, keyed by BCP 47 language tag. */
export const NOT_PLAYING_TEXT: Record<string, string> = trayData.NOT_PLAYING_TEXT;
/** Translations for back, keyed by BCP 47 language tag. */
export const BACK_TEXT: Record<string, string> = trayData.BACK_TEXT;
/** Translations for forward, keyed by BCP 47 language tag. */
export const FORWARD_TEXT: Record<string, string> = trayData.FORWARD_TEXT;
/** Translations for reload, keyed by BCP 47 language tag. */
export const RELOAD_TEXT: Record<string, string> = trayData.RELOAD_TEXT;
/** Translations for settings, keyed by BCP 47 language tag. */
export const SETTINGS_TEXT: Record<string, string> = trayData.SETTINGS_TEXT;
/** Translations for integrations, keyed by BCP 47 language tag. */
export const INTEGRATIONS_TEXT: Record<string, string> = trayData.INTEGRATIONS_TEXT;
/** Translations for settings error, keyed by BCP 47 language tag. */
export const SETTINGS_ERROR_TEXT: Record<string, string> = trayData.SETTINGS_ERROR_TEXT;

/** Translations for update available, keyed by BCP 47 language tag. */
export const UPDATE_AVAILABLE_TEXT: Record<string, string> = updateData.UPDATE_AVAILABLE_TEXT;
/** Translations for up to date, keyed by BCP 47 language tag. */
export const UP_TO_DATE_TEXT: Record<string, string> = updateData.UP_TO_DATE_TEXT;
/** Translations for update ready, keyed by BCP 47 language tag. */
export const UPDATE_READY_TEXT: Record<string, string> = updateData.UPDATE_READY_TEXT;
/** Translations for restart now, keyed by BCP 47 language tag. */
export const RESTART_NOW_TEXT: Record<string, string> = updateData.RESTART_NOW_TEXT;
/** Translations for later, keyed by BCP 47 language tag. */
export const LATER_TEXT: Record<string, string> = updateData.LATER_TEXT;

/** Translations for close, keyed by BCP 47 language tag. */
export const CLOSE_TEXT: Record<string, string> = aboutData.CLOSE_TEXT;
/** Translations for about description, keyed by BCP 47 language tag. */
export const ABOUT_DESCRIPTION_TEXT: Record<string, string> = aboutData.ABOUT_DESCRIPTION_TEXT;
/** Translations for version prefix, keyed by BCP 47 language tag. */
export const VERSION_PREFIX: Record<string, string> = aboutData.VERSION_PREFIX;
/** Translations for copyright suffix, keyed by BCP 47 language tag. */
export const COPYRIGHT_SUFFIX: Record<string, string> = aboutData.COPYRIGHT_SUFFIX;
/** Translations for license prefix, keyed by BCP 47 language tag. */
export const LICENSE_PREFIX: Record<string, string> = aboutData.LICENSE_PREFIX;

// --- Cached system language list ---
// Cached because every tray rebuild resolves the whole string set. A system
// language changed mid-session therefore takes effect on the next launch
let _cachedLangs: string[] | null = null;
function getSystemLanguages(): string[] {
  if (!_cachedLangs) _cachedLangs = app.getPreferredSystemLanguages();
  return _cachedLangs;
}

// --- Generic locale resolution ---

/**
 * Resolve preferred languages in order, checking exact and normalised tags before base languages.
 * Chinese script matching precedes base-language fallback.
 * Use English only when no preferred language matches, so every record needs an en entry.
 */
export function getLocalizedString(
  record: Record<string, string>,
  langs: string[],
): string {
  return getLocalizedEntry(record, langs).value;
}

function getLocalizedEntry(
  record: Record<string, string>,
  langs: string[],
): { value: string; lang: string } {
  for (const lang of langs) {
    if (record[lang]) return { value: record[lang], lang };
    try {
      const locale = new Intl.Locale(lang);
      if (record[locale.baseName]) return { value: record[locale.baseName], lang: locale.baseName };
      if (locale.language === 'zh') {
        const script = locale.maximize().script;
        const region = locale.region;
        const regionalTag = region ? `zh-${region}` : '';
        const regionalScript = region ? new Intl.Locale(regionalTag).maximize().script : undefined;
        const tag = record[regionalTag] && regionalScript === script
          ? regionalTag : script === 'Hant' ? 'zh-TW' : 'zh-CN';
        if (record[tag]) return { value: record[tag], lang: tag };
      }
      const base = locale.language;
      if (record[base]) return { value: record[base], lang: base };
    } catch {
      continue;
    }
  }
  return { value: record['en'], lang: 'en' };
}

// --- Public API (uses Electron app internally) ---

/**
 * The Apple Music storefront path segment, taken from the region rather than the
 * language: a Welsh or Gaelic UI in the United Kingdom still shops in gb.
 */
export function getStorefront(): string {
  const code = app.getLocaleCountryCode().toLowerCase();
  if (code) {
    i18nLog.debug(`storefront detected from locale: ${code}`);
    return code;
  }
  i18nLog.debug('storefront fallback: us');
  return 'us';
}

/**
 * The splash screen string, with the tag it resolved to. The splash needs the
 * tag as well as the text, because Arabic and Hebrew switch it to right to left.
 */
export function getLoadingText(): { text: string; lang: string } {
  const langs = getSystemLanguages();
  const { value: text, lang } = getLocalizedEntry(LOADING_TEXT, langs);
  i18nLog.debug(`resolved locale: ${lang}`);
  return { text, lang };
}

/** Resolved labels shared by tray and settings controls. */
export interface TrayStrings {
  settings: string;
  integrations: string;
  settingsError: string;
  lastfm: string;
  lastfmConnected: string;
  about: string;
  quit: string;
  notifications: string;
  discord: string;
  player: string;
  lastfmConnect: string;
  lastfmDisconnect: string;
  startPage: string;
  startPageHome: string;
  startPageNew: string;
  startPageRadio: string;
  startPageAllPlaylists: string;
  startPageBrowse: string;
  startPageLibrary: string;
  startPagePlaylists: string;
  startPageSearch: string;
  startPageLast: string;
  on: string;
  off: string;
  style: string;
  styleAppleMusic: string;
  styleCustom: string;
  zoom: string;
  zoom100: string;
  zoom125: string;
  zoom150: string;
  zoom175: string;
  zoom200: string;
  previous: string;
  play: string;
  pause: string;
  notPlaying: string;
  next: string;
  volume: string;
  mute: string;
  share: string;
  hideWindow: string;
  showWindow: string;
  closeToTray: string;
}

// Every tray label against the record it resolves from. Typed on keyof
// TrayStrings, so a key added to the interface and left out here fails tsc.
// The brand name and the zoom steps read the same in every language and are
// written as en-only records: en is what getLocalizedString falls back to, so
// one shape covers the whole table.
const TRAY_TEXT: Record<keyof TrayStrings, Record<string, string>> = {
  settings: SETTINGS_TEXT,
  integrations: INTEGRATIONS_TEXT,
  settingsError: SETTINGS_ERROR_TEXT,
  lastfm: { en: 'Last.fm' },
  lastfmConnected: LASTFM_CONNECTED_TEXT,
  about: ABOUT_TEXT,
  quit: QUIT_TEXT,
  notifications: NOTIFICATIONS_TEXT,
  discord: DISCORD_TEXT,
  player: PLAYER_TEXT,
  lastfmConnect: LASTFM_CONNECT_TEXT,
  lastfmDisconnect: LASTFM_DISCONNECT_TEXT,
  startPage: START_PAGE_TEXT,
  startPageHome: START_PAGE_HOME_TEXT,
  startPageNew: START_PAGE_NEW_TEXT,
  startPageRadio: START_PAGE_RADIO_TEXT,
  startPageAllPlaylists: START_PAGE_ALL_PLAYLISTS_TEXT,
  startPageBrowse: START_PAGE_BROWSE_TEXT,
  startPageLibrary: START_PAGE_LIBRARY_TEXT,
  startPagePlaylists: START_PAGE_PLAYLISTS_TEXT,
  startPageSearch: START_PAGE_SEARCH_TEXT,
  startPageLast: START_PAGE_LAST_TEXT,
  on: ON_TEXT,
  off: OFF_TEXT,
  style: STYLE_TEXT,
  styleAppleMusic: { en: 'Apple Music' },
  styleCustom: STYLE_CUSTOM_TEXT,
  zoom: ZOOM_TEXT,
  zoom100: { en: '100%' },
  zoom125: { en: '125%' },
  zoom150: { en: '150%' },
  zoom175: { en: '175%' },
  zoom200: { en: '200%' },
  previous: PREVIOUS_TEXT,
  play: PLAY_TEXT,
  pause: PAUSE_TEXT,
  notPlaying: NOT_PLAYING_TEXT,
  next: NEXT_TEXT,
  volume: VOLUME_TEXT,
  mute: MUTE_TEXT,
  share: SHARE_TEXT,
  hideWindow: HIDE_WINDOW_TEXT,
  showWindow: SHOW_WINDOW_TEXT,
  closeToTray: CLOSE_TO_TRAY_TEXT,
};

// TRAY_TEXT is a Record literal, so excess property checking already rules out
// a key outside the interface and this list is exactly keyof TrayStrings.
const TRAY_KEYS = Object.keys(TRAY_TEXT) as (keyof TrayStrings)[];

const NAMED_TRAY_KEYS: ReadonlySet<keyof TrayStrings> = new Set([
  'about',
  'hideWindow',
  'showWindow',
]);

/**
 * Every tray label in one object, resolved once per menu rebuild. Labels that
 * name the app carry a {name} placeholder rather than the word "Sidra", so a
 * translation cannot hardcode it and the product name stays in package.json.
 * NAMED_TRAY_KEYS lists them.
 */
export function getTrayStrings(): TrayStrings {
  const langs = getSystemLanguages();
  const productName: string = getProductInfo().productName;
  const strings = {} as TrayStrings;
  for (const key of TRAY_KEYS) {
    const value = getLocalizedString(TRAY_TEXT[key], langs);
    strings[key] = NAMED_TRAY_KEYS.has(key) ? value.replace('{name}', productName) : value;
  }
  return strings;
}

/** Format the localised Discord service label. */
export function getDiscordPlayOnText(service: string): string {
  return getLocalizedString(DISCORD_PLAY_ON_TEXT, getSystemLanguages()).replace('{service}', () => service);
}

/** Format the localised Discord artist label, using the unknown-artist translation for null. */
export function getDiscordArtistText(artist: string | null): string {
  const langs = getSystemLanguages();
  const name = artist ?? getLocalizedString(UNKNOWN_ARTIST_TEXT, langs);
  return getLocalizedString(DISCORD_BY_ARTIST_TEXT, langs).replace('{artist}', () => name);
}

/** Format the connected Last.fm account label. */
export function getLastfmConnectedText(name: string): string {
  const langs = getSystemLanguages();
  return getLocalizedString(LASTFM_CONNECTED_TEXT, langs).replace('{name}', name);
}

/** Resolve the Last.fm connection failure message. */
export function getLastfmConnectFailedText(): string {
  return getLocalizedString(LASTFM_CONNECT_FAILED_TEXT, getSystemLanguages());
}

/**
 * Placeholder for JSON labels in assets/navigationBar.js.
 * executeJavaScript() injection has no loadFile() query parameters, so loadAssets() substitutes labels before injection.
 */
export const NAV_LABELS_TOKEN = '__SIDRA_NAV_LABELS__';

/** Resolve the labels for the injected navigation bar. */
export function getNavigationStrings(): {
  settings: string;
  back: string;
  forward: string;
  reload: string;
} {
  const langs = getSystemLanguages();
  return {
    settings: getLocalizedString(SETTINGS_TEXT, langs),
    back: getLocalizedString(BACK_TEXT, langs),
    forward: getLocalizedString(FORWARD_TEXT, langs),
    reload: getLocalizedString(RELOAD_TEXT, langs),
  };
}

/** Resolve the About window text and metadata labels. */
export function getAboutStrings(): {
  description: string;
  close: string;
  versionPrefix: string;
  copyrightSuffix: string;
  licensePrefix: string;
} {
  const langs = getSystemLanguages();
  return {
    close: getLocalizedString(CLOSE_TEXT, langs),
    description: getLocalizedString(ABOUT_DESCRIPTION_TEXT, langs),
    versionPrefix: getLocalizedString(VERSION_PREFIX, langs),
    copyrightSuffix: getLocalizedString(COPYRIGHT_SUFFIX, langs),
    licensePrefix: getLocalizedString(LICENSE_PREFIX, langs),
  };
}

/** Resolve update availability messages. */
export function getUpdateStrings(): {
  updateAvailable: string;
  upToDate: string;
} {
  const langs = getSystemLanguages();
  return {
    updateAvailable: getLocalizedString(UPDATE_AVAILABLE_TEXT, langs),
    upToDate: getLocalizedString(UP_TO_DATE_TEXT, langs),
  };
}

/** Resolve the downloaded-update prompt and its action labels. */
export function getAutoUpdateStrings(): {
  ready: string;
  restartNow: string;
  later: string;
} {
  const langs = getSystemLanguages();
  return {
    ready: getLocalizedString(UPDATE_READY_TEXT, langs),
    restartNow: getLocalizedString(RESTART_NOW_TEXT, langs),
    later: getLocalizedString(LATER_TEXT, langs),
  };
}
