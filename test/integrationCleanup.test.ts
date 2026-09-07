// Check that player listeners have named references and removals inside cleanup blocks.
// Timer cleanup alone leaves listeners attached. A returned teardown closure also needs a caller.
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

/** Integration entry points and other known modules that register Player listeners. */
function playerConsumerFiles(): string[] {
  const integrations = fs
    .readdirSync(INTEGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(INTEGRATIONS_DIR, entry.name, 'index.ts'))
    .filter((file) => fs.existsSync(file));

  // wedgeDetector and tray need the same cleanup checks despite living outside integrations/.
  return [...integrations, path.join(SRC_DIR, 'wedgeDetector.ts'), path.join(SRC_DIR, 'tray.ts')];
}

/**
 * Match integration `will-quit` handlers and returned teardown closures.
 * A separate test checks that main.ts registers the tray closure on `will-quit`.
 */
const CLEANUP_OPENER =
  /app\.on\(\s*'will-quit'\s*,\s*(?:async\s*)?\(\s*\)\s*=>\s*\{|return\s*(?:async\s*)?\(\s*\)\s*=>\s*\{/;

/**
 * Find the closing quote, or return -1 for an unterminated literal.
 * Template contents are skipped as text, without parsing interpolation or nested templates.
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
 * Find the block body by balancing braces outside comments and string literals.
 * Return `null` for unreadable blocks so the cleanup check fails instead of assuming that removals exist.
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
 * Return listener-cleanup faults, using the same pure check for source files and fixtures.
 * Require removals inside cleanup blocks because a removal elsewhere does not establish teardown.
 * Registration order is unrestricted because MPRIS declares cleanup before attaching its listeners.
 */
function findCleanupFaults(source: string): string[] {
  const faults: string[] = [];

  // Named references let teardown remove listeners, including `once` listeners that do not fire before quit.
  // Node exposes the original callback through the once wrapper's `.listener`, so removeListener accepts that reference even after delivery.
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
  // Discover integration directories automatically so new modules receive the same structural cleanup check.
  // This check needs no D-Bus, Discord or platform mocks, but does not prove that teardown runs.
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

    // addListener aliases on, so matching only player.on misses valid registrations.
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
