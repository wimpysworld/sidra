import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config', () => ({
  getTheme: vi.fn(),
  getMusicService: vi.fn(() => 'music'),
}));

// Hoisted so the same mock functions survive vi.resetModules(): the
// watcher-failure test loads a second copy of src/theme.ts and has to drive the
// same fs.
const fsMock = vi.hoisted(() => ({
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  watch: vi.fn(),
  mkdirSync: vi.fn(),
}));

vi.mock('fs', () => ({ default: fsMock, ...fsMock }));

import { getMusicService, getTheme } from '../src/config';
import {
  customCssPath,
  getThemeCss,
  hasCustomCss,
  initThemeCSS,
  invalidateCustomCssCache,
  resolveTheme,
  setRebuildTrayCallback,
  setThemeCssKey,
} from '../src/theme';

describe('theme helpers', () => {
  beforeEach(() => {
    vi.mocked(getTheme).mockReturnValue('apple-music');
    // Reset per test, so a switch to classical cannot leak into the next one.
    vi.mocked(getMusicService).mockReturnValue('music');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
    vi.mocked(fs.readFileSync).mockClear();
    vi.mocked(fs.watch).mockReset();
    // custom.css contents are cached for the life of the process, so each test
    // starts from a cold cache.
    invalidateCustomCssCache();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // vi.mocked() resolves fs.watch to its two-argument overload, so the mock is
  // typed against the three-argument form initThemeCSS() actually calls.
  type WatchWithOptions = (
    filename: fs.PathLike,
    options: fs.WatchOptions,
    listener: fs.WatchListener<string | Buffer>,
  ) => fs.FSWatcher;

  // Fake timers plus a captured fs.watch listener, so a test can drive the
  // watcher and step past the 150ms debounce.
  // init defaults to the statically imported module; the cache-disable tests
  // pass a freshly loaded copy so the flag they flip stays out of other tests.
  function watcherHarness(options: { isDestroyed?: boolean; init?: typeof initThemeCSS } = {}) {
    vi.useFakeTimers();
    const removeInsertedCSS = vi.fn().mockResolvedValue(undefined);
    const insertCSS = vi.fn().mockResolvedValue('unused');
    let watchHandler: fs.WatchListener<string | Buffer> | undefined;
    const watcherListeners = new Map<string, (error: Error) => void>();
    vi.mocked(fs.watch as unknown as WatchWithOptions).mockImplementation((_filename, _options, listener) => {
      watchHandler = listener;
      return {
        on: vi.fn((event: string, handler: (error: Error) => void) => {
          watcherListeners.set(event, handler);
        }),
        close: vi.fn(),
      } as unknown as fs.FSWatcher;
    });
    const win = {
      isDestroyed: vi.fn().mockReturnValue(options.isDestroyed ?? false),
      webContents: { removeInsertedCSS, insertCSS },
    } as unknown as Parameters<typeof initThemeCSS>[0];

    return {
      insertCSS,
      removeInsertedCSS,
      win,
      start: () => { (options.init ?? initThemeCSS)(win); },
      // Fire the watcher's own error event, which Node follows by closing it.
      fireError(error: Error = new Error('EBADF: bad file descriptor')) {
        watcherListeners.get('error')?.(error);
      },
      // Fire a watcher event without running the debounce.
      fire(eventType: 'rename' | 'change', filename = 'custom.css') {
        watchHandler?.(eventType, filename);
      },
      // Fire a watcher event, then run the debounce and the CSS promise chain.
      async emit(eventType: 'rename' | 'change') {
        watchHandler?.(eventType, 'custom.css');
        vi.advanceTimersByTime(151);
        await Promise.resolve();
        await Promise.resolve();
      },
    };
  }

  function throwEnoent(): void {
    const enoent: NodeJS.ErrnoException = new Error('ENOENT: no such file or directory');
    enoent.code = 'ENOENT';
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw enoent; });
  }

  it('builds the custom.css path from userData', () => {
    expect(customCssPath()).toBe(path.join(app.getPath('userData'), 'custom.css'));
  });

  it('reports custom.css presence from file content', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    expect(hasCustomCss()).toBe(true);
  });

  it('reports no custom.css when the file is missing', () => {
    throwEnoent();
    expect(hasCustomCss()).toBe(false);
  });

  it('agrees with resolveTheme for whitespace-only custom.css', () => {
    vi.mocked(getTheme).mockReturnValue('custom');
    // The file is on disk, so an existence check would call it present.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('   \n');
    expect(hasCustomCss()).toBe(false);
    expect(resolveTheme()).toBe('apple-music');
  });

  it('agrees with resolveTheme for populated custom.css', () => {
    vi.mocked(getTheme).mockReturnValue('custom');
    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    expect(hasCustomCss()).toBe(true);
    expect(resolveTheme()).toBe('custom');
  });

  it('falls back to apple-music for unknown stored themes', () => {
    vi.mocked(getTheme).mockReturnValue('not-a-theme' as never);
    expect(resolveTheme()).toBe('apple-music');
  });

  it('falls back to apple-music when custom theme is selected without custom.css', () => {
    vi.mocked(getTheme).mockReturnValue('custom');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    expect(resolveTheme()).toBe('apple-music');
  });

  it('keeps custom when custom.css exists', () => {
    vi.mocked(getTheme).mockReturnValue('custom');
    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    expect(resolveTheme()).toBe('custom');
  });

  it('falls back to apple-music when custom.css is empty or whitespace', () => {
    vi.mocked(getTheme).mockReturnValue('custom');
    vi.mocked(fs.readFileSync).mockReturnValue('\n  \n');
    expect(resolveTheme()).toBe('apple-music');
  });

  it('forces apple-music on classical for a bundled theme', () => {
    // Bundled theme CSS targets the music.apple.com DOM, so classical gets none.
    vi.mocked(getTheme).mockReturnValue('catppuccin');
    vi.mocked(getMusicService).mockReturnValue('classical');
    expect(resolveTheme()).toBe('apple-music');
  });

  it('forces apple-music on classical even with populated custom.css', () => {
    vi.mocked(getTheme).mockReturnValue('custom');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    vi.mocked(getMusicService).mockReturnValue('classical');
    expect(resolveTheme()).toBe('apple-music');
  });

  it('restores the stored theme when the service switches back from classical', () => {
    // The gate suppresses the theme; it never rewrites the stored value.
    vi.mocked(getTheme).mockReturnValue('catppuccin');
    expect(resolveTheme()).toBe('catppuccin');

    vi.mocked(getMusicService).mockReturnValue('classical');
    expect(resolveTheme()).toBe('apple-music');
    expect(getTheme()).toBe('catppuccin');

    vi.mocked(getMusicService).mockReturnValue('music');
    expect(resolveTheme()).toBe('catppuccin');
  });

  it('returns null for apple-music even with populated custom.css', () => {
    // apple-music means "inject no override CSS", so it must never pick up the
    // custom.css a fall-through past the guard would reach.
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    expect(getThemeCss('apple-music')).toBeNull();
    expect(fs.readFileSync).not.toHaveBeenCalled();
  });

  it('returns null for missing custom.css', () => {
    throwEnoent();
    expect(getThemeCss('custom')).toBeNull();
  });

  it('returns null for empty or whitespace custom.css', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('\n  \n');
    expect(getThemeCss('custom')).toBeNull();
  });

  it('returns custom.css content when present', () => {
    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    expect(getThemeCss('custom')).toBe('body { color: red; }');
  });

  it('reads custom.css once across repeated resolveTheme calls', () => {
    vi.mocked(getTheme).mockReturnValue('custom');
    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    expect(resolveTheme()).toBe('custom');
    expect(resolveTheme()).toBe('custom');
    expect(resolveTheme()).toBe('custom');
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('serves hasCustomCss and getThemeCss from the same cached read', () => {
    vi.mocked(getTheme).mockReturnValue('custom');
    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    expect(hasCustomCss()).toBe(true);
    expect(getThemeCss('custom')).toBe('body { color: red; }');
    expect(resolveTheme()).toBe('custom');
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('caches the absence of custom.css rather than retrying the read', () => {
    throwEnoent();
    expect(hasCustomCss()).toBe(false);
    expect(hasCustomCss()).toBe(false);
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('re-reads custom.css as soon as the watcher fires, before the debounce', () => {
    const harness = watcherHarness();
    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    harness.start();
    expect(getThemeCss('custom')).toBe('body { color: red; }');
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);

    vi.mocked(fs.readFileSync).mockReturnValue('body { color: blue; }');
    harness.fire('change');
    expect(getThemeCss('custom')).toBe('body { color: blue; }');
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });

  it('keeps the cache when the watcher event names another file', () => {
    const harness = watcherHarness();
    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    harness.start();
    expect(getThemeCss('custom')).toBe('body { color: red; }');

    harness.fire('change', 'config.json');
    expect(getThemeCss('custom')).toBe('body { color: red; }');
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);
  });

  it('stops caching when the watcher cannot start', async () => {
    // Nothing would clear a cache the watcher never populates events for, so a
    // failed watcher has to fall back to reading on every call.
    vi.resetModules();
    vi.mocked(fs.watch).mockImplementation(() => { throw new Error('EMFILE: too many open files'); });
    const theme = await import('../src/theme');
    const win = {
      isDestroyed: vi.fn().mockReturnValue(false),
      webContents: { removeInsertedCSS: vi.fn(), insertCSS: vi.fn() },
    } as unknown as Parameters<typeof initThemeCSS>[0];
    theme.initThemeCSS(win);

    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    expect(theme.getThemeCss('custom')).toBe('body { color: red; }');
    vi.mocked(fs.readFileSync).mockReturnValue('body { color: blue; }');
    expect(theme.getThemeCss('custom')).toBe('body { color: blue; }');
  });

  it('reads custom.css on every call once the watcher has failed to start', async () => {
    // Two reads, two filesystem calls: the cache is off, not merely cleared.
    vi.resetModules();
    vi.mocked(fs.watch).mockImplementation(() => { throw new Error('EMFILE: too many open files'); });
    const theme = await import('../src/theme');
    const win = {
      isDestroyed: vi.fn().mockReturnValue(false),
      webContents: { removeInsertedCSS: vi.fn(), insertCSS: vi.fn() },
    } as unknown as Parameters<typeof initThemeCSS>[0];
    theme.initThemeCSS(win);

    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    expect(theme.getThemeCss('custom')).toBe('body { color: red; }');
    expect(theme.getThemeCss('custom')).toBe('body { color: red; }');
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });

  it('drops the warm custom.css cache when the watcher reports an error', async () => {
    // Node closes the watcher on error, so the cache it warmed is now stale
    // with nothing left to clear it.
    vi.resetModules();
    const theme = await import('../src/theme');
    const harness = watcherHarness({ init: theme.initThemeCSS });
    harness.start();

    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    expect(theme.getThemeCss('custom')).toBe('body { color: red; }');
    expect(fs.readFileSync).toHaveBeenCalledTimes(1);

    harness.fireError();

    vi.mocked(fs.readFileSync).mockReturnValue('body { color: blue; }');
    expect(theme.getThemeCss('custom')).toBe('body { color: blue; }');
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });

  it('reads custom.css on every call after a watcher error', async () => {
    vi.resetModules();
    const theme = await import('../src/theme');
    const harness = watcherHarness({ init: theme.initThemeCSS });
    harness.start();

    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    expect(theme.getThemeCss('custom')).toBe('body { color: red; }');
    harness.fireError();

    // Two reads after the error, two filesystem calls: caching stays off rather
    // than warming again on the next read.
    vi.mocked(fs.readFileSync).mockClear();
    expect(theme.getThemeCss('custom')).toBe('body { color: red; }');
    expect(theme.getThemeCss('custom')).toBe('body { color: red; }');
    expect(fs.readFileSync).toHaveBeenCalledTimes(2);
  });

  it('renders bundled theme CSS', () => {
    const css = getThemeCss('catppuccin');
    expect(css).toContain('@media (prefers-color-scheme: dark)');
    expect(css).toContain('@media (prefers-color-scheme: light)');
    expect(css).toContain('--pageBG: #1e1e2e !important;');
  });

  it('removes injected css when custom.css disappears for stored custom theme', async () => {
    const harness = watcherHarness();
    vi.mocked(getTheme).mockReturnValue('custom');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    setThemeCssKey('stale-theme-css-key');
    harness.start();
    await harness.emit('change');
    expect(harness.removeInsertedCSS).toHaveBeenCalledWith('stale-theme-css-key');
    expect(harness.insertCSS).not.toHaveBeenCalled();
  });

  it('rebuilds the tray menu after create, write and delete events', async () => {
    const rebuildTray = vi.fn();
    setRebuildTrayCallback(rebuildTray);
    const harness = watcherHarness();
    vi.mocked(getTheme).mockReturnValue('custom');
    setThemeCssKey(null);
    harness.start();

    // Create: the file appears with content.
    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    await harness.emit('rename');
    expect(rebuildTray).toHaveBeenCalledTimes(1);

    // Write: the content changes.
    vi.mocked(fs.readFileSync).mockReturnValue('body { color: blue; }');
    await harness.emit('change');
    expect(rebuildTray).toHaveBeenCalledTimes(2);

    // Delete: the file is gone.
    throwEnoent();
    await harness.emit('rename');
    expect(rebuildTray).toHaveBeenCalledTimes(3);
  });

  it('rebuilds the tray menu when the stored theme is not custom', async () => {
    const rebuildTray = vi.fn();
    setRebuildTrayCallback(rebuildTray);
    const harness = watcherHarness();
    vi.mocked(getTheme).mockReturnValue('catppuccin');
    setThemeCssKey(null);
    harness.start();

    // custom.css appears while a bundled theme is active: no CSS work, but the
    // tray still needs the new Style entry.
    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    await harness.emit('rename');
    expect(rebuildTray).toHaveBeenCalledTimes(1);
    expect(harness.insertCSS).not.toHaveBeenCalled();
    expect(harness.removeInsertedCSS).not.toHaveBeenCalled();
  });

  it('does not rebuild the tray menu when the window is destroyed', async () => {
    const rebuildTray = vi.fn();
    setRebuildTrayCallback(rebuildTray);
    const harness = watcherHarness({ isDestroyed: true });
    vi.mocked(getTheme).mockReturnValue('custom');
    setThemeCssKey(null);
    harness.start();

    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    await harness.emit('change');
    expect(rebuildTray).not.toHaveBeenCalled();
  });
});
