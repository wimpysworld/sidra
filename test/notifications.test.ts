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
import { setPlatform, restorePlatform } from './mocks/platform';
import { initCommandBridge } from '../src/commandBridge';
import { getTrayStrings } from '../src/i18n';
import type { BrowserWindow } from 'electron';
import * as i18n from '../src/i18n';

const linuxAdapter = vi.hoisted(() => ({ show: vi.fn(), dispose: vi.fn() }));
vi.mock('../src/linuxNotifications', () => ({ createLinuxNotifications: () => linuxAdapter }));

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
    setPlatform('win32');
    vi.clearAllMocks();
    vi.useFakeTimers();
    resetNotifyFake('record');
    setNotificationsEnabled(true);
    player = new FakePlayer();
    init({ player, getMainWindow: () => null });
  });

  afterEach(() => {
    quit();
    vi.restoreAllMocks();
    restorePlatform();
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
      actions: [
        { type: 'button', text: getTrayStrings().previous },
        { type: 'button', text: getTrayStrings().next },
      ],
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

  it.each(['win32', 'darwin'])('dispatches only the two native actions on %s', async (platform) => {
    setPlatform(platform);
    const send = vi.fn();
    initCommandBridge(send);
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    shown()?.handlers.action({ actionIndex: 0 }, 1);
    shown()?.handlers.action({ actionIndex: 1 }, 0);
    for (const actionIndex of [-1, 2, 0.5, '0', undefined]) {
      shown()?.handlers.action({ actionIndex });
    }
    expect(send.mock.calls).toEqual([['player:previous'], ['player:next']]);
  });

  it('shows and focuses the window only on a body click', async () => {
    quit();
    const win = { show: vi.fn(), focus: vi.fn() };
    init({ player, getMainWindow: () => win as unknown as BrowserWindow });
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    shown()?.handlers.action({ actionIndex: 0 });
    expect(win.show).not.toHaveBeenCalled();
    shown()?.handlers.click();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
  });

  it('rechecks the preference before a pending notification', async () => {
    player.emitNowPlaying(TRACK);
    setNotificationsEnabled(false);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('drops artwork work after quit', async () => {
    vi.mocked(downloadArtwork).mockReturnValueOnce(new Promise(() => {}));
    player.emitNowPlaying({ ...TRACK, artworkUrl: 'https://example.com/art.jpg' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    quit();
    await vi.advanceTimersByTimeAsync(500);
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('closes native notifications and removes action handlers on quit', async () => {
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const notification = shown();
    quit();
    expect(notification?.close).toHaveBeenCalledOnce();
    expect(notification?.handlers).toEqual({});
  });

  it('uses the existing translated labels for native buttons', async () => {
    vi.spyOn(i18n, 'getTrayStrings').mockReturnValue({
      ...getTrayStrings(), previous: 'Précédent', next: 'Suivant',
    });
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(shown()?.options.actions).toEqual([
      { type: 'button', text: 'Précédent' },
      { type: 'button', text: 'Suivant' },
    ]);
  });

  it('uses only the Linux adapter and disposes it on quit', async () => {
    setPlatform('linux');
    const send = vi.fn();
    initCommandBridge(send);
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(createNotification).not.toHaveBeenCalled();
    expect(linuxAdapter.show).toHaveBeenCalledOnce();
    const [notification] = linuxAdapter.show.mock.calls[0];
    expect(notification).toMatchObject({
      title: TRACK.name, previous: getTrayStrings().previous, next: getTrayStrings().next,
    });
    notification.onAction('previous');
    notification.onAction('next');
    expect(send.mock.calls).toEqual([['player:previous'], ['player:next']]);
    quit();
    await Promise.resolve();
    expect(linuxAdapter.dispose).toHaveBeenCalledOnce();
  });
});
