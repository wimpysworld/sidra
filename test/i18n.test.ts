// test/i18n.test.ts
import { afterEach, describe, it, expect, vi } from 'vitest';
import { app } from 'electron';
import { DISCORD_PLAY_ON_TEXT, getLocalizedString, getNavigationStrings, getTrayStrings, LOADING_TEXT } from '../src/i18n';
import { allServices } from '../src/musicService';

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

  it.each([
    ['zh-Hans-CN', 'zh-CN'], ['zh-Hans', 'zh-CN'], ['zh-Hant-TW', 'zh-TW'],
    ['zh-Hant', 'zh-TW'], ['zh-Hant-HK', 'zh-HK'], ['zh-Hans-SG', 'zh-SG'],
    ['zh-Hant-US', 'zh-TW'], ['zh-Hans-HK', 'zh-CN'], ['ZH-hant-hk', 'zh-HK'],
  ])('resolves %s to %s', (requested, resolved) => {
    const record = Object.fromEntries(Object.keys(LOADING_TEXT).map(lang => [lang, lang]));
    expect(getLocalizedString(record, [requested, 'en'])).toBe(resolved);
  });

  it('continues after a malformed language tag', () => {
    expect(getLocalizedString(LOADING_TEXT, ['not_a_tag', 'fr'])).toBe(LOADING_TEXT.fr);
  });
});

describe('translated UI labels', () => {
  it('keeps every Discord button within the service limit without shortening brand names', () => {
    for (const [lang, template] of Object.entries(DISCORD_PLAY_ON_TEXT)) {
      for (const service of allServices()) {
        const label = template.replace('{service}', service.displayName);
        expect(label, `${lang}: ${service.id}`).toContain(service.displayName);
        expect(label.length, `${lang}: ${service.id}`).toBeLessThanOrEqual(32);
      }
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('uses French labels and preserves literal metadata placeholders', async () => {
    vi.resetModules();
    const { app: freshApp } = await import('electron');
    vi.spyOn(freshApp, 'getPreferredSystemLanguages').mockReturnValue(['fr-CA']);
    const i18n = await import('../src/i18n');
    expect(i18n.getTrayStrings().styleCustom).toBe('Thème personnalisé');
    expect(i18n.getDiscordPlayOnText('Apple Music Classical')).toBe('Lire sur Apple Music Classical');
    expect(i18n.getDiscordArtistText(null)).toBe('par Artiste inconnu');
    expect(i18n.getDiscordArtistText('$&')).toBe('par $&');
    expect(i18n.getAboutStrings().description).toBe('Un client de bureau minimaliste pour Apple Music.');
    expect(i18n.getLoadingText().lang).toBe('fr');
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
