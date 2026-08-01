import fs from 'fs';
import path from 'path';
import { app, type WebContents } from 'electron';
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
  applyTheme,
  customCssPath,
  getThemeCss,
  hasCustomCss,
  initThemeCSS,
  injectThemeCss,
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
    const contentsListeners = new Map<string, () => void>();
    const win = {
      isDestroyed: vi.fn().mockReturnValue(options.isDestroyed ?? false),
      webContents: {
        removeInsertedCSS,
        insertCSS,
        on: vi.fn((event: string, handler: () => void) => {
          contentsListeners.set(event, handler);
        }),
      },
    } as unknown as Parameters<typeof initThemeCSS>[0];

    return {
      insertCSS,
      removeInsertedCSS,
      win,
      start: () => { (options.init ?? initThemeCSS)(win); },
      // Commit a main-frame navigation, which replaces the document.
      navigate() {
        contentsListeners.get('did-navigate')?.();
      },
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

  // applyTheme() returns void and the CSS queue is not exported, so draining
  // the microtask queue is the only way to wait for work it enqueued.
  async function flushCssQueue(): Promise<void> {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
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

  it('keeps a bundled theme on classical', () => {
    vi.mocked(getTheme).mockReturnValue('catppuccin');
    vi.mocked(getMusicService).mockReturnValue('classical');
    expect(resolveTheme()).toBe('catppuccin');
  });

  it('keeps custom on classical with populated custom.css', () => {
    vi.mocked(getTheme).mockReturnValue('custom');
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('body { color: red; }');
    vi.mocked(getMusicService).mockReturnValue('classical');
    expect(resolveTheme()).toBe('custom');
  });

  it('resolves the same theme across a music to classical to music switch', () => {
    // The active service is not an input to resolveTheme().
    vi.mocked(getTheme).mockReturnValue('catppuccin');
    expect(resolveTheme()).toBe('catppuccin');

    vi.mocked(getMusicService).mockReturnValue('classical');
    expect(resolveTheme()).toBe('catppuccin');

    vi.mocked(getMusicService).mockReturnValue('music');
    expect(resolveTheme()).toBe('catppuccin');
  });

  // main.ts calls injectThemeCss() from injectContent() on every page load, and
  // src/main.ts cannot be imported under Vitest, so this is where that path is
  // covered.
  describe('injectThemeCss', () => {
    beforeEach(() => {
      // The key outlives the module, so each test starts with none injected.
      setThemeCssKey(null);
    });

    function fakeContents() {
      const insertCSS = vi.fn().mockResolvedValue('key');
      return { insertCSS, contents: { insertCSS } as unknown as WebContents };
    }

    // A WebContents whose insertCSS stays pending until release() is called, so
    // a test can hold a page-load injection open and queue work behind it.
    function heldContents() {
      let release: (key: string) => void = () => { /* replaced below */ };
      const pending = new Promise<string>((resolve) => { release = resolve; });
      const insertCSS = vi.fn().mockReturnValue(pending);
      return { insertCSS, release: (key: string) => { release(key); }, contents: { insertCSS } as unknown as WebContents };
    }

    it('injects bundled theme CSS while classical is active', async () => {
      vi.mocked(getTheme).mockReturnValue('catppuccin');
      vi.mocked(getMusicService).mockReturnValue('classical');
      const { insertCSS, contents } = fakeContents();

      await injectThemeCss(contents);

      expect(insertCSS).toHaveBeenCalledTimes(1);
      const [css] = insertCSS.mock.calls[0] as [string];
      expect(css).toContain('--pageBG');
    });

    it('injects nothing for the apple-music theme', async () => {
      vi.mocked(getTheme).mockReturnValue('apple-music');
      const { insertCSS, contents } = fakeContents();

      await injectThemeCss(contents);

      expect(insertCSS).not.toHaveBeenCalled();
    });

    it('clears a stale key on the apple-music path', async () => {
      // The load replaced the document, so a key held from the previous one is
      // stale. removeInsertedCSS rejects on a stale key and that rejection
      // aborts the theme change that follows, so the key must not survive here.
      const harness = watcherHarness();
      harness.start();
      vi.mocked(getTheme).mockReturnValue('apple-music');
      setThemeCssKey('stale-key');
      const { insertCSS, contents } = fakeContents();

      await injectThemeCss(contents);
      expect(insertCSS).not.toHaveBeenCalled();

      // The next theme change must reach its insert, with no removal attempted.
      applyTheme('catppuccin');
      await flushCssQueue();

      expect(harness.removeInsertedCSS).not.toHaveBeenCalled();
      expect(harness.insertCSS).toHaveBeenCalledTimes(1);
    });

    it('leaves one stylesheet when a theme change lands during a page load', async () => {
      // Both entry points share one queue, so the theme change waits for the
      // in-flight injection and removes the key that injection produced.
      // Interleaved, the change would insert against a null key and strand the
      // page-load stylesheet with nothing left holding its key.
      const harness = watcherHarness();
      harness.insertCSS.mockResolvedValue('theme-key');
      harness.start();
      vi.mocked(getTheme).mockReturnValue('catppuccin');
      const { insertCSS, release, contents } = heldContents();

      const loading = injectThemeCss(contents);
      await flushCssQueue();
      expect(insertCSS).toHaveBeenCalledTimes(1);

      applyTheme('nord');
      await flushCssQueue();

      // The theme change is queued behind the load, not racing it.
      expect(harness.removeInsertedCSS).not.toHaveBeenCalled();
      expect(harness.insertCSS).not.toHaveBeenCalled();

      release('load-key');
      await loading;
      await flushCssQueue();

      // Two inserts, one removal of the first insert's key: one sheet survives.
      expect(harness.removeInsertedCSS).toHaveBeenCalledTimes(1);
      expect(harness.removeInsertedCSS).toHaveBeenCalledWith('load-key');
      expect(insertCSS).toHaveBeenCalledTimes(1);
      expect(harness.insertCSS).toHaveBeenCalledTimes(1);
    });

    it('drops queued work when the document is replaced before it runs', async () => {
      // insertCSS reaches whatever document the WebContents holds at call time.
      // Queued behind an in-flight operation, an injection for the old page
      // would land on the new one, beside that page's own injection, and only
      // the later key would be tracked.
      const harness = watcherHarness();
      harness.start();
      vi.mocked(getTheme).mockReturnValue('catppuccin');
      const held = heldContents();
      const stale = fakeContents();

      const inFlight = injectThemeCss(held.contents);
      await flushCssQueue();
      expect(held.insertCSS).toHaveBeenCalledTimes(1);

      // A second load queues behind the first, then its document is replaced.
      const queued = injectThemeCss(stale.contents);
      harness.navigate();
      held.release('load-key');
      await inFlight;
      await queued;
      await flushCssQueue();

      expect(stale.insertCSS).not.toHaveBeenCalled();

      // The key the released operation wrote belongs to the replaced document,
      // so the next theme change must insert without attempting a removal.
      applyTheme('nord');
      await flushCssQueue();
      expect(harness.removeInsertedCSS).not.toHaveBeenCalled();
      expect(harness.insertCSS).toHaveBeenCalledTimes(1);

      // The queue still runs work queued after the navigation.
      const fresh = fakeContents();
      await injectThemeCss(fresh.contents);
      expect(fresh.insertCSS).toHaveBeenCalledTimes(1);
    });
  });

  it('drops a live theme replacement when the document is replaced mid-removal', async () => {
    // The removal and the insert are two awaits, so a navigation that commits
    // between them lands after the pre-flight generation check has passed. The
    // insert would then reach the new document beside that document's own
    // injection, leaving a sheet nothing holds the key for.
    const harness = watcherHarness();
    harness.start();
    setThemeCssKey('live-key');
    let releaseRemoval: () => void = () => { /* replaced below */ };
    harness.removeInsertedCSS.mockReturnValue(new Promise<void>((resolve) => { releaseRemoval = resolve; }));

    applyTheme('catppuccin');
    await flushCssQueue();
    expect(harness.removeInsertedCSS).toHaveBeenCalledWith('live-key');
    expect(harness.insertCSS).not.toHaveBeenCalled();

    harness.navigate();
    releaseRemoval();
    await flushCssQueue();

    expect(harness.insertCSS).not.toHaveBeenCalled();

    // The key belonged to the replaced document, so the next theme change must
    // reach its insert with no removal attempted.
    harness.removeInsertedCSS.mockResolvedValue(undefined);
    applyTheme('nord');
    await flushCssQueue();

    expect(harness.removeInsertedCSS).toHaveBeenCalledTimes(1);
    expect(harness.insertCSS).toHaveBeenCalledTimes(1);
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
      webContents: { removeInsertedCSS: vi.fn(), insertCSS: vi.fn(), on: vi.fn() },
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
      webContents: { removeInsertedCSS: vi.fn(), insertCSS: vi.fn(), on: vi.fn() },
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
