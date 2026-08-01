import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, nativeTheme, type WebContents } from 'electron';
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

// custom.css is read on every tray rebuild, through both hasCustomCss() and
// resolveTheme(), so its contents are cached and the fs.watch callback below
// clears the cache. Nothing else would clear it, so a watcher that never starts
// or dies switches caching off rather than leaving a cache that goes stale for
// the life of the process.
let customCssCache: string | null = null;
let customCssCached = false;
let customCssCacheEnabled = true;

// Track injected theme CSS for live toggle
let themeCssKey: string | null = null;

// Every mutation of themeCssKey runs on this one chain, so a theme change and a
// post-load injection cannot interleave and strand a stylesheet on the page.
let themeCssOp: Promise<void> = Promise.resolve();

// insertCSS applies to whatever document the WebContents holds when the call is
// made, not the one that queued the work, and the WebContents outlives every
// document it loads. Work that waits its turn across a navigation would insert
// into the new page on behalf of the old one, on top of that page's own
// injection, leaving two theme sheets with only the later key tracked. The
// counter advances on main-frame did-navigate, which is the commit point, so a
// captured value that no longer matches means the document is gone.
let documentGeneration = 0;

function enqueueThemeCssOp(work: () => Promise<void>): Promise<void> {
  const generation = documentGeneration;
  themeCssOp = themeCssOp
    // The catch sits ahead of the then so a failed operation cannot deadlock
    // the queue: the next one still runs.
    .catch((error: unknown) => {
      themeLog.warn('Theme CSS operation failed', error);
    })
    .then(() => {
      if (generation !== documentGeneration) {
        // Any sheet the old document held died with it, so the tracked key is
        // stale too; removeInsertedCSS would reject on it.
        themeCssKey = null;
        themeLog.debug('Theme CSS operation skipped: document replaced');
        return;
      }
      return work();
    });
  return themeCssOp;
}

// Apply or remove theme CSS on the main window.
// Handles enable, disable, and re-injection (variant change) cases.
// No-op until initThemeCSS() assigns the real implementation.
let applyThemeCSSInternal: (name: ThemeName) => Promise<void> = () => Promise.resolve();

// Rebuild the tray menu after a custom.css change.
// tray.ts imports theme.ts, so theme.ts cannot import rebuildTrayMenu back; main.ts supplies it.
let rebuildTrayCallback: (() => void) | null = null;

export function applyTheme(name: ThemeName): void {
  void applyThemeCSSInternal(name);
}

export function customCssPath(): string {
  return path.join(app.getPath('userData'), customCssFilename);
}

export function hasCustomCss(): boolean {
  return getThemeCss('custom') !== null;
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

function readCustomCss(): string | null {
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

// Exported for the watcher below and for tests; nothing else needs it.
export function invalidateCustomCssCache(): void {
  customCssCache = null;
  customCssCached = false;
}

function disableCustomCssCache(): void {
  customCssCacheEnabled = false;
  invalidateCustomCssCache();
}

export function getThemeCss(name: ThemeName): string | null {
  if (name === 'apple-music') return null;
  if (name === 'custom') {
    if (customCssCached) return customCssCache;
    const css = readCustomCss();
    if (customCssCacheEnabled) {
      customCssCache = css;
      customCssCached = true;
    }
    return css;
  }

  const cached = bundledCssCache.get(name);
  if (cached) return cached;
  const theme = bundledThemesByName.get(name);
  if (!theme) return null;
  const css = buildThemeCss(theme);
  bundledCssCache.set(name, css);
  return css;
}

// Inject the resolved theme CSS after a page load. main.ts calls this on every load.
// The load replaced the document, so nothing is removed here: any key held belongs
// to the old document and removeInsertedCSS would reject on it.
export function injectThemeCss(contents: WebContents): Promise<void> {
  return enqueueThemeCssOp(async () => {
    const theme = resolveTheme();
    if (theme === 'apple-music') {
      themeCssKey = null;
      return;
    }
    const css = getThemeCss(theme);
    if (css === null) {
      themeLog.warn(`Theme CSS unavailable: ${theme}`);
      return;
    }
    themeCssKey = await contents.insertCSS(css);
    themeLog.debug(`Theme CSS injected: ${theme}`);
  });
}

export function initThemeCSS(win: BrowserWindow): void {
  // Commit of a main-frame navigation; did-navigate-in-page keeps the document,
  // so it is not one and must not advance the counter.
  win.webContents.on('did-navigate', () => {
    documentGeneration += 1;
  });

  applyThemeCSSInternal = (name: ThemeName) => enqueueThemeCssOp(async () => {
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
      // Before the debounce, not inside it: a tray rebuild during the debounce
      // window must not read the previous contents back out of the cache.
      invalidateCustomCssCache();
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
        // Unconditional: creating custom.css adds the tray Style entry and deleting it removes
        // the entry, whichever theme is stored.
        rebuildTrayCallback?.();
      }, THEME_RELOAD_DEBOUNCE_MS);
    });
    watcher.on('error', (error) => {
      themeLog.warn('custom.css watcher error', error);
      // Node closes the watcher on error, so nothing is left to clear the cache.
      disableCustomCssCache();
    });
  } catch (error) {
    themeLog.warn('Failed to initialise custom.css watcher', error);
    disableCustomCssCache();
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

export function setRebuildTrayCallback(callback: () => void): void {
  rebuildTrayCallback = callback;
}
