import { BrowserWindow, nativeTheme } from 'electron';
import log from 'electron-log/main';
import { getTheme } from './config';

export type ThemeName = 'apple-music' | 'catppuccin';

const mainLog = log.scope('main');

// Map from theme name to CSS content (null = no override CSS)
const themeCssMap: Record<ThemeName, string | null> = {
  'apple-music': null,
  'catppuccin': null,  // populated by initThemeCSS
};

// Track injected theme CSS for live toggle
let themeCssKey: string | null = null;

// Apply or remove theme CSS on the main window.
// Handles enable, disable, and re-injection (variant change) cases.
let applyThemeCSSInternal: (name: ThemeName) => Promise<void>;

export function applyTheme(name: ThemeName): void {
  void applyThemeCSSInternal(name);
}

export function initThemeCSS(win: BrowserWindow, catppuccinCSS: string): void {
  themeCssMap['catppuccin'] = catppuccinCSS;

  let themeCssOp = Promise.resolve();
  applyThemeCSSInternal = (name: ThemeName) => {
    themeCssOp = themeCssOp
      .catch((error) => {
        mainLog.warn('Theme CSS operation failed', error);
      })
      .then(async () => {
        const css = themeCssMap[name];
        if (css !== null && themeCssKey !== null) {
          await win.webContents.removeInsertedCSS(themeCssKey);
          themeCssKey = await win.webContents.insertCSS(css);
          mainLog.debug(`Theme CSS re-injected: ${name}`);
        } else if (css !== null) {
          themeCssKey = await win.webContents.insertCSS(css);
          mainLog.debug(`Theme CSS injected: ${name}`);
        } else if (themeCssKey !== null) {
          await win.webContents.removeInsertedCSS(themeCssKey);
          themeCssKey = null;
          mainLog.debug(`Theme CSS removed: ${name}`);
        }
      });
    return themeCssOp;
  };

  nativeTheme.on('updated', () => {
    const currentTheme = getTheme();
    if (currentTheme !== 'apple-music') {
      void applyThemeCSSInternal(currentTheme);
    }
  });
}

export function setThemeCssKey(key: string | null): void {
  themeCssKey = key;
}
