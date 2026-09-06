import { expect } from 'vitest';

// Extracts the single, literal script block in repository fixtures, not arbitrary HTML.
export function extractInlineScript(html: string): string {
  const openingTag = '<script>';
  const closingTag = '</script>';
  const start = html.indexOf(openingTag);
  const end = html.indexOf(closingTag);
  expect(start, 'Fixture must contain an opening script tag').toBeGreaterThanOrEqual(0);
  expect(end, 'Fixture must close the script after its opening tag').toBeGreaterThanOrEqual(start + openingTag.length);
  expect(html.lastIndexOf(openingTag), 'Fixture must contain one opening script tag').toBe(start);
  expect(html.lastIndexOf(closingTag), 'Fixture must contain one closing script tag').toBe(end);
  const script = html.slice(start + openingTag.length, end);
  expect(script.trim(), 'Fixture script must not be empty').not.toBe('');
  return script;
}
