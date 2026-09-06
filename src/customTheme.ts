import type { SchemeColours, ThemeDefinition } from './themeTemplate';

const COLOUR_SLOTS = {
  base: true, mantle: true, crust: true, surface0: true, surface1: true, surface2: true,
  overlay: true, text: true, subtext1: true, subtext0: true, accent: true, accentHover: true,
} satisfies Record<keyof SchemeColours, true>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseScheme(value: unknown): SchemeColours | null {
  if (!isRecord(value)) return null;
  const colours = {} as SchemeColours;
  for (const slot of Object.keys(COLOUR_SLOTS) as (keyof SchemeColours)[]) {
    const colour = value[slot];
    if (!Object.hasOwn(value, slot) || typeof colour !== 'string' || !/^#[0-9a-f]{6}$/i.test(colour) || colour.length !== 7) return null;
    colours[slot] = colour;
  }
  return colours;
}

export function parseCustomTheme(json: string): ThemeDefinition | null {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(value) || !Object.hasOwn(value, 'dark')) return null;
  const dark = parseScheme(value.dark);
  if (!dark) return null;
  const light = Object.hasOwn(value, 'light') ? parseScheme(value.light) : dark;
  if (!light) return null;
  return { name: 'custom', label: 'Custom Theme', dark, light };
}
