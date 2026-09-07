import { bundledTheme } from '../../src/palettes';
import { buildThemeCss, type ThemeDefinition } from '../../src/themeTemplate';

/** Builds matching JSON and CSS fixtures from Catppuccin, with dark colours for both schemes. */
export function customThemeFixture(accent = '#ff0000') {
  const base = bundledTheme('catppuccin');
  if (!base) throw new Error('Custom theme fixture requires Catppuccin');
  const dark = { ...base.dark, accent };
  const theme: ThemeDefinition = { name: 'custom', label: 'Custom Theme', dark, light: dark };
  return { dark, json: JSON.stringify({ dark }), css: buildThemeCss(theme) };
}
