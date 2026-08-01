// test/mocks/player.ts
// Shared fake Player for integration tests.
//
// Integrations receive a Player through IntegrationContext and read
// playbackSnapshot() to decide whether playback is still live. The real Player
// only updates that snapshot from IPC handlers, which these tests do not drive,
// so FakePlayer puts it under test control.
//
// It extends the real Player rather than reimplementing the interface: Player
// holds private fields, so a structural stand-in is not assignable to
// IntegrationContext without a cast.
import { Player, PlaybackSnapshot, PlaybackState, NowPlayingPayload } from '../../src/player';

export class FakePlayer extends Player {
  private snapshot: PlaybackSnapshot = { isPlaying: false, positionUs: 0, state: PlaybackState.None };

  override playbackSnapshot(): PlaybackSnapshot {
    return { ...this.snapshot };
  }

  /**
   * Moves the reported playhead and emits, as position reports from the
   * renderer do. Both halves matter: the real Player stores the position and
   * emits it from the same handler, and an integration may only trust the
   * stored value once it has seen the event.
   */
  setPositionUs(positionUs: number): void {
    this.snapshot = { ...this.snapshot, positionUs };
    this.emit('playbackTimeDidChange', positionUs);
  }

  /** Advances the playhead by `ms` of playback. */
  advancePositionMs(ms: number): void {
    this.setPositionUs(this.snapshot.positionUs + ms * 1000);
  }

  /** Updates the snapshot to match `state` without emitting. */
  setPlaybackState(state: number): void {
    this.snapshot = { ...this.snapshot, state, isPlaying: state === PlaybackState.Playing };
  }

  /** Updates the snapshot to match `state`, then emits, exactly as the real Player does. */
  emitPlaybackState(state: number): void {
    this.setPlaybackState(state);
    this.emit('playbackStateDidChange', { status: this.snapshot.isPlaying, state });
  }

  emitNowPlaying(payload: NowPlayingPayload | null): void {
    this.emit('nowPlayingItemDidChange', payload);
  }
}
