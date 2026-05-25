import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import log from 'electron-log/main';

const customCssLog = log.scope('customCss');

const WATCH_DEBOUNCE_MS = 150;
const TARGET_FILE = 'custom.css';

let cssKey: string | null = null;
let watcher: fs.FSWatcher | null = null;
let debounceTimer: NodeJS.Timeout | null = null;
let cssOp: Promise<void> = Promise.resolve();
let targetWindow: BrowserWindow | null = null;

function customCssPath(): string {
  return path.join(app.getPath('userData'), TARGET_FILE);
}

function readCustomCss(): string | null {
  try {
    return fs.readFileSync(customCssPath(), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return null;
    customCssLog.warn('failed to read custom.css', err);
    return null;
  }
}

export function applyCustomCss(win: BrowserWindow): Promise<void> {
  cssOp = cssOp
    .catch((err: unknown) => {
      customCssLog.warn('custom CSS op failed', err);
    })
    .then(async () => {
      if (cssKey !== null) {
        // the key may be stale after a page navigation; if so the inserted
        // stylesheet is already gone and remove throws
        try {
          await win.webContents.removeInsertedCSS(cssKey);
        } catch {
          // stale key, nothing to clean up
        }
        cssKey = null;
      }
      const css = readCustomCss();
      if (css !== null && css.trim() !== '') {
        cssKey = await win.webContents.insertCSS(css);
        customCssLog.debug('custom.css applied');
      }
    });
  return cssOp;
}

export function initCustomCss(win: BrowserWindow): void {
  targetWindow = win;
  const dir = app.getPath('userData');

  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    customCssLog.warn('failed to ensure userData dir exists', err);
    return;
  }

  try {
    watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
      if (filename !== TARGET_FILE) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        if (!targetWindow || targetWindow.isDestroyed()) return;
        customCssLog.debug('custom.css changed, re-applying');
        void applyCustomCss(targetWindow);
      }, WATCH_DEBOUNCE_MS);
    });
    watcher.on('error', (err) => {
      customCssLog.warn('watcher error', err);
    });
    customCssLog.debug(`watching ${path.join(dir, TARGET_FILE)}`);
  } catch (err) {
    customCssLog.warn('failed to watch userData for custom.css', err);
  }

  app.on('will-quit', () => {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }
    if (watcher) {
      watcher.close();
      watcher = null;
    }
    targetWindow = null;
  });
}
