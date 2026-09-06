import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const html = fs.readFileSync(path.join(__dirname, '../assets/about.html'), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

describe('About page display name', () => {
  it.each([
    ['?name=Test+Player', 'Test Player'],
    ['?name=%3Cb%3ETest%3C%2Fb%3E', '<b>Test</b>'],
    ['', 'Sidra'],
  ])('uses the resolved name for text and image alt with query %s', (search, name) => {
    const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(match => [
      match[1], { textContent: '', alt: '', addEventListener: vi.fn() },
    ]));
    const document = {
      title: '',
      getElementById: (id: string) => elements.get(id),
      querySelector: () => elements.get('close-btn'),
    };
    expect(script).toBeDefined();
    vm.runInNewContext(script!, { document, window: { location: { search } }, URLSearchParams });

    expect(document.title).toBe(`About ${name}`);
    expect(elements.get('name')?.textContent).toBe(name);
    expect(elements.get('icon')?.alt).toBe(name);
    expect(html).not.toMatch(/innerHTML|insertAdjacentHTML/);
  });
});
