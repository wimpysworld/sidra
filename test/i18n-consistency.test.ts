// test/i18n-consistency.test.ts
import { describe, it, expect } from 'vitest';
import * as i18n from '../src/i18n';

const TRANSLATION_RECORDS = [
  'LOADING_TEXT', 'ABOUT_TEXT', 'QUIT_TEXT', 'NOTIFICATIONS_TEXT',
  'DISCORD_TEXT', 'ON_TEXT', 'OFF_TEXT', 'START_PAGE_TEXT',
  'START_PAGE_HOME_TEXT', 'START_PAGE_NEW_TEXT', 'START_PAGE_RADIO_TEXT',
  'START_PAGE_ALL_PLAYLISTS_TEXT', 'START_PAGE_LAST_TEXT',
  'CATPPUCCIN_TEXT', 'STYLE_TEXT', 'STYLE_APPLE_MUSIC_TEXT',
  'ZOOM_TEXT', 'UPDATE_AVAILABLE_TEXT', 'UP_TO_DATE_TEXT',
  'UPDATE_READY_TEXT',
  'CLOSE_TEXT', 'VERSION_PREFIX', 'COPYRIGHT_SUFFIX', 'LICENSE_PREFIX',
] as const;

describe('i18n translation records', () => {
  const referenceKeys = Object.keys(
    (i18n as Record<string, Record<string, string>>)[TRANSLATION_RECORDS[0]]
  ).sort();

  for (const name of TRANSLATION_RECORDS) {
    const record = (i18n as Record<string, Record<string, string>>)[name];

    it(`${name} is exported from i18n`, () => {
      expect(record, `${name} is listed in TRANSLATION_RECORDS but not exported from src/i18n`).toBeDefined();
    });

    if (!record) continue;

    it(`${name} has the same language keys as LOADING_TEXT`, () => {
      expect(Object.keys(record).sort()).toEqual(referenceKeys);
    });

    it(`${name} has no empty values`, () => {
      for (const [lang, value] of Object.entries(record)) {
        expect(value, `${name}['${lang}'] is empty`).not.toBe('');
      }
    });

    it(`${name} includes English fallback`, () => {
      expect(record).toHaveProperty('en');
    });
  }
});
