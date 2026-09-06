import { describe, expect, it } from 'vitest';
import { parseCustomTheme } from '../src/customTheme';
import { buildThemeCss } from '../src/themeTemplate';
import { customThemeFixture } from './mocks/customTheme';

const { dark, json } = customThemeFixture();

describe('custom theme parser', () => {
  it('uses the complete dark palette for both schemes when light is omitted', () => {
    expect(parseCustomTheme(json)).toEqual({ name: 'custom', label: 'Custom Theme', dark, light: dark });
  });

  it('accepts a separate complete light palette and mixed-case hex', () => {
    const light = { ...dark, base: '#AbC123' };
    expect(parseCustomTheme(JSON.stringify({ dark, light }))?.light).toEqual(light);
  });

  it.each(['', ' ', '{', 'null', '[]', 'true', '12', '"theme"', '{}', '{"dark":null}', '{"dark":[]}'])('rejects malformed or incomplete input: %s', input => {
    expect(parseCustomTheme(input)).toBeNull();
  });

  it.each(Object.keys(dark))('requires the %s slot in both supplied schemes', slot => {
    const incomplete: Record<string, string> = { ...dark };
    delete incomplete[slot];
    expect(parseCustomTheme(JSON.stringify({ dark: incomplete }))).toBeNull();
    expect(parseCustomTheme(JSON.stringify({ dark, light: incomplete }))).toBeNull();
  });

  it.each([null, [], {}, false, 123456, '#fff', '#12345678', '123456', '#gggggg', 'red', 'rgb(0,0,0)', 'var(--colour)', '#123456\n', ' #123456', '#123456 ', '#123456; } body { display:none', 'url(https://example.com)'])('rejects non-six-digit colours: %j', accent => {
    expect(parseCustomTheme(JSON.stringify({ dark: { ...dark, accent } }))).toBeNull();
  });

  it.each([null, false, [], {}, 'dark'])('rejects an invalid explicit light scheme: %j', light => {
    expect(parseCustomTheme(JSON.stringify({ dark, light }))).toBeNull();
  });

  it('copies only known slots and ignores names, labels and prototype keys', () => {
    const value = JSON.parse(json);
    const injection = '*/ body { background: url(https://example.com); } /*';
    value.label = injection;
    value.name = injection;
    value.dark.extra = injection;
    const input = JSON.stringify(value).replace('"dark":{', '"__proto__":{"polluted":true},"dark":{"__proto__":{"accent":"red"},"constructor":"unsafe",');
    const theme = parseCustomTheme(input);
    expect(theme).toEqual({ name: 'custom', label: 'Custom Theme', dark, light: dark });
    expect(Object.hasOwn(theme!.dark, '__proto__')).toBe(false);
    expect(buildThemeCss(theme!)).not.toContain(injection);
    expect(buildThemeCss(theme!)).not.toContain('unsafe');
  });

  it('does not accept a required slot supplied under a prototype key', () => {
    const { accent, ...incomplete } = dark;
    const input = JSON.stringify({ dark: incomplete }).replace('"dark":{', `"dark":{"__proto__":{"accent":"${accent}"},`);
    expect(parseCustomTheme(input)).toBeNull();
  });

  it('accepts low-contrast palettes without changing their values', () => {
    const flat = Object.fromEntries(Object.keys(dark).map(slot => [slot, '#111111']));
    expect(parseCustomTheme(JSON.stringify({ dark: flat }))?.dark).toEqual(flat);
  });
});
