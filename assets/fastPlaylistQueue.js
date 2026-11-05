// Start library playlists immediately. Apple's page makes MusicKit fetch every track, one
// page at a time, before playback begins: about 25 seconds for 1,800 songs. Keeping a local
// copy of the track list lets MusicKit build the same queue in milliseconds.
(function () {
  // SPA navigation re-injects this script, so one document must install it only once.
  if (window.__sidraFastQueueInjected) return;
  window.__sidraFastQueueInjected = true;

  const DB_NAME = "sidra-fast-queue";
  const STORE_NAME = "playlists";
  const PAGE_SIZE = 100;
  const FETCH_CONCURRENCY = 4;
  const REVALIDATE_INTERVAL_MS = 60000;
  const INSTALL_POLL_MS = 1000;
  const SHUFFLE_PIN_POLL_MS = 20;
  const SHUFFLE_PIN_TIMEOUT_MS = 8000;
  const SHUFFLE_SONGS = 1;
  const PLAYLIST_PATH = /\/library\/playlist\/(p\.[^/?#]+)/;
  // Any other option is a request this script does not understand, so MusicKit keeps it.
  const HANDLED_OPTIONS = new Set([
    "context",
    "parameters",
    "playlists",
    "startPlaying",
    "startWith",
  ]);

  /** @type {Map<string, { id: string, version: string, items: object[] }>} */
  const memory = new Map();
  /** @type {Map<string, Promise<object>>} */
  const refreshes = new Map();
  /** @type {Map<string, number>} */
  const lastChecked = new Map();
  const installed = new WeakSet();
  // Each queue request supersedes earlier ones, so late background work must not touch the queue.
  let queueGeneration = 0;
  let prewarmedPath = "";

  /**
   * Run one IndexedDB request. Storage is an optimisation, so failures resolve to undefined.
   * @param {IDBTransactionMode} mode - Transaction mode
   * @param {(store: IDBObjectStore) => IDBRequest} operation - Request to run
   * @returns {Promise<any>} The request result, or undefined
   */
  function withStore(mode, operation) {
    return new Promise((resolve) => {
      try {
        const open = indexedDB.open(DB_NAME, 1);
        open.onupgradeneeded = () => {
          open.result.createObjectStore(STORE_NAME, { keyPath: "id" });
        };
        open.onerror = () => resolve(undefined);
        open.onsuccess = () => {
          const db = open.result;
          const request = operation(
            db.transaction(STORE_NAME, mode).objectStore(STORE_NAME),
          );
          request.onerror = () => {
            db.close();
            resolve(undefined);
          };
          request.onsuccess = () => {
            db.close();
            resolve(request.result);
          };
        };
      } catch (_) {
        resolve(undefined);
      }
    });
  }

  /**
   * Read a playlist's saved track list.
   * @param {string} id - Library playlist ID
   * @returns {Promise<{ id: string, version: string, items: object[] } | undefined>}
   */
  async function readCached(id) {
    if (memory.has(id)) return memory.get(id);
    const saved = await withStore("readonly", (store) => store.get(id));
    if (saved && !memory.has(id)) memory.set(id, saved);
    return memory.get(id);
  }

  /**
   * MusicKit drops tracks without play parameters, which would shift later queue positions.
   * @param {object} item - Library track resource
   * @returns {boolean}
   */
  function isPlayable(item) {
    return Boolean(item && item.attributes && item.attributes.playParams);
  }

  /**
   * Fetch a playlist's tracks with a few parallel page requests.
   * @param {object} mk - The MusicKit instance
   * @param {string} id - Library playlist ID
   * @returns {Promise<object[]>} Playable tracks in playlist order
   */
  async function fetchTracks(mk, id) {
    const path = `/v1/me/library/playlists/${id}/tracks`;
    const first = await mk.api.music(path, { limit: PAGE_SIZE, offset: 0 });
    const total = (first.data.meta && first.data.meta.total) || 0;
    const offsets = [];
    for (let offset = PAGE_SIZE; offset < total; offset += PAGE_SIZE) {
      offsets.push(offset);
    }
    const pages = new Array(offsets.length);
    let next = 0;
    const workers = Array.from({ length: FETCH_CONCURRENCY }, async () => {
      while (next < offsets.length) {
        const page = next++;
        const response = await mk.api.music(path, {
          limit: PAGE_SIZE,
          offset: offsets[page],
        });
        pages[page] = response.data.data;
      }
    });
    await Promise.all(workers);
    return [first.data.data, ...pages].flat().filter(isPlayable);
  }

  /**
   * Identify a playlist's current contents without fetching its tracks.
   * @param {object} mk - The MusicKit instance
   * @param {string} id - Library playlist ID
   * @returns {Promise<string>} A value that changes when the playlist changes
   */
  async function fetchVersion(mk, id) {
    const path = `/v1/me/library/playlists/${id}`;
    const [playlist, tracks] = await Promise.all([
      mk.api.music(path),
      mk.api.music(`${path}/tracks`, { limit: 1 }),
    ]);
    const modified = playlist.data.data[0].attributes.lastModifiedDate;
    return `${modified}:${tracks.data.meta && tracks.data.meta.total}`;
  }

  /**
   * Bring a saved track list up to date, sharing work between concurrent callers.
   * @param {object} mk - The MusicKit instance
   * @param {string} id - Library playlist ID
   * @returns {Promise<{ id: string, version: string, items: object[] }>}
   */
  function refresh(mk, id) {
    if (refreshes.has(id)) return refreshes.get(id);
    const run = (async () => {
      const cached = await readCached(id);
      const checked = lastChecked.get(id) || 0;
      if (cached && Date.now() - checked < REVALIDATE_INTERVAL_MS) return cached;
      lastChecked.set(id, Date.now());
      const version = await fetchVersion(mk, id);
      if (cached && cached.version === version) return cached;
      const entry = { id, version, items: await fetchTracks(mk, id) };
      memory.set(id, entry);
      await withStore("readwrite", (store) => store.put(entry));
      return entry;
    })().finally(() => refreshes.delete(id));
    refreshes.set(id, run);
    return run;
  }

  /**
   * Refresh in the background, where a failure only means the saved list stays as it is.
   * @param {object} mk - The MusicKit instance
   * @param {string} id - Library playlist ID
   * @returns {Promise<object | undefined>}
   */
  function refreshQuietly(mk, id) {
    return refresh(mk, id).catch(() => {
      console.warn("[Sidra] failed to refresh playlist tracks");
      return undefined;
    });
  }

  /**
   * @param {object[]} items - Items to shuffle in place
   * @returns {object[]} The same array
   */
  function shuffleInPlace(items) {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  /**
   * @param {unknown} options - Options passed to setQueue
   * @returns {boolean} Whether this is a request to play one whole library playlist
   */
  function isLibraryPlaylistRequest(options) {
    if (!options || typeof options !== "object") return false;
    const { playlists, startWith } = options;
    if (!Object.keys(options).every((key) => HANDLED_OPTIONS.has(key))) return false;
    if (!Array.isArray(playlists) || playlists.length !== 1) return false;
    if (typeof playlists[0] !== "string" || !playlists[0].startsWith("p.")) return false;
    if (startWith === undefined) return true;
    return (
      Boolean(startWith) &&
      typeof startWith.id === "string" &&
      (startWith.type === "songs" || startWith.type === "playlists")
    );
  }

  /**
   * Start a queue on one song, keeping the user's shuffle setting.
   *
   * MusicKit ignores the requested song when shuffle is already on, and loses it when shuffle
   * turns on before that song loads. Turning shuffle on once the song is current keeps it
   * playing, puts every other track after it, and lets shuffle-off restore playlist order.
   *
   * @param {object} mk - The MusicKit instance
   * @param {(options: object) => Promise<any>} setQueue - The original setQueue
   * @param {object} options - Original request options
   * @param {object[]} items - Queue items
   * @param {string} startId - Library song ID to start on
   * @returns {Promise<any>} The setQueue result
   */
  async function startQueue(mk, setQueue, options, items, startId) {
    const { playlists: _playlists, startWith: _startWith, ...rest } = options;
    const request = { ...rest, items: structuredClone(items), startWith: startId };
    if (mk.shuffleMode !== SHUFFLE_SONGS) return setQueue(request);

    mk.shuffleMode = 0;
    let queue;
    try {
      queue = await setQueue(request);
      const playing = mk.play();
      const deadline = Date.now() + SHUFFLE_PIN_TIMEOUT_MS;
      while (
        !(mk.nowPlayingItem && mk.nowPlayingItem.id === startId) &&
        Date.now() < deadline
      ) {
        await new Promise((resolve) => setTimeout(resolve, SHUFFLE_PIN_POLL_MS));
      }
      mk.shuffleMode = SHUFFLE_SONGS;
      await playing;
    } finally {
      mk.shuffleMode = SHUFFLE_SONGS;
    }
    return queue;
  }

  /**
   * Start a playlist with no saved track list: play one song now and queue the rest behind it.
   * @param {object} mk - The MusicKit instance
   * @param {(options: object) => Promise<any>} setQueue - The original setQueue
   * @param {object} options - Original request options
   * @param {string} id - Library playlist ID
   * @param {string | undefined} songId - Requested song, if any
   * @param {number} generation - This request's queue generation
   * @returns {Promise<any>} The setQueue result
   */
  async function startWithoutSavedList(mk, setQueue, options, id, songId, generation) {
    const shuffled = mk.shuffleMode === SHUFFLE_SONGS;
    let candidates;
    if (songId) {
      const song = await mk.api.music(`/v1/me/library/songs/${songId}`);
      candidates = song.data.data;
    } else {
      const page = await mk.api.music(`/v1/me/library/playlists/${id}/tracks`, {
        limit: PAGE_SIZE,
        offset: 0,
      });
      candidates = page.data.data;
    }
    const playable = candidates.filter(isPlayable);
    if (playable.length === 0) throw new Error("no playable track");
    if (generation !== queueGeneration) return mk.queue;
    const first = shuffled
      ? playable[Math.floor(Math.random() * playable.length)]
      : playable[0];
    const queue = await startQueue(mk, setQueue, options, [first], first.id);

    void refreshQuietly(mk, id).then((entry) => {
      if (!entry || generation !== queueGeneration) return;
      const index = entry.items.findIndex((item) => item.id === first.id);
      const rest = shuffled
        ? shuffleInPlace(entry.items.filter((item) => item.id !== first.id))
        : entry.items.slice(index + 1);
      if (rest.length > 0) return mk.playLater({ items: structuredClone(rest) });
      return undefined;
    }).catch(() => {
      console.warn("[Sidra] failed to queue remaining playlist tracks");
    });
    return queue;
  }

  /**
   * Serve a library playlist request from the saved list where possible.
   * @param {object} mk - The MusicKit instance
   * @param {(options: object) => Promise<any>} setQueue - The original setQueue
   * @param {object} options - Original request options
   * @param {number} generation - This request's queue generation
   * @returns {Promise<any>} The setQueue result
   */
  async function startPlaylist(mk, setQueue, options, generation) {
    const id = options.playlists[0];
    const songId =
      options.startWith && options.startWith.type === "songs"
        ? options.startWith.id
        : undefined;
    const cached = await readCached(id);
    if (generation !== queueGeneration) return mk.queue;
    if (!cached || cached.items.length === 0) {
      return startWithoutSavedList(mk, setQueue, options, id, songId, generation);
    }

    void refreshQuietly(mk, id);
    const { items } = cached;
    // A song added elsewhere is missing from the saved list, so Apple's slower path must play it.
    if (songId && !items.some((item) => item.id === songId)) {
      lastChecked.delete(id);
      return setQueue(options);
    }
    const startId =
      songId ||
      (mk.shuffleMode === SHUFFLE_SONGS
        ? items[Math.floor(Math.random() * items.length)].id
        : items[0].id);
    return startQueue(mk, setQueue, options, items, startId);
  }

  /**
   * Wrap a MusicKit instance's queue methods.
   * @param {object} mk - The MusicKit instance
   * @returns {void}
   */
  function install(mk) {
    if (installed.has(mk) || typeof mk.setQueue !== "function") return;
    installed.add(mk);
    const setQueue = mk.setQueue.bind(mk);
    mk.setQueue = function (options) {
      queueGeneration += 1;
      if (!isLibraryPlaylistRequest(options)) return setQueue(options);
      const generation = queueGeneration;
      return startPlaylist(mk, setQueue, options, generation).catch(() => {
        console.warn("[Sidra] fast playlist start failed, using the standard queue");
        return generation === queueGeneration ? setQueue(options) : mk.queue;
      });
    };
    if (typeof mk.setStationQueue === "function") {
      const setStationQueue = mk.setStationQueue.bind(mk);
      mk.setStationQueue = function (options) {
        queueGeneration += 1;
        return setStationQueue(options);
      };
    }
  }

  // MusicKit can replace its instance without a new document, so keep checking for it.
  setInterval(() => {
    if (!window.MusicKit) return;
    let mk;
    try {
      mk = window.MusicKit.getInstance();
    } catch (_) {
      return;
    }
    if (!mk) return;
    install(mk);
    // Prepare the list when a playlist opens, so even its first play has a full queue.
    const path = window.location.pathname;
    if (path === prewarmedPath) return;
    prewarmedPath = path;
    const match = PLAYLIST_PATH.exec(path);
    if (match) void refreshQuietly(mk, match[1]);
  }, INSTALL_POLL_MS);
})();
