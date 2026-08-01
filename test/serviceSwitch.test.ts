import { describe, it, expect, expectTypeOf, vi, beforeEach } from 'vitest';
import { Tray } from 'electron';
import type { MusicServiceId } from '../src/musicService';

// One shared recorder: every mocked step appends its own name, so a dropped or
// reordered step in switchService() shows up as a different array.
const { calls, state } = vi.hoisted(() => ({
  calls: [] as string[],
  state: { service: 'music' as MusicServiceId },
}));

vi.mock('../src/wedgeDetector', () => ({
  reset: vi.fn(() => { calls.push('resetWedgeDetector'); }),
}));

vi.mock('../src/config', () => ({
  getMusicService: vi.fn(() => state.service),
  setMusicService: vi.fn((id: MusicServiceId) => {
    calls.push('setMusicService');
    state.service = id;
  }),
}));

vi.mock('../src/tray', () => ({
  rebuildTrayMenu: vi.fn(() => { calls.push('rebuildTrayMenu'); }),
}));

vi.mock('../src/theme', () => ({
  setThemeCssKey: vi.fn(() => { calls.push('setThemeCssKey'); }),
}));

// Returns the persisted service, so a URL built before setMusicService names the old one.
vi.mock('../src/storefront', () => ({
  buildAppleMusicURL: vi.fn(() => `https://example.test/${state.service}`),
}));

import { initServiceSwitch, routeToMusicService, switchService } from '../src/serviceSwitch';
import { setMusicService } from '../src/config';
import { rebuildTrayMenu } from '../src/tray';
import { setThemeCssKey } from '../src/theme';
import { buildAppleMusicURL } from '../src/storefront';

describe('serviceSwitch', () => {
  const tray = new Tray('/tmp/sidra-test/icon.png');
  const loadURL = vi.fn((_url: string) => { calls.push('loadURL'); });

  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    state.service = 'music';
    initServiceSwitch({ getTray: () => tray, loadURL });
  });

  it('runs the five steps in the fixed order', () => {
    switchService('classical');
    expect(calls).toEqual([
      'resetWedgeDetector',
      'setMusicService',
      'rebuildTrayMenu',
      'setThemeCssKey',
      'loadURL',
    ]);
  });

  it('persists the requested service and rebuilds the supplied tray', () => {
    switchService('classical');
    expect(setMusicService).toHaveBeenCalledWith('classical');
    expect(rebuildTrayMenu).toHaveBeenCalledWith(tray);
  });

  it('clears the tracked inserted-CSS key', () => {
    switchService('classical');
    expect(setThemeCssKey).toHaveBeenCalledWith(null);
  });

  it('builds the default URL after persisting the service', () => {
    switchService('classical');
    expect(loadURL).toHaveBeenCalledWith('https://example.test/classical');
    expect(vi.mocked(buildAppleMusicURL).mock.invocationCallOrder[0])
      .toBeGreaterThan(vi.mocked(setMusicService).mock.invocationCallOrder[0]);
  });

  it('passes an explicit target URL through unchanged', () => {
    switchService('music', 'https://music.apple.com/gb/album/1');
    expect(loadURL).toHaveBeenCalledWith('https://music.apple.com/gb/album/1');
    expect(buildAppleMusicURL).not.toHaveBeenCalled();
  });

  it('completes the sequence when no tray exists', () => {
    initServiceSwitch({ getTray: () => null, loadURL });
    switchService('classical');
    expect(calls).toEqual(['resetWedgeDetector', 'setMusicService', 'setThemeCssKey', 'loadURL']);
    expect(rebuildTrayMenu).not.toHaveBeenCalled();
  });

  it('takes a service id, not a bare string', () => {
    expectTypeOf(switchService).parameter(0).toEqualTypeOf<MusicServiceId>();
    expectTypeOf(switchService).parameter(1).toEqualTypeOf<string | undefined>();
  });
});

// The itms:// path in main.ts is this function plus a URL. The service branch lives
// here rather than in main.ts, which runs app.whenReady() at import and cannot be
// loaded under Vitest, so driving the function directly covers the whole path.
describe('routeToMusicService', () => {
  const tray = new Tray('/tmp/sidra-test/icon.png');
  const loadURL = vi.fn((_url: string) => { calls.push('loadURL'); });
  const deepLink = 'https://music.apple.com/gb/album/1234';

  beforeEach(() => {
    vi.clearAllMocks();
    calls.length = 0;
    initServiceSwitch({ getTray: () => tray, loadURL });
  });

  it('runs the same sequence as the tray path when classical is active', () => {
    state.service = 'classical';
    routeToMusicService(deepLink);
    expect(calls).toEqual([
      'resetWedgeDetector',
      'setMusicService',
      'rebuildTrayMenu',
      'setThemeCssKey',
      'loadURL',
    ]);
    expect(setMusicService).toHaveBeenCalledWith('music');
    expect(setThemeCssKey).toHaveBeenCalledWith(null);
  });

  it('navigates once, to the link rather than the start page', () => {
    state.service = 'classical';
    routeToMusicService(deepLink);
    expect(loadURL).toHaveBeenCalledTimes(1);
    expect(loadURL).toHaveBeenCalledWith(deepLink);
    expect(buildAppleMusicURL).not.toHaveBeenCalled();
  });

  it('loads the link without switching when music is already active', () => {
    state.service = 'music';
    routeToMusicService(deepLink);
    expect(calls).toEqual(['loadURL']);
    expect(loadURL).toHaveBeenCalledWith(deepLink);
    expect(setMusicService).not.toHaveBeenCalled();
  });
});
