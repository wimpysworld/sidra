import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/config', () => ({
  getTheme: vi.fn(),
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
import { customCssPath, getThemeCss, hasCustomCss, initThemeCSS, resolveTheme, setThemeCssKey } from '../src/theme';

describe('theme helpers', () => {
  beforeEach(() => {
    vi.mocked(getTheme).mockReturnValue('apple-music');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue('');
  });

  it('builds the custom.css path from userData', () => {
    expect(customCssPath()).toBe(path.join(app.getPath('userData'), 'custom.css'));
  });

  it('reports custom.css presence from disk', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    expect(hasCustomCss()).toBe(true);
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
    const enoent: NodeJS.ErrnoException = new Error('ENOENT: no such file or directory');
    enoent.code = 'ENOENT';
    vi.mocked(fs.readFileSync).mockImplementation(() => { throw enoent; });
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
    vi.useFakeTimers();
    const removeInsertedCSS = vi.fn().mockResolvedValue(undefined);
    const insertCSS = vi.fn().mockResolvedValue('unused');
    let watchHandler: ((eventType: string, filename: string | Buffer | null) => void) | undefined;
    vi.mocked(fs.watch).mockImplementation((_, __, listener) => {
      watchHandler = listener;
      return {
        on: vi.fn(),
        close: vi.fn(),
      } as unknown as fs.FSWatcher;
    });
    const win = {
      isDestroyed: vi.fn().mockReturnValue(false),
      webContents: { removeInsertedCSS, insertCSS },
    } as unknown as Parameters<typeof initThemeCSS>[0];
    vi.mocked(getTheme).mockReturnValue('custom');
    vi.mocked(fs.existsSync).mockReturnValue(false);
    setThemeCssKey('stale-theme-css-key');
    initThemeCSS(win);
    watchHandler?.('change', 'custom.css');
    vi.advanceTimersByTime(151);
    await Promise.resolve();
    await Promise.resolve();
    expect(removeInsertedCSS).toHaveBeenCalledWith('stale-theme-css-key');
    expect(insertCSS).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});
