import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config', () => ({
  getTheme: vi.fn(),
  getMusicService: vi.fn(() => 'music'),
}));

vi.mock('fs', () => ({
  default: {
    readFileSync: vi.fn(),
    existsSync: vi.fn(),
    watch: vi.fn(),
    mkdirSync: vi.fn(),
  },
  readFileSync: vi.fn(),
  existsSync: vi.fn(),
  watch: vi.fn(),
  mkdirSync: vi.fn(),
}));

import { getTheme } from '../src/config';
import {
  customCssPath,
  getThemeCss,
  hasCustomCss,
  initThemeCSS,
  resolveTheme,
  setRebuildTrayCallback,
  setThemeCssKey,
} from '../src/theme';

describe('theme helpers', () => {
  beforeEach(() => {
    vi.mocked(getTheme).mockReturnValue('apple-music');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
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
  function watcherHarness(options: { isDestroyed?: boolean } = {}) {
    vi.useFakeTimers();
    const removeInsertedCSS = vi.fn().mockResolvedValue(undefined);
    const insertCSS = vi.fn().mockResolvedValue('unused');
    let watchHandler: fs.WatchListener<string | Buffer> | undefined;
    vi.mocked(fs.watch as unknown as WatchWithOptions).mockImplementation((_filename, _options, listener) => {
      watchHandler = listener;
      return {
        on: vi.fn(),
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
      start: () => { initThemeCSS(win); },
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
