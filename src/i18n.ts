import fs from 'fs';
import { app } from 'electron';
import log from 'electron-log/main';
import { getAssetPath } from './paths';

const i18nLog = log.scope('i18n');

// --- Load translation records from JSON ---

type TranslationFile = Record<string, Record<string, string>>;

function loadLocaleFile(filename: string): TranslationFile {
  const filePath = getAssetPath('assets', 'locales', filename);
  return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as TranslationFile;
}

const loadingData = loadLocaleFile('loading.json');
const trayData = loadLocaleFile('tray.json');
const aboutData = loadLocaleFile('about.json');
const updateData = loadLocaleFile('update.json');

// --- Re-export translation records (preserves existing import paths) ---

export const LOADING_TEXT: Record<string, string> = loadingData.LOADING_TEXT;

export const ABOUT_TEXT: Record<string, string> = trayData.ABOUT_TEXT;
export const QUIT_TEXT: Record<string, string> = trayData.QUIT_TEXT;
export const NOTIFICATIONS_TEXT: Record<string, string> = trayData.NOTIFICATIONS_TEXT;
export const DISCORD_TEXT: Record<string, string> = trayData.DISCORD_TEXT;
export const START_PAGE_TEXT: Record<string, string> = trayData.START_PAGE_TEXT;
export const START_PAGE_HOME_TEXT: Record<string, string> = trayData.START_PAGE_HOME_TEXT;
export const START_PAGE_NEW_TEXT: Record<string, string> = trayData.START_PAGE_NEW_TEXT;
export const START_PAGE_RADIO_TEXT: Record<string, string> = trayData.START_PAGE_RADIO_TEXT;
export const START_PAGE_ALL_PLAYLISTS_TEXT: Record<string, string> = trayData.START_PAGE_ALL_PLAYLISTS_TEXT;
export const START_PAGE_LAST_TEXT: Record<string, string> = trayData.START_PAGE_LAST_TEXT;
export const ON_TEXT: Record<string, string> = trayData.ON_TEXT;
export const OFF_TEXT: Record<string, string> = trayData.OFF_TEXT;
export const STYLE_TEXT: Record<string, string> = trayData.STYLE_TEXT;
export const ZOOM_TEXT: Record<string, string> = trayData.ZOOM_TEXT;

export const UPDATE_AVAILABLE_TEXT: Record<string, string> = updateData.UPDATE_AVAILABLE_TEXT;
export const UP_TO_DATE_TEXT: Record<string, string> = updateData.UP_TO_DATE_TEXT;
export const UPDATE_READY_TEXT: Record<string, string> = updateData.UPDATE_READY_TEXT;
export const RESTART_NOW_TEXT: Record<string, string> = updateData.RESTART_NOW_TEXT;
export const LATER_TEXT: Record<string, string> = updateData.LATER_TEXT;

export const CLOSE_TEXT: Record<string, string> = aboutData.CLOSE_TEXT;
export const VERSION_PREFIX: Record<string, string> = aboutData.VERSION_PREFIX;
export const COPYRIGHT_SUFFIX: Record<string, string> = aboutData.COPYRIGHT_SUFFIX;
export const LICENSE_PREFIX: Record<string, string> = aboutData.LICENSE_PREFIX;

// Zoom percentage labels are language-invariant (numeric + symbol)
const ZOOM_100 = '100%';
const ZOOM_125 = '125%';
const ZOOM_150 = '150%';
const ZOOM_175 = '175%';
const ZOOM_200 = '200%';

// --- Cached system language list ---
let _cachedLangs: string[] | null = null;
function getSystemLanguages(): string[] {
  if (!_cachedLangs) _cachedLangs = app.getPreferredSystemLanguages();
  return _cachedLangs;
}

// --- Generic locale resolution ---
export function getLocalizedString(
  record: Record<string, string>,
  langs: string[],
): string {
  for (const lang of langs) {
    if (record[lang]) {
      return record[lang];
    }
    const base = lang.split('-')[0];
    if (record[base]) {
      return record[base];
    }
  }
  return record['en'];
}

function getLocalizedEntry(
  record: Record<string, string>,
  langs: string[],
): { value: string; lang: string } {
  for (const lang of langs) {
    if (record[lang]) return { value: record[lang], lang };
    const base = lang.split('-')[0];
    if (record[base]) return { value: record[base], lang: base };
  }
  return { value: record['en'], lang: 'en' };
}

// --- Public API (uses Electron app internally) ---

export function getStorefront(): string {
  const code = app.getLocaleCountryCode().toLowerCase();
  if (code) {
    i18nLog.debug(`storefront detected from locale: ${code}`);
    return code;
  }
  i18nLog.debug('storefront fallback: us');
  return 'us';
}

export function getLoadingText(): { text: string; lang: string } {
  const langs = getSystemLanguages();
  const { value: text, lang } = getLocalizedEntry(LOADING_TEXT, langs);
  i18nLog.debug(`resolved locale: ${lang}`);
  return { text, lang };
}

export function getTrayStrings(): { about: string; quit: string; notifications: string; discord: string; startPage: string; startPageHome: string; startPageNew: string; startPageRadio: string; startPageAllPlaylists: string; startPageLast: string; catppuccin: string; on: string; off: string; style: string; styleAppleMusic: string; zoom: string; zoom100: string; zoom125: string; zoom150: string; zoom175: string; zoom200: string } {
  const langs = getSystemLanguages();
  const productName: string = app.getName();
  const aboutTemplate = getLocalizedString(ABOUT_TEXT, langs);
  const about = aboutTemplate.replace('{name}', productName);
  const quit = getLocalizedString(QUIT_TEXT, langs);
  const notifications = getLocalizedString(NOTIFICATIONS_TEXT, langs);
  const discord = getLocalizedString(DISCORD_TEXT, langs);
  const startPage = getLocalizedString(START_PAGE_TEXT, langs);
  const startPageHome = getLocalizedString(START_PAGE_HOME_TEXT, langs);
  const startPageNew = getLocalizedString(START_PAGE_NEW_TEXT, langs);
  const startPageRadio = getLocalizedString(START_PAGE_RADIO_TEXT, langs);
  const startPageAllPlaylists = getLocalizedString(START_PAGE_ALL_PLAYLISTS_TEXT, langs);
  const startPageLast = getLocalizedString(START_PAGE_LAST_TEXT, langs);
  const catppuccin = 'Catppuccin';
  const on = getLocalizedString(ON_TEXT, langs);
  const off = getLocalizedString(OFF_TEXT, langs);
  const style = getLocalizedString(STYLE_TEXT, langs);
  const styleAppleMusic = 'Apple Music';
  const zoom = getLocalizedString(ZOOM_TEXT, langs);
  const zoom100 = ZOOM_100;
  const zoom125 = ZOOM_125;
  const zoom150 = ZOOM_150;
  const zoom175 = ZOOM_175;
  const zoom200 = ZOOM_200;
  return { about, quit, notifications, discord, startPage, startPageHome, startPageNew, startPageRadio, startPageAllPlaylists, startPageLast, catppuccin, on, off, style, styleAppleMusic, zoom, zoom100, zoom125, zoom150, zoom175, zoom200 };
}

export function getAboutStrings(): {
  close: string;
  versionPrefix: string;
  copyrightSuffix: string;
  licensePrefix: string;
} {
  const langs = getSystemLanguages();
  return {
    close: getLocalizedString(CLOSE_TEXT, langs),
    versionPrefix: getLocalizedString(VERSION_PREFIX, langs),
    copyrightSuffix: getLocalizedString(COPYRIGHT_SUFFIX, langs),
    licensePrefix: getLocalizedString(LICENSE_PREFIX, langs),
  };
}

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
