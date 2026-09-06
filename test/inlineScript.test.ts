import { describe, expect, it } from 'vitest';
import { extractInlineScript } from './mocks/inlineScript';

describe('repository inline script extraction', () => {
  it('preserves the complete script, including whitespace and comparisons', () => {
    const script = '\nif (1 < 2) {\n  document.title = "Ready";\n}\n';
    expect(extractInlineScript(`<html><script>${script}</script></html>`)).toBe(script);
  });

  it.each([
    ['absent script', '<html></html>'],
    ['missing opening tag', 'code</script>'],
    ['missing closing tag', '<script>code'],
    ['reversed tags', '</script>code<script>'],
    ['duplicate opening tag', '<script><script>code</script>'],
    ['duplicate closing tag', '<script>code</script></script>'],
    ['multiple scripts', '<script>first</script><script>second</script>'],
    ['empty script', '<script>\n </script>'],
  ])('rejects a fixture with %s', (_description, html) => {
    expect(() => extractInlineScript(html)).toThrow();
  });
});
