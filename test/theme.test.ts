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
import { customCssPath, getThemeCss, hasCustomCss, resolveTheme } from '../src/theme';

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
    vi.mocked(fs.existsSync).mockReturnValue(true);
    expect(resolveTheme()).toBe('custom');
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
});
