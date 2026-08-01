// test/integrationCleanup.test.ts
//
// Enforces the AGENTS.md claim that every listener is cleaned up on will-quit.
// Nothing else in the suite notices when it breaks, and it breaks quietly:
// anonymous listeners cannot be removed at all, a module can stop its timer
// and leave its listeners attached, and a teardown closure is discarded by
// calling the function that returns it as a bare statement.
import fs from 'node:fs';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { app } from 'electron';

import { PlaybackState } from '../src/player';
import type { IntegrationContext } from '../src/player';
import { FakePlayer } from './mocks/player';
import { quit } from './mocks/appLifecycle';
import { setPlatform, restorePlatform } from './mocks/platform';

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
 * The two cleanup forms this tree uses: the `will-quit` handler an integration
 * registers, and the teardown closure `initTrayStateManager` returns. A
 * separate test in this file checks main.ts wires that closure to `will-quit`.
 */
const CLEANUP_OPENER =
  /app\.on\(\s*'will-quit'\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{|return\s*(?:async\s*)?\(\s*\)\s*=>\s*\{/;

/**
 * The index of the quote that closes the string literal starting at
 * `openIndex`, or -1 when it never closes. A `${}` expression inside a template is skipped whole; the
 * braces in it balance, so passing over them costs the brace count nothing.
 */
function endOfString(source: string, openIndex: number): number {
  const quote = source[openIndex];
  for (let i = openIndex + 1; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '\\') {
      i += 1;
      continue;
    }
    if (ch === quote) return i;
    if (quote !== '`' && ch === '\n') return -1;
  }
  return -1;
}

/**
 * The body of the block whose `{` sits at `openIndex`, found by balancing
 * braces forward, or `null` when the balance never returns to zero. Comments
 * and string literals are stepped over so a brace inside either is not counted.
 * Returning `null` fails the sweep rather than passing it: a block this scanner
 * cannot read is a block whose removals it cannot see.
 */
function balancedBody(source: string, openIndex: number): string | null {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const eol = source.indexOf('\n', i);
      if (eol === -1) return null;
      i = eol;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      if (end === -1) return null;
      i = end + 1;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const end = endOfString(source, i);
      if (end === -1) return null;
      i = end;
      continue;
    }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    }
  }
  return null;
}

/** Every cleanup block body in a file, plus the count of blocks that would not balance. */
function cleanupRegions(source: string): { bodies: string[]; unbalanced: number } {
  const opener = new RegExp(CLEANUP_OPENER.source, 'g');
  const bodies: string[] = [];
  let unbalanced = 0;
  let match: RegExpExecArray | null = opener.exec(source);
  while (match !== null) {
    const body = balancedBody(source, match.index + match[0].length - 1);
    if (body === null) unbalanced += 1;
    else bodies.push(body);
    match = opener.exec(source);
  }
  return { bodies, unbalanced };
}

/**
 * What is wrong with one module's listener cleanup; empty means nothing is.
 * Pure, so the on-disk sweep and the fixtures below exercise the same code.
 *
 * The removal has to sit inside a cleanup block, not merely somewhere in the
 * file. A removal parked in a function nothing calls at teardown reads exactly
 * like a real one to a whole-file search, and leaves the listener attached for
 * the life of the process - the failure this file exists to catch. Position is
 * not checked: mpris registers its `will-quit` handler above its `player.on`
 * calls, and that order is fine.
 */
function findCleanupFaults(source: string): string[] {
  const faults: string[] = [];

  // Only a named reference can be removed later, so an inline listener is a
  // failure whatever else the file does.
  //
  // `once` is held to the same rule as `on`: it detaches itself only after it
  // fires, so until then it is a live listener and quitting has to remove it.
  // Node stores the wrapper with `.listener` set to the original function, so
  // `removeListener` takes the same reference the registration used, and it is
  // a harmless no-op when the listener has already fired.
  const named = [
    ...source.matchAll(
      /player\.(?:on|once|addListener)\(\s*'([^']+)'\s*,\s*([A-Za-z_$][\w$]*)\s*\)/g,
    ),
  ];
  const total = [...source.matchAll(/player\.(?:on|once|addListener)\(/g)].length;
  if (named.length !== total) {
    faults.push('registers a player listener with an inline function, which cannot be removed');
  }

  const { bodies, unbalanced } = cleanupRegions(source);
  if (unbalanced > 0) {
    faults.push(`has ${unbalanced} cleanup block(s) whose braces never balance`);
  }
  const cleanup = bodies.join('\n');

  for (const [, event, handler] of named) {
    const removal = new RegExp(
      `player\\.(removeListener|off)\\(\\s*'${event}'\\s*,\\s*${handler}\\s*\\)`,
    );
    if (removal.test(cleanup)) continue;
    faults.push(
      removal.test(source)
        ? `removes '${event}' as ${handler} outside any will-quit handler or teardown closure, so quitting leaves it attached`
        : `registers '${event}' as ${handler} but never removes it`,
    );
  }

  return faults;
}

describe('player listener cleanup', () => {
  // A source sweep rather than a per-module behavioural test, so a new
  // integration directory is covered the moment it is added. Reaching every
  // module behaviourally would mean mocking dbus, discord-rpc and three
  // platforms; this catches the omission the same way and cannot go stale.
  describe('every registration has a matching removal', () => {
    for (const file of playerConsumerFiles()) {
      const relative = path.relative(path.join(__dirname, '..'), file);

      it(`${relative} removes every player listener it registers on quit`, () => {
        const source = fs.readFileSync(file, 'utf-8');
        const faults = findCleanupFaults(source);

        expect(faults, `${relative} ${faults.join('; ')}`).toEqual([]);
      });
    }
  });

  // Fixtures for the sweep itself. The first is the point of the region check:
  // a whole-file search for the removal accepts it, and the sweep must not.
  describe('the sweep itself', () => {
    const REGISTER = "player.on('playbackStateDidChange', onPlaybackStateDidChange);";
    const REMOVE = "player.removeListener('playbackStateDidChange', onPlaybackStateDidChange);";

    it('rejects a removal outside any cleanup block', () => {
      const source = `
        export function init(): void {
          ${REGISTER}
        }

        function resetOnServiceSwitch(): void {
          ${REMOVE}
        }
      `;

      expect(findCleanupFaults(source)).toEqual([
        expect.stringContaining('outside any will-quit handler or teardown closure'),
      ]);
    });

    it('accepts a removal inside the will-quit handler', () => {
      const source = `
        export function init(): void {
          ${REGISTER}

          app.on('will-quit', () => {
            if (timer) {
              clearTimeout(timer);
            }
            ${REMOVE}
          });
        }
      `;

      expect(findCleanupFaults(source)).toEqual([]);
    });

    it('accepts a removal inside a returned teardown closure', () => {
      const source = `
        export function initTrayStateManager(): () => void {
          ${REGISTER}

          return () => {
            player.off('playbackStateDidChange', onPlaybackStateDidChange);
          };
        }
      `;

      expect(findCleanupFaults(source)).toEqual([]);
    });

    it('accepts a cleanup block written above the registration, as mpris has it', () => {
      const source = `
        export function init(): void {
          app.on('will-quit', () => {
            ${REMOVE}
            disconnectBus();
          });

          ${REGISTER}
        }
      `;

      expect(findCleanupFaults(source)).toEqual([]);
    });

    it('rejects an inline listener even when a cleanup block exists', () => {
      const source = `
        export function init(): void {
          player.on('playbackStateDidChange', (state) => {
            update(state);
          });

          app.on('will-quit', () => {
            teardown();
          });
        }
      `;

      expect(findCleanupFaults(source)).toEqual([
        expect.stringContaining('inline function, which cannot be removed'),
      ]);
    });

    // `addListener` is the same registration under another name, so a sweep
    // matching `player.on(` alone passes a module that registers this way
    // while reading as coverage.
    it('rejects an addListener registration with no removal', () => {
      const source = `
        export function init(): void {
          player.addListener('playbackStateDidChange', onPlaybackStateDidChange);
        }
      `;

      expect(findCleanupFaults(source)).toEqual([
        expect.stringContaining("registers 'playbackStateDidChange'"),
      ]);
    });

    it('rejects a once registration with no removal', () => {
      const source = `
        export function init(): void {
          player.once('playbackStateDidChange', onPlaybackStateDidChange);
        }
      `;

      expect(findCleanupFaults(source)).toEqual([
        expect.stringContaining("registers 'playbackStateDidChange'"),
      ]);
    });

    it('accepts a once registration removed inside the will-quit handler', () => {
      const source = `
        export function init(): void {
          player.once('playbackStateDidChange', onPlaybackStateDidChange);

          app.on('will-quit', () => {
            ${REMOVE}
          });
        }
      `;

      expect(findCleanupFaults(source)).toEqual([]);
    });

    it('rejects an inline once listener', () => {
      const source = `
        export function init(): void {
          player.once('playbackStateDidChange', (state) => {
            update(state);
          });

          app.on('will-quit', () => {
            teardown();
          });
        }
      `;

      expect(findCleanupFaults(source)).toEqual([
        expect.stringContaining('inline function, which cannot be removed'),
      ]);
    });

    it('rejects an inline addListener listener', () => {
      const source = `
        export function init(): void {
          player.addListener('playbackStateDidChange', (state) => {
            update(state);
          });

          app.on('will-quit', () => {
            teardown();
          });
        }
      `;

      expect(findCleanupFaults(source)).toEqual([
        expect.stringContaining('inline function, which cannot be removed'),
      ]);
    });
  });

  it('main.ts invokes the teardown initTrayStateManager returns', () => {
    const source = fs.readFileSync(path.join(SRC_DIR, 'main.ts'), 'utf-8');

    // A bare call statement discards the closure, leaving the tray pause timer
    // and its three player listeners attached for the life of the process.
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

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.mocked(app.on).mockClear();

    setPlatform('darwin');

    setMenu = vi.fn();
    (app as unknown as { dock: { setMenu: typeof setMenu } }).dock = { setMenu };

    player = new FakePlayer();
    const dock = await import('../src/integrations/macos-dock');
    dock.init({ player, getMainWindow: () => null } as IntegrationContext);
  });

  afterEach(() => {
    restorePlatform();
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
