import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// The notify stand-in mirrors the D-Bus daemon gate; 'record' mode is what this
// file needs, because the integration attaches listeners and calls show() on
// the object it gets back, and the tests read both.
import { FakeNotification, notifyFake, resetNotifyFake } from './mocks/notify';

import { downloadArtwork } from '../src/artwork';
import { createNotification } from '../src/notify';
import { setNotificationsEnabled } from '../src/config';
import { init } from '../src/integrations/notifications';
import { NowPlayingPayload, PlaybackState } from '../src/player';
import { FakePlayer } from './mocks/player';
import { quit } from './mocks/appLifecycle';
import { setPlatform, restorePlatform } from './mocks/platform';
import { initCommandBridge } from '../src/commandBridge';
import { getTrayStrings } from '../src/i18n';
import { Notification, type BrowserWindow } from 'electron';
import * as i18n from '../src/i18n';

const linuxAdapter = vi.hoisted(() => ({ show: vi.fn().mockResolvedValue(undefined), dispose: vi.fn() }));
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

const STATION: NowPlayingPayload = {
  name: 'Radio Station', albumName: 'Station Album',
  artworkUrl: 'https://example.com/station.jpg',
  trackId: 'station', playParams: { kind: 'radioStation' },
};
const RADIO_SONG = { name: 'Radio Song', artistName: 'Radio Artist', transition: 'initial' as const };

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
      id: expect.any(String),
      groupId: 'playback',
      title: 'Blue Monday',
      body: 'New Order - Power, Corruption & Lies',
      silent: true,
      actions: [
        { type: 'button', text: getTrayStrings().play },
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
    shown()?.handlers.action({ actionIndex: 1 }, 0);
    shown()?.handlers.action({ actionIndex: 2 }, 1);
    for (const actionIndex of [-1, 3, 0.5, '0', undefined]) {
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
    notification?.handlers.show();
    quit();
    expect(notification?.close).toHaveBeenCalledOnce();
    expect(notification?.handlers).toEqual({});
  });

  it.each(['win32', 'darwin'])('replaces the previous native notification on %s', async (platform) => {
    setPlatform(platform);
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const previous = shown()!;
    previous.handlers.show();
    player.emitNowPlaying({ ...TRACK, name: 'Ceremony' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(previous.close).toHaveBeenCalledOnce();
    expect(previous.handlers).toEqual({});
    expect(notifyFake.built[1].options).toMatchObject({ id: expect.any(String), groupId: 'playback' });
    expect(previous.options.id).toMatch(/^[0-9a-f]{16}$/);
    expect(notifyFake.built[1].options.id).toMatch(/^[0-9a-f]{16}$/);
    expect(notifyFake.built[1].options.id).not.toBe(previous.options.id);
    expect(notifyFake.built[1].show).toHaveBeenCalledOnce();
  });

  it('retains the native object for history cleanup after its banner closes', async () => {
    const send = vi.fn();
    initCommandBridge(send);
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const notification = shown()!;
    notification.handlers.show();
    notification.handlers.close?.();
    notification.handlers.action({ actionIndex: 1 });
    expect(send).toHaveBeenCalledExactlyOnceWith('player:previous');
    quit();
    expect(notification.close).toHaveBeenCalledOnce();
  });

  it.each(['win32', 'darwin'])('closes only a retired notification when it displays late on %s', async (platform) => {
    setPlatform(platform);
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const previous = shown()!;
    player.emitNowPlaying({ ...TRACK, name: 'Newer Track' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const latest = notifyFake.built[1];
    latest.handlers.show();
    expect(previous.handlers.action).toBeUndefined();
    expect(previous.handlers.click).toBeUndefined();
    expect(previous.options.id).not.toBe(latest.options.id);
    expect(previous.close).not.toHaveBeenCalled();
    previous.handlers.show();
    expect(previous.close).toHaveBeenCalledOnce();
    expect(previous.handlers).toEqual({});
    expect(latest.close).not.toHaveBeenCalled();
    expect(latest.handlers.action).toBeTypeOf('function');
  });

  it('keeps retired pending objects for quit cleanup and closes a display after quit', async () => {
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const previous = shown()!;
    player.emitNowPlaying({ ...TRACK, name: 'Newer Track' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const latest = notifyFake.built[1];
    quit();
    expect(previous.close).not.toHaveBeenCalled();
    expect(latest.close).not.toHaveBeenCalled();
    expect(previous.handlers.action).toBeUndefined();
    previous.handlers.show();
    expect(previous.close).toHaveBeenCalledOnce();
    expect(previous.handlers).toEqual({});
    latest.handlers.show();
    expect(latest.close).toHaveBeenCalledOnce();
  });

  it('releases a retired notification after display failure', async () => {
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const previous = shown()!;
    player.emitNowPlaying({ ...TRACK, name: 'Newer Track' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    previous.handlers.failed({}, 'Unavailable');
    expect(previous.handlers).toEqual({});
    quit();
    expect(previous.close).not.toHaveBeenCalled();
  });

  it('removes only the playback group on macOS startup and quit, even while disabled', () => {
    quit();
    setPlatform('darwin');
    setNotificationsEnabled(false);
    vi.mocked(Notification.removeGroup).mockClear();
    init({ player, getMainWindow: () => null });
    expect(Notification.removeGroup).toHaveBeenCalledExactlyOnceWith('playback');
    expect(createNotification).not.toHaveBeenCalled();
    quit();
    expect(vi.mocked(Notification.removeGroup).mock.calls).toEqual([['playback'], ['playback']]);
  });

  it('does not use the macOS history API on Windows', () => {
    quit();
    expect(Notification.removeGroup).not.toHaveBeenCalled();
  });

  it('continues delivery when macOS history cleanup fails', async () => {
    quit();
    setPlatform('darwin');
    vi.mocked(Notification.removeGroup).mockImplementationOnce(() => { throw new Error('Unavailable'); });
    init({ player, getMainWindow: () => null });
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(shown()?.show).toHaveBeenCalledOnce();
  });

  it('ignores captured callbacks after preference disable or quit', async () => {
    const send = vi.fn();
    initCommandBridge(send);
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const action = shown()!.handlers.action;
    setNotificationsEnabled(false);
    action({ actionIndex: 0 });
    setNotificationsEnabled(true);
    quit();
    action({ actionIndex: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it('uses the existing translated labels for native buttons', async () => {
    vi.spyOn(i18n, 'getTrayStrings').mockReturnValue({
      ...getTrayStrings(), previous: 'Précédent', next: 'Suivant',
    });
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(shown()?.options.actions).toEqual([
      { type: 'button', text: getTrayStrings().play },
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

  it.each([undefined, 3600000])('coalesces the station and first radio song with duration %s', async (durationInMillis) => {
    player.emitNowPlaying({ ...STATION, durationInMillis });
    await vi.advanceTimersByTimeAsync(500);
    player.emitTimedMetadata(RADIO_SONG);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(notifyFake.built).toHaveLength(1);
    expect(shown()?.options).toMatchObject({
      title: 'Radio Song', body: 'Radio Artist', icon: '/tmp/sidra-test/artwork.jpg',
    });
    expect(downloadArtwork).toHaveBeenCalledExactlyOnceWith(STATION.artworkUrl);
  });

  it('ignores duplicate timed display fields and catalogue-only enrichment without delaying delivery', async () => {
    player.emitNowPlaying(STATION);
    player.emitTimedMetadata(RADIO_SONG);
    await vi.advanceTimersByTimeAsync(1000);
    player.emitTimedMetadata({ ...RADIO_SONG, trackId: 'catalogue-id' });
    await vi.advanceTimersByTimeAsync(500);
    expect(notifyFake.built).toHaveLength(1);
    player.emitTimedMetadata({ ...RADIO_SONG, playParams: { kind: 'song', catalogId: 'catalogue-id' } });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(notifyFake.built).toHaveLength(1);
  });

  it('replaces each changed song and clears an absent album', async () => {
    player.emitNowPlaying(STATION);
    player.emitTimedMetadata({ ...RADIO_SONG, albumName: 'Song Album' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(shown()?.options.body).toBe('Radio Artist - Song Album');
    shown()?.handlers.show();
    player.emitTimedMetadata({ ...RADIO_SONG, name: 'Next Song' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(notifyFake.built[1].options).toMatchObject({ title: 'Next Song', body: 'Radio Artist' });
    expect(shown()?.close).toHaveBeenCalledOnce();
  });

  it('resets timed display deduplication on station change and restores ordinary track metadata', async () => {
    player.emitNowPlaying(STATION);
    player.emitTimedMetadata(RADIO_SONG);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    player.emitNowPlaying({ ...STATION, trackId: 'station-2' });
    player.emitTimedMetadata(RADIO_SONG);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(notifyFake.built).toHaveLength(2);
    player.emitNowPlaying(TRACK);
    player.emitTimedMetadata(RADIO_SONG);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(notifyFake.built[2].options.title).toBe(TRACK.name);
  });

  it('drops pending timed work on document replacement and waits for a new station', async () => {
    player.emitNowPlaying(STATION);
    player.emitTimedMetadata(RADIO_SONG);
    player.resetForDocumentReplacement();
    player.emitTimedMetadata(RADIO_SONG);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(notifyFake.built).toHaveLength(0);
    player.emitNowPlaying(STATION);
    player.emitTimedMetadata(RADIO_SONG);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(notifyFake.built).toHaveLength(1);
  });

  it('does not restore an old song when its artwork arrives late', async () => {
    let resolveArtwork!: (path: string) => void;
    vi.mocked(downloadArtwork).mockReturnValueOnce(new Promise(resolve => { resolveArtwork = resolve; }));
    player.emitNowPlaying(STATION);
    player.emitTimedMetadata(RADIO_SONG);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    player.emitTimedMetadata({ ...RADIO_SONG, name: 'Latest Song' });
    resolveArtwork('/tmp/old-artwork.jpg');
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(notifyFake.built).toHaveLength(1);
    expect(shown()?.options.title).toBe('Latest Song');
  });

  it('keeps Linux radio actions and detaches the timed listener on quit', async () => {
    setPlatform('linux');
    const send = vi.fn();
    initCommandBridge(send);
    player.emitNowPlaying(STATION);
    player.emitTimedMetadata(RADIO_SONG);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const [notification] = linuxAdapter.show.mock.calls[0];
    expect(notification).toMatchObject({ title: 'Radio Song', body: 'Radio Artist', icon: '/tmp/sidra-test/artwork.jpg' });
    notification.onAction('previous');
    notification.onAction('next');
    expect(send.mock.calls).toEqual([['player:previous'], ['player:next']]);
    quit();
    expect(player.listenerCount('timedMetadataDidChange')).toBe(0);
    player.emitTimedMetadata({ ...RADIO_SONG, name: 'After Quit' });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    expect(linuxAdapter.show).toHaveBeenCalledOnce();
  });

  it.each(['win32', 'darwin'])('uses an explicit primary action and checks the latest snapshot on %s', async (platform) => {
    setPlatform(platform);
    const send = vi.fn();
    initCommandBridge(send);
    player.emitPlaybackState(PlaybackState.Playing);
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const notification = shown()!;
    expect(notification.options.actions?.[0].text).toBe(getTrayStrings().pause);
    player.setPlaybackState(PlaybackState.Paused);
    notification.handlers.action({ actionIndex: 0 });
    expect(send).not.toHaveBeenCalled();
    player.setPlaybackState(PlaybackState.Playing);
    notification.handlers.action({ actionIndex: 0 });
    expect(send).toHaveBeenCalledExactlyOnceWith('player:pause');
  });

  it.each(['win32', 'darwin', 'linux'])('keeps explicit actions tied to stable playback during transient states on %s', async (platform) => {
    setPlatform(platform);
    const send = vi.fn();
    initCommandBridge(send);
    player.emitPlaybackState(PlaybackState.Playing);
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const pause = platform === 'linux'
      ? () => linuxAdapter.show.mock.calls[0][0].onAction('pause')
      : () => shown()!.handlers.action({ actionIndex: 0 });
    for (const state of [PlaybackState.Seeking, PlaybackState.Waiting]) {
      player.emitPlaybackState(state);
      pause();
    }
    expect(send.mock.calls).toEqual([['player:pause'], ['player:pause']]);
    send.mockClear();
    if (platform !== 'linux') shown()!.handlers.show();
    player.emitPlaybackState(PlaybackState.Paused);
    const play = platform === 'linux'
      ? () => linuxAdapter.show.mock.calls[1][0].onAction('play')
      : () => notifyFake.built[1].handlers.action({ actionIndex: 0 });
    for (const state of [PlaybackState.Seeking, PlaybackState.Waiting]) {
      player.emitPlaybackState(state);
      play();
      if (platform === 'linux') pause();
    }
    expect(send.mock.calls).toEqual([['player:play'], ['player:play']]);
  });

  it('refreshes state with cached artwork and ignores repeated or transient state events', async () => {
    player.emitPlaybackState(PlaybackState.Playing);
    player.emitNowPlaying({ ...TRACK, artworkUrl: STATION.artworkUrl });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    shown()!.handlers.show();
    player.emitPlaybackState(PlaybackState.Waiting);
    player.emitPlaybackState(PlaybackState.Playing);
    expect(notifyFake.built).toHaveLength(1);
    player.emitPlaybackState(PlaybackState.Paused);
    const paused = notifyFake.built[1];
    expect(paused.options.actions?.[0].text).toBe(getTrayStrings().play);
    expect(paused.options.icon).toBe('/tmp/sidra-test/artwork.jpg');
    paused.handlers.show();
    player.emitPlaybackState(PlaybackState.Paused);
    expect(notifyFake.built).toHaveLength(2);
    expect(downloadArtwork).toHaveBeenCalledOnce();
  });

  it('does not reset the song debounce when playback changes', async () => {
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(1000);
    player.emitPlaybackState(PlaybackState.Playing);
    await vi.advanceTimersByTimeAsync(500);
    expect(notifyFake.built).toHaveLength(1);
    expect(shown()!.options.actions?.[0].text).toBe(getTrayStrings().pause);
  });

  it('refreshes a pending display once after it settles without a show loop', async () => {
    player.emitPlaybackState(PlaybackState.Playing);
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    player.emitPlaybackState(PlaybackState.Paused);
    player.emitPlaybackState(PlaybackState.Paused);
    player.emitPlaybackState(PlaybackState.Seeking);
    expect(notifyFake.built).toHaveLength(1);
    shown()!.handlers.show();
    expect(notifyFake.built).toHaveLength(2);
    expect(notifyFake.built[1].options.actions?.[0].text).toBe(getTrayStrings().play);
    notifyFake.built[1].handlers.show();
    expect(notifyFake.built).toHaveLength(2);
  });

  it('keeps the last stable button when display settles during a transient state', async () => {
    player.emitPlaybackState(PlaybackState.Playing);
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    player.emitPlaybackState(PlaybackState.Seeking);
    shown()!.handlers.show();
    expect(notifyFake.built).toHaveLength(1);
    expect(shown()!.options.actions?.[0].text).toBe(getTrayStrings().pause);
  });

  it('does not revive a dismissed notification on state changes', async () => {
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    shown()!.handlers.show();
    shown()!.handlers.close();
    player.emitPlaybackState(PlaybackState.Playing);
    expect(notifyFake.built).toHaveLength(1);
  });

  it('ignores a previous object close event during replacement', async () => {
    player.emitPlaybackState(PlaybackState.Paused);
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    shown()!.handlers.show();
    const oldClose = shown()!.handlers.close;
    player.emitPlaybackState(PlaybackState.Playing);
    oldClose();
    notifyFake.built[1].handlers.show();
    player.emitPlaybackState(PlaybackState.Paused);
    expect(notifyFake.built).toHaveLength(3);
  });

  it('disables state refresh after preference disable, navigation or quit', async () => {
    player.emitNowPlaying(TRACK);
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    shown()!.handlers.show();
    setNotificationsEnabled(false);
    player.emitPlaybackState(PlaybackState.Playing);
    setNotificationsEnabled(true);
    player.resetForDocumentReplacement();
    player.emitPlaybackState(PlaybackState.Paused);
    quit();
    player.emitPlaybackState(PlaybackState.Playing);
    expect(notifyFake.built).toHaveLength(1);
    expect(player.listenerCount('playbackStateDidChange')).toBe(0);
  });

  it('refreshes Linux buttons without artwork work and makes stale explicit actions harmless', async () => {
    setPlatform('linux');
    const send = vi.fn();
    initCommandBridge(send);
    player.emitPlaybackState(PlaybackState.Playing);
    player.emitNowPlaying({ ...TRACK, artworkUrl: STATION.artworkUrl });
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    const [notification] = linuxAdapter.show.mock.calls[0];
    expect(notification).toMatchObject({ playbackAction: 'pause', playbackLabel: getTrayStrings().pause });
    player.emitPlaybackState(PlaybackState.Paused);
    expect(linuxAdapter.show.mock.calls[1][0]).toMatchObject({ playbackAction: 'play', playbackLabel: getTrayStrings().play });
    expect(linuxAdapter.show.mock.calls[1][2]).toBe(true);
    notification.onAction('pause');
    expect(send).not.toHaveBeenCalled();
    notification.onAction('play');
    expect(send).toHaveBeenCalledExactlyOnceWith('player:play');
    expect(downloadArtwork).toHaveBeenCalledOnce();
  });
});
