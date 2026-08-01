// src/itms.ts
// Pure parser for itms:// URLs delivered via OS protocol handler or argv.
// No imports from electron, electron-log, or config: keep this module
// dependency-free so it is trivially unit-testable.

import { MUSIC_SERVICES } from './musicService';

// The one list of route tokens. The type is derived from it, so the allowlist the
// parser tests against and the union every consumer sees cannot drift apart.
const ROUTE_TOKENS = ['library', 'browse', 'radio', 'listenNow', 'subscribe'] as const;

/** The named destinations Apple's itms://music.apple.com/deeplink?p= form carries. */
export type ItmsRouteToken = typeof ROUTE_TOKENS[number];

/** Either a catalogue URL to open as-is, or a route the storefront resolves to one. */
export type ItmsTarget =
  | { kind: 'url'; url: string }
  | { kind: 'route'; token: ItmsRouteToken };

// Typed ReadonlySet<string>, not ReadonlySet<ItmsRouteToken>: the value under test
// comes from the OS, so a narrow set would need a cast at the trust boundary.
const ROUTE_TOKEN_LOOKUP: ReadonlySet<string> = new Set(ROUTE_TOKENS);

function isRouteToken(value: string | null): value is ItmsRouteToken {
  return value !== null && ROUTE_TOKEN_LOOKUP.has(value);
}

/**
 * Validates one itms:// URL and converts it to something Sidra can open. This is a
 * trust boundary: the URL arrives from the OS, so a bad scheme or host is null, and
 * a /deeplink path is null unless its `p` token is on the allowlist. Any other path
 * becomes an https catalogue URL with the `app` parameter stripped.
 */
export function transformItmsUrl(input: string): ItmsTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'itms:') {
    return null;
  }
  // itms:// is permanently pinned to the music service
  if (parsed.hostname !== MUSIC_SERVICES['music'].host) {
    return null;
  }

  if (parsed.pathname === '/deeplink') {
    const token = parsed.searchParams.get('p');
    if (!isRouteToken(token)) {
      return null;
    }
    return { kind: 'route', token };
  }

  // Catalogue URL: rebuild as https, strip the `app` parameter.
  const rebuilt = new URL(`${MUSIC_SERVICES['music'].origin}/`);
  rebuilt.pathname = parsed.pathname;
  const params = new URLSearchParams(parsed.searchParams);
  params.delete('app');
  rebuilt.search = params.toString();
  return { kind: 'url', url: rebuilt.toString() };
}

/**
 * First valid itms:// URL in a process argv, or null. Used at launch and by the
 * second-instance handler, where the link arrives as an argument rather than an event.
 */
export function extractItmsUrlFromArgv(argv: readonly string[]): ItmsTarget | null {
  for (const arg of argv) {
    if (arg.startsWith('itms:')) {
      const target = transformItmsUrl(arg);
      if (target !== null) {
        return target;
      }
    }
  }
  return null;
}
