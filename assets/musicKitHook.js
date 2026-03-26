(function () {
  if (window.MusicKit && window.__sidraHookedMk === MusicKit.getInstance()) return;

  const waitForMK = setInterval(() => {
    if (!window.MusicKit) return;
    clearInterval(waitForMK);

    let volumePollTimer = null;

    function attachToInstance(mk) {
      // Clear previous volume polling timer on re-hook
      if (volumePollTimer !== null) {
        clearInterval(volumePollTimer);
        volumePollTimer = null;
      }

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
        const pp = item.attributes?.playParams;
        window.AMWrapper.ipcRenderer.send('nowPlayingItemDidChange', {
          name: item.attributes?.name,
          albumName: item.attributes?.albumName,
          artistName: item.attributes?.artistName,
          durationInMillis: item.attributes?.durationInMillis,
          genreNames: item.attributes?.genreNames,
          artworkUrl: item.attributes?.artwork?.url
            ?.replace('{w}', '512').replace('{h}', '512'),
          trackId: item.id,
          audioTraits: item.attributes?.audioTraits,
          trackNumber: item.attributes?.trackNumber,
          targetBitrate: mk.bitrate,
          url: item.attributes?.url,
          discNumber: item.attributes?.discNumber,
          composerName: item.attributes?.composerName,
          releaseDate: item.attributes?.releaseDate,
          contentRating: item.attributes?.contentRating,
          itemType: item.attributes?.playParams?.kind,
          containerId: item.container?.id,
          containerType: item.container?.type,
          containerName: item.container?.attributes?.name,
          playParams: pp ? {
            catalogId: pp.catalogId,
            globalId: pp.globalId,
            kind: pp.kind,
            isLibrary: pp.isLibrary,
          } : undefined,
          isrc: item.attributes?.isrc,
          queueLength: mk.queue?.length,
          queueIndex: mk.nowPlayingItemIndex,
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
      volumePollTimer = setInterval(() => {
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

      window.__sidraHookedMk = mk;
    }

    const mk = MusicKit.getInstance();
    attachToInstance(mk);

    // Allowed commands that may be dispatched via window.postMessage from the
    // preload script. Must stay in sync with RECEIVE_CHANNELS in src/preload.ts.
    const COMMANDS = new Set([
      'play', 'pause', 'playPause', 'next', 'previous',
      'seek', 'setVolume', 'setRepeat', 'setShuffle',
    ]);

    // Bridge: the preload script (isolated world) forwards IPC commands via
    // window.postMessage because it cannot access window.__sidra directly.
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (!event.data || event.data.type !== 'sidra:command') return;

      const { channel, args } = event.data;
      const method = channel.replace('player:', '');
      if (!COMMANDS.has(method)) {
        console.warn(`[Sidra] blocked unrecognised command: "${method}"`);
        return;
      }
      if (typeof window.__sidra[method] === 'function') {
        window.__sidra[method](...(args || []));
      }
    });

    console.log('[Sidra] MusicKit hooked successfully');

    // Monitor for MusicKit instance replacement every 5 seconds.
    // Apple Music may internally re-create the MusicKit instance during a
    // session; this detects the change and re-attaches listeners.
    setInterval(() => {
      try {
        const currentMk = MusicKit.getInstance();
        if (currentMk !== window.__sidraHookedMk &&
            typeof currentMk.addEventListener === 'function') {
          attachToInstance(currentMk);
          console.log('[Sidra] MusicKit re-hooked (instance replaced)');
        }
      } catch (_) {
        // MusicKit.getInstance() may throw during re-initialisation; skip cycle
      }
    }, 5000);
  }, 500);
})();
