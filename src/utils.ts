import type { BrowserWindow, WebContents } from 'electron';

/**
 * The window's renderer, or null when nothing is left to receive a message.
 *
 * `webContents` is a native getter that throws `Object has been destroyed` once
 * the window has gone, so a truthy `BrowserWindow` reference is not enough to
 * read it. Quitting destroys the window before `will-quit` runs, and the
 * unguarded read there put a main-process error dialog on screen (#257). This
 * is the one guard every main-to-renderer send and every teardown goes through,
 * so the check is made in one place.
 *
 * The import is type-only, which keeps this module free of electron at runtime.
 */
export function liveWebContents(win: BrowserWindow | null | undefined): WebContents | null {
  if (!win || win.isDestroyed()) return null;
  const contents = win.webContents;
  return contents && !contents.isDestroyed() ? contents : null;
}

/**
 * The message of an Error, or the value itself as a string. A catch binds
 * unknown under strict mode, so this holds the narrowing every log site needs.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run named steps in order, continuing after each reported failure.
 * The caller supplies the reporter to keep this module independent of electron-log.
 */
export function runSteps(
  steps: readonly (readonly [string, () => void])[],
  report: (name: string, err: unknown) => void,
): void {
  for (const [name, step] of steps) {
    try {
      step();
    } catch (e: unknown) {
      report(name, e);
    }
  }
}
