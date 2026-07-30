import { describe, it, expect, expectTypeOf } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  MUSIC_SERVICES,
  DEFAULT_SERVICE_ID,
  getService,
  getServiceByHost,
  allServices,
  isMusicServiceId,
  ALLOWED_NAVIGATION_HOSTS,
  isAllowedNavigationUrl,
} from '../src/musicService';
import type {
  MusicServiceId,
  MusicService,
  MusicStartPageId,
  ClassicalStartPageId,
  AnyStartPageId,
} from '../src/musicService';
import { CONTENT_READY_SELECTOR } from '../src/contentReady';

describe('MusicService types', () => {
  it('DEFAULT_SERVICE_ID is MusicServiceId', () => {
    expectTypeOf(DEFAULT_SERVICE_ID).toEqualTypeOf<MusicServiceId>();
  });

  it('getService returns MusicService', () => {
    expectTypeOf(getService).returns.toEqualTypeOf<MusicService>();
  });

  // Pins the derived unions: adding or renaming a registry start page must be a deliberate edit
  // here too, because config keys and the tray label record are typed from these.
  it('MusicStartPageId covers exactly the music start pages', () => {
    expectTypeOf<MusicStartPageId>().toEqualTypeOf<'home' | 'new' | 'radio' | 'all-playlists'>();
  });

  it('ClassicalStartPageId covers exactly the classical start pages', () => {
    expectTypeOf<ClassicalStartPageId>().toEqualTypeOf<'home' | 'browse' | 'playlists' | 'search'>();
  });

  it('AnyStartPageId is the union of both services', () => {
    expectTypeOf<AnyStartPageId>().toEqualTypeOf<MusicStartPageId | ClassicalStartPageId>();
    expectTypeOf<AnyStartPageId>().toEqualTypeOf<
      'home' | 'new' | 'radio' | 'all-playlists' | 'browse' | 'playlists' | 'search'
    >();
  });
});

describe('MUSIC_SERVICES registry', () => {
  // One whole-registry comparison rather than a field at a time: an added, renamed or dropped
  // entry is caught as well, and a failure prints the whole diff instead of one stray value.
  // Start page order is the tray submenu order, so the arrays are compared in order.
  it('matches the expected registry shape', () => {
    expect(MUSIC_SERVICES).toEqual({
      music: {
        id: 'music',
        host: 'music.apple.com',
        origin: 'https://music.apple.com',
        displayName: 'Apple Music',
        authFrameHosts: ['auth.music.apple.com', 'idmsa.apple.com'],
        contentReadySelector: CONTENT_READY_SELECTOR,
        startPages: [
          { id: 'home', path: 'home' },
          { id: 'new', path: 'new' },
          { id: 'radio', path: 'radio' },
          { id: 'all-playlists', path: 'library/all-playlists/' },
        ],
        defaultStartPage: 'new',
      },
      classical: {
        id: 'classical',
        host: 'classical.music.apple.com',
        origin: 'https://classical.music.apple.com',
        displayName: 'Apple Music Classical',
        authFrameHosts: ['auth.music.apple.com', 'idmsa.apple.com'],
        contentReadySelector: CONTENT_READY_SELECTOR,
        startPages: [
          { id: 'home', path: '' },
          // Classical serves its catalogue under browse/, so both of these paths carry the prefix.
          { id: 'browse', path: 'browse/catalog' },
          { id: 'playlists', path: 'browse/playlists' },
          { id: 'search', path: 'search' },
        ],
        defaultStartPage: 'home',
      },
    });
  });
});

// Both services probe readiness with the same selector; a second copy of the literal would
// drift silently, so the registry must reference the one in contentReady.ts.
describe('content ready selector', () => {
  it('music entry uses CONTENT_READY_SELECTOR', () => {
    expect(MUSIC_SERVICES['music'].contentReadySelector).toBe(CONTENT_READY_SELECTOR);
  });

  it('classical entry uses CONTENT_READY_SELECTOR', () => {
    expect(MUSIC_SERVICES['classical'].contentReadySelector).toBe(CONTENT_READY_SELECTOR);
  });
});

describe('DEFAULT_SERVICE_ID', () => {
  it('is music', () => {
    expect(DEFAULT_SERVICE_ID).toBe('music');
  });
});

describe('getService', () => {
  it('returns the music service for id "music"', () => {
    const svc = getService('music');
    expect(svc.id).toBe('music');
    expect(svc.host).toBe('music.apple.com');
    expect(svc.origin).toBe('https://music.apple.com');
    expect(svc.displayName).toBe('Apple Music');
  });

  it('returns same object as MUSIC_SERVICES registry', () => {
    expect(getService('music')).toBe(MUSIC_SERVICES['music']);
  });
});

describe('getServiceByHost', () => {
  it('returns the music service for music.apple.com', () => {
    const svc = getServiceByHost('music.apple.com');
    expect(svc).toBeDefined();
    expect(svc!.id).toBe('music');
  });

  it('returns the classical service for classical.music.apple.com', () => {
    const svc = getServiceByHost('classical.music.apple.com');
    expect(svc).toBeDefined();
    expect(svc!.id).toBe('classical');
  });

  it('returns undefined for an unknown host', () => {
    expect(getServiceByHost('unknown.example.com')).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(getServiceByHost('')).toBeUndefined();
  });
});

describe('isMusicServiceId', () => {
  it('accepts every registered id', () => {
    expect(isMusicServiceId('music')).toBe(true);
    expect(isMusicServiceId('classical')).toBe(true);
  });

  it('rejects an unregistered id', () => {
    expect(isMusicServiceId('jazz')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isMusicServiceId('')).toBe(false);
  });

  // A prototype-walking check would accept these and hand main.ts an undefined service.
  it('rejects inherited Object.prototype keys', () => {
    expect(isMusicServiceId('toString')).toBe(false);
    expect(isMusicServiceId('constructor')).toBe(false);
  });

  it('narrows a string to MusicServiceId', () => {
    const persisted: string = 'classical';
    if (isMusicServiceId(persisted)) {
      expectTypeOf(persisted).toEqualTypeOf<MusicServiceId>();
      expect(getService(persisted).id).toBe('classical');
    }
  });
});

describe('start page registry integrity', () => {
  for (const service of allServices()) {
    it(`${service.id} declares at least one start page`, () => {
      expect(service.startPages.length).toBeGreaterThan(0);
    });

    it(`${service.id} defaultStartPage names one of its own start pages`, () => {
      expect(service.startPages.map(p => p.id)).toContain(service.defaultStartPage);
    });
  }
});

describe('allServices', () => {
  it('returns an array containing both services', () => {
    const svcs = allServices();
    expect(svcs.length).toBe(2);
    expect(svcs.map(s => s.id)).toContain('music');
    expect(svcs.map(s => s.id)).toContain('classical');
  });
});

describe('ALLOWED_NAVIGATION_HOSTS', () => {
  it('holds exactly the hosts derived from the registry', () => {
    const derived = allServices().flatMap(svc => [svc.host, ...svc.authFrameHosts]);
    expect([...ALLOWED_NAVIGATION_HOSTS].sort()).toEqual([...new Set(derived)].sort());
  });
});

describe('isAllowedNavigationUrl', () => {
  for (const service of allServices()) {
    it(`accepts an https URL on the ${service.id} host`, () => {
      expect(isAllowedNavigationUrl(`https://${service.host}/`)).toBe(true);
    });

    for (const host of service.authFrameHosts) {
      it(`accepts an https URL on the ${service.id} auth frame host ${host}`, () => {
        expect(isAllowedNavigationUrl(`https://${host}/`)).toBe(true);
      });
    }
  }

  it('rejects a foreign host', () => {
    expect(isAllowedNavigationUrl('https://evil.test/')).toBe(false);
  });

  // An endsWith comparison would accept this subdomain.
  it('rejects a subdomain of an allowed host', () => {
    expect(isAllowedNavigationUrl('https://evil.music.apple.com/')).toBe(false);
  });

  it('rejects a host ending with an allowed host as a suffix', () => {
    expect(isAllowedNavigationUrl('https://evil.music.apple.com.attacker.test/')).toBe(false);
  });

  // An includes comparison would accept this hostname.
  it('rejects a host that merely contains an allowed host', () => {
    expect(isAllowedNavigationUrl('https://music.apple.com.attacker.test/')).toBe(false);
  });

  // An includes comparison against the whole URL would accept this query string.
  it('rejects a foreign host carrying an allowed host in the query string', () => {
    expect(isAllowedNavigationUrl('https://attacker.test/?x=music.apple.com')).toBe(false);
  });

  it('rejects a malformed URL', () => {
    expect(isAllowedNavigationUrl('not a url')).toBe(false);
  });

  it('rejects an empty string', () => {
    expect(isAllowedNavigationUrl('')).toBe(false);
  });

  it('rejects an allowed host carried in the userinfo of a foreign host', () => {
    expect(isAllowedNavigationUrl('https://music.apple.com@evil.test/')).toBe(false);
  });

  // Pins the URL parser behaviour the predicate depends on.
  it('reads the hostname after the userinfo, not the userinfo itself', () => {
    expect(new URL('https://music.apple.com@evil.test/').hostname).toBe('evil.test');
  });
});

describe('preload contract', () => {
  it('postMessage uses window.location.origin (service-agnostic)', () => {
    const preload = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'preload.ts'),
      'utf-8',
    );
    expect(preload).toMatch(/window\.postMessage\(.*window\.location\.origin\)/);
  });
});
