// Apple's page makes MusicKit fetch a library playlist one page at a time before playback.
// A saved track list lets MusicKit build the same queue without those requests.
(function () {
  if (window.__sidraFastQueueInjected) return;
  window.__sidraFastQueueInjected = true;

  const DB_NAME = "sidra-fast-queue";
  const DB_VERSION = 2;
  const LISTS = "playlists";
  const SONGS = "songs";
  const PAGE_SIZE = 100;
  const FETCH_CONCURRENCY = 4;
  const REVALIDATE_INTERVAL_MS = 60000;
  // Saved data stays bounded however large a playlist is: recently used playlists only, for a
  // limited time, within a total size.
  const MAX_SAVED_LISTS = 20;
  const MAX_SAVED_BYTES = 5 * 1024 * 1024;
  const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const USAGE_SAVE_INTERVAL_MS = 60000;
  const USAGE_KEY = "__usage";
  const INSTALL_POLL_MS = 1000;
  const FILL_ATTEMPTS = 3;
  const FILL_RETRY_MS = 2000;
  // A request that fails for a moment is tried again, waiting twice as long each time.
  const RETRY_ATTEMPTS = 3;
  const RETRY_BASE_MS = 500;
  const SHUFFLE_SONGS = 1;
  const PLAYLIST_PATH = /\/library\/playlist\/(p\.[^/?#]+)/;
  // MusicKit keeps any request with an option this script does not understand.
  const HANDLED_OPTIONS = new Set([
    "context",
    "parameters",
    "playlists",
    "startPlaying",
    "startWith",
  ]);

  // A playlist is an ordered list of song IDs. Each song is kept once, however many saved
  // playlists use it, so a change to a playlist only touches the songs that changed.
  const lists = new Map();
  const songs = new Map();
  const songBytes = new Map();
  const usage = new Map();
  const refreshes = new Map();
  const installed = new WeakSet();
  let loaded = null;
  let usageSavedAt = 0;
  // Saves run one at a time, so a retried older save can never overwrite a newer one.
  let writeChain = Promise.resolve();
  // Late background work must not touch a queue that a newer request has replaced.
  let queueGeneration = 0;
  let accountGeneration = 0;
  let prewarmedPath = "";

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Runs requests in one transaction and resolves with the result of the last one. Storage is
  // an optimisation, so every failure resolves to undefined and never leaves a caller waiting.
  function withStore(mode, operation) {
    return new Promise((resolve) => {
      try {
        const open = indexedDB.open(DB_NAME, DB_VERSION);
        open.onupgradeneeded = (event) => {
          const db = open.result;
          for (const name of [LISTS, SONGS]) {
            if (!db.objectStoreNames || !db.objectStoreNames.contains(name)) {
              db.createObjectStore(name, { keyPath: "id" });
            }
          }
          // Version 1 saved whole lists in one record, which this version does not read.
          if (event && event.oldVersion === 1) open.transaction.objectStore(LISTS).clear();
        };
        open.onblocked = () => resolve(undefined);
        open.onerror = () => resolve(undefined);
        open.onsuccess = () => {
          const db = open.result;
          try {
            const tx = db.transaction([LISTS, SONGS], mode);
            const request = operation(tx.objectStore(LISTS), tx.objectStore(SONGS));
            if (!request) {
              db.close();
              resolve(undefined);
              return;
            }
            request.onerror = () => {
              db.close();
              resolve(undefined);
            };
            request.onsuccess = () => {
              db.close();
              resolve(request.result);
            };
          } catch (_) {
            db.close();
            resolve(undefined);
          }
        };
      } catch (_) {
        resolve(undefined);
      }
    });
  }

  async function withRetry(operation, account) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await operation();
      } catch (error) {
        if (attempt >= RETRY_ATTEMPTS || account !== accountGeneration) throw error;
        await delay(RETRY_BASE_MS * 2 ** (attempt - 1));
        if (account !== accountGeneration) throw error;
      }
    }
  }

  // Saving never holds up a caller. A write that fails is tried again, and one queued before a
  // sign-out is dropped, so nothing is saved for an account that has gone.
  function enqueueWrite(account, operation) {
    writeChain = writeChain.then(async () => {
      for (let attempt = 1; attempt <= RETRY_ATTEMPTS; attempt += 1) {
        if (account !== accountGeneration) return;
        if ((await withStore("readwrite", operation)) !== undefined) return;
        if (attempt < RETRY_ATTEMPTS) await delay(RETRY_BASE_MS * 2 ** (attempt - 1));
      }
      console.warn("[Sidra] failed to save playlist tracks");
    });
    return writeChain;
  }

  function byteSize(value) {
    return JSON.stringify(value).length;
  }

  function referencedSongs() {
    const ids = new Set();
    for (const list of lists.values()) for (const id of list.order) ids.add(id);
    return ids;
  }

  // Removes songs no saved playlist uses any more, so nothing is left behind.
  function dropUnreferenced() {
    const used = referencedSongs();
    const gone = [];
    for (const id of songs.keys()) if (!used.has(id)) gone.push(id);
    for (const id of gone) {
      songs.delete(id);
      songBytes.delete(id);
    }
    return gone;
  }

  function savedBytes() {
    let total = 0;
    for (const bytes of songBytes.values()) total += bytes;
    for (const list of lists.values()) total += list.order.join(",").length;
    return total;
  }

  function loadSaved() {
    if (!loaded) {
      loaded = (async () => {
        let listRequest;
        const savedSongs = await withStore("readonly", (listStore, songStore) => {
          listRequest = listStore.getAll();
          return songStore.getAll();
        });
        if (!savedSongs || !listRequest) return;
        for (const item of savedSongs) {
          if (songs.has(item.id)) continue;
          songs.set(item.id, item);
          songBytes.set(item.id, byteSize(item));
        }
        const unusable = [];
        for (const record of listRequest.result || []) {
          if (record.id === USAGE_KEY) {
            for (const [id, time] of Object.entries(record.used || {})) {
              if (!usage.has(id)) usage.set(id, time);
            }
          } else if (
            Array.isArray(record.order) &&
            record.order.every((id) => songs.has(id)) &&
            !lists.has(record.id)
          ) {
            lists.set(record.id, { id: record.id, version: record.version, order: record.order, checkedAt: 0 });
          } else {
            unusable.push(record.id);
          }
        }
        for (const id of [...usage.keys()]) if (!lists.has(id)) usage.delete(id);
        const gone = dropUnreferenced();
        if (gone.length > 0 || unusable.length > 0) {
          void withStore("readwrite", (listStore, songStore) => {
            let last;
            for (const id of gone) last = songStore.delete(id);
            for (const id of unusable) last = listStore.delete(id);
            return last;
          });
        }
      })();
    }
    return loaded;
  }

  async function saveUsage() {
    await loadSaved();
    usageSavedAt = Date.now();
    await withStore("readwrite", (listStore) =>
      listStore.put({ id: USAGE_KEY, used: Object.fromEntries(usage) }),
    );
  }

  // Playing records use in a small record of its own, so it never rewrites a playlist.
  function markUsed(id) {
    if (!lists.has(id)) return;
    usage.set(id, Date.now());
    if (Date.now() - usageSavedAt >= USAGE_SAVE_INTERVAL_MS) void saveUsage();
  }

  // The playlist just saved is never the one removed.
  function evict(keep) {
    const rank = (id) => (id === keep ? Infinity : usage.get(id) || 0);
    const evicted = [];
    const remove = (id) => {
      lists.delete(id);
      usage.delete(id);
      evicted.push(id);
    };
    const ranked = [...lists.keys()].sort((a, b) => rank(b) - rank(a));
    for (const [index, id] of ranked.entries()) {
      if (id === keep) continue;
      if (index >= MAX_SAVED_LISTS || Date.now() - (usage.get(id) || 0) > MAX_AGE_MS) remove(id);
    }
    const gone = dropUnreferenced();
    while (savedBytes() > MAX_SAVED_BYTES) {
      const victim = [...lists.keys()].filter((id) => id !== keep).sort((a, b) => rank(a) - rank(b))[0];
      if (victim === undefined) break;
      remove(victim);
      gone.push(...dropUnreferenced());
    }
    return { evicted, gone };
  }

  // Saves a playlist by writing only what changed: songs that are new or different, the
  // order, and the removal of songs nothing uses any more. Returns false when it is too large.
  function saveList(id, version, items) {
    const account = accountGeneration;
    const order = items.map((item) => item.id);
    const changed = new Map();
    let incoming = order.join(",").length;
    for (const item of items) {
      if (changed.has(item.id)) continue;
      const known = songs.get(item.id);
      const text = JSON.stringify(item);
      if (!known || JSON.stringify(known) !== text) changed.set(item.id, item);
      incoming += text.length;
    }
    if (incoming > MAX_SAVED_BYTES) {
      if (lists.delete(id)) {
        usage.delete(id);
        const gone = dropUnreferenced();
        enqueueWrite(account, (listStore, songStore) => {
          for (const songId of gone) songStore.delete(songId);
          listStore.delete(id);
          return listStore.put({ id: USAGE_KEY, used: Object.fromEntries(usage) });
        });
      }
      return false;
    }
    for (const [songId, item] of changed) {
      songs.set(songId, item);
      songBytes.set(songId, byteSize(item));
    }
    lists.set(id, { id, version, order, checkedAt: Date.now() });
    usage.set(id, Date.now());
    const { evicted, gone } = evict(id);
    gone.push(...dropUnreferenced());
    usageSavedAt = Date.now();
    const used = Object.fromEntries(usage);
    enqueueWrite(account, (listStore, songStore) => {
      for (const item of changed.values()) songStore.put(item);
      for (const songId of gone) songStore.delete(songId);
      for (const evictedId of evicted) listStore.delete(evictedId);
      listStore.put({ id: USAGE_KEY, used });
      return listStore.put({ id, version, order });
    });
    return true;
  }

  function savedItems(list) {
    return list.order.map((songId) => songs.get(songId));
  }

  function forgetSavedLists() {
    accountGeneration += 1;
    queueGeneration += 1;
    lists.clear();
    songs.clear();
    songBytes.clear();
    usage.clear();
    writeChain = writeChain.then(() =>
      withStore("readwrite", (listStore, songStore) => {
        songStore.clear();
        return listStore.clear();
      }),
    );
    return writeChain;
  }

  // MusicKit drops tracks without play parameters, which would shift later queue positions.
  function isPlayable(item) {
    return Boolean(item && item.attributes && item.attributes.playParams);
  }

  async function fetchTracks(mk, id, account, retry) {
    const path = `/v1/me/library/playlists/${id}/tracks`;
    const page = (offset) => {
      const request = () => mk.api.music(path, { limit: PAGE_SIZE, offset });
      return retry ? withRetry(request, account) : request();
    };
    const first = await page(0);
    const total = (first.data.meta && first.data.meta.total) || 0;
    const offsets = [];
    for (let offset = PAGE_SIZE; offset < total; offset += PAGE_SIZE) {
      offsets.push(offset);
    }
    const pages = new Array(offsets.length);
    let next = 0;
    const workers = Array.from({ length: FETCH_CONCURRENCY }, async () => {
      while (next < offsets.length) {
        const index = next++;
        const response = await page(offsets[index]);
        pages[index] = response.data.data;
      }
    });
    await Promise.all(workers);
    return [first.data.data, ...pages].flat().filter(isPlayable);
  }

  async function fetchVersion(mk, id) {
    const path = `/v1/me/library/playlists/${id}`;
    const [playlist, tracks] = await Promise.all([
      mk.api.music(path),
      mk.api.music(`${path}/tracks`, { limit: 1 }),
    ]);
    const modified = playlist.data.data[0].attributes.lastModifiedDate;
    return `${modified}:${tracks.data.meta && tracks.data.meta.total}`;
  }

  // A failed check keeps the saved list, which is better than a slow start while offline.
  async function isUpToDate(mk, id, version) {
    try {
      return (await fetchVersion(mk, id)) === version;
    } catch (_) {
      return true;
    }
  }

  function refresh(mk, id, retry = true) {
    if (refreshes.has(id)) return refreshes.get(id);
    const account = accountGeneration;
    const run = (async () => {
      await loadSaved();
      const cached = lists.get(id);
      if (cached && Date.now() - cached.checkedAt < REVALIDATE_INTERVAL_MS) {
        markUsed(id);
        return { version: cached.version, items: savedItems(cached) };
      }
      if (cached) cached.checkedAt = Date.now();
      const attempt = (operation) => (retry ? withRetry(operation, account) : operation());
      const version = await attempt(() => fetchVersion(mk, id));
      if (cached && cached.version === version) {
        markUsed(id);
        return { version, items: savedItems(cached) };
      }
      const items = await fetchTracks(mk, id, account, retry);
      if (account !== accountGeneration) return undefined;
      saveList(id, version, items);
      return { version, items };
    })().finally(() => refreshes.delete(id));
    refreshes.set(id, run);
    return run;
  }

  function refreshQuietly(mk, id, retry = true) {
    return refresh(mk, id, retry).catch(() => {
      console.warn("[Sidra] failed to refresh playlist tracks");
      return undefined;
    });
  }

  function shuffleInPlace(items) {
    for (let i = items.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [items[i], items[j]] = [items[j], items[i]];
    }
    return items;
  }

  function isLibraryPlaylistRequest(options) {
    if (!options || typeof options !== "object") return false;
    const { playlists, startPlaying, startWith } = options;
    if (startPlaying === false) return false;
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

  // `attempt` records what already ran, so a request is never sent to MusicKit twice once
  // it has produced a queue or has failed on the original path.
  async function startQueue(mk, setQueue, options, items, startId, attempt) {
    const { playlists: _playlists, startWith: _startWith, ...rest } = options;
    const request = { ...rest, items: structuredClone(items) };
    if (startId) request.startWith = startId;
    const queue = await setQueue(request);
    if (mk.queue && mk.queue.length === 0) throw new Error("empty queue");
    attempt.queued = true;
    return queue;
  }

  function standardQueue(setQueue, options, attempt) {
    attempt.standard = true;
    return setQueue(options);
  }

  async function queueRemainder(mk, id, first, shuffled, generation) {
    for (let attempt = 0; attempt < FILL_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await delay(FILL_RETRY_MS);
      if (generation !== queueGeneration) return;
      const entry = await refreshQuietly(mk, id, false);
      if (generation !== queueGeneration) return;
      if (!entry) continue;
      const index = entry.items.findIndex((item) => item.id === first.id);
      let remainder = entry.items.slice(index + 1);
      if (shuffled) {
        remainder = entry.items.slice();
        if (index >= 0) remainder.splice(index, 1);
        shuffleInPlace(remainder);
      }
      if (remainder.length === 0) return;
      try {
        await mk.playLater({ items: structuredClone(remainder) });
        return;
      } catch (_) {
        console.warn("[Sidra] failed to queue remaining playlist tracks");
      }
    }
  }

  async function startWithoutSavedList(mk, setQueue, options, id, songId, generation, attempt) {
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
    const queue = await startQueue(
      mk,
      setQueue,
      options,
      [first],
      shuffled ? undefined : first.id,
      attempt,
    );
    queueRemainder(mk, id, first, shuffled, generation).catch(() => {
      console.warn("[Sidra] failed to queue remaining playlist tracks");
    });
    return queue;
  }

  async function startPlaylist(mk, setQueue, options, generation, attempt) {
    const id = options.playlists[0];
    const songId =
      options.startWith && options.startWith.type === "songs"
        ? options.startWith.id
        : undefined;
    const shuffled = mk.shuffleMode === SHUFFLE_SONGS;
    // MusicKit ignores startWith while shuffle is on. Apple's page turns shuffle off before a
    // song click, so this is rare, and Apple's path is the one that can honour it.
    if (songId && shuffled) {
      void refreshQuietly(mk, id);
      return standardQueue(setQueue, options, attempt);
    }
    await loadSaved();
    if (generation !== queueGeneration) return mk.queue;
    const cached = lists.get(id);
    if (!cached || cached.order.length === 0) {
      return startWithoutSavedList(mk, setQueue, options, id, songId, generation, attempt);
    }

    // MusicKit keeps one copy of an item ID it is given, but Apple's own queue keeps repeats.
    if (new Set(cached.order).size !== cached.order.length) {
      void refreshQuietly(mk, id);
      return standardQueue(setQueue, options, attempt);
    }
    // A list that has changed since it was saved could queue a removed song or miss a new
    // one, so that play uses Apple's path and the list is refreshed for the next one.
    const upToDate = await isUpToDate(mk, id, cached.version);
    if (generation !== queueGeneration) return mk.queue;
    if (!upToDate) {
      cached.checkedAt = 0;
      void refreshQuietly(mk, id);
      return standardQueue(setQueue, options, attempt);
    }
    cached.checkedAt = Date.now();
    markUsed(id);
    // A song added since the list was saved is not in it, so Apple's path has to play it.
    if (songId && !cached.order.includes(songId)) {
      return standardQueue(setQueue, options, attempt);
    }
    const startId = songId || (shuffled ? undefined : cached.order[0]);
    return startQueue(mk, setQueue, options, savedItems(cached), startId, attempt);
  }

  function install(mk) {
    if (installed.has(mk) || typeof mk.setQueue !== "function") return;
    installed.add(mk);
    const setQueue = mk.setQueue.bind(mk);
    mk.setQueue = function (options) {
      queueGeneration += 1;
      if (!isLibraryPlaylistRequest(options)) return setQueue(options);
      const generation = queueGeneration;
      const attempt = { queued: false, standard: false };
      return startPlaylist(mk, setQueue, options, generation, attempt).catch((error) => {
        // Once a queue exists, or the original path has failed, a second request would
        // replace a working queue or repeat a failure.
        if (attempt.queued || attempt.standard) {
          if (attempt.standard) throw error;
          return mk.queue;
        }
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
    if (typeof mk.unauthorize === "function") {
      const unauthorize = mk.unauthorize.bind(mk);
      mk.unauthorize = function (...args) {
        void forgetSavedLists();
        return unauthorize(...args);
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
    const path = window.location.pathname;
    if (path === prewarmedPath) return;
    prewarmedPath = path;
    const match = PLAYLIST_PATH.exec(path);
    if (match) void refreshQuietly(mk, match[1]);
  }, INSTALL_POLL_MS);
})();
