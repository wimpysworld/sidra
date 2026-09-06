import fs from 'fs';
import path from 'path';
import { app, BrowserWindow, nativeTheme, type WebContents } from 'electron';
import log from 'electron-log/main';
import { bundledTheme, isThemeName, type BundledThemeName, type ThemeName } from './palettes';
import { buildThemeCss } from './themeTemplate';
import { parseCustomTheme } from './customTheme';
import { getTheme } from './config';

export type { ThemeName };

const themeLog = log.scope('theme');

const THEME_RELOAD_DEBOUNCE_MS = 150;
const customThemeFilename = 'custom-theme.json';
const bundledCssCache = new Map<BundledThemeName, string>();

// custom-theme.json is read for Settings, through both hasCustomTheme() and
// resolveTheme(), so its generated CSS is cached and the fs.watch callback below
// clears the cache. Nothing else would clear it, so a watcher that never starts
// or dies switches caching off rather than leaving a cache that goes stale for
// the life of the process.
let customThemeCache: string | null = null;
let customThemeCached = false;
let customThemeCacheEnabled = true;

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

// Insert a stylesheet and record its key, the only place either happens. The
// generation is re-checked after the insert: a key recorded once the document
// has gone would be removed against the new one, which rejects and takes the
// theme change behind it down with it.
async function insertAndTrack(
  contents: WebContents,
  css: string,
  generation: number,
  appliedMessage: string,
): Promise<void> {
  const key = await contents.insertCSS(css);
  if (documentReplaced(generation)) return;
  themeCssKey = key;
  themeLog.debug(appliedMessage);
}

// Apply or remove theme CSS on the main window.
// Handles enable, disable, and re-injection (variant change) cases.
//
// Before initialisation there is no document to update. Settings persists the
// choice before calling applyTheme(), and injectThemeCss() reads that choice on
// every page load, so an early change needs no queued replay.
let applyThemeCSSInternal: (name: ThemeName) => Promise<void> = (name: ThemeName) => {
  themeLog.warn(`Theme CSS not applied, theme system not initialised yet: ${name}`);
  return Promise.resolve();
};

// main.ts supplies the callback to refresh Settings without an import cycle.
let themeChangedCallback: (() => void) | null = null;

/** Queue a theme change against the live page. Failures are logged, never thrown. */
export function applyTheme(name: ThemeName): void {
  void applyThemeCSSInternal(name);
}

/** The custom palette path: custom-theme.json in the userData directory. */
export function customThemePath(): string {
  return path.join(app.getPath('userData'), customThemeFilename);
}

/** True when custom-theme.json contains a valid palette. */
export function hasCustomTheme(): boolean {
  return getThemeCss('custom') !== null;
}

/**
 * The theme to render: the stored one, falling back to 'apple-music' when it is
 * unknown or when 'custom' is stored without a valid custom-theme.json.
 */
export function resolveTheme(): ThemeName {
  const theme = getTheme();
  if (!isThemeName(theme)) return 'apple-music';
  if (theme === 'custom' && getThemeCss('custom') === null) return 'apple-music';
  return theme;
}

function readCustomTheme(): string | null {
  try {
    const theme = parseCustomTheme(fs.readFileSync(customThemePath(), 'utf-8'));
    if (!theme) {
      themeLog.warn('Invalid custom-theme.json in userData directory');
      return null;
    }
    return buildThemeCss(theme);
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== 'ENOENT') {
      themeLog.warn('Failed to read custom-theme.json from userData directory', error);
    }
    return null;
  }
}

/** Drop the generated Custom Theme CSS cache. */
export function invalidateCustomThemeCache(): void {
  customThemeCache = null;
  customThemeCached = false;
}

function disableCustomThemeCache(): void {
  customThemeCacheEnabled = false;
  invalidateCustomThemeCache();
}

/**
 * Stylesheet for a theme, or null for 'apple-music' and for a missing or invalid
 * custom-theme.json. Bundled themes are rendered once and cached. Custom Theme
 * CSS is cached while the watcher below can invalidate it.
 */
export function getThemeCss(name: ThemeName): string | null {
  if (name === 'apple-music') return null;
  if (name === 'custom') {
    if (customThemeCached) return customThemeCache;
    const css = readCustomTheme();
    if (customThemeCacheEnabled) {
      customThemeCache = css;
      customThemeCached = true;
    }
    return css;
  }

  const cached = bundledCssCache.get(name);
  if (cached) return cached;
  const theme = bundledTheme(name);
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
    await insertAndTrack(contents, css, generation, `Theme CSS injected: ${theme}`);
  });
}

/**
 * Bring the theme system to life against a window: document tracking, the real
 * applyTheme implementation, re-application on a system colour-scheme change,
 * and the custom-theme.json watcher. Call once.
 */
export function initThemeCSS(win: BrowserWindow): void {
  // Commit of a main-frame navigation; did-navigate-in-page keeps the document,
  // so it is not one and must not advance the counter.
  win.webContents.on('did-navigate', () => {
    documentGeneration += 1;
  });

  applyThemeCSSInternal = (name: ThemeName) => enqueueThemeCssOp(async (generation) => {
    const css = getThemeCss(name);
    const previousKey = themeCssKey;
    if (previousKey !== null) {
      await win.webContents.removeInsertedCSS(previousKey);
      themeCssKey = null;
      // The removal is awaited, so the new document's own injection may already
      // have run; inserting now would put a second sheet on it.
      if (documentReplaced(generation)) return;
    }
    if (css === null) {
      if (previousKey !== null) themeLog.debug(`Theme CSS removed: ${name}`);
      return;
    }
    const verb = previousKey !== null ? 're-injected' : 'injected';
    await insertAndTrack(win.webContents, css, generation, `Theme CSS ${verb}: ${name}`);
  });

  nativeTheme.on('updated', () => {
    const currentTheme = resolveTheme();
    if (currentTheme !== 'apple-music') {
      void applyThemeCSSInternal(currentTheme);
    }
  });

  // Last, because the debounced callback below calls applyThemeCSSInternal and
  // resolveTheme against the window this function has just wired up.
  initCustomThemeWatcher(win);
}

/**
 * Watch the userData directory for custom-theme.json changes, re-apply the CSS when the
 * stored theme needs it, and refresh Settings. Owns its debounce timer and closes
 * both on will-quit.
 */
function initCustomThemeWatcher(win: BrowserWindow): void {
  let customThemeTimer: NodeJS.Timeout | null = null;
  const userDataPath = app.getPath('userData');
  let watcher: fs.FSWatcher | null = null;
  try {
    fs.mkdirSync(userDataPath, { recursive: true });
    watcher = fs.watch(userDataPath, { persistent: false }, (eventType, filename) => {
      // macOS may emit a null filename for directory-level change events.
      if (filename !== null && filename.toString() !== customThemeFilename) return;
      themeLog.debug(`custom-theme.json watcher event: ${eventType}`);
      // Before the debounce, not inside it: a Settings refresh during the debounce
      // window must not read the previous contents back out of the cache.
      invalidateCustomThemeCache();
      if (customThemeTimer) clearTimeout(customThemeTimer);
      customThemeTimer = setTimeout(() => {
        customThemeTimer = null;
        if (win.isDestroyed()) return;
        const resolved = resolveTheme();
        if (resolved === 'custom') {
          void applyThemeCSSInternal('custom');
        } else if (getTheme() === 'custom') {
          void applyThemeCSSInternal('apple-music');
        }
        // File creation and deletion change the Settings options for every stored theme.
        themeChangedCallback?.();
      }, THEME_RELOAD_DEBOUNCE_MS);
    });
    watcher.on('error', (error) => {
      themeLog.warn('custom-theme.json watcher error', error);
      // Node closes the watcher on error, so nothing is left to clear the cache.
      disableCustomThemeCache();
    });
  } catch (error) {
    themeLog.warn('Failed to initialise custom-theme.json watcher', error);
    disableCustomThemeCache();
  }

  app.on('will-quit', () => {
    if (customThemeTimer) {
      clearTimeout(customThemeTimer);
      customThemeTimer = null;
    }
    if (watcher) {
      watcher.close();
      watcher = null;
    }
  });
}

/**
 * Told by serviceSwitch.ts that a navigation is about to replace the document, so
 * the sheet the tracked key names is about to go with it and the next injection
 * must not remove against that key.
 *
 * The clear is queued rather than written straight to the field, because the field
 * belongs to the chain: an insert already in flight records its own key when it
 * resolves, and a raw write made before that would be overwritten by it. Queueing
 * cannot lose the clear either. Work dropped for a stale generation clears the key
 * on its way out, so both paths through the queue leave nothing tracked, and FIFO
 * order puts this ahead of the next document's own injection, which is queued from
 * that document's load.
 */
export function notifyDocumentReplacing(): void {
  void enqueueThemeCssOp(() => {
    themeCssKey = null;
    return Promise.resolve();
  });
}

/** main.ts supplies the Settings refresh callback here. */
export function setThemeChangedCallback(callback: () => void): void {
  themeChangedCallback = callback;
}
