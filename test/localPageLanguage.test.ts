import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { extractInlineScript } from './mocks/inlineScript';

describe.each(['about', 'splash'])('%s page language', page => {
  const html = fs.readFileSync(path.join(__dirname, `../assets/${page}.html`), 'utf8');
  const script = extractInlineScript(html);

  it.each([
    ['fr', 'ltr'],
    ['ar', 'rtl'],
    ['he-IL', 'rtl'],
    ['', 'ltr'],
  ])('sets the document language and direction for %s', (lang, dir) => {
    const element = { textContent: '', alt: '', addEventListener: vi.fn() };
    const document = {
      title: '',
      documentElement: { lang: '', dir: '' },
      getElementById: () => element,
      querySelector: () => element,
    };
    const search = new URLSearchParams({ lang, text: 'Chargement...' }).toString();
    vm.runInNewContext(script, { document, window: { location: { search } }, URLSearchParams });
    expect(document.documentElement).toEqual({ lang: lang || 'en', dir });
    if (page === 'splash') {
      expect(document.title).toBe('Chargement...');
      expect(element.textContent).toBe('Chargement...');
    }
  });
});
