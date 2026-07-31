// test/integrationCleanup.test.ts
//
// Enforces the AGENTS.md claim that every listener is cleaned up on will-quit.
// The claim had drifted in three places before this file existed: macos-dock
// registered three anonymous listeners and had no will-quit handler at all,
// wedgeDetector stopped its timer and left its listeners attached, and main.ts
// discarded the teardown closure initTrayStateManager returns.
import fs from 'node:fs';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from 'electron';

import { PlaybackState } from '../src/player';
import type { IntegrationContext } from '../src/player';
import { FakePlayer } from './mocks/player';

const SRC_DIR = path.join(__dirname, '..', 'src');
const INTEGRATIONS_DIR = path.join(SRC_DIR, 'integrations');

/** Every module that takes a Player and may register listeners on it. */
function playerConsumerFiles(): string[] {
  const integrations = fs
    .readdirSync(INTEGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(INTEGRATIONS_DIR, entry.name, 'index.ts'))
    .filter((file) => fs.existsSync(file));

  // wedgeDetector and tray are not under integrations/ but register on the
  // same Player and are bound by the same claim.
  return [...integrations, path.join(SRC_DIR, 'wedgeDetector.ts'), path.join(SRC_DIR, 'tray.ts')];
}

/**
 * Runs the `will-quit` handlers a module registered, as quitting does. The
 * electron mock records them rather than firing them, and its `app.on` is a
 * plain `vi.fn()`, so the overloaded signature is narrowed to what is stored.
 */
function quit(): void {
  const registered = vi.mocked(app.on).mock.calls as unknown as Array<[string, () => void]>;
  for (const [event, handler] of registered) if (event === 'will-quit') handler();
}

describe('player listener cleanup', () => {
  // A source sweep rather than a per-module behavioural test, so a new
  // integration directory is covered the moment it is added. Reaching every
  // module behaviourally would mean mocking dbus, discord-rpc and three
  // platforms; this catches the omission the same way and cannot go stale.
  describe('every registration has a matching removal', () => {
    for (const file of playerConsumerFiles()) {
      const relative = path.relative(path.join(__dirname, '..'), file);

      it(`${relative} removes every player listener it registers`, () => {
        const source = fs.readFileSync(file, 'utf-8');

        // Only a named reference can be removed later, so an inline listener
        // is a failure whatever else the file does.
        const named = [...source.matchAll(/player\.on\(\s*'([^']+)'\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g)];
        const total = [...source.matchAll(/player\.on\(/g)].length;
        expect(
          named.length,
          `${relative} registers a player listener with an inline function, which cannot be removed`,
        ).toBe(total);

        for (const [, event, handler] of named) {
          const removal = new RegExp(
            `player\\.(removeListener|off)\\(\\s*'${event}'\\s*,\\s*${handler}\\s*\\)`,
          );
          expect(
            removal.test(source),
            `${relative} registers '${event}' as ${handler} but never removes it`,
          ).toBe(true);
        }
      });
    }
  });

  it('main.ts invokes the teardown initTrayStateManager returns', () => {
    const source = fs.readFileSync(path.join(SRC_DIR, 'main.ts'), 'utf-8');

    // A bare call statement discards the closure, which is how the tray pause
    // timer and its three listeners survived quitting.
    expect(
      /^\s*initTrayStateManager\(/m.test(source),
      'main.ts calls initTrayStateManager() as a statement, discarding its teardown closure',
    ).toBe(false);
    expect(source).toMatch(/app\.on\(\s*'will-quit'\s*,\s*teardownTrayState\s*\)/);
  });
});

describe('macos-dock cleanup', () => {
  let player: FakePlayer;
  let setMenu: ReturnType<typeof vi.fn>;
  let originalPlatform: PropertyDescriptor | undefined;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.mocked(app.on).mockClear();

    originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });

    setMenu = vi.fn();
    (app as unknown as { dock: { setMenu: typeof setMenu } }).dock = { setMenu };

    player = new FakePlayer();
    const dock = await import('../src/integrations/macos-dock');
    dock.init({ player, getMainWindow: () => null } as IntegrationContext);
  });

  afterEach(() => {
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
    delete (app as unknown as { dock?: unknown }).dock;
    vi.useRealTimers();
  });

  it('registers listeners on init', () => {
    expect(player.listenerCount('nowPlayingItemDidChange')).toBe(1);
    expect(player.listenerCount('playbackStateDidChange')).toBe(1);
    expect(player.listenerCount('playbackTimeDidChange')).toBe(1);
  });

  it('removes every listener on will-quit', () => {
    quit();

    expect(player.eventNames()).toEqual([]);
  });

  it('runs no handler for an event emitted after will-quit', () => {
    quit();
    const before = setMenu.mock.calls.length;

    player.emitNowPlaying({ name: 'Blue Monday', artistName: 'New Order' });
    player.emitPlaybackState(PlaybackState.Playing);
    player.setPositionUs(1_000_000);

    expect(setMenu.mock.calls.length).toBe(before);
  });

  it('cannot fire the pause timer after will-quit', () => {
    // Playing then paused arms the 30 second timer, whose expiry rebuilds the
    // dock menu. Quitting has to destroy it or it fires into a torn-down dock.
    player.emitPlaybackState(PlaybackState.Playing);
    player.emitPlaybackState(PlaybackState.Paused);

    quit();
    const before = setMenu.mock.calls.length;
    vi.advanceTimersByTime(60_000);

    expect(setMenu.mock.calls.length).toBe(before);
  });
});

describe('wedgeDetector cleanup', () => {
  let player: FakePlayer;
  let send: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.mocked(app.on).mockClear();
    vi.resetModules();

    player = new FakePlayer();
    send = vi.fn();
    const wedgeDetector = await import('../src/wedgeDetector');
    wedgeDetector.init({
      player,
      getMainWindow: () => ({ webContents: { send } }),
    } as unknown as IntegrationContext);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('removes every listener on will-quit', () => {
    expect(player.eventNames().length).toBeGreaterThan(0);

    quit();

    expect(player.eventNames()).toEqual([]);
  });

  it('attempts no skip for playback stalled after will-quit', () => {
    quit();

    player.emitPlaybackState(PlaybackState.Playing);
    vi.advanceTimersByTime(60_000);

    expect(send).not.toHaveBeenCalled();
  });
});

describe('tray state manager cleanup', () => {
  it('removes every listener when its teardown runs', async () => {
    const player = new FakePlayer();
    const { initTrayStateManager } = await import('../src/tray');
    const tray = {
      setContextMenu: vi.fn(),
      setToolTip: vi.fn(),
      on: vi.fn(),
    };

    const teardown = initTrayStateManager(player, tray as unknown as Electron.Tray);
    expect(player.eventNames().length).toBeGreaterThan(0);

    teardown();

    expect(player.eventNames()).toEqual([]);
  });
});
