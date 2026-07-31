import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';

import { setMusicService } from '../src/config';
import type { IntegrationContext } from '../src/player';
import * as mpris from '../src/integrations/mpris';
import { FakePlayer } from './mocks/player';

interface DbusBus {
  on: (event: string, listener: (err: Error) => void) => void;
  export: (path: string, iface: object) => void;
  requestName: (name: string, flags: number) => Promise<unknown>;
}

interface DbusModule {
  sessionBus: () => DbusBus;
}

// src/integrations/mpris/index.ts pulls @holusion/dbus-next in with a bare
// require, which vi.mock does not intercept. The module loads fine off a bus -
// only sessionBus() opens a socket - so the real one is loaded and that single
// entry point is stubbed.
const dbus = require('@holusion/dbus-next') as DbusModule;

const busStub = {
  on: vi.fn(),
  export: vi.fn<(path: string, iface: object) => void>(),
  requestName: vi.fn(() => Promise.resolve()),
};

interface PlayerInterface {
  OpenUri(uri: string): void;
}

describe('MPRIS OpenUri', () => {
  let win: { loadURL: ReturnType<typeof vi.fn> };

  /**
   * init() exports the root interface first and the player interface second, so
   * the live MediaPlayer2Player instance is the second argument of the second
   * export. Driving the real method this way needs no production change.
   */
  function initPlayerInterface(): PlayerInterface {
    const ctx: IntegrationContext = {
      player: new FakePlayer(),
      getMainWindow: () => win as unknown as BrowserWindow,
    };
    mpris.init(ctx);
    expect(busStub.export).toHaveBeenCalledTimes(2);
    return busStub.export.mock.calls[1][1] as PlayerInterface;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(dbus, 'sessionBus').mockReturnValue(busStub);
    setMusicService('music');
    // loadURL must return a promise: production attaches a .catch() to it.
    win = { loadURL: vi.fn(() => Promise.resolve()) };
  });

  it('loads a music.apple.com URI', () => {
    initPlayerInterface().OpenUri('https://music.apple.com/gb/album/foo');
    expect(win.loadURL).toHaveBeenCalledWith('https://music.apple.com/gb/album/foo');
  });

  it('loads a classical.music.apple.com URI', () => {
    initPlayerInterface().OpenUri('https://classical.music.apple.com/gb/album/foo');
    expect(win.loadURL).toHaveBeenCalledWith('https://classical.music.apple.com/gb/album/foo');
  });

  // Every registered host is accepted whatever the active service is. The check
  // once compared against the active service's host, so with Classical selected
  // every music.apple.com URI an MPRIS client sent was dropped.
  it('loads a music.apple.com URI while Classical is the active service', () => {
    setMusicService('classical');
    initPlayerInterface().OpenUri('https://music.apple.com/gb/album/foo');
    expect(win.loadURL).toHaveBeenCalledWith('https://music.apple.com/gb/album/foo');
  });

  it('rejects an unregistered host', () => {
    initPlayerInterface().OpenUri('https://example.com/gb/album/foo');
    expect(win.loadURL).not.toHaveBeenCalled();
  });

  it('rejects a non-https URI', () => {
    initPlayerInterface().OpenUri('http://music.apple.com/gb/album/foo');
    expect(win.loadURL).not.toHaveBeenCalled();
  });

  it('rejects a malformed URI without throwing', () => {
    const playerIface = initPlayerInterface();
    expect(() => playerIface.OpenUri('not a url')).not.toThrow();
    expect(win.loadURL).not.toHaveBeenCalled();
  });
});

describe('MPRIS without a session bus', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setMusicService('music');
  });

  // dbus-next throws synchronously from sessionBus() when
  // DBUS_SESSION_BUS_ADDRESS is unset and it cannot read the address from the
  // filesystem. init() is called bare inside the did-finish-load handler in
  // main.ts, so an escaping throw takes out every integration after it and the
  // splash screen never closes.
  it('does not throw when the bus cannot be opened', () => {
    vi.spyOn(dbus, 'sessionBus').mockImplementation(() => {
      throw new Error('could not get DISPLAY environment variable');
    });

    const ctx: IntegrationContext = {
      player: new FakePlayer(),
      getMainWindow: () => ({ loadURL: vi.fn(() => Promise.resolve()) }) as unknown as BrowserWindow,
    };

    expect(() => mpris.init(ctx)).not.toThrow();
  });

  it('exports no interfaces when the bus cannot be opened', () => {
    vi.spyOn(dbus, 'sessionBus').mockImplementation(() => {
      throw new Error('could not get DISPLAY environment variable');
    });

    const ctx: IntegrationContext = {
      player: new FakePlayer(),
      getMainWindow: () => ({ loadURL: vi.fn(() => Promise.resolve()) }) as unknown as BrowserWindow,
    };
    mpris.init(ctx);

    expect(busStub.export).not.toHaveBeenCalled();
    expect(busStub.requestName).not.toHaveBeenCalled();
  });

  it('subscribes to no player events when the bus cannot be opened', () => {
    vi.spyOn(dbus, 'sessionBus').mockImplementation(() => {
      throw new Error('could not get DISPLAY environment variable');
    });

    const player = new FakePlayer();
    mpris.init({
      player,
      getMainWindow: () => ({ loadURL: vi.fn(() => Promise.resolve()) }) as unknown as BrowserWindow,
    });

    // The subscriptions sit after the bus is opened, so a bail-out leaves the
    // player untouched and nothing holds a reference to the dead integration.
    expect(player.listenerCount('playbackStateDidChange')).toBe(0);
    expect(player.listenerCount('nowPlayingItemDidChange')).toBe(0);
    expect(player.listenerCount('playbackTimeDidChange')).toBe(0);
  });
});
