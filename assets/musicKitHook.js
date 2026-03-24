(function () {
  if (window.__sidra) return;

  const waitForMK = setInterval(() => {
    if (!window.MusicKit) return;
    clearInterval(waitForMK);

    const mk = MusicKit.getInstance();

    mk.addEventListener('playbackStateDidChange', ({ state }) => {
      window.AMWrapper.ipcRenderer.send('playbackStateDidChange', {
        status: state === MusicKit.PlaybackStates.playing,
        state,
      });
    });

    mk.addEventListener('nowPlayingItemDidChange', ({ item }) => {
      if (!item) {
        window.AMWrapper.ipcRenderer.send('nowPlayingItemDidChange', null);
        return;
      }
      window.AMWrapper.ipcRenderer.send('nowPlayingItemDidChange', {
        name: item.attributes.name,
        albumName: item.attributes.albumName,
        artistName: item.attributes.artistName,
        durationInMillis: item.attributes.durationInMillis,
        genreNames: item.attributes.genreNames,
        artworkUrl: item.attributes.artwork?.url
          ?.replace('{w}', '512').replace('{h}', '512'),
        trackId: item.id,
        audioTraits: item.attributes?.audioTraits,
        trackNumber: item.attributes.trackNumber,
        targetBitrate: mk.bitrate,
        url: item.attributes.url,
      });
    });

    mk.addEventListener('playbackTimeDidChange', () => {
      window.AMWrapper.ipcRenderer.send('playbackTimeDidChange',
        mk.currentPlaybackTime * 1_000_000
      );
    });

    mk.addEventListener('repeatModeDidChange', () => {
      window.AMWrapper.ipcRenderer.send('repeatModeDidChange', mk.repeatMode);
    });

    mk.addEventListener('shuffleModeDidChange', () => {
      window.AMWrapper.ipcRenderer.send('shuffleModeDidChange', mk.shuffleMode);
    });

    let lastVolume = mk.volume;
    // Send the initial volume so MPRIS (and any other listener) receives the
    // real value immediately, not just on subsequent changes.
    window.AMWrapper.ipcRenderer.send('volumeDidChange', lastVolume);
    mk.addEventListener('volumeDidChange', () => {
      lastVolume = mk.volume;
      window.AMWrapper.ipcRenderer.send('volumeDidChange', mk.volume);
    });
    setInterval(() => {
      const v = mk.volume;
      if (v !== lastVolume) {
        lastVolume = v;
        window.AMWrapper.ipcRenderer.send('volumeDidChange', v);
      }
    }, 250);

    window.__sidra = {
      play:       () => mk.play(),
      pause:      () => mk.pause(),
      playPause:  () => mk.isPlaying ? mk.pause() : mk.play(),
      next:       () => mk.skipToNextItem(),
      previous:   () => mk.skipToPreviousItem(),
      seek:       (secs) => mk.seekToTime(secs),
      setVolume:  (v) => { mk.volume = v; },
      setRepeat:  (m) => { mk.repeatMode = m; },
      setShuffle: (m) => { mk.shuffleMode = m; },
    };

    console.log('[Sidra] MusicKit hooked successfully');
  }, 500);
})();
