import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, nativeTheme } from 'electron';
import log from 'electron-log/main';
import { BUNDLED_THEMES, type BundledThemeName } from './palettes';
import { buildThemeCss } from './themeTemplate';
import { getTheme } from './config';

export type ThemeName = 'apple-music' | BundledThemeName | 'custom';

const themeLog = log.scope('theme');

const THEME_RELOAD_DEBOUNCE_MS = 150;
const customCssFilename = 'custom.css';
const bundledThemesByName = new Map(BUNDLED_THEMES.map(theme => [theme.name, theme] as const));
const bundledCssCache = new Map<BundledThemeName, string>();

// Track injected theme CSS for live toggle
let themeCssKey: string | null = null;

// Apply or remove theme CSS on the main window.
// Handles enable, disable, and re-injection (variant change) cases.
// No-op until initThemeCSS() assigns the real implementation.
let applyThemeCSSInternal: (name: ThemeName) => Promise<void> = () => Promise.resolve();

export function applyTheme(name: ThemeName): void {
  void applyThemeCSSInternal(name);
}

export function customCssPath(): string {
  return path.join(app.getPath('userData'), customCssFilename);
}

export function hasCustomCss(): boolean {
  return fs.existsSync(customCssPath());
}

function isThemeName(value: string): value is ThemeName {
  return value === 'apple-music'
    || value === 'custom'
    || bundledThemesByName.has(value as BundledThemeName);
}

export function resolveTheme(): ThemeName {
  const theme = getTheme();
  if (!isThemeName(theme)) return 'apple-music';
  if (theme === 'custom' && getThemeCss('custom') === null) return 'apple-music';
  return theme;
}

export function getThemeCss(name: ThemeName): string | null {
  if (name === 'apple-music') return null;
  if (name === 'custom') {
    try {
      const css = fs.readFileSync(customCssPath(), 'utf-8');
      return css.trim().length > 0 ? css : null;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') {
        themeLog.warn('Failed to read custom.css from userData directory', error);
      }
      return null;
    }
  }

  const cached = bundledCssCache.get(name);
  if (cached) return cached;
  const theme = bundledThemesByName.get(name);
  if (!theme) return null;
  const css = buildThemeCss(theme);
  bundledCssCache.set(name, css);
  return css;
}

export function initThemeCSS(win: BrowserWindow): void {

  let themeCssOp = Promise.resolve();
  applyThemeCSSInternal = (name: ThemeName) => {
    themeCssOp = themeCssOp
      .catch((error: unknown) => {
        themeLog.warn('Theme CSS operation failed', error);
      })
      .then(async () => {
        const css = getThemeCss(name);
        if (css !== null && themeCssKey !== null) {
          await win.webContents.removeInsertedCSS(themeCssKey);
          themeCssKey = await win.webContents.insertCSS(css);
          themeLog.debug(`Theme CSS re-injected: ${name}`);
        } else if (css !== null) {
          themeCssKey = await win.webContents.insertCSS(css);
          themeLog.debug(`Theme CSS injected: ${name}`);
        } else if (themeCssKey !== null) {
          await win.webContents.removeInsertedCSS(themeCssKey);
          themeCssKey = null;
          themeLog.debug(`Theme CSS removed: ${name}`);
        }
      });
    return themeCssOp;
  };

  nativeTheme.on('updated', () => {
    const currentTheme = resolveTheme();
    if (currentTheme !== 'apple-music') {
      void applyThemeCSSInternal(currentTheme);
    }
  });

  let customCssTimer: NodeJS.Timeout | null = null;
  const userDataPath = app.getPath('userData');
  let watcher: fs.FSWatcher | null = null;
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    watcher = fs.watch(userDataPath, { persistent: false }, (eventType, filename) => {
      // macOS may emit a null filename for directory-level change events.
      if (filename !== null && filename.toString() !== customCssFilename) return;
      themeLog.debug(`custom.css watcher event: ${eventType}`);
      if (customCssTimer) clearTimeout(customCssTimer);
      customCssTimer = setTimeout(() => {
        customCssTimer = null;
        if (win.isDestroyed()) return;
        const resolved = resolveTheme();
        if (resolved === 'custom') {
          void applyThemeCSSInternal('custom');
        } else if (getTheme() === 'custom') {
          void applyThemeCSSInternal('apple-music');
        }
      }, THEME_RELOAD_DEBOUNCE_MS);
    });
    watcher.on('error', (error) => {
      themeLog.warn('custom.css watcher error', error);
    });
  } catch (error) {
    themeLog.warn('Failed to initialise custom.css watcher', error);
  }

  app.on('will-quit', () => {
    if (customCssTimer) {
      clearTimeout(customCssTimer);
      customCssTimer = null;
    }
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  });
}

export function setThemeCssKey(key: string | null): void {
  themeCssKey = key;
}
