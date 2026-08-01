import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildThemeCss } from '../src/themeTemplate';
import { BUNDLED_THEMES, themeLabel } from '../src/palettes';

const styleFixCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'styleFix.css'), 'utf-8');

function mediaBlock(css: string, query: string): string {
  const start = css.indexOf(`@media (${query})`);
  expect(start).toBeGreaterThanOrEqual(0);

  const next = css.indexOf('@media (', start + 1);
  return next === -1 ? css.slice(start) : css.slice(start, next);
}

const HEX_RE = /^#[0-9a-f]{6}$/;
const CSS_HEX_RE = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/;
const CSS_RGBA_RE = /^rgba\((\d+),(\d+),(\d+),([0-9.]+)\)$/;

/** WCAG 2.x AA floor for body text. */
const CONTRAST_FLOOR = 4.5;

// Catppuccin Latte ships subtext0 at #6c6f85, which lands at 4.37:1. It is the
// one documented exception to the floor: the Catppuccin values are Catppuccin's
// own and are kept byte for byte, and Latte was checked on screen. A new palette
// gets no entry here.
const SECONDARY_FLOORS: Record<string, number> = {
  'catppuccin light': 4.37,
};

type Rgb = [number, number, number];

/** Reads one custom property out of a generated scheme block. */
function cssVar(block: string, name: string): string {
  const match = new RegExp(`--${name}: ([^;]+) !important;`).exec(block);
  if (match === null) {
    throw new Error(`--${name} is missing from the generated block`);
  }
  return match[1];
}

/** Reads the thumb and track of the scrollbar-color declaration. */
function scrollbarColor(block: string): { thumb: string; track: string } {
  const match = /scrollbar-color: (\S+) (\S+) !important;/.exec(block);
  if (match === null) {
    throw new Error('scrollbar-color is missing from the generated block');
  }
  return { thumb: match[1], track: match[2] };
}

/** Reads the background-color of the .chrome-player::before rule. */
function chromePlayerFill(block: string): string {
  const match = /\.chrome-player::before \{\s*background-color: ([^;]+) !important;/.exec(block);
  if (match === null) {
    throw new Error('.chrome-player::before is missing its background-color');
  }
  return match[1];
}

function parseHex(value: string): Rgb {
  const match = CSS_HEX_RE.exec(value);
  if (match === null) {
    throw new Error(`${value} is not a six-digit hex colour`);
  }
  return [parseInt(match[1], 16), parseInt(match[2], 16), parseInt(match[3], 16)];
}

function parseRgba(value: string): { rgb: Rgb; alpha: number } {
  const match = CSS_RGBA_RE.exec(value);
  if (match === null) {
    throw new Error(`${value} is not an rgba() colour`);
  }
  return {
    rgb: [Number(match[1]), Number(match[2]), Number(match[3])],
    alpha: Number(match[4]),
  };
}

/** Paints a translucent colour over an opaque one. */
function composite(fg: Rgb, alpha: number, bg: Rgb): Rgb {
  return [
    fg[0] * alpha + bg[0] * (1 - alpha),
    fg[1] * alpha + bg[1] * (1 - alpha),
    fg[2] * alpha + bg[2] * (1 - alpha),
  ];
}

function relativeLuminance([r, g, b]: Rgb): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG 2.x contrast ratio, rounded to the two decimals the failures report. */
function contrastRatio(a: Rgb, b: Rgb): number {
  const lighter = Math.max(relativeLuminance(a), relativeLuminance(b));
  const darker = Math.min(relativeLuminance(a), relativeLuminance(b));
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

const SCHEMES = ['dark', 'light'] as const;

describe('palettes', () => {
  it('has unique kebab-case names and unique labels', () => {
    const names = BUNDLED_THEMES.map(t => t.name);
    const labels = BUNDLED_THEMES.map(t => t.label);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(labels).size).toBe(labels.length);
    for (const name of names) {
      expect(name).toMatch(/^[a-z]+(-[a-z]+)*$/);
    }
  });

  it('defines every slot as a six-digit lowercase hex colour', () => {
    for (const theme of BUNDLED_THEMES) {
      for (const scheme of [theme.dark, theme.light]) {
        for (const [slot, value] of Object.entries(scheme)) {
          expect(value, `${theme.name} ${slot}`).toMatch(HEX_RE);
        }
      }
    }
  });

  it('resolves labels for bundled, custom, and unknown names', () => {
    expect(themeLabel('catppuccin')).toBe('Catppuccin');
    expect(themeLabel('rose-pine')).toBe('Ros\u00e9 Pine');
    expect(themeLabel('custom')).toBe('Custom');
    expect(themeLabel('apple-music')).toBe('Apple Music');
    expect(themeLabel('no-such-theme')).toBe('Apple Music');
  });
});

describe('palette ladders and text contrast', () => {
  it('gives each background and foreground slot its own hex', () => {
    for (const theme of BUNDLED_THEMES) {
      for (const scheme of SCHEMES) {
        const c = theme[scheme];
        expect(
          c.overlay,
          `${theme.name} ${scheme}: overlay and subtext0 both use ${c.overlay}`,
        ).not.toBe(c.subtext0);
        expect(
          c.crust,
          `${theme.name} ${scheme}: crust and surface0 both use ${c.crust}`,
        ).not.toBe(c.surface0);
      }
    }
  });

  // Read from the generated CSS, not the palette, so the alpha values come from
  // the template itself and cannot drift out of sync with this test.
  // --systemSecondary sits below the floor in every scheme by design, so it is
  // not asserted here.
  it('keeps primary and secondary text at or above the WCAG floor', () => {
    for (const theme of BUNDLED_THEMES) {
      const css = buildThemeCss(theme);
      for (const scheme of SCHEMES) {
        const block = mediaBlock(css, `prefers-color-scheme: ${scheme}`);
        const pageBG = parseHex(cssVar(block, 'pageBG'));

        const primary = parseRgba(cssVar(block, 'systemPrimary'));
        const primaryRatio = contrastRatio(composite(primary.rgb, primary.alpha, pageBG), pageBG);
        expect(
          primaryRatio,
          `${theme.name} ${scheme}: --systemPrimary is ${primaryRatio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(CONTRAST_FLOOR);

        const secondary = parseHex(cssVar(block, 'systemSecondary-vibrant'));
        const secondaryRatio = contrastRatio(secondary, pageBG);
        const floor = SECONDARY_FLOORS[`${theme.name} ${scheme}`] ?? CONTRAST_FLOOR;
        expect(
          secondaryRatio,
          `${theme.name} ${scheme}: --systemSecondary-vibrant is ${secondaryRatio.toFixed(2)}:1`,
        ).toBeGreaterThanOrEqual(floor);
      }
    }
  });
});

describe('buildThemeCss', () => {
  for (const theme of BUNDLED_THEMES) {
    describe(theme.name, () => {
      const css = buildThemeCss(theme);
      const darkCss = mediaBlock(css, 'prefers-color-scheme: dark');
      const lightCss = mediaBlock(css, 'prefers-color-scheme: light');
      const schemeBlocks = [
        { block: darkCss, colours: theme.dark },
        { block: lightCss, colours: theme.light },
      ];

      // Both sides come from the palette, so a slot change cannot drift past
      // this test.
      it('paints the scrollbar thumb and track from the palette', () => {
        for (const { block, colours } of schemeBlocks) {
          expect(scrollbarColor(block)).toEqual({
            thumb: colours.surface1,
            track: colours.mantle,
          });
        }
      });

      // From Chrome 121 Chromium ignores ::-webkit-scrollbar-* on any element
      // carrying a non-auto scrollbar-color, and the * rule above sets one on
      // every element, so any such rule would be dead text in every build.
      it('emits no scrollbar rules Chromium ignores', () => {
        expect(css).not.toContain('::-webkit-scrollbar');
      });

      // The * block is the only declaration site for the accent group, because
      // the shadow DOM of amp-* elements does not inherit from :root. cssVar
      // reads the first match, so a resolved value here proves the root element
      // still reaches one despite the lower specificity.
      it('resolves the accent variables from the * block', () => {
        for (const { block, colours } of schemeBlocks) {
          expect(cssVar(block, 'keyColor')).toBe(colours.accent);
          expect(cssVar(block, 'keyColor-rollover')).toBe(colours.accentHover);
          expect(cssVar(block, 'musicKeyColor')).toBe(colours.accent);
          expect(cssVar(block, 'selectionColor')).toBe(colours.accent);
        }
      });

      it('styles footer, locale switcher, and banner in both variants', () => {
        for (const block of [darkCss, lightCss]) {
          expect(block).toContain('/* Footer */');
          expect(block).toContain('.scrollable-page footer');
          expect(block).toContain('[class*="locale-switcher"]');
          expect(block).toContain('[data-testid="banner-container"]');
        }
      });

      it('retains player variables and the accent button override', () => {
        expect(darkCss).toContain('--playerBackground:');
        expect(darkCss).toContain('--keyColor:');
        expect(css).toContain('.button.primary button.click-action');
        expect(css).toContain('background-color: var(--keyColor) !important;');
      });

      it('themes the player bar and the Classical LCD in both variants', () => {
        for (const block of [darkCss, lightCss]) {
          expect(block).toContain('.chrome-player::before');
          expect(block).toContain('background-image: none !important;');
          expect(block).toContain('--chromePlayerBGFill:');
          expect(block).toContain('--lcd-bg-color:');
          expect(block).toContain('--playerMissingArtworkBg:');
          expect(block).toContain('--playerMissingArtworkIcon:');
        }
      });

      it('paints the player bar with the player background value', () => {
        for (const block of [darkCss, lightCss]) {
          expect(chromePlayerFill(block)).toBe(cssVar(block, 'playerBackground'));
          expect(cssVar(block, 'chromePlayerBGFill')).toBe(cssVar(block, 'playerBackground'));
          expect(cssVar(block, 'lcd-bg-color')).toBe(cssVar(block, 'playerLCDBGFill'));
        }
      });

      it('emits no Svelte scope hash', () => {
        expect(css).not.toMatch(/svelte-[a-z0-9]/);
      });

      it('keeps old player structural selectors out', () => {
        expect(css).not.toContain('.wrapper amp-chrome-player::before');
        expect(css).not.toContain('amp-chrome-player');
        expect(css).not.toContain('.player-bar');
        expect(css).not.toContain('.chrome-player.chrome-player__music');
        expect(css).not.toContain('amp-lcd');
      });

      it('keeps selectors and properties Apple no longer ships out', () => {
        expect(css).not.toContain('dt-footer');
        expect(css).not.toContain('page-footer');
        expect(css).not.toContain('--lovedBGColor');
        expect(css).not.toContain('--playerBGFill');
        expect(css).not.toContain('--playerScrubberPlayhead');
        expect(css).not.toContain('--playerVolumeFill');
        expect(css).not.toContain('--playerVolumeIconFill');
        expect(css).not.toContain('--playerVolumeTrack');
        expect(css).not.toContain('--systemAccentBG');
      });

      it('keeps country/location banner control styling on Apple Music defaults', () => {
        expect(css).not.toContain('[class*="country-select"]');
        expect(css).not.toContain('[class*="country-selector"]');
        expect(css).not.toContain('[class*="location-selector"]');
        expect(css).not.toContain('[class*="storefront-selector"]');
        expect(css).not.toContain('[data-testid*="country" i]');
        expect(css).not.toContain('[aria-label*="country" i]');
        expect(css).not.toContain('[role="combobox"]');
        expect(css).not.toContain('[class*="menu"]');
        expect(css).not.toContain('[class*="continue"]');
        expect(css).not.toContain('[aria-label*="continue" i]');
        expect(css).not.toContain('[class*="close-button"]');
        expect(css).not.toContain('[aria-label*="close" i]');
      });
    });
  }
});

describe('catppuccin regression against the retired static asset', () => {
  const catppuccin = BUNDLED_THEMES.find(t => t.name === 'catppuccin')!;
  const css = buildThemeCss(catppuccin);
  const darkCss = mediaBlock(css, 'prefers-color-scheme: dark');
  const lightCss = mediaBlock(css, 'prefers-color-scheme: light');

  it('reproduces the Mocha values byte for byte', () => {
    expect(darkCss).toContain('--pageBG: #1e1e2e !important;');
    expect(darkCss).toContain('--pageBG-rgb: 30,30,46 !important;');
    expect(darkCss).toContain('--keyColor: #f38ba8 !important;');
    expect(darkCss).toContain('--keyColor-disabled: rgba(243,139,168,0.35) !important;');
    expect(darkCss).toContain('--systemPrimary: rgba(205,214,244,0.85) !important;');
    expect(darkCss).toContain('--playerBackground: rgba(24,24,37,0.88) !important;');
    expect(darkCss).toContain('scrollbar-color: #45475a #181825 !important;');
    expect(darkCss).toContain('background: #11111b !important;');
    expect(darkCss).toContain('background-color: #181825 !important;');
    expect(darkCss).toContain('background-color: rgba(24, 24, 37, 0.97) !important;');
  });

  it('reproduces the Latte values byte for byte', () => {
    expect(lightCss).toContain('--pageBG: #eff1f5 !important;');
    expect(lightCss).toContain('--keyColor: #d20f39 !important;');
    expect(lightCss).toContain('--playerBackground: rgba(230,233,239,0.88) !important;');
    expect(lightCss).toContain('scrollbar-color: #bcc0cc #e6e9ef !important;');
    expect(lightCss).toContain('background: #dce0e8 !important;');
    expect(lightCss).toContain('background-color: #e6e9ef !important;');
  });
});

describe('styleFix.css separation', () => {
  it('keeps scrollbar styling out of styleFix.css', () => {
    expect(styleFixCss).not.toContain('scrollbar-color');
    expect(styleFixCss).not.toContain('::-webkit-scrollbar');
  });

  it('keeps theme footer and prompt styling out of styleFix.css', () => {
    expect(styleFixCss).not.toContain('[class*="country-banner"]');
    expect(styleFixCss).not.toContain('[class*="location-banner"]');
    expect(styleFixCss).not.toContain('[class*="storefront-banner"]');
    expect(styleFixCss).not.toContain('[class*="country-selector"]');
    expect(styleFixCss).not.toContain('[data-testid*="country" i]');
    expect(styleFixCss).not.toContain('[role="dialog"]:has(select):has(button)');
  });
});
