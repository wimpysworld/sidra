(function () {
  // This flag persists for the page lifetime and is never cleared. Re-injection
  // must not re-run the IIFE: the 5-second monitor inside the hook already
  // handles MusicKit instance replacement, and re-running would install a
  // duplicate set of message and wheel listeners.
  if (window.__sidraHookInjected) return;
  window.__sidraHookInjected = true;

  const waitForMK = setInterval(() => {
    if (!window.MusicKit) return;
    clearInterval(waitForMK);

    /** @type {number | null} Timer ID for the volume polling fallback. */
    let volumePollTimer = null;

    /**
     * Send to the main process, tolerating an absent bridge.
     *
     * window.AMWrapper is installed by the preload script. It is normally there
     * before this runs, but the hook is injected into a page it does not
     * control and cannot assume it. The eager volume send in attachToInstance()
     * is the most likely thrower, and every send goes through here so no path
     * can throw on an absent bridge.
     *
     * @param {string} channel - IPC channel name
     * @param {unknown} [payload] - Channel payload
     * @returns {void}
     */
    function sendToMain(channel, payload) {
      const bridge = window.AMWrapper;
      if (!bridge || !bridge.ipcRenderer) return;
      bridge.ipcRenderer.send(channel, payload);
    }

    /**
     * The media session to report position state on, or null when the page
     * cannot take it.
     *
     * Resolved on every call rather than once: the hook is injected into a page
     * it does not control, and Safari exposes navigator.mediaSession without
     * setPositionState.
     *
     * @returns {MediaSession | null} The usable media session, or null
     */
    function getPositionSink() {
      if (typeof navigator === 'undefined' ||
          !navigator.mediaSession ||
          typeof navigator.mediaSession.setPositionState !== 'function') {
        return null;
      }
      return navigator.mediaSession;
    }

    /**
     * Attach event listeners to a MusicKit instance and expose control
     * methods on window.__sidra.
     *
     * Called on initial hook and whenever MusicKit replaces its singleton.
     *
     * @param {object} mk - The MusicKit.getInstance() singleton
     * @returns {void}
     */
    function attachToInstance(mk) {
      // The first statement, claimed before anything below can throw. The
      // 5-second monitor re-attaches whenever this marker does not match the
      // live instance, so a throw ahead of the assignment leaves it stale and
      // the monitor adds a duplicate set of listeners on every cycle. A
      // part-attached instance is the lesser fault, and attachSafely() logs it.
      window.__sidraHookedMk = mk;

      // The previous poll closes over the replaced instance, so a re-hook must
      // stop it rather than leave two timers reporting different volumes.
      if (volumePollTimer !== null) {
        clearInterval(volumePollTimer);
        volumePollTimer = null;
      }

      /**
       * Report explicit media session position state for OS media controls.
       *
       * The playbackTimeDidChange listener calls this on every tick and must
       * not debounce it: music.apple.com writes to the same MediaSession from
       * the same world, and the repeated call keeps Sidra's value in place. It
       * starts no debounce timer, so the project rule against debounced sends
       * from that event still holds.
       * @returns {void}
       */
      function reportPositionState() {
        const sink = getPositionSink();
        if (!sink) return;

        // An unresolvable duration or position clears the state rather than
        // reporting duration: Infinity, because the hook cannot tell genuinely
        // unbounded media (a radio station) from a duration not yet resolved.
        let duration;
        if (Number.isFinite(mk.currentPlaybackDuration) &&
            mk.currentPlaybackDuration > 0) {
          duration = mk.currentPlaybackDuration;
        } else {
          const durationInMillis = mk.nowPlayingItem?.attributes?.durationInMillis;
          if (!Number.isFinite(durationInMillis) || durationInMillis <= 0) {
            clearPositionState();
            return;
          }
          duration = durationInMillis / 1000;
        }

        const position = mk.currentPlaybackTime;
        if (!Number.isFinite(position) || position < 0) {
          clearPositionState();
          return;
        }

        try {
          sink.setPositionState({
            duration,
            playbackRate: 1,
            position: Math.min(position, duration),
          });
        } catch (_) {
          // A value Chromium rejects is not worth failing the listener over;
          // the next playbackTimeDidChange tick reports again.
        }
      }

      /**
       * Clear media session position state for OS media controls.
       * @returns {void}
       */
      function clearPositionState() {
        const sink = getPositionSink();
        if (!sink) return;

        try {
          sink.setPositionState();
        } catch (_) {
          // Clearing is best effort; the caller has nothing else to try.
        }
      }

      /**
       * Forward playback state changes to the main process.
       * @param {{ state: number }} event - MusicKit playbackStateDidChange event
       */
      mk.addEventListener('playbackStateDidChange', ({ state }) => {
        sendToMain('playbackStateDidChange', {
          status: state === MusicKit.PlaybackStates.playing,
          state,
        });
      });

      /**
       * Forward now-playing metadata to the main process.
       * Sends null when no item is playing (e.g. queue cleared).
       * @param {{ item: object | null }} event - MusicKit nowPlayingItemDidChange event
       */
      mk.addEventListener('nowPlayingItemDidChange', ({ item }) => {
        if (!item) {
          sendToMain('nowPlayingItemDidChange', null);
          clearPositionState();
          return;
        }
        const pp = item.attributes?.playParams;
        sendToMain('nowPlayingItemDidChange', {
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
          // The document this item came from. The main process persists the
          // active service separately and the two can disagree, so a share URL
          // built from config can name a host the track was never on.
          sourceHost: window.location.hostname,
        });
      });

      /**
       * Forward playback position (in microseconds) to the main process and
       * refresh the media session position state.
       */
      mk.addEventListener('playbackTimeDidChange', () => {
        sendToMain('playbackTimeDidChange',
          mk.currentPlaybackTime * 1_000_000
        );
        reportPositionState();
      });

      /** Forward repeat mode changes to the main process. */
      mk.addEventListener('repeatModeDidChange', () => {
        sendToMain('repeatModeDidChange', mk.repeatMode);
      });

      /** Forward shuffle mode changes to the main process. */
      mk.addEventListener('shuffleModeDidChange', () => {
        sendToMain('shuffleModeDidChange', mk.shuffleMode);
      });

      /**
       * Last value sent over the volumeDidChange IPC channel, so the poll
       * below does not re-send a value the listener already reported.
       * @type {number}
       */
      let lastVolume = mk.volume;
      // Send the initial volume so MPRIS (and any other listener) receives the
      // real value immediately, not just on subsequent changes.
      sendToMain('volumeDidChange', lastVolume);
      // playbackVolumeDidChange is the only volume event MusicKit publishes, so
      // binding volumeDidChange leaves the listener dead. The IPC channel below
      // keeps the volumeDidChange name, which is Sidra's own and deliberately
      // unrelated to the MusicKit event name.
      mk.addEventListener('playbackVolumeDidChange', () => {
        lastVolume = mk.volume;
        sendToMain('volumeDidChange', mk.volume);
      });
      // Poll mk.volume every 250ms as a fallback for a volume write the hook
      // cannot observe through playbackVolumeDidChange. What the player bar
      // volume control writes has never been confirmed, so this stays as the
      // second of the only two paths reporting volume.
      volumePollTimer = setInterval(() => {
        const v = mk.volume;
        if (v !== lastVolume) {
          lastVolume = v;
          sendToMain('volumeDidChange', v);
        }
      }, 250);

      /**
       * Control methods exposed to the preload script via window.postMessage.
       * @type {SidraHook}
       * @see {SidraHook} in src/types/hook.d.ts
       */
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
    }

    /**
     * Attach to an instance, containing any failure.
     *
     * The marker is claimed inside attachToInstance() before it can throw, so
     * the monitor will not retry a part-attached instance. Reporting the error
     * is all that is left to do, and it must not propagate: the monitor's own
     * catch would swallow it, and on the first call it would abort the rest of
     * the hook, including the message and wheel listeners below.
     *
     * @param {object} mk - The MusicKit.getInstance() singleton
     * @returns {void}
     */
    function attachSafely(mk) {
      try {
        attachToInstance(mk);
      } catch (err) {
        console.error('[Sidra] failed to attach to the MusicKit instance', err);
      }
    }

    const mk = MusicKit.getInstance();
    attachSafely(mk);

    /**
     * Allowed commands that may be dispatched via window.postMessage from the
     * preload script. Must stay in sync with RECEIVE_CHANNELS in
     * src/preload.ts and keyof SidraHook in src/types/hook.d.ts.
     * @type {Set<string>}
     */
    const COMMANDS = new Set([
      'play', 'pause', 'playPause', 'next', 'previous',
      'seek', 'setVolume', 'setRepeat', 'setShuffle',
    ]);

    /**
     * Bridge: the preload script (isolated world) forwards IPC commands via
     * window.postMessage because it cannot access window.__sidra directly.
     * @param {MessageEvent} event - The postMessage event
     * @see {SidraCommandMessage} in src/types/hook.d.ts for the payload shape
     */
    window.addEventListener('message', (event) => {
      if (event.source !== window) return;
      if (!event.data || event.data.type !== 'sidra:command') return;

      const { channel, args } = event.data;
      const method = channel.replace('player:', '');
      if (!COMMANDS.has(method)) {
        console.warn(`[Sidra] blocked unrecognised command: "${method}"`);
        return;
      }
      // window.__sidra is the last thing attachToInstance() assigns, and this
      // listener installs even when the attach threw before reaching it, so the
      // hook object may be absent. An unguarded index would throw a TypeError
      // straight back out of the path attachSafely() exists to contain.
      if (typeof window.__sidra?.[method] === 'function') {
        window.__sidra[method](...(args || []));
      }
    });

    /**
     * Volume change applied per wheel notch. The step is fixed and never scaled
     * by deltaY magnitude: Chromium reports a wheel and a touchpad identically
     * as DOM_DELTA_PIXEL, so scaling gives a wheel a full-range jump and a
     * touchpad an invisible nudge.
     */
    const VOLUME_STEP = 0.05;
    /** Chromium's default deltaY, in pixels, for one mouse wheel notch. */
    const WHEEL_NOTCH_DELTA = 100;
    /**
     * Wheel delta not yet consumed by a step, so a touchpad accumulates
     * smoothly instead of needing a full notch per event.
     * @type {number}
     */
    let wheelDelta = 0;

    /**
     * Change the volume when the pointer is over the player bar volume control.
     *
     * Both services put the `chrome-volume` class token on the control, on a
     * `div` for music.apple.com and on an `amp-chrome-volume` element for
     * classical.music.apple.com, so the gate matches that token anywhere in the
     * composed path and never the element name, which would work on Classical
     * and silently do nothing on Apple Music. Never write a Svelte scope hash
     * into the selector; those change on any Apple rebuild. Writing mk.volume
     * reaches the main process by the existing playbackVolumeDidChange route.
     *
     * The listener is on window rather than on the control itself, because the
     * control does not exist when the hook runs and is replaced on navigation
     * and service switches.
     *
     * @param {WheelEvent} event - The wheel event
     */
    window.addEventListener('wheel', (event) => {
      // Ctrl+scroll and pinch are zoom gestures, not volume ones.
      if (event.ctrlKey) return;
      const overVolume = event.composedPath()
        .some((target) => target.classList?.contains('chrome-volume'));
      if (!overVolume) return;
      // Stop the page scrolling under the control, even when this event only
      // accumulates and moves the volume nowhere.
      event.preventDefault();

      const hookedMk = window.__sidraHookedMk;
      if (!hookedMk) return;

      // A reversal starts from zero, so a residual from scrolling one way does
      // not delay the first step the other way.
      const direction = Math.sign(event.deltaY);
      if (direction !== 0 && direction !== Math.sign(wheelDelta)) wheelDelta = 0;
      wheelDelta += event.deltaY;

      const steps = Math.trunc(wheelDelta / WHEEL_NOTCH_DELTA);
      if (steps === 0) return;
      wheelDelta -= steps * WHEEL_NOTCH_DELTA;

      // Read the live volume every time: a write MusicKit drops self-corrects
      // on the next notch. Scrolling down (positive deltaY) lowers the volume,
      // and the result is clamped because MusicKit throws outside 0 to 1.
      const volume = hookedMk.volume - steps * VOLUME_STEP;
      hookedMk.volume = Math.min(1, Math.max(0, Math.round(volume * 100) / 100));
    }, { passive: false });

    console.log('[Sidra] MusicKit hooked successfully');

    // Apple Music may re-create the MusicKit instance during a session, which
    // raises no event, so the replacement is only visible by comparing the live
    // instance against the marker.
    setInterval(() => {
      try {
        const currentMk = MusicKit.getInstance();
        if (currentMk !== window.__sidraHookedMk &&
            typeof currentMk.addEventListener === 'function') {
          attachSafely(currentMk);
          console.log('[Sidra] MusicKit re-hooked (instance replaced)');
        }
      } catch (_) {
        // MusicKit.getInstance() may throw during re-initialisation; skip cycle
      }
    }, 5000);
  }, 500);
})();
