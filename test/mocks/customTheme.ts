import { BUNDLED_THEMES } from '../../src/palettes';
import { buildThemeCss, type ThemeDefinition } from '../../src/themeTemplate';

export function customThemeFixture(accent = '#ff0000') {
  const dark = { ...BUNDLED_THEMES[0].dark, accent };
  const theme: ThemeDefinition = { name: 'custom', label: 'Custom Theme', dark, light: dark };
  return { dark, json: JSON.stringify({ dark }), css: buildThemeCss(theme) };
}
