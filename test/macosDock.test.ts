// test/macosDock.test.ts
//
// The dock menu is built from getTrayStrings(), so every expectation reads the
// same i18n module the integration does rather than an English literal. The
// idle header is the case worth pinning: the Pause label there reads as a
// transport control rather than as a statement of what is playing.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from 'electron';

import { getTrayStrings } from '../src/i18n';
import { PlaybackState } from '../src/player';
import type { NowPlayingPayload } from '../src/player';
import { init } from '../src/integrations/macos-dock';
import { FakePlayer } from './mocks/player';
import { setPlatform, restorePlatform } from './mocks/platform';

const strings = getTrayStrings();

// app.dock exists on macOS only and the electron mock omits it. The Menu mock
// returns { items: template }, so the built menu carries its own template.
const setMenu = vi.fn<(menu: Electron.Menu) => void>();

afterEach(restorePlatform);

/** The template behind the menu most recently handed to the dock. */
function dockTemplate(): Electron.MenuItemConstructorOptions[] {
  const calls = setMenu.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  const menu = calls[calls.length - 1][0] as unknown as { items: Electron.MenuItemConstructorOptions[] };
  return menu.items;
}

function labels(): Array<string | undefined> {
  return dockTemplate().map((item) => (typeof item.label === 'string' ? item.label : undefined));
}

describe('macos-dock off darwin', () => {
  afterEach(() => {
    delete (app as unknown as { dock?: unknown }).dock;
  });

  for (const platform of ['linux', 'win32']) {
    it(`registers no player listeners and builds no menu on ${platform}`, () => {
      setPlatform(platform);
      setMenu.mockClear();
      (app as unknown as { dock: { setMenu: typeof setMenu } }).dock = { setMenu };
      const player = new FakePlayer();

      init({ player, getMainWindow: () => null });

      expect(player.eventNames()).toEqual([]);
      expect(setMenu).not.toHaveBeenCalled();
    });
  }
});

describe('macos-dock menu', () => {
  let player: FakePlayer;

  const track: NowPlayingPayload = {
    name: 'Blue Monday',
    artistName: 'New Order',
    url: 'https://music.apple.com/gb/song/blue-monday/1',
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(app.on).mockClear();
    setMenu.mockClear();
    setPlatform('darwin');
    (app as unknown as { dock: { setMenu: typeof setMenu } }).dock = { setMenu };

    player = new FakePlayer();
    init({ player, getMainWindow: () => null });
  });

  afterEach(() => {
    delete (app as unknown as { dock?: unknown }).dock;
    vi.useRealTimers();
  });

  it('heads the idle menu with the Not Playing label, not the Pause label', () => {
    const header = dockTemplate()[0];

    expect(header.label).toBe(strings.notPlaying);
    expect(header.enabled).toBe(false);
    // The two labels differ, so this fails the moment the header falls back to
    // the transport control's text.
    expect(header.label).not.toBe(strings.pause);
  });

  it('keeps Pause as a transport control while playing', () => {
    player.setPlaybackState(PlaybackState.Playing);
    player.emitNowPlaying(track);

    // The header names the track, so Pause can only be the control below it.
    expect(labels()).toContain(strings.pause);
    expect(dockTemplate()[0].label).not.toBe(strings.pause);
  });

  it('labels the transport control Play while paused', () => {
    expect(labels()).toContain(strings.play);
    expect(labels()).not.toContain(strings.pause);
  });

  it('puts the track and artist in the header', () => {
    player.emitNowPlaying(track);

    const header = dockTemplate()[0];
    expect(header.label).toBe('Blue Monday - New Order');
    expect(header.enabled).toBe(false);
  });

  it('names the track alone when the payload carries no artist', () => {
    player.emitNowPlaying({ name: 'Blue Monday' });

    expect(dockTemplate()[0].label).toBe('Blue Monday');
  });

  it('adds the Share item when a share URL resolves', () => {
    player.emitNowPlaying(track);

    expect(labels()).toContain(strings.share);
  });

  it('omits the Share item when no share URL resolves', () => {
    player.emitNowPlaying({ name: 'Blue Monday', artistName: 'New Order' });

    expect(labels()).not.toContain(strings.share);
  });

  it('clears the header back to the idle label on a terminal playback state', () => {
    player.emitNowPlaying(track);
    expect(dockTemplate()[0].label).toBe('Blue Monday - New Order');

    player.emitPlaybackState(PlaybackState.Stopped);

    expect(dockTemplate()[0].label).toBe(strings.notPlaying);
    expect(labels()).not.toContain(strings.share);
  });

  it('clears the header back to the idle label on a null payload', () => {
    player.emitNowPlaying(track);

    player.emitNowPlaying(null);

    expect(dockTemplate()[0].label).toBe(strings.notPlaying);
  });
});
