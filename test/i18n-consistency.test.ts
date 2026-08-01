// test/i18n-consistency.test.ts
import fs from 'node:fs';
import path from 'node:path';

import { describe, it, expect } from 'vitest';
import * as i18n from '../src/i18n';

/** A named translation record taken from the i18n module exports. */
type RecordEntry = [name: string, record: Record<string, string>];

/**
 * The module exports translation records alongside functions, so an object
 * export is a record and a function export is not. Deriving the list this way
 * puts a new record under the guard with no edit to this file. Do not put the
 * names back in a hand-written list: the previous one covered 36 of the 43
 * records and left the whole tray media-control group unchecked.
 */
function isRecordEntry(entry: [string, unknown]): entry is RecordEntry {
  return typeof entry[1] === 'object' && entry[1] !== null;
}

const TRANSLATION_RECORDS: RecordEntry[] = Object.entries(i18n).filter(isRecordEntry);

// LOADING_TEXT is the reference every other record is compared against, named
// rather than taken by position so export order cannot change what is checked.
const REFERENCE_NAME = 'LOADING_TEXT';
const referenceKeys = Object.keys(i18n.LOADING_TEXT).sort();

describe('i18n translation records', () => {
  it('finds the translation records exported from src/i18n', () => {
    expect(TRANSLATION_RECORDS.length).toBeGreaterThan(0);
  });

  it('exports every record defined in assets/locales', () => {
    const localeDir = path.join(__dirname, '..', 'assets', 'locales');
    const exported = new Set(TRANSLATION_RECORDS.map(([name]) => name));

    for (const file of fs.readdirSync(localeDir)) {
      if (!file.endsWith('.json')) continue;
      const data: unknown = JSON.parse(
        fs.readFileSync(path.join(localeDir, file), 'utf-8'),
      );
      for (const name of Object.keys(data as Record<string, unknown>)) {
        expect(
          exported.has(name),
          `${name} is defined in assets/locales/${file} but not exported from src/i18n`,
        ).toBe(true);
      }
    }
  });

  for (const [name, record] of TRANSLATION_RECORDS) {
    it(`${name} has the same language keys as ${REFERENCE_NAME}`, () => {
      const keys = Object.keys(record).sort();
      const missing = referenceKeys.filter((lang) => !keys.includes(lang));
      const extra = keys.filter((lang) => !referenceKeys.includes(lang));

      expect(
        missing,
        `${name} is missing these languages: ${missing.join(', ')}`,
      ).toEqual([]);
      expect(
        extra,
        `${name} has languages no other record carries: ${extra.join(', ')}`,
      ).toEqual([]);
    });

    it(`${name} has no empty values`, () => {
      for (const [lang, value] of Object.entries(record)) {
        expect(value, `${name}['${lang}'] is empty`).not.toBe('');
      }
    });

    it(`${name} includes English fallback`, () => {
      expect(record, `${name} has no 'en' entry to fall back to`).toHaveProperty('en');
    });
  }
});
