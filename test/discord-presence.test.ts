import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SetActivity } from '@xhayper/discord-rpc';
import { ActivityType } from 'discord-api-types/v10';
import { app } from 'electron';
import { PlaybackState, NowPlayingPayload } from '../src/player';
import { FakePlayer } from './mocks/player';

// Matches DEBOUNCE_MS and PAUSE_TIMEOUT_MS in
// src/integrations/discord-presence/index.ts, which keeps them private.
const DEBOUNCE_MS = 1000;
const PAUSE_TIMEOUT_MS = 30_000;
// The reconnect backoff doubles from the base to the cap.
const RECONNECT_BASE_MS = 2000;
const RECONNECT_CAP_MS = 60_000;
const CLEAR_ACTIVITY_TIMEOUT_MS = 2000;

// 'timeout' clears the cached connection promise, while 'transport' retains it.
// The integration must recover from both library failure paths.
type ConnectOutcome = 'connected' | 'timeout' | 'transport';

// Use a structural type because the client class lives inside the hoisted vi.mock factory.
// Type annotations disappear at runtime, unlike a reference to that class.
interface ClientHandle {
  isConnected: boolean;
  connectAttempts: number;
  destroyCalls: number;
  listenerCount(event: string): number;
}

// Promise-returning spies replace Discord socket calls and support production .then()/.catch() chains.
// The hoisted holder survives fresh module imports. Typed setActivity arguments let tests inspect recorded activities.
// outcome controls connection results, while instances records clients so tests can identify the live one.
const rpc = vi.hoisted(() => ({
  setActivity: vi.fn((_activity: SetActivity) => Promise.resolve({})),
  clearActivity: vi.fn(() => Promise.resolve()),
  handlers: {} as Record<string, (...args: unknown[]) => void>,
  instances: [] as ClientHandle[],
  connectAttempts: 0,
  outcome: (_attempt: number): ConnectOutcome => 'connected',
}));

// Only Client is replaced. StatusDisplayType comes from the real package, so a
// renumbering there reaches the source under test rather than being masked.
vi.mock('@xhayper/discord-rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xhayper/discord-rpc')>();

  // Model @xhayper/discord-rpc 1.3.4: failed connections retain once('connected') listeners.
  // Transport rejection also retains connectionPromise, so reuse returns the same rejected promise without connecting.
  // destroy() closes only the transport. Keeping both failure modes makes client replacement observable.
  class FakeClient {
    isConnected = false;
    connectAttempts = 0;
    destroyCalls = 0;
    user = { setActivity: rpc.setActivity, clearActivity: rpc.clearActivity };

    private listeners = new Map<string, Array<(...args: unknown[]) => void>>();
    private connectionPromise: Promise<void> | undefined;
    // The transport close handler is installed from inside the 'connected'
    // handler, so only a client that reached that point emits 'disconnected'
    // when its transport closes.
    private closeArmed = false;

    constructor() {
      rpc.instances.push(this);
    }

    on(event: string, handler: (...args: unknown[]) => void): this {
      const bucket = this.listeners.get(event) ?? [];
      bucket.push(handler);
      this.listeners.set(event, bucket);
      rpc.handlers[event] = handler;
      return this;
    }

    once(event: string, handler: (...args: unknown[]) => void): this {
      const wrapper = (...args: unknown[]): void => {
        this.remove(event, wrapper);
        handler(...args);
      };
      return this.on(event, wrapper);
    }

    removeAllListeners(): this {
      this.listeners.clear();
      return this;
    }

    listenerCount(event: string): number {
      return this.listeners.get(event)?.length ?? 0;
    }

    emit(event: string, ...args: unknown[]): boolean {
      const bucket = this.listeners.get(event);
      if (!bucket || bucket.length === 0) return false;
      for (const handler of [...bucket]) handler(...args);
      return true;
    }

    connect(): Promise<void> {
      if (this.connectionPromise) return this.connectionPromise;

      this.connectAttempts++;
      rpc.connectAttempts++;
      const attempt = rpc.connectAttempts;

      this.connectionPromise = new Promise<void>((resolve, reject) => {
        this.once('connected', () => {
          this.connectionPromise = undefined;
          this.isConnected = true;
          this.closeArmed = true;
          resolve();
        });
        // Every outcome settles asynchronously, as the socket and the 10 second
        // timer both do. It also has to: the timeout path clears the field the
        // assignment below has not made yet.
        void Promise.resolve().then(() => {
          const outcome = rpc.outcome(attempt);
          if (outcome === 'connected') {
            this.emit('connected');
            return;
          }
          if (outcome === 'timeout') {
            this.connectionPromise = undefined;
            reject(new Error('Connection timed out'));
            return;
          }
          reject(new Error('could not connect'));
        });
      });

      return this.connectionPromise;
    }

    async login(): Promise<void> {
      await this.connect();
      this.emit('ready');
    }

    async destroy(): Promise<void> {
      this.destroyCalls++;
      this.isConnected = false;
      if (this.closeArmed) {
        this.closeArmed = false;
        this.emit('disconnected');
      }
    }

    private remove(event: string, handler: (...args: unknown[]) => void): void {
      const bucket = this.listeners.get(event);
      if (!bucket) return;
      const index = bucket.indexOf(handler);
      if (index !== -1) bucket.splice(index, 1);
    }
  }
  return { ...actual, Client: FakeClient };
});

const TRACK: NowPlayingPayload = {
  name: 'Blue Monday',
  artistName: 'New Order',
  albumName: 'Power, Corruption & Lies',
  durationInMillis: 240_000,
  url: 'https://music.apple.com/gb/album/blue-monday/1',
};

const START = new Date('2026-01-01T00:00:00Z');

/**
 * Loads a fresh copy of the integration with the toggle on. trackName, client
 * and the timers are module-scoped, so one instance carries state between
 * tests. Config is imported after the reset because resetModules re-runs the
 * electron-conf mock factory: a statically imported config writes to a store
 * the reloaded integration no longer reads.
 */
async function loadDiscord(): Promise<typeof import('../src/integrations/discord-presence')> {
  vi.resetModules();
  const config = await import('../src/config');
  config.setDiscordEnabled(true);
  return import('../src/integrations/discord-presence');
}

/** The activity object of the only setActivity call made so far. */
function activity(): SetActivity {
  expect(rpc.setActivity).toHaveBeenCalledTimes(1);
  return rpc.setActivity.mock.calls[0][0];
}

/**
 * A bound on the reconnect drive loop, so a chain that stalls fails an
 * assertion instead of hanging the suite.
 */
const MAX_RECONNECT_STEPS = 40;

/**
 * Runs the backoff chain until `target` connect attempts have been made. Each
 * step advances a full cap length, which covers every delay in the chain, and
 * the async form lets each rejected login settle so the reconnect it schedules
 * is armed inside the same step.
 */
async function driveConnectAttempts(target: number): Promise<void> {
  for (let step = 0; step < MAX_RECONNECT_STEPS && rpc.connectAttempts < target; step++) {
    await vi.advanceTimersByTimeAsync(RECONNECT_CAP_MS);
  }
}

// The registry and the script outlive a module reset, so they are cleared for
// every test in the file whichever block owns it. This hook runs before the
// per-describe ones.
beforeEach(() => {
  rpc.instances.length = 0;
  rpc.connectAttempts = 0;
  rpc.outcome = () => 'connected';
});

describe('discord presence integration', () => {
  let player: FakePlayer;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(START);
    player = new FakePlayer();
    const discord = await loadDiscord();
    discord.init({ player, getMainWindow: () => null });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('sends a listening activity with the track title as the status display', () => {
    vi.spyOn(app, 'getName').mockReturnValue('Test Player');
    player.setPlaybackState(PlaybackState.Playing);
    player.emitNowPlaying(TRACK);
    vi.advanceTimersByTime(DEBOUNCE_MS);

    // The literal, not the enum member: Discord reads the wire value, and a
    // test importing the same enum as the source cannot catch a renumbering.
    expect(activity()).toMatchObject({
      statusDisplayType: 2,
      type: ActivityType.Listening,
      details: 'Blue Monday',
      state: 'by New Order',
      buttons: [
        { label: 'Test Player', url: 'https://github.com/wimpysworld/sidra' },
        { label: 'Play on Apple Music', url: TRACK.url },
      ],
      smallImageKey: 'sidra_logo',
      smallImageText: 'Test Player',
      // sendActivity() anchors both stamps to Date.now() at fire time, and the
      // fake clock has moved by the debounce. The playhead sits at zero, so
      // the start is that moment and the end is a track length later.
      startTimestamp: new Date(START.getTime() + DEBOUNCE_MS),
      endTimestamp: new Date(START.getTime() + DEBOUNCE_MS + 240_000),
    });
  });

  it('translates artist fallback and service buttons without changing metadata or URLs', async () => {
    const { app: freshApp } = await import('electron');
    vi.spyOn(freshApp, 'getPreferredSystemLanguages').mockReturnValue(['fr']);
    player.emitNowPlaying({ ...TRACK, artistName: undefined });
    vi.advanceTimersByTime(DEBOUNCE_MS);
    expect(activity()).toMatchObject({
      details: TRACK.name,
      state: 'par Artiste inconnu',
      buttons: expect.arrayContaining([
        { label: 'Lire sur Apple Music', url: TRACK.url },
      ]),
    });
  });

  it('sends no timestamps while paused but keeps the status display', () => {
    player.setPlaybackState(PlaybackState.Paused);
    player.emitNowPlaying(TRACK);
    vi.advanceTimersByTime(DEBOUNCE_MS);

    const sent = activity();
    expect(sent).toMatchObject({ statusDisplayType: 2 });
    expect(sent).not.toHaveProperty('startTimestamp');
    expect(sent).not.toHaveProperty('endTimestamp');
  });

  it('clears a published activity once after a document replacement', async () => {
    player.setPlaybackState(PlaybackState.Playing);
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rpc.setActivity).toHaveBeenCalledTimes(1);

    player.resetForDocumentReplacement();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(rpc.clearActivity).toHaveBeenCalledTimes(1);
    expect(rpc.setActivity).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(PAUSE_TIMEOUT_MS);
    expect(rpc.clearActivity).toHaveBeenCalledTimes(1);
  });
});

// Separate from the block above because these tests install their own connect
// script before init(), and the shared beforeEach there logs in first.
describe('discord presence reconnect', () => {
  let player: FakePlayer;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(START);
    player = new FakePlayer();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('leaves at most one connected listener on the live client after repeated failures', async () => {
    rpc.outcome = () => 'timeout';
    const discord = await loadDiscord();
    discord.init({ player, getMainWindow: () => null });

    await driveConnectAttempts(15);
    expect(rpc.connectAttempts).toBeGreaterThanOrEqual(15);

    // Each attempt leaks the listener it registered. Only discarding the client
    // keeps the count on the live one at the single leak of its own attempt;
    // reusing one instance accrues one per attempt and trips Node's warning.
    const live = rpc.instances[rpc.instances.length - 1];
    expect(live.listenerCount('connected')).toBeLessThanOrEqual(1);
  });

  it('makes a fresh connect after a transport rejection instead of replaying the rejected promise', async () => {
    // Only the first attempt fails at the transport, the path that leaves the
    // cached connection promise in place.
    rpc.outcome = (attempt) => (attempt === 1 ? 'transport' : 'timeout');
    const discord = await loadDiscord();
    discord.init({ player, getMainWindow: () => null });

    await vi.advanceTimersByTimeAsync(0);
    expect(rpc.connectAttempts).toBe(1);
    expect(rpc.instances).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS);

    // A reused instance returns the rejected promise it cached, so the counter
    // stays at one and presence is dead for the process.
    expect(rpc.connectAttempts).toBe(2);
    expect(rpc.instances).toHaveLength(2);
  });

  it('carries the ready handler onto the replacement client, so a late connect still sends an activity', async () => {
    const SUCCEED_ON = 12;
    rpc.outcome = (attempt) => (attempt < SUCCEED_ON ? 'timeout' : 'connected');
    const discord = await loadDiscord();
    discord.init({ player, getMainWindow: () => null });
    player.setPlaybackState(PlaybackState.Playing);
    player.emitNowPlaying(TRACK);

    await driveConnectAttempts(SUCCEED_ON);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    // The client that connected is not the one init() built, and the activity
    // proves its ready handler ran: only that handler schedules the update.
    expect(rpc.instances.length).toBeGreaterThan(1);
    expect(rpc.setActivity).toHaveBeenCalled();
    const sent = rpc.setActivity.mock.calls[rpc.setActivity.mock.calls.length - 1][0];
    expect(sent).toMatchObject({ details: 'Blue Monday' });
  });

  it('reads the playhead through the replacement client, so a reconnected session still carries timestamps', async () => {
    // A replacement client's ready handler must read the player snapshot, even though init() did not create that client.
    rpc.outcome = (attempt) => (attempt === 1 ? 'transport' : 'connected');
    const discord = await loadDiscord();
    discord.init({ player, getMainWindow: () => null });
    player.setPlaybackState(PlaybackState.Playing);
    player.setPositionUs(30_000_000);
    player.emitNowPlaying(TRACK);

    // The first connect fails, the debounced update finds the client down and
    // asks it to log in again, then the backoff replaces the client and that
    // one connects. Each advance is a single scheduled step, so the moment the
    // activity is sent is known: base delay plus one debounce.
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(RECONNECT_BASE_MS - DEBOUNCE_MS);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(rpc.instances).toHaveLength(2);
    const sentAt = START.getTime() + RECONNECT_BASE_MS + DEBOUNCE_MS;
    expect(activity()).toMatchObject({
      startTimestamp: new Date(sentAt - 30_000),
      endTimestamp: new Date(sentAt - 30_000 + 240_000),
    });
  });

  it('sends an activity again after disable() and enable()', async () => {
    const discord = await loadDiscord();
    discord.init({ player, getMainWindow: () => null });
    player.setPlaybackState(PlaybackState.Playing);
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(rpc.setActivity).toHaveBeenCalledTimes(1);

    discord.disable();
    expect(rpc.clearActivity).toHaveBeenCalledTimes(1);
    // Teardown builds the replacement, so the tray toggle never logs in on a
    // client whose transport is already closing.
    expect(rpc.instances).toHaveLength(2);

    discord.enable();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(rpc.setActivity).toHaveBeenCalledTimes(2);
  });

  // clearActivity() waits for Discord's nonce reply, which can remain pending on a live socket.
  // Teardown must still destroy the transport to release the socket and stale activity.
  it('destroys a retired client whose activity clear never answers, and destroys it once', async () => {
    const discord = await loadDiscord();
    discord.init({ player, getMainWindow: () => null });
    await vi.advanceTimersByTimeAsync(0);

    const retired = rpc.instances[0];
    expect(retired.isConnected).toBe(true);

    let answer: (() => void) | undefined;
    rpc.clearActivity.mockReturnValueOnce(new Promise<void>((resolve) => {
      answer = resolve;
    }));

    discord.disable();
    expect(rpc.clearActivity).toHaveBeenCalledTimes(1);
    expect(retired.destroyCalls).toBe(0);

    await vi.advanceTimersByTimeAsync(CLEAR_ACTIVITY_TIMEOUT_MS);
    expect(retired.destroyCalls).toBe(1);

    // The loser of the race settles late and must not destroy a second time.
    answer?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(retired.destroyCalls).toBe(1);
  });
});

// The send path takes the Player as an argument, and init() is the only place
// that has one. The exported toggles are the boundary where that is checked, so
// a tray click before init() has to be inert rather than reaching a client.
describe('discord presence tray toggles before init', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('builds no client and sends nothing', async () => {
    const discord = await loadDiscord();

    expect(() => discord.enable()).not.toThrow();
    expect(() => discord.disable()).not.toThrow();

    expect(rpc.instances).toHaveLength(0);
    expect(rpc.setActivity).not.toHaveBeenCalled();
    expect(rpc.clearActivity).not.toHaveBeenCalled();
  });
});
