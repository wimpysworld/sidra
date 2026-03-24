import { describe, it, expect, expectTypeOf } from 'vitest';

import { PlaybackState, type PlayerEvents } from '../src/player';

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
