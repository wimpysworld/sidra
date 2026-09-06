// Pure module: no electron imports so tests can exercise it directly.
//
// Bundled theme palettes. Each palette maps an upstream colour scheme
// onto the 12 semantic slots consumed by src/themeTemplate.ts. Shades
// marked "derived" have no upstream equivalent and are interpolated to
// fit the slot's role.
//
// Two rules, checked by test/themes.test.ts:
// - overlay differs from subtext0, and crust from surface0. Each pair
//   paints a different part of the UI, so one hex in both flattens it.
// - text and subtext0 reach 4.5:1 against base once the template applies
//   its alpha. Catppuccin Latte holds its shipped 4.37:1 instead.
//
// Upstream palettes (colour values only; palettes are not creative
// works, attribution given as a courtesy):
// - Catppuccin (Mocha/Latte)  https://github.com/catppuccin/palette      MIT
// - Dracula                   https://github.com/dracula/dracula-theme   MIT
// - Everforest (Dark/Light)   https://github.com/sainnhe/everforest      MIT
// - Gruvbox                   https://github.com/morhetz/gruvbox         MIT
// - Nord                      https://github.com/nordtheme/nord          MIT
// - Ros\u00e9 Pine (Main/Dawn)     https://github.com/rose-pine/palette       MIT
// - Solarized                 https://github.com/altercation/solarized   MIT
// - Tokyo Night (Night/Light) https://github.com/tokyo-night/tokyo-night-vscode-theme  MIT

import type { SchemeColours, ThemeDefinition } from './themeTemplate';

interface BundledTheme extends ThemeDefinition {
  name: BundledThemeName;
}

/** Names of the themes Sidra ships, as stored in config and shown in the tray. */
export type BundledThemeName =
  | 'catppuccin'
  | 'dracula'
  | 'everforest'
  | 'gruvbox'
  | 'nord'
  | 'rose-pine'
  | 'solarized'
  | 'tokyo-night';

/** Active theme. 'apple-music' means no override CSS is injected at all. */
export type ThemeName = 'apple-music' | BundledThemeName | 'custom';

// Dracula defines no official light scheme; the dark palette serves both
// colour schemes, matching how Dracula presents everywhere else.
const draculaDark: SchemeColours = {
  base: '#282a36',
  mantle: '#21222c',
  crust: '#191a21',
  surface0: '#343746',
  surface1: '#44475a',
  surface2: '#565966', // derived
  overlay: '#6272a4',
  text: '#f8f8f2',
  subtext1: '#d8d8d2', // derived
  subtext0: '#b8b8b2', // derived
  accent: '#bd93f9',
  accentHover: '#ff79c6',
};

/** Every bundled theme, in the order the tray Style submenu lists them. */
export const BUNDLED_THEMES: readonly BundledTheme[] = [
  {
    name: 'catppuccin',
    label: 'Catppuccin',
    dark: {
      // Mocha
      base: '#1e1e2e',
      mantle: '#181825',
      crust: '#11111b',
      surface0: '#313244',
      surface1: '#45475a',
      surface2: '#585b70',
      overlay: '#6c7086',
      text: '#cdd6f4',
      subtext1: '#bac2de',
      subtext0: '#a6adc8',
      accent: '#f38ba8',
      accentHover: '#eba0ac',
    },
    light: {
      // Latte
      base: '#eff1f5',
      mantle: '#e6e9ef',
      crust: '#dce0e8',
      surface0: '#ccd0da',
      surface1: '#bcc0cc',
      surface2: '#acb0be',
      overlay: '#9ca0b0',
      text: '#4c4f69',
      subtext1: '#5c5f77',
      subtext0: '#6c6f85',
      accent: '#d20f39',
      accentHover: '#e64553',
    },
  },
  {
    name: 'dracula',
    label: 'Dracula',
    dark: draculaDark,
    light: draculaDark,
  },
  {
    name: 'everforest',
    label: 'Everforest',
    dark: {
      // Dark, medium contrast
      base: '#2d353b',
      mantle: '#232a2e',
      crust: '#1e2326',
      surface0: '#343f44',
      surface1: '#3d484d',
      surface2: '#475258',
      overlay: '#859289',
      text: '#d3c6aa',
      subtext1: '#d3c6aa',
      subtext0: '#9da9a0',
      accent: '#a7c080',
      accentHover: '#83c092',
    },
    light: {
      // Light, medium contrast. Darker text keeps 4.5:1 contrast after the template applies alpha.
      base: '#fdf6e3',
      mantle: '#f4f0d9',
      crust: '#efebd4',
      surface0: '#e6e2cc',
      surface1: '#e0dcc7',
      surface2: '#bdc3af',
      overlay: '#939f91',
      text: '#414b52',
      subtext1: '#5c6a72',
      subtext0: '#5c6a72',
      accent: '#5d6b01',
      accentHover: '#206e4e',
    },
  },
  {
    name: 'gruvbox',
    label: 'Gruvbox',
    dark: {
      base: '#282828',
      mantle: '#1d2021',
      crust: '#141617', // derived
      surface0: '#3c3836',
      surface1: '#504945',
      surface2: '#665c54',
      overlay: '#7c6f64',
      text: '#ebdbb2',
      subtext1: '#d5c4a1',
      subtext0: '#bdae93',
      accent: '#fe8019',
      accentHover: '#d65d0e',
    },
    light: {
      base: '#fbf1c7',
      mantle: '#f2e5bc',
      crust: '#ebdbb2',
      surface0: '#d5c4a1',
      surface1: '#bdae93',
      surface2: '#a89984',
      overlay: '#928374',
      text: '#3c3836',
      subtext1: '#504945',
      subtext0: '#665c54',
      accent: '#af3a03',
      accentHover: '#d65d0e',
    },
  },
  {
    name: 'nord',
    label: 'Nord',
    dark: {
      // Polar Night with Frost accent
      base: '#2e3440',
      mantle: '#292e39', // derived
      crust: '#242933', // derived
      surface0: '#3b4252',
      surface1: '#434c5e',
      surface2: '#4c566a',
      overlay: '#616e88', // derived
      text: '#eceff4',
      subtext1: '#e5e9f0',
      subtext0: '#d8dee9',
      accent: '#88c0d0',
      accentHover: '#81a1c1',
    },
    light: {
      // Snow Storm with darker Frost accent for contrast
      base: '#eceff4',
      mantle: '#e5e9f0',
      crust: '#d8dee9',
      surface0: '#cdd4e0', // derived
      surface1: '#c2c9d6', // derived
      surface2: '#aab2c4', // derived
      overlay: '#7b88a1', // derived
      text: '#2e3440',
      subtext1: '#3b4252',
      subtext0: '#4c566a',
      accent: '#5e81ac',
      accentHover: '#81a1c1',
    },
  },
  {
    name: 'rose-pine',
    label: 'Ros\u00e9 Pine',
    dark: {
      // Main
      base: '#191724',
      mantle: '#13111d', // derived
      crust: '#0e0c15', // derived
      surface0: '#26233a',
      surface1: '#403d52',
      surface2: '#524f67',
      overlay: '#6e6a86',
      text: '#e0def4',
      subtext1: '#b8b5cf', // derived
      subtext0: '#908caa',
      accent: '#ebbcba',
      accentHover: '#eb6f92',
    },
    light: {
      // Dawn
      base: '#faf4ed',
      mantle: '#f2e9e1',
      crust: '#ede0d4', // derived
      surface0: '#f4ede8',
      surface1: '#dfdad9',
      surface2: '#cecacd',
      overlay: '#9893a5',
      text: '#575279',
      subtext1: '#797593',
      subtext0: '#686486', // derived
      accent: '#d7827e',
      accentHover: '#b4637a',
    },
  },
  {
    name: 'solarized',
    label: 'Solarized',
    dark: {
      base: '#002b36',
      mantle: '#00252e', // derived
      crust: '#001f27', // derived
      surface0: '#073642',
      surface1: '#0e4552', // derived
      surface2: '#586e75',
      overlay: '#657b83',
      text: '#eee8d5',
      subtext1: '#839496',
      subtext0: '#93a1a1',
      accent: '#268bd2',
      accentHover: '#2aa198',
    },
    light: {
      base: '#fdf6e3',
      mantle: '#f5eed9', // derived
      crust: '#eee8d5',
      surface0: '#e6dfcb', // derived
      surface1: '#ddd6c1', // derived
      surface2: '#93a1a1',
      overlay: '#839496',
      text: '#073642',
      subtext1: '#657b83',
      subtext0: '#586e75',
      accent: '#268bd2',
      accentHover: '#2aa198',
    },
  },
  {
    name: 'tokyo-night',
    label: 'Tokyo Night',
    dark: {
      // Night
      base: '#1a1b26',
      mantle: '#16161e',
      crust: '#0f0f14',
      surface0: '#292e42',
      surface1: '#414868',
      surface2: '#565f89',
      overlay: '#545c7e',
      text: '#c0caf5',
      subtext1: '#a9b1d6',
      subtext0: '#9aa5ce',
      accent: '#7aa2f7',
      accentHover: '#bb9af7',
    },
    light: {
      // Light
      base: '#e6e7ed',
      mantle: '#d6d8df',
      crust: '#c1c2c7',
      surface0: '#dcdee3',
      surface1: '#bdc1cf',
      surface2: '#9da0ab',
      overlay: '#707280',
      text: '#343b59',
      subtext1: '#6c6e75',
      subtext0: '#4a5272',
      accent: '#2959aa',
      accentHover: '#5a3e8e',
    },
  },
];

const bundledThemesByName = new Map(BUNDLED_THEMES.map(theme => [theme.name, theme] as const));

/** The palette behind a bundled theme name. */
export function bundledTheme(name: BundledThemeName): BundledTheme | undefined {
  return bundledThemesByName.get(name);
}

/** True when a stored string is a theme Sidra can render. */
export function isThemeName(value: string): value is ThemeName {
  return value === 'apple-music'
    || value === 'custom'
    || bundledThemesByName.has(value as BundledThemeName);
}

/** Settings label for a theme name. */
export function themeLabel(name: ThemeName): string {
  if (name === 'apple-music') return 'Apple Music';
  if (name === 'custom') return 'Custom Theme';
  return bundledThemesByName.get(name)?.label ?? name;
}
