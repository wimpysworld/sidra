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
import type { MusicServiceId, MusicService } from '../src/musicService';

describe('MusicService types', () => {
  it('DEFAULT_SERVICE_ID is MusicServiceId', () => {
    expectTypeOf(DEFAULT_SERVICE_ID).toEqualTypeOf<MusicServiceId>();
  });

  it('getService returns MusicService', () => {
    expectTypeOf(getService).returns.toEqualTypeOf<MusicService>();
  });
});

describe('MUSIC_SERVICES registry', () => {
  it('contains the music entry', () => {
    expect(MUSIC_SERVICES['music']).toBeDefined();
  });

  it('music entry has correct id', () => {
    expect(MUSIC_SERVICES['music'].id).toBe('music');
  });

  it('music entry has correct host', () => {
    expect(MUSIC_SERVICES['music'].host).toBe('music.apple.com');
  });

  it('music entry has correct origin', () => {
    expect(MUSIC_SERVICES['music'].origin).toBe('https://music.apple.com');
  });

  it('music entry has correct displayName', () => {
    expect(MUSIC_SERVICES['music'].displayName).toBe('Apple Music');
  });

  it('music entry has correct authFrameHosts', () => {
    expect(MUSIC_SERVICES['music'].authFrameHosts).toContain('auth.music.apple.com');
    expect(MUSIC_SERVICES['music'].authFrameHosts).toContain('idmsa.apple.com');
  });

  it('contains the classical entry', () => {
    expect(MUSIC_SERVICES['classical']).toBeDefined();
  });

  it('classical entry has correct id', () => {
    expect(MUSIC_SERVICES['classical'].id).toBe('classical');
  });

  it('classical entry has correct host', () => {
    expect(MUSIC_SERVICES['classical'].host).toBe('classical.music.apple.com');
  });

  it('classical entry has correct origin', () => {
    expect(MUSIC_SERVICES['classical'].origin).toBe('https://classical.music.apple.com');
  });

  it('classical entry has correct displayName', () => {
    expect(MUSIC_SERVICES['classical'].displayName).toBe('Apple Music Classical');
  });

  it('classical entry has start pages', () => {
    expect(MUSIC_SERVICES['classical'].startPages.length).toBeGreaterThan(0);
    expect(MUSIC_SERVICES['classical'].startPages.map(p => p.id)).toContain('home');
  });

  it('classical entry declares exactly the reachable start pages', () => {
    expect(MUSIC_SERVICES['classical'].startPages.map(p => p.id)).toEqual([
      'home',
      'browse',
      'playlists',
      'search',
    ]);
  });

  it('classical browse start page points at browse/catalog', () => {
    const browse = MUSIC_SERVICES['classical'].startPages.find(p => p.id === 'browse');
    expect(browse).toBeDefined();
    expect(browse!.path).toBe('browse/catalog');
  });

  it('classical entry has a defaultStartPage', () => {
    expect(MUSIC_SERVICES['classical'].defaultStartPage).toBe('home');
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

  it('does not throw on malformed input', () => {
    expect(() => isAllowedNavigationUrl('not a url')).not.toThrow();
    expect(() => isAllowedNavigationUrl('')).not.toThrow();
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
