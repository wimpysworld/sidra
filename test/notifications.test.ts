import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// The notify stand-in mirrors the D-Bus daemon gate; 'record' mode is what this
// file needs, because the integration attaches listeners and calls show() on
// the object it gets back, and the tests read both.
import { FakeNotification, notifyFake, resetNotifyFake } from './mocks/notify';

import { downloadArtwork } from '../src/artwork';
import { createNotification } from '../src/notify';
import { setNotificationsEnabled } from '../src/config';
import { init } from '../src/integrations/notifications';
import { NowPlayingPayload } from '../src/player';
import { FakePlayer } from './mocks/player';
import { quit } from './mocks/appLifecycle';

// Matches NOTIFICATION_DEBOUNCE_MS in src/integrations/notifications/index.ts,
// which the module keeps private.
const DEBOUNCE_MS = 1500;

// The artwork download is the expensive half of a notification: a network fetch
// and a disk write per track. The gate must sit in front of it.
vi.mock('../src/artwork', () => ({
  downloadArtwork: vi.fn(() => Promise.resolve('/tmp/sidra-test/artwork.jpg')),
}));

const TRACK: NowPlayingPayload = {
  name: 'Blue Monday',
  artistName: 'New Order',
  albumName: 'Power, Corruption & Lies',
};

/** The notification the integration asked for, or undefined if it asked for none. */
function shown(): FakeNotification | undefined {
  return notifyFake.built[0];
}

describe('notifications integration', () => {
  let player: FakePlayer;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetNotifyFake('record');
    setNotificationsEnabled(true);
    player = new FakePlayer();
    init({ player, getMainWindow: () => null });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds no notification and downloads no artwork while the gate is closed', async () => {
    notifyFake.available = false;

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
