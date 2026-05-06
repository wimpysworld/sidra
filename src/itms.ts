// src/itms.ts
// Pure parser for itms:// URLs delivered via OS protocol handler or argv.
// No imports from electron, electron-log, or config: keep this module
// dependency-free so it is trivially unit-testable.

export type ItmsRouteToken = 'library' | 'browse' | 'radio' | 'listenNow' | 'subscribe';

export type ItmsTarget =
  | { kind: 'url'; url: string }
  | { kind: 'route'; token: ItmsRouteToken };

const ROUTE_TOKENS: ReadonlySet<ItmsRouteToken> = new Set<ItmsRouteToken>([
  'library',
  'browse',
  'radio',
  'listenNow',
  'subscribe',
]);

function isRouteToken(value: string | null): value is ItmsRouteToken {
  return value !== null && ROUTE_TOKENS.has(value as ItmsRouteToken);
}

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
  if (parsed.hostname !== 'music.apple.com') {
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
  const rebuilt = new URL('https://music.apple.com/');
  rebuilt.pathname = parsed.pathname;
  const params = new URLSearchParams(parsed.searchParams);
  params.delete('app');
  rebuilt.search = params.toString();
  return { kind: 'url', url: rebuilt.toString() };
}

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
