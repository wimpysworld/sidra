(function () {
  // Keep this flag for the document lifetime to prevent duplicate message and pointerover listeners.
  // The five-second monitor handles MusicKit instance replacement without re-injection.
  if (window.__sidraHookInjected) return;
  window.__sidraHookInjected = true;
  const injectedDocumentGeneration = __SIDRA_DOCUMENT_GENERATION__;
  const serviceHosts = new Set(__SIDRA_SERVICE_HOSTS__);

  const waitForMK = setInterval(() => {
    if (!window.MusicKit) return;
    // MusicKit can be present while getInstance() still throws during its own
    // initialisation. Resolve the instance before clearing the poll: a throw
    // after the clear would end setup for the document lifetime, because
    // __sidraHookInjected blocks re-injection.
    let mk;
    try {
      mk = MusicKit.getInstance();
    } catch (_) {
      return;
    }
    clearInterval(waitForMK);

    /** @type {number | null} Timer ID for the volume polling fallback. */
    let volumePollTimer = null;
    let documentGeneration = 0;
    let documentActive = true;
    let resetStopForDocument = () => {};
    window.addEventListener('pagehide', () => {
      documentGeneration += 1;
      documentActive = false;
      resetStopForDocument();
    });
    window.addEventListener('pageshow', () => { documentActive = true; });
    const unsafeTimedText = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/u;

    /**
     * Send to the main process, tolerating an absent bridge.
     *
     * The injected hook cannot assume that the preload bridge exists.
     * Guard every send, including the initial volume report, against an absent bridge.
     *
     * @param {string} channel - IPC channel name
     * @param {unknown} [payload] - Channel payload
     * @returns {void}
     */
    function sendToMain(channel, payload) {
      const bridge = window.AMWrapper;
      if (!bridge || !bridge.ipcRenderer) return;
      bridge.ipcRenderer.send(channel, payload, injectedDocumentGeneration);
    }

    /**
     * Resolve the current media session only when it supports setPositionState.
     * The injected hook cannot assume that the page provides this method.
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
        // A failed clear has no fallback.
      }
    }

    function effectiveDuration(mk) {
      const itemDurationMs = mk.nowPlayingItem?.attributes?.durationInMillis;
      const duration = Number.isFinite(mk.currentPlaybackDuration) && mk.currentPlaybackDuration > 0
        ? mk.currentPlaybackDuration
        : Number.isFinite(itemDurationMs) ? itemDurationMs / 1000 : null;
      return Number.isFinite(duration) && duration > 0 && duration <= Number.MAX_SAFE_INTEGER / 1_000_000
        ? duration : null;
    }

    /**
     * Report explicit media session position state for OS media controls.
     *
     * Report on every playbackTimeDidChange event because Apple writes to the same MediaSession.
     * Do not debounce these writes: continuous position events would keep postponing the update.
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
      const duration = effectiveDuration(mk);
      if (duration === null) {
        clearPositionState();
        return;
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
        // Keep the listener active after rejection. The next playbackTimeDidChange event reports again.
      }
    }

    /**
     * Register the playback listeners that forward state, metadata, position,
     * repeat and shuffle to the main process.
     *
     * Called once per attach, so a replaced instance receives its own set.
     *
     * @param {object} mk - The MusicKit.getInstance() singleton
     * @param {() => void} resetStop - Invalidates stopped intent and pending commands
     * @returns {() => void} Refreshes changed playback capabilities
     */
    function attachPlaybackListeners(mk, resetStop) {
      let lastCapabilities;
      function reportCapabilities(item = mk.nowPlayingItem) {
        if (window.__sidraHookedMk !== mk) return;
        const duration = item ? effectiveDuration(mk) : null;
        const capabilities = {
          canPlay: !!item && typeof mk.play === 'function',
          canPause: !!item && typeof mk.pause === 'function',
          canSeek: !item || typeof mk.seekToTime !== 'function' ? false : duration === null ? null : true,
          durationUs: duration === null ? null : Math.trunc(duration * 1_000_000),
        };
        const serialised = JSON.stringify(capabilities);
        if (serialised === lastCapabilities) return;
        lastCapabilities = serialised;
        sendToMain('playbackCapabilitiesDidChange', capabilities);
      }
      /**
       * Forward playback state changes to the main process.
       * @param {{ state: number }} event - MusicKit playbackStateDidChange event
       */
      function reportPlaybackState({ state }) {
        if (state === MusicKit.PlaybackStates.playing) resetStop();
        sendToMain('playbackStateDidChange', {
          status: state === MusicKit.PlaybackStates.playing,
          state,
        });
        reportCapabilities();
      }
      mk.addEventListener('playbackStateDidChange', reportPlaybackState);

      /**
       * Forward now-playing metadata to the main process.
       * Send null when the queue has no current item.
       * @param {{ item: object | null }} event - MusicKit nowPlayingItemDidChange event
       */
      function reportNowPlaying({ item }) {
        resetStop();
        reportCapabilities(item);
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
          // Use the item's document host for sharing. The persisted service can
          // change before the previous service's track metadata disappears.
          sourceHost: window.location.hostname,
        });
      }
      mk.addEventListener('nowPlayingItemDidChange', reportNowPlaying);

      /**
       * Forward complete songs embedded in a radio station or archived show.
       * @param {object} metadata - MusicKit timedMetadataDidChange payload
       */
      mk.addEventListener('timedMetadataDidChange', (metadata) => {
        if (mk.nowPlayingItem?.attributes?.playParams?.kind !== 'radioStation') return;

        const title = typeof metadata?.title === 'string' ? metadata.title.trim() : '';
        const artist = typeof metadata?.performer === 'string' ? metadata.performer.trim() : '';
        if (!title || !artist) {
          sendToMain('timedMetadataDidChange', null);
          return;
        }

        const links = Array.isArray(metadata.links) ? metadata.links : [];
        const descriptions = links
          .map((link) => typeof link?.description === 'string' ? link.description : null)
          .filter((description) => description !== null);
        if (new Set(descriptions).size !== descriptions.length) return;

        const adamIds = metadata.storefrontAdamIds &&
          typeof metadata.storefrontAdamIds === 'object' &&
          !Array.isArray(metadata.storefrontAdamIds)
          ? [...new Set(Object.values(metadata.storefrontAdamIds)
              .filter((value) => typeof value === 'string')
              .map((value) => value.trim())
              .filter((value) => value !== '' && value.length <= 128 && !unsafeTimedText.test(value)))]
          : [];
        const catalogId = adamIds.length === 1 ? adamIds[0] : null;
        const album = typeof metadata.album === 'string' ? metadata.album.trim() : undefined;
        if (title.length > 512 || artist.length > 512) return;
        sendToMain('timedMetadataDidChange', {
          name: title,
          artistName: artist,
          albumName: album !== undefined && album.length <= 512 && !unsafeTimedText.test(album)
            ? album
            : undefined,
          trackId: catalogId ?? undefined,
          playParams: catalogId ? { catalogId, kind: 'song' } : undefined,
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
      reportNowPlaying({ item: mk.nowPlayingItem ?? null });
      reportPlaybackState({ state: mk.playbackState ?? (mk.isPlaying ? MusicKit.PlaybackStates.playing : 0) });
      sendToMain('playbackTimeDidChange', mk.currentPlaybackTime * 1_000_000);
      sendToMain('repeatModeDidChange', mk.repeatMode);
      sendToMain('shuffleModeDidChange', mk.shuffleMode);
      return reportCapabilities;
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
     * @param {() => void} reportCapabilities - Refreshes changed playback capabilities
     * @returns {void}
     */
    function attachVolume(mk, reportCapabilities) {
      /**
       * Last value sent over the volumeDidChange IPC channel, so the poll
       * below does not re-send a value the listener already reported.
       * @type {number}
       */
      let lastVolume = mk.volume;
      // Send the initial volume so MPRIS (and any other listener) receives the
      // real value immediately, not just on subsequent changes.
      sendToMain('volumeDidChange', lastVolume);
      // MusicKit publishes playbackVolumeDidChange, not volumeDidChange.
      // Sidra's separate IPC channel keeps the volumeDidChange name.
      mk.addEventListener('playbackVolumeDidChange', () => {
        lastVolume = mk.volume;
        sendToMain('volumeDidChange', mk.volume);
      });
      // Poll every 250 ms for volume changes that do not reach the listener.
      // The player bar's write path is unknown, so both reporting paths are necessary.
      volumePollTimer = setInterval(() => {
        reportCapabilities();
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
      // Claim the instance before attachment can throw, or the monitor adds duplicate listeners on each cycle.
      // attachSafely() logs partial attachment without retrying the same instance.
      window.__sidraHookedMk = mk;

      let generation = 0;
      let resumeGeneration = 0;
      let pendingStop = null;
      let stopped = false;
      let queueRequest = 0;
      let queueTask = Promise.resolve();
      let blockedQueue = null;
      function resetStop() {
        generation += 1;
        pendingStop = null;
        stopped = false;
      }
      resetStopForDocument = resetStop;
      function current(operationGeneration, pageGeneration) {
        return documentActive && window.__sidraHookedMk === mk &&
          generation === operationGeneration && documentGeneration === pageGeneration;
      }
      function stop(requestId) {
        if (!Number.isSafeInteger(requestId) || requestId <= 0) return Promise.resolve();
        if (pendingStop) return pendingStop;
        const operationGeneration = generation;
        const pageGeneration = documentGeneration;
        const task = Promise.resolve().then(async () => {
          if (!current(operationGeneration, pageGeneration)) return;
          if (!stopped) {
            mk.pause();
            if (mk.nowPlayingItem && effectiveDuration(mk) !== null && typeof mk.seekToTime === 'function') {
              let timeout;
              try {
                await Promise.race([
                  mk.seekToTime(0),
                  new Promise((_, reject) => {
                    timeout = setTimeout(() => reject(new Error('Stop seek timed out')), 5000);
                  }),
                ]);
              } finally {
                clearTimeout(timeout);
              }
            }
          }
          if (!current(operationGeneration, pageGeneration)) return;
          stopped = true;
          sendToMain('playbackStopped', { requestId, success: true });
        }).catch(() => {
          console.warn('[Sidra] failed to stop playback');
          if (current(operationGeneration, pageGeneration)) {
            sendToMain('playbackStopped', { requestId, success: false });
          }
        }).finally(() => {
          if (pendingStop === task) pendingStop = null;
        });
        pendingStop = task;
        return task;
      }
      function resume(toggle) {
        const operationGeneration = generation;
        const resumeToken = resumeGeneration;
        const pageGeneration = documentGeneration;
        const afterStop = pendingStop;
        const run = () => {
          if (resumeToken !== resumeGeneration || !current(operationGeneration, pageGeneration)) return;
          return toggle && !afterStop && !stopped && mk.isPlaying ? mk.pause() : mk.play();
        };
        try {
          return (afterStop ? afterStop.then(run) : Promise.resolve(run())).catch(() => {
            console.warn('[Sidra] failed to resume playback');
          });
        } catch (_) {
          console.warn('[Sidra] failed to resume playback');
          return Promise.resolve();
        }
      }

      // Stopping the previous poll comes first, so a throw in either attach
      // below cannot leave a second timer polling the replaced instance.
      stopVolumePoll();
      const reportCapabilities = attachPlaybackListeners(mk, resetStop);
      attachVolume(mk, reportCapabilities);

      /**
       * Control methods exposed to the preload script via window.postMessage.
       *
       * Assign only after listener attachment succeeds. A failure leaves the previous
       * hook object, or none on the first attachment, so the message listener checks it.
       *
       * @type {SidraHook}
       * @see {SidraHook} in src/types/hook.d.ts
       */
      window.__sidra = {
        openUri: async (uri) => {
          try {
            const url = new URL(uri);
            if (url.protocol !== 'https:' || !serviceHosts.has(url.hostname) ||
                url.origin !== window.location.origin || url.username || url.password ||
                !documentActive || window.__sidraHookedMk !== mk) return;
            if (blockedQueue) throw new Error('Queue replacement still pending');
            const request = ++queueRequest;
            const pageGeneration = documentGeneration;
            queueTask = queueTask.then(async () => {
              if (request !== queueRequest || pageGeneration !== documentGeneration ||
                  !documentActive || window.__sidraHookedMk !== mk) return;
              resetStop();
              await mk.setQueue({ url: url.href, startPlaying: true });
            }).catch(() => {
              console.warn('[Sidra] failed to open requested media');
            });
            let timeout;
            try {
              await Promise.race([
                queueTask,
                new Promise((_, reject) => {
                  timeout = setTimeout(() => {
                    if (!blockedQueue) {
                      // Keep the SDK operation serialised after callers stop waiting.
                      queueRequest += 1;
                      blockedQueue = queueTask;
                      blockedQueue.then(() => { blockedQueue = null; });
                    }
                    reject(new Error('Queue replacement timed out'));
                  }, 5000);
                }),
              ]);
            } finally {
              clearTimeout(timeout);
            }
          } catch (_) {
            console.warn('[Sidra] failed to open requested media');
          }
        },
        play:       () => resume(false),
        pause:      () => { resumeGeneration += 1; return mk.pause(); },
        stop,
        playPause:  () => resume(true),
        next:       () => mk.skipToNextItem(),
        previous:   () => mk.skipToPreviousItem(),
        seek:       (secs) => mk.seekToTime(secs),
        setVolume:  (v) => { mk.volume = v; },
        setRepeat:  (m) => { mk.repeatMode = m; },
        setShuffle: (m) => { mk.shuffleMode = m; },
      };
      sendToMain('hookReady', injectedDocumentGeneration);
    }

    /**
     * Attach to an instance, containing any failure.
     *
     * attachToInstance() claims the marker first, so the monitor does not retry partial attachment.
     * Log here because the monitor suppresses errors, and an initial failure must not prevent message and pointerover listener registration.
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

    /**
     * Allowed commands dispatched via window.postMessage from the
     * preload script. Must stay in sync with RECEIVE_CHANNELS in
     * src/preload.ts and keyof SidraHook in src/types/hook.d.ts.
     * @type {Set<string>}
     */
    const COMMANDS = new Set([
      'play', 'pause', 'stop', 'playPause', 'next', 'previous', 'openUri',
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
      // A failed initial attachment leaves no hook object, but this listener still runs.
      if (typeof window.__sidra?.[method] === 'function') {
        window.__sidra[method](...(args || []));
      }
    });
    attachSafely(mk);

    /**
     * Apply a fixed volume step per accumulated wheel notch. Both wheels and
     * touchpads report DOM_DELTA_PIXEL, so per-event scaling gives inconsistent steps.
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
     * Match the shared class on music.apple.com's div and Classical's amp-chrome-volume.
     * Element names differ, and Svelte scope hashes change between Apple builds.
     */
    const VOLUME_SELECTOR = '.chrome-volume';

    /**
     * The control the wheel listener is currently bound to, or null.
     * @type {Element | null}
     */
    let boundVolumeControl = null;

    /**
     * Change the volume when the wheel turns over the player bar volume
     * control. MusicKit's playbackVolumeDidChange event forwards mk.volume writes
     * through Sidra's volumeDidChange IPC channel.
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
     * Move the wheel listener from the previous volume control to the current one.
     * A non-passive listener on window or document makes every scroll wait for
     * Apple's busy main thread, even when the handler does not cancel the event.
     * Binding only to the control limits that cost to its bounds.
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
     * Navigation and service switches replace the control, so resolve it when the pointer arrives.
     * A passive pointerover listener leaves compositor scrolling available and avoids
     * the allocation cost of observing every DOM mutation.
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

    // MusicKit instance replacement raises no event, so compare the live instance with the marker.
    setInterval(() => {
      try {
        const currentMk = MusicKit.getInstance();
        if (currentMk !== window.__sidraHookedMk &&
            typeof currentMk.addEventListener === 'function') {
          attachSafely(currentMk);
          console.log('[Sidra] MusicKit re-hooked (instance replaced)');
        }
      } catch (_) {
        // Skip this cycle if MusicKit.getInstance() throws during re-initialisation.
      }
    }, 5000);
  }, 500);
})();
