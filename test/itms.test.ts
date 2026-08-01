// test/itms.test.ts
// Covers the pure itms:// parser only. buildItmsRouteURL, which turns a route
// token into a URL, belongs to test/storefront.test.ts along with the rest of
// that module.
import { describe, it, expect } from 'vitest';

import { transformItmsUrl, extractItmsUrlFromArgv, type ItmsRouteToken } from '../src/itms';

describe('transformItmsUrl', () => {
  it('rebuilds catalogue album URL as https and strips app=music', () => {
    const result = transformItmsUrl('itms://music.apple.com/gb/album/foo/123?app=music');
    expect(result).toEqual({ kind: 'url', url: 'https://music.apple.com/gb/album/foo/123' });
  });

  it('preserves other query params while stripping app=music', () => {
    const result = transformItmsUrl('itms://music.apple.com/gb/album/foo/123?i=789&app=music');
    expect(result).toEqual({ kind: 'url', url: 'https://music.apple.com/gb/album/foo/123?i=789' });
  });

  it.each<[string, ItmsRouteToken]>([
    ['library', 'library'],
    ['browse', 'browse'],
    ['radio', 'radio'],
    ['listenNow', 'listenNow'],
    ['subscribe', 'subscribe'],
  ])('parses deeplink ?p=%s into route token', (param, token) => {
    const result = transformItmsUrl(`itms://music.apple.com/deeplink?p=${param}`);
    expect(result).toEqual({ kind: 'route', token });
  });

  it('returns null for deeplink with unknown token', () => {
    expect(transformItmsUrl('itms://music.apple.com/deeplink?p=bogus')).toBeNull();
  });

  it('returns null for deeplink with no p parameter', () => {
    expect(transformItmsUrl('itms://music.apple.com/deeplink')).toBeNull();
  });

  it('rejects itmss:// scheme', () => {
    expect(transformItmsUrl('itmss://music.apple.com/gb/album/foo/123')).toBeNull();
  });

  it('rejects https:// scheme', () => {
    expect(transformItmsUrl('https://music.apple.com/gb/album/foo/123')).toBeNull();
  });

  it('rejects javascript: scheme', () => {
    expect(transformItmsUrl('javascript:alert(1)')).toBeNull();
  });

  it('rejects data: scheme', () => {
    expect(transformItmsUrl('data:text/html,<script>')).toBeNull();
  });

  it('rejects file: scheme', () => {
    expect(transformItmsUrl('file:///etc/passwd')).toBeNull();
  });

  it('rejects wrong host', () => {
    expect(transformItmsUrl('itms://evil.example.com/gb/album/foo/123')).toBeNull();
  });

  it('rejects subdomain of music.apple.com', () => {
    expect(transformItmsUrl('itms://attacker.music.apple.com/gb/album/foo/123')).toBeNull();
  });

  it('returns null for malformed input', () => {
    expect(transformItmsUrl('not a url')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(transformItmsUrl('')).toBeNull();
  });
});

describe('extractItmsUrlFromArgv', () => {
  it('returns the parsed target when itms URL is the last argv element', () => {
    const argv = ['/usr/bin/sidra', '--enable-features=Foo', 'itms://music.apple.com/gb/album/foo/123?app=music'];
    expect(extractItmsUrlFromArgv(argv)).toEqual({
      kind: 'url',
      url: 'https://music.apple.com/gb/album/foo/123',
    });
  });

  it('returns the parsed target when itms URL is in the middle of argv', () => {
    const argv = ['/usr/bin/sidra', 'itms://music.apple.com/deeplink?p=radio', '--some-flag'];
    expect(extractItmsUrlFromArgv(argv)).toEqual({ kind: 'route', token: 'radio' });
  });

  it('returns null when argv contains no itms URL', () => {
    const argv = ['/usr/bin/sidra', '--enable-features=Foo'];
    expect(extractItmsUrlFromArgv(argv)).toBeNull();
  });

  it('returns null when argv contains only a malformed itms URL', () => {
    const argv = ['/usr/bin/sidra', 'itms://evil.example.com/album/foo'];
    expect(extractItmsUrlFromArgv(argv)).toBeNull();
  });

  it('returns the first valid itms URL when multiple are present', () => {
    const argv = [
      '/usr/bin/sidra',
      'itms://music.apple.com/deeplink?p=library',
      'itms://music.apple.com/gb/album/foo/123?app=music',
    ];
    expect(extractItmsUrlFromArgv(argv)).toEqual({ kind: 'route', token: 'library' });
  });

  it('skips malformed itms URLs and returns the first valid one', () => {
    const argv = [
      '/usr/bin/sidra',
      'itms://evil.example.com/foo',
      'itms://music.apple.com/deeplink?p=browse',
    ];
    expect(extractItmsUrlFromArgv(argv)).toEqual({ kind: 'route', token: 'browse' });
  });
});
