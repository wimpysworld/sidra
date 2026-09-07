// Integration tests control the playback snapshot without sending renderer IPC.
// Extending Player preserves its private-field identity, so IntegrationContext accepts the fake without a cast.
import { Player, PlaybackSnapshot, PlaybackState, NowPlayingPayload, TimedMetadataPayload } from '../../src/player';

/** A Player with a test-controlled snapshot and explicit event helpers. */
export class FakePlayer extends Player {
  private snapshot: PlaybackSnapshot = { isPlaying: false, positionUs: 0, state: PlaybackState.None };

  /** Returns a copy so callers cannot mutate the test-controlled snapshot. */
  override playbackSnapshot(): PlaybackSnapshot {
    return { ...this.snapshot };
  }

  /** Clears the fake snapshot before the real reset emits its events. */
  override resetForDocumentReplacement(): void {
    this.snapshot = { isPlaying: false, positionUs: 0, state: PlaybackState.None };
    super.resetForDocumentReplacement();
  }

  /**
   * Stores the playhead before emitting its position report, as the real Player does.
   * Integrations trust the stored position only after they receive the event.
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

  /** Emits queue metadata without changing the playback snapshot. */
  emitNowPlaying(payload: NowPlayingPayload | null): void {
    this.emit('nowPlayingItemDidChange', payload);
  }

  /** Emits radio song metadata without replacing the queue item. */
  emitTimedMetadata(payload: TimedMetadataPayload): void {
    this.emit('timedMetadataDidChange', payload);
  }
}
