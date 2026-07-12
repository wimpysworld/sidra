import { describe, it, expect, expectTypeOf } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  MUSIC_SERVICES,
  DEFAULT_SERVICE_ID,
  getService,
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

describe('preload contract', () => {
  it('postMessage origin literal matches music service registry', () => {
    const preload = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'preload.ts'),
      'utf-8',
    );
    const origin = MUSIC_SERVICES['music'].origin;
    expect(preload).toMatch(new RegExp(`window\\.postMessage\\(.*'${origin}'\\)`));
  });
});
