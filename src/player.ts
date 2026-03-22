import { EventEmitter } from 'events';
import log from 'electron-log/main';

const playerLog = log.scope('player');

const PLAYBACK_STATES: Record<number, string> = {
  0: 'none',
  1: 'loading',
  2: 'playing',
  3: 'paused',
  4: 'stopped',
  5: 'ended',
  6: 'seeking',
  7: 'waiting',
  8: 'stalled',
  9: 'completed',
};

export class Player extends EventEmitter {
  private lastTimeLogAt = 0;

  constructor() {
    super();
  }

  handlePlaybackStateDidChange(payload: unknown): void {
    const p = payload as { status: boolean; state: number } | null;
    const stateName = p != null ? (PLAYBACK_STATES[p.state] ?? String(p.state)) : null;
    playerLog.debug('playbackStateDidChange:', { ...p, state: stateName });
    this.emit('playbackStateDidChange', payload);
  }

  handleNowPlayingItemDidChange(payload: unknown): void {
    playerLog.debug('nowPlayingItemDidChange:', payload);
    this.emit('nowPlayingItemDidChange', payload);
  }

  handlePlaybackTimeDidChange(payload: unknown): void {
    const now = Date.now();
    if (now - this.lastTimeLogAt >= 10_000) {
      playerLog.debug('playbackTimeDidChange:', payload);
      this.lastTimeLogAt = now;
    }
    this.emit('playbackTimeDidChange', payload);
  }

  handleRepeatModeDidChange(payload: unknown): void {
    playerLog.debug('repeatModeDidChange:', payload);
    this.emit('repeatModeDidChange', payload);
  }

  handleShuffleModeDidChange(payload: unknown): void {
    playerLog.debug('shuffleModeDidChange:', payload);
    this.emit('shuffleModeDidChange', payload);
  }

  handleVolumeDidChange(payload: unknown): void {
    playerLog.debug('volumeDidChange:', payload);
    this.emit('volumeDidChange', payload);
  }
}
