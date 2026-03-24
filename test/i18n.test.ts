// test/i18n.test.ts
import { describe, it, expect } from 'vitest';
import { getLocalizedString, LOADING_TEXT } from '../src/i18n';

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
