import { describe, it, expect } from 'vitest';

import { PlaybackState } from '../src/player';

describe('PlaybackState', () => {
  it('Playing is 2', () => {
    expect(PlaybackState.Playing).toBe(2);
  });

  it('Paused is 3', () => {
    expect(PlaybackState.Paused).toBe(3);
  });

  it('Stopped is 4', () => {
    expect(PlaybackState.Stopped).toBe(4);
  });
});
