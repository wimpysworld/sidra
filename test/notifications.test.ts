import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { app } from 'electron';
import { downloadArtwork } from '../src/artwork';
import { createNotification } from '../src/notify';
import { setNotificationsEnabled } from '../src/config';
import { init } from '../src/integrations/notifications';
import { NowPlayingPayload } from '../src/player';
import { FakePlayer } from './mocks/player';

// Matches NOTIFICATION_DEBOUNCE_MS in src/integrations/notifications/index.ts,
// which the module keeps private.
const DEBOUNCE_MS = 1500;

// createNotification() gates every construction on a D-Bus daemon probe that
// never runs under test, and the gate starts closed on Linux. The stand-in
// mirrors that gate so a test can open or close it. It records what it built,
// because the integration attaches listeners and calls show() on the object it
// gets back. test/notify.test.ts covers the real gate.
const daemon = vi.hoisted(() => ({ available: true, created: [] as FakeNotification[] }));

vi.mock('../src/notify', () => ({
  notificationsAvailable: vi.fn(() => daemon.available),
  createNotification: vi.fn((options: Electron.NotificationConstructorOptions) => {
    if (!daemon.available) return null;
    const handlers: Record<string, (...args: unknown[]) => void> = {};
    const notification: FakeNotification = {
      options,
      handlers,
      on(event, listener) {
        handlers[event] = listener;
        return notification;
      },
      show: vi.fn(),
    };
    daemon.created.push(notification);
    return notification;
  }),
}));

// The artwork download is the expensive half of a notification: a network fetch
// and a disk write per track. The gate must sit in front of it.
vi.mock('../src/artwork', () => ({
  downloadArtwork: vi.fn(() => Promise.resolve('/tmp/sidra-test/artwork.jpg')),
}));

interface FakeNotification {
  options: Electron.NotificationConstructorOptions;
  handlers: Record<string, (...args: unknown[]) => void>;
  on(event: string, listener: (...args: unknown[]) => void): FakeNotification;
  show: ReturnType<typeof vi.fn>;
}

const TRACK: NowPlayingPayload = {
  name: 'Blue Monday',
  artistName: 'New Order',
  albumName: 'Power, Corruption & Lies',
};

/**
 * Runs the `will-quit` handlers the integration registered, as quitting does.
 * The electron mock records them rather than firing them, and its `app.on` is a
 * plain `vi.fn()`, so the overloaded signature is narrowed to what is stored.
 */
function quit(): void {
  const registered = vi.mocked(app.on).mock.calls as unknown as Array<[string, () => void]>;
  for (const [event, handler] of registered) if (event === 'will-quit') handler();
}

/** The notification the integration asked for, or undefined if it asked for none. */
function shown(): FakeNotification | undefined {
  return daemon.created[0];
}

describe('notifications integration', () => {
  let player: FakePlayer;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    daemon.available = true;
    daemon.created = [];
    setNotificationsEnabled(true);
    player = new FakePlayer();
    init({ player, getMainWindow: () => null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds no notification and downloads no artwork while the gate is closed', async () => {
    daemon.available = false;

    player.emitNowPlaying({ ...TRACK, artworkUrl: 'https://example.com/art.jpg' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(vi.mocked(createNotification)).not.toHaveBeenCalled();
    expect(vi.mocked(downloadArtwork)).not.toHaveBeenCalled();
  });

  it('collapses a burst of track changes into one notification for the last track', async () => {
    player.emitNowPlaying({ ...TRACK, name: 'Ceremony' });
    await vi.advanceTimersByTimeAsync(500);
    player.emitNowPlaying({ ...TRACK, name: 'Temptation' });
    await vi.advanceTimersByTimeAsync(500);
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(vi.mocked(createNotification)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(createNotification)).toHaveBeenCalledWith({
      title: 'Blue Monday',
      body: 'New Order - Power, Corruption & Lies',
      silent: true,
    });
    expect(shown()?.show).toHaveBeenCalledOnce();
  });

  it('joins only the fields the payload carries into the body', async () => {
    player.emitNowPlaying({ name: 'Elegia', artistName: 'New Order' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(shown()?.options.body).toBe('New Order');
  });

  it('schedules nothing while notifications are disabled', async () => {
    setNotificationsEnabled(false);

    player.emitNowPlaying(TRACK);
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(vi.mocked(createNotification)).not.toHaveBeenCalled();
  });

  it('builds no notification for a payload with no track name', async () => {
    player.emitNowPlaying({});
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(vi.mocked(createNotification)).not.toHaveBeenCalled();
  });

  it('drops a pending notification and detaches from the player on quit', async () => {
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(500);

    quit();

    expect(player.listenerCount('nowPlayingItemDidChange')).toBe(0);

    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(vi.mocked(createNotification)).not.toHaveBeenCalled();
  });

  it('ignores track changes that arrive after quit', async () => {
    quit();

    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);

    expect(vi.mocked(createNotification)).not.toHaveBeenCalled();
  });
});
