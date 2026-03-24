import { describe, it, expect, expectTypeOf, vi } from 'vitest';

import { PlaybackState, Player, type PlayerEvents } from '../src/player';

describe('PlaybackState', () => {
  it('None is 0', () => {
    expect(PlaybackState.None).toBe(0);
  });

  it('Loading is 1', () => {
    expect(PlaybackState.Loading).toBe(1);
  });

  it('Playing is 2', () => {
    expect(PlaybackState.Playing).toBe(2);
  });

  it('Paused is 3', () => {
    expect(PlaybackState.Paused).toBe(3);
  });

  it('Stopped is 4', () => {
    expect(PlaybackState.Stopped).toBe(4);
  });

  it('Ended is 5', () => {
    expect(PlaybackState.Ended).toBe(5);
  });

  it('Seeking is 6', () => {
    expect(PlaybackState.Seeking).toBe(6);
  });

  it('Waiting is 7', () => {
    expect(PlaybackState.Waiting).toBe(7);
  });

  it('Stalled is 8', () => {
    expect(PlaybackState.Stalled).toBe(8);
  });

  it('Completed is 9', () => {
    expect(PlaybackState.Completed).toBe(9);
  });

  it('has exactly 10 states', () => {
    expect(Object.keys(PlaybackState)).toHaveLength(10);
  });
});

describe('PlayerEvents', () => {
  it('keys match Player handler event names', () => {
    type EventKeys = keyof PlayerEvents;
    type ExpectedKeys =
      | 'playbackStateDidChange'
      | 'nowPlayingItemDidChange'
      | 'playbackTimeDidChange'
      | 'repeatModeDidChange'
      | 'shuffleModeDidChange'
      | 'volumeDidChange';

    expectTypeOf<EventKeys>().toEqualTypeOf<ExpectedKeys>();
  });
});

describe('Player event forwarding', () => {
  it('emits playbackStateDidChange with payload', () => {
    const player = new Player();
    const listener = vi.fn();
    player.on('playbackStateDidChange', listener);

    const payload = { status: true, state: PlaybackState.Playing };
    player.handlePlaybackStateDidChange(payload);

    expect(listener).toHaveBeenCalledWith(payload);
  });

  it('emits nowPlayingItemDidChange with payload', () => {
    const player = new Player();
    const listener = vi.fn();
    player.on('nowPlayingItemDidChange', listener);

    const payload = { name: 'Track', artistName: 'Artist' };
    player.handleNowPlayingItemDidChange(payload);

    expect(listener).toHaveBeenCalledWith(payload);
  });

  it('emits playbackTimeDidChange with position', () => {
    const player = new Player();
    const listener = vi.fn();
    player.on('playbackTimeDidChange', listener);

    player.handlePlaybackTimeDidChange(42000);

    expect(listener).toHaveBeenCalledWith(42000);
  });

  it('emits repeatModeDidChange with mode', () => {
    const player = new Player();
    const listener = vi.fn();
    player.on('repeatModeDidChange', listener);

    player.handleRepeatModeDidChange(2);

    expect(listener).toHaveBeenCalledWith(2);
  });

  it('emits shuffleModeDidChange with mode', () => {
    const player = new Player();
    const listener = vi.fn();
    player.on('shuffleModeDidChange', listener);

    player.handleShuffleModeDidChange(1);

    expect(listener).toHaveBeenCalledWith(1);
  });

  it('emits volumeDidChange with volume', () => {
    const player = new Player();
    const listener = vi.fn();
    player.on('volumeDidChange', listener);

    player.handleVolumeDidChange(0.75);

    expect(listener).toHaveBeenCalledWith(0.75);
  });
});
