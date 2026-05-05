import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const catppuccinCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'catppuccin.css'), 'utf-8');
const styleFixCss = fs.readFileSync(path.join(__dirname, '..', 'assets', 'styleFix.css'), 'utf-8');

function mediaBlock(css: string, query: string): string {
  const start = css.indexOf(`@media (${query})`);
  expect(start).toBeGreaterThanOrEqual(0);

  const next = css.indexOf('@media (', start + 1);
  return next === -1 ? css.slice(start) : css.slice(start, next);
}

describe('catppuccin.css', () => {
  it('styles scrollbars in both colour-scheme variants', () => {
    const darkCss = mediaBlock(catppuccinCss, 'prefers-color-scheme: dark');
    const lightCss = mediaBlock(catppuccinCss, 'prefers-color-scheme: light');

    expect(darkCss).toContain('scrollbar-color: #45475a #181825 !important;');
    expect(darkCss).toContain('*::-webkit-scrollbar');
    expect(darkCss).toContain('*::-webkit-scrollbar-thumb');
    expect(darkCss).toContain('*::-webkit-scrollbar-track');

    expect(lightCss).toContain('scrollbar-color: #bcc0cc #e6e9ef !important;');
    expect(lightCss).toContain('*::-webkit-scrollbar');
    expect(lightCss).toContain('*::-webkit-scrollbar-thumb');
    expect(lightCss).toContain('*::-webkit-scrollbar-track');
  });

  it('keeps scrollbar styling out of styleFix.css', () => {
    expect(styleFixCss).not.toContain('scrollbar-color');
    expect(styleFixCss).not.toContain('::-webkit-scrollbar');
  });

  it('keeps old player structural selectors out while retaining player variables', () => {
    const darkCss = mediaBlock(catppuccinCss, 'prefers-color-scheme: dark');
    const lightCss = mediaBlock(catppuccinCss, 'prefers-color-scheme: light');

    expect(catppuccinCss).not.toContain('.wrapper amp-chrome-player::before');
    expect(catppuccinCss).not.toContain('.player-bar');
    expect(catppuccinCss).not.toContain('.chrome-player.chrome-player__music');
    expect(catppuccinCss).not.toContain('amp-lcd');

    expect(darkCss).toContain('--playerBackground: rgba(24,24,37,0.88) !important;');
    expect(darkCss).toContain('--playerBGFill: rgba(24, 24, 37, 0.88) !important;');
    expect(darkCss).toContain('--keyColor: #f38ba8 !important;');

    expect(lightCss).toContain('--playerBackground: rgba(230,233,239,0.88) !important;');
    expect(lightCss).toContain('--playerBGFill: rgba(230, 233, 239, 0.88) !important;');
    expect(lightCss).toContain('--keyColor: #d20f39 !important;');
  });

  it('styles footer areas in both colour-scheme variants', () => {
    const darkCss = mediaBlock(catppuccinCss, 'prefers-color-scheme: dark');
    const lightCss = mediaBlock(catppuccinCss, 'prefers-color-scheme: light');

    expect(darkCss).toContain('/* Footer */');
    expect(darkCss).toContain('.scrollable-page footer');
    expect(darkCss).toContain('background: #11111b !important;');
    expect(darkCss).toContain('background-color: #181825 !important;');

    expect(lightCss).toContain('/* Footer */');
    expect(lightCss).toContain('.scrollable-page footer');
    expect(lightCss).toContain('background: #dce0e8 !important;');
    expect(lightCss).toContain('background-color: #e6e9ef !important;');
  });

  it('sets country/location banner container backgrounds in both colour-scheme variants', () => {
    const darkCss = mediaBlock(catppuccinCss, 'prefers-color-scheme: dark');
    const lightCss = mediaBlock(catppuccinCss, 'prefers-color-scheme: light');

    expect(darkCss).toContain('/* Country/location banner background */');
    expect(darkCss).toContain('[class*="country-banner"]');
    expect(darkCss).toContain('[class*="location-banner"]');
    expect(darkCss).toContain('[class*="storefront-banner"]');
    expect(darkCss).toContain('[role="dialog"]:has(select):has(button)');
    expect(darkCss).toContain('body > :is(div, section, aside)[style*="bottom"]:has(select):has(button)');
    expect(darkCss).toContain('background: #181825 !important;');
    expect(darkCss).toContain('background-color: #181825 !important;');

    expect(lightCss).toContain('/* Country/location banner background */');
    expect(lightCss).toContain('[class*="country-banner"]');
    expect(lightCss).toContain('[class*="location-banner"]');
    expect(lightCss).toContain('[class*="storefront-banner"]');
    expect(lightCss).toContain('[role="dialog"]:has(select):has(button)');
    expect(lightCss).toContain('body > :is(div, section, aside)[style*="bottom"]:has(select):has(button)');
    expect(lightCss).toContain('background: #e6e9ef !important;');
    expect(lightCss).toContain('background-color: #e6e9ef !important;');
  });

  it('keeps country/location banner control styling on Apple Music defaults', () => {
    expect(catppuccinCss).not.toContain('[class*="country-select"]');
    expect(catppuccinCss).not.toContain('[class*="country-selector"]');
    expect(catppuccinCss).not.toContain('[class*="location-selector"]');
    expect(catppuccinCss).not.toContain('[class*="storefront-selector"]');
    expect(catppuccinCss).not.toContain('[data-testid*="country" i]');
    expect(catppuccinCss).not.toContain('[aria-label*="country" i]');
    expect(catppuccinCss).not.toContain('[role="combobox"]');
    expect(catppuccinCss).not.toContain('[class*="menu"]');
    expect(catppuccinCss).not.toContain('[class*="continue"]');
    expect(catppuccinCss).not.toContain('[aria-label*="continue" i]');
    expect(catppuccinCss).not.toContain('[class*="close-button"]');
    expect(catppuccinCss).not.toContain('[aria-label*="close" i]');
  });

  it('keeps Catppuccin footer and prompt styling out of styleFix.css', () => {
    expect(styleFixCss).not.toContain('[class*="country-banner"]');
    expect(styleFixCss).not.toContain('[class*="location-banner"]');
    expect(styleFixCss).not.toContain('[class*="storefront-banner"]');
    expect(styleFixCss).not.toContain('[class*="country-selector"]');
    expect(styleFixCss).not.toContain('[data-testid*="country" i]');
    expect(styleFixCss).not.toContain('[role="dialog"]:has(select):has(button)');
  });
});
