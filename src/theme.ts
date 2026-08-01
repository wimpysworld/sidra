import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, nativeTheme, type WebContents } from 'electron';
import log from 'electron-log/main';
import { BUNDLED_THEMES, type BundledThemeName } from './palettes';
import { buildThemeCss } from './themeTemplate';
import { getTheme } from './config';

/** Active theme. 'apple-music' means no override CSS is injected at all. */
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

// The insertCSS key of the sheet currently on the page, which is what a later
// removeInsertedCSS needs. Null means no sheet is tracked.
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

// Every await inside queued work is another point a navigation can commit at,
// so the pre-flight check below covers only the wait for the queue. Work that
// awaits must re-check its captured generation afterwards, before it touches
// the document again or records a key the document no longer holds.
function documentReplaced(generation: number): boolean {
  if (generation === documentGeneration) return false;
  themeCssKey = null;
  themeLog.debug('Theme CSS operation abandoned: document replaced');
  return true;
}

function enqueueThemeCssOp(work: (generation: number) => Promise<void>): Promise<void> {
  const generation = documentGeneration;
  themeCssOp = themeCssOp
    .then(() => {
      if (generation !== documentGeneration) {
        // Any sheet the old document held died with it, so the tracked key is
        // stale too; removeInsertedCSS would reject on it.
        themeCssKey = null;
        themeLog.debug('Theme CSS operation skipped: document replaced');
        return;
      }
      return work(generation);
    })
    // The catch sits at the end, so the promise stored and returned here always
    // fulfils. applyTheme() discards that promise, and a rejection left on it is
    // an unhandled rejection in the main process; a fulfilled one also keeps one
    // failure from deadlocking the queue, because the next operation still runs.
    // It drops the tracked key because a failed operation leaves it naming a
    // sheet that either cannot be removed or is already gone, and keeping it
    // would send every later change down the same rejected removal, so none
    // would reach its insertion.
    .catch((error: unknown) => {
      themeCssKey = null;
      themeLog.warn('Theme CSS operation failed', error);
    });
  return themeCssOp;
}

// Apply or remove theme CSS on the main window.
// Handles enable, disable, and re-injection (variant change) cases.
//
// Until initThemeCSS() assigns the real implementation there is no window and no
// document, so this one warns and applies nothing. The gap is reachable: main.ts
// builds the tray, whose Style items are live from that moment, before it awaits
// the session and then calls initThemeCSS(), so a click landing inside that await
// arrives here. Nothing is replayed because nothing is lost - the tray persists
// the choice with setTheme() before it calls applyTheme(), and injectThemeCss()
// reads the store on every page load, so the first load applies it. Queueing the
// call instead would need a documentGeneration for a document that does not yet
// exist, and initThemeCSS() still runs before the first loadURL().
let applyThemeCSSInternal: (name: ThemeName) => Promise<void> = (name: ThemeName) => {
  themeLog.warn(`Theme CSS not applied, theme system not initialised yet: ${name}`);
  return Promise.resolve();
};

// Rebuild the tray menu after a custom.css change.
// tray.ts imports theme.ts, so theme.ts cannot import rebuildTrayMenu back; main.ts supplies it.
let rebuildTrayCallback: (() => void) | null = null;

/** Queue a theme change against the live page. Failures are logged, never thrown. */
export function applyTheme(name: ThemeName): void {
  void applyThemeCSSInternal(name);
}

/** Where a user drops their own stylesheet: custom.css in the userData directory. */
export function customCssPath(): string {
  return path.join(app.getPath('userData'), customCssFilename);
}

/** True when custom.css is readable and non-blank; existing is not enough. */
export function hasCustomCss(): boolean {
  return getThemeCss('custom') !== null;
}

function isThemeName(value: string): value is ThemeName {
  return value === 'apple-music'
    || value === 'custom'
    || bundledThemesByName.has(value as BundledThemeName);
}

/**
 * The theme to render: the stored one, falling back to 'apple-music' when it is
 * unknown or when 'custom' is stored with no readable custom.css behind it.
 */
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

/** Drop the cached custom.css. Exported for the watcher below and for tests; nothing else needs it. */
export function invalidateCustomCssCache(): void {
  customCssCache = null;
  customCssCached = false;
}

function disableCustomCssCache(): void {
  customCssCacheEnabled = false;
  invalidateCustomCssCache();
}

/**
 * Stylesheet for a theme, or null for 'apple-music' and for a missing or blank
 * custom.css. Bundled themes are rendered once and cached; custom.css is cached
 * only while the watcher below is alive to invalidate it.
 */
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

/**
 * Inject the resolved theme CSS after a page load. main.ts calls this on every
 * load. The load replaced the document, so nothing is removed here: any key held
 * belongs to the old document and removeInsertedCSS would reject on it.
 */
export function injectThemeCss(contents: WebContents): Promise<void> {
  return enqueueThemeCssOp(async (generation) => {
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
    const key = await contents.insertCSS(css);
    // A key recorded here after the document went would be removed against the
    // new one, which rejects and takes the theme change behind it down with it.
    if (documentReplaced(generation)) return;
    themeCssKey = key;
    themeLog.debug(`Theme CSS injected: ${theme}`);
  });
}

/**
 * Bring the theme system to life against a window: document tracking, the real
 * applyTheme implementation, re-application on a system colour-scheme change,
 * and the custom.css watcher. Call once.
 */
export function initThemeCSS(win: BrowserWindow): void {
  // Commit of a main-frame navigation; did-navigate-in-page keeps the document,
  // so it is not one and must not advance the counter.
  win.webContents.on('did-navigate', () => {
    documentGeneration += 1;
  });

  applyThemeCSSInternal = (name: ThemeName) => enqueueThemeCssOp(async (generation) => {
    const css = getThemeCss(name);
    if (css !== null && themeCssKey !== null) {
      await win.webContents.removeInsertedCSS(themeCssKey);
      // The removal is awaited, so the new document's own injection may already
      // have run; inserting now would put a second sheet on it.
      if (documentReplaced(generation)) return;
      const key = await win.webContents.insertCSS(css);
      if (documentReplaced(generation)) return;
      themeCssKey = key;
      themeLog.debug(`Theme CSS re-injected: ${name}`);
    } else if (css !== null) {
      const key = await win.webContents.insertCSS(css);
      if (documentReplaced(generation)) return;
      themeCssKey = key;
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

/**
 * Set or clear the tracked key. serviceSwitch.ts clears it before its navigation,
 * because the document that key belongs to is about to be replaced.
 */
export function setThemeCssKey(key: string | null): void {
  themeCssKey = key;
}

/** main.ts supplies rebuildTrayMenu here; see the note on rebuildTrayCallback above. */
export function setRebuildTrayCallback(callback: () => void): void {
  rebuildTrayCallback = callback;
}
