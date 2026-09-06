// test/i18n.test.ts
import { afterEach, describe, it, expect, vi } from 'vitest';
import { app } from 'electron';
import { getLocalizedString, getNavigationStrings, getTrayStrings, LOADING_TEXT } from '../src/i18n';

describe('settings labels', () => {
  it('shares the settings label between navigation and the tray', () => {
    expect(getNavigationStrings().settings).toBe(getTrayStrings().settings);
    expect(getTrayStrings().lastfmConnected).toContain('{name}');
  });
});

describe('getLocalizedString', () => {
  it('returns exact tag match', () => {
    expect(getLocalizedString(LOADING_TEXT, ['zh-TW'])).toBe('載入中…');
  });

  it('falls back to base language', () => {
    expect(getLocalizedString(LOADING_TEXT, ['fr-CA'])).toBe('Chargement...');
  });

  it('falls back to English when no match', () => {
    expect(getLocalizedString(LOADING_TEXT, ['xx-YY'])).toBe('Loading...');
  });

  it('respects priority order', () => {
    expect(getLocalizedString(LOADING_TEXT, ['ja', 'fr'])).toBe('読み込み中…');
  });

  it('handles empty language list', () => {
    expect(getLocalizedString(LOADING_TEXT, [])).toBe('Loading...');
  });
});

// The records load at module scope, so a read failure is only observable on a
// fresh import with fs stubbed for that copy of the module graph alone. A
// file-level fs mock would break the tests above, which need the real files.
async function importI18nWithRead(
  readFileSync: () => string,
): Promise<typeof import('../src/i18n')> {
  vi.resetModules();
  vi.doMock('fs', async () => {
    const actual = await vi.importActual<typeof import('fs')>('fs');
    return { ...actual, default: { ...actual, readFileSync } };
  });
  return import('../src/i18n');
}

/** The error logger of the freshly imported module graph. */
async function freshErrorLog(): Promise<ReturnType<typeof vi.fn>> {
  const { default: log } = await import('electron-log/main');
  return vi.mocked(log.scope('i18n').error);
}

describe('locale file loading', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock('fs');
    vi.resetModules();
  });

  it('names the file and the asarUnpack rule when the read fails', async () => {
    vi.spyOn(app, 'getName').mockReturnValue('Test Player');
    await expect(
      importI18nWithRead(() => {
        throw new Error('ENOENT: no such file or directory');
      }),
    ).rejects.toThrow(/Test Player could not load the locale file .*loading\.json.*ENOENT[\s\S]*asarUnpack/);

    expect(await freshErrorLog()).toHaveBeenCalledWith(
      expect.stringContaining('failed to load locale file'),
    );
  });

  it('names the file when the JSON is malformed', async () => {
    await expect(importI18nWithRead(() => '{ "LOADING_TEXT": ')).rejects.toThrow(
      /loading\.json/,
    );
  });
});
