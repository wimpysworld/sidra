(function () {
  // This flag persists for the page lifetime and is never cleared. Re-injection
  // must not re-run the IIFE: the 5-second monitor inside the hook already
  // handles MusicKit instance replacement, and re-running would install a
  // duplicate set of message and pointerover listeners.
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
     * control and cannot assume it. The eager volume send in attachVolume() is
     * the most likely thrower, and every send goes through here so no path can
     * throw on an absent bridge.
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
     * Report explicit media session position state for OS media controls.
     *
     * The playbackTimeDidChange listener calls this on every tick and must not
     * debounce it: music.apple.com writes to the same MediaSession from the
     * same world, and the repeated call keeps Sidra's value in place. It starts
     * no debounce timer, so the project rule against debounced sends from that
     * event still holds.
     *
     * @param {object} mk - The MusicKit.getInstance() singleton
     * @returns {void}
     */
    function reportPositionState(mk) {
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
     * Register the playback listeners that forward state, metadata, position,
     * repeat and shuffle to the main process.
     *
     * Called once per attach, so a replaced instance receives its own set.
     *
     * @param {object} mk - The MusicKit.getInstance() singleton
     * @returns {void}
     */
    function attachPlaybackListeners(mk) {
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
          trackNumber: item.attributes?.trackNumber,
          url: item.attributes?.url,
          discNumber: item.attributes?.discNumber,
          composerName: item.attributes?.composerName,
          releaseDate: item.attributes?.releaseDate,
          playParams: pp ? {
            catalogId: pp.catalogId,
            globalId: pp.globalId,
            kind: pp.kind,
            isLibrary: pp.isLibrary,
          } : undefined,
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
        reportPositionState(mk);
      });

      /** Forward repeat mode changes to the main process. */
      mk.addEventListener('repeatModeDidChange', () => {
        sendToMain('repeatModeDidChange', mk.repeatMode);
      });

      /** Forward shuffle mode changes to the main process. */
      mk.addEventListener('shuffleModeDidChange', () => {
        sendToMain('shuffleModeDidChange', mk.shuffleMode);
      });
    }

    /**
     * Stop the volume poll.
     *
     * The poll closes over the instance it was started for, so a re-hook must
     * stop it rather than leave two timers reporting different volumes.
     *
     * @returns {void}
     */
    function stopVolumePoll() {
      if (volumePollTimer === null) return;
      clearInterval(volumePollTimer);
      volumePollTimer = null;
    }

    /**
     * Report the current volume, then keep reporting it by listener and by
     * poll. Called once per attach, after stopVolumePoll().
     *
     * @param {object} mk - The MusicKit.getInstance() singleton
     * @returns {void}
     */
    function attachVolume(mk) {
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

      // Stopping the previous poll comes first, so a throw in either attach
      // below cannot leave a second timer polling the replaced instance.
      stopVolumePoll();
      attachPlaybackListeners(mk);
      attachVolume(mk);

      /**
       * Control methods exposed to the preload script via window.postMessage.
       *
       * The last assignment, so a throw in any call above leaves the hook
       * object absent rather than half-built. The message listener indexes it
       * defensively for that reason.
       *
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
     * the hook, including the message and pointerover listeners below.
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
     * Matches the player bar volume control by the class token both services
     * put on it: a `div` on music.apple.com, an `amp-chrome-volume` element on
     * classical.music.apple.com. It must stay a class-token selector and never
     * an element name, which would work on Classical and silently do nothing on
     * Apple Music. Never write a Svelte scope hash into it; those change on any
     * Apple rebuild.
     */
    const VOLUME_SELECTOR = '.chrome-volume';

    /**
     * The control the wheel listener is currently bound to, or null.
     * @type {Element | null}
     */
    let boundVolumeControl = null;

    /**
     * Change the volume when the wheel turns over the player bar volume
     * control. Writing mk.volume reaches the main process by the existing
     * playbackVolumeDidChange route, so nothing outside the hook changes.
     *
     * @param {WheelEvent} event - The wheel event
     * @returns {void}
     */
    function onVolumeWheel(event) {
      // Ctrl+scroll and pinch are zoom gestures, not volume ones.
      if (event.ctrlKey) return;
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
    }

    /**
     * Point the wheel listener at the volume control, moving it off whichever
     * control it was on before.
     *
     * The listener must never go on `window` or `document`: a non-passive wheel
     * listener there marks the whole document a non-fast-scrollable region, so
     * Chromium stops scrolling on the compositor thread and every wheel tick
     * waits on a main thread Apple Music keeps busy. The cost comes from the
     * listener existing, not from what it does, which is why it survived review
     * while the handler itself stayed correct. On the control the region is
     * that control's own box.
     *
     * @param {Element} control - The volume control to bind
     * @returns {void}
     */
    function bindVolumeWheel(control) {
      if (control === boundVolumeControl) return;
      if (boundVolumeControl) {
        boundVolumeControl.removeEventListener('wheel', onVolumeWheel);
      }
      boundVolumeControl = control;
      control.addEventListener('wheel', onVolumeWheel, { passive: false });
    }

    /**
     * Find the volume control and bind to it when the pointer reaches it.
     *
     * The control does not exist when the hook runs and is replaced on
     * navigation and service switches, so the binding is resolved lazily rather
     * than once. `pointerover` is what resolves it: a wheel event over the
     * control is always preceded by the pointer arriving there, and this
     * listener is passive, so it costs scrolling nothing.
     *
     * A MutationObserver would answer the same question and is deliberately not
     * used: one in this file previously cost 180 MiB/s.
     *
     * @param {PointerEvent} event - The pointerover event
     * @returns {void}
     */
    function onPointerOver(event) {
      const target = event.target;
      if (typeof target?.closest !== 'function') return;
      const control = target.closest(VOLUME_SELECTOR);
      if (control) bindVolumeWheel(control);
    }

    window.addEventListener('pointerover', onPointerOver, { passive: true });

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
