import { app, BrowserWindow, nativeTheme } from 'electron';
import log from 'electron-log/main';
import { getCatppuccinEnabled } from './config';

const mainLog = log.scope('main');

// Track injected Catppuccin CSS for live toggle
let catppuccinCssKey: string | null = null;

// Apply or remove Catppuccin CSS on the main window.
// Handles enable, disable, and re-injection (variant change) cases.
let applyCatppuccinCSS: (enabled: boolean) => Promise<void>;

export function initCatppuccinCSS(win: BrowserWindow, CATPPUCCIN_CSS: string): void {
  let catppuccinCssOp = Promise.resolve();
  applyCatppuccinCSS = (enabled: boolean) => {
    catppuccinCssOp = catppuccinCssOp
      .catch((error) => {
        mainLog.warn('Catppuccin CSS operation failed', error);
      })
      .then(async () => {
      if (enabled && catppuccinCssKey !== null) {
        await win.webContents.removeInsertedCSS(catppuccinCssKey);
        catppuccinCssKey = await win.webContents.insertCSS(CATPPUCCIN_CSS);
        mainLog.debug('Catppuccin CSS re-injected');
      } else if (enabled) {
        catppuccinCssKey = await win.webContents.insertCSS(CATPPUCCIN_CSS);
        mainLog.debug('Catppuccin CSS injected');
      } else if (catppuccinCssKey !== null) {
        await win.webContents.removeInsertedCSS(catppuccinCssKey);
        catppuccinCssKey = null;
        mainLog.debug('Catppuccin CSS removed');
      }
    });
    return catppuccinCssOp;
  };

  (app as NodeJS.EventEmitter).on('catppuccin-toggle', (_event: unknown, enabled: boolean) => {
    void applyCatppuccinCSS(enabled);
  });

  nativeTheme.on('updated', () => {
    if (getCatppuccinEnabled()) {
      void applyCatppuccinCSS(true);
    }
  });
}

export function setCatppuccinCssKey(key: string | null): void {
  catppuccinCssKey = key;
}
