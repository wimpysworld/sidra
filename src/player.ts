import { EventEmitter } from 'events';
import log from 'electron-log/main';

const playerLog = log.scope('player');

export class Player extends EventEmitter {
  constructor() {
    super();
  }

  handlePlaybackStateDidChange(payload: unknown): void {
    playerLog.debug('playbackStateDidChange:', payload);
    this.emit('playbackStateDidChange', payload);
  }

  handleNowPlayingItemDidChange(payload: unknown): void {
    playerLog.debug('nowPlayingItemDidChange:', payload);
    this.emit('nowPlayingItemDidChange', payload);
  }

  handlePlaybackTimeDidChange(payload: unknown): void {
    playerLog.debug('playbackTimeDidChange:', payload);
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
