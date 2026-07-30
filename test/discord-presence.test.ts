import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { SetActivity } from '@xhayper/discord-rpc';
import { ActivityType } from 'discord-api-types/v10';
import { PlaybackState, NowPlayingPayload } from '../src/player';
import { FakePlayer } from './mocks/player';

// Matches DEBOUNCE_MS in src/integrations/discord-presence/index.ts, which the
// module keeps private.
const DEBOUNCE_MS = 1000;

// The RPC client talks to a Discord socket that no test has. The stand-in
// reports itself connected so sendActivity() reaches the activity object, and
// every method the module calls returns a promise: production chains
// .then().catch() onto setActivity() and .catch() onto clearActivity(), so a
// bare vi.fn() throws inside them. The spies live in a hoisted holder because
// each test loads a fresh module instance, which builds a fresh Client.
// setActivity is typed with its argument so mock.calls carries the activity
// object; an untyped vi.fn() gives an empty call tuple and indexing it fails.
const rpc = vi.hoisted(() => ({
  setActivity: vi.fn((_activity: SetActivity) => Promise.resolve({})),
  clearActivity: vi.fn(() => Promise.resolve()),
  handlers: {} as Record<string, (...args: unknown[]) => void>,
}));

// Only Client is replaced. StatusDisplayType comes from the real package, so a
// renumbering there reaches the source under test rather than being masked.
vi.mock('@xhayper/discord-rpc', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@xhayper/discord-rpc')>();
  class FakeClient {
    isConnected = true;
    user = { setActivity: rpc.setActivity, clearActivity: rpc.clearActivity };
    on(event: string, handler: (...args: unknown[]) => void): this {
      rpc.handlers[event] = handler;
      return this;
    }
    login(): Promise<this> {
      return Promise.resolve(this);
    }
    destroy(): Promise<void> {
      return Promise.resolve();
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
    vi.useRealTimers();
  });

  it('sends a listening activity with the track title as the status display', () => {
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
        { label: 'Sidra', url: 'https://github.com/wimpysworld/sidra' },
        { label: 'Play on Apple Music', url: TRACK.url },
      ],
      // sendActivity() anchors both stamps to Date.now() at fire time, and the
      // fake clock has moved by the debounce. The playhead sits at zero, so
      // the start is that moment and the end is a track length later.
      startTimestamp: new Date(START.getTime() + DEBOUNCE_MS),
      endTimestamp: new Date(START.getTime() + DEBOUNCE_MS + 240_000),
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
});
