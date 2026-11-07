// Apple's page makes MusicKit fetch a library playlist one page at a time before playback.
// A saved track list lets MusicKit build the same queue without those requests.
(function () {
  if (window.__sidraFastQueueInjected) return;
  window.__sidraFastQueueInjected = true;

  const PAGE_SIZE = 100;
  const FETCH_CONCURRENCY = 8;
  // Saved data stays bounded: the newest playlists only, within a size and an age.
  const MAX_LISTS = 20;
  const MAX_BYTES = 5 * 1024 * 1024;
  const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
  const STORAGE_TIMEOUT_MS = 3000;
  const PLAYLIST_PATH = /\/library\/playlist\/(p\.[^/?#]+)/;
  // MusicKit keeps any request with an option this script does not understand.
  const HANDLED_OPTIONS = new Set(["context", "parameters", "playlists", "startPlaying", "startWith"]);

  const inflight = new Map();
  const tooLarge = new Set();
  const installed = new WeakSet();
  let database;
  let pruned;
  // A newer queue request, or a sign-out, ends work that was started for an older one.
  let queueGeneration = 0;
  let accountGeneration = 0;
  let prewarmedPath = "";

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // A request that fails is tried once more, because one failure should not cost the fast start.
  const retry = (request) => request().catch(request);
  // MusicKit returns an HTTP error as a body instead of throwing. That is a failure to retry, except
  // the 404 Apple gives for a playlist with no tracks.
  const ok = ({ data }) => {
    if (data.errors && data.errors[0].status !== "404") throw new Error("request failed");
    return data;
  };

  function openDatabase() {
    database ||= new Promise((resolve) => {
      // A failed open is not remembered, so the next call tries again.
      const fail = () => {
        database = undefined;
        resolve();
      };
      try {
        const open = indexedDB.open("sidra-fast-queue", 3);
        open.onupgradeneeded = () => {
          for (const name of [...open.result.objectStoreNames]) open.result.deleteObjectStore(name);
          for (const name of ["meta", "lists"]) open.result.createObjectStore(name, { keyPath: "id" });
        };
        open.onsuccess = () => {
          const db = open.result;
          // A newer version, or cleared site data, ends this connection; the next call opens again.
          db.onclose = () => (database = undefined);
          db.onversionchange = () => {
            db.close();
            database = undefined;
          };
          resolve(db);
        };
        open.onerror = open.onblocked = fail;
      } catch (_) {
        fail();
      }
    });
    return database;
  }

  // Runs `work` in one transaction and resolves with `{ value }` once it has committed, or with
  // undefined when storage is missing, fails or does not answer in time. Storage is an
  // optimisation, so nothing here ever rejects or leaves a caller waiting.
  function withStore(mode, work) {
    const run = openDatabase().then(
      (db) =>
        db &&
        new Promise((resolve) => {
          let tx;
          try {
            tx = db.transaction(["meta", "lists"], mode);
            const value = work(tx.objectStore("meta"), tx.objectStore("lists"));
            tx.oncomplete = () => resolve({ value });
            tx.onabort = tx.onerror = () => resolve();
          } catch (_) {
            // Never leave a half-written transaction to commit.
            tx?.abort();
            resolve();
          }
        }),
    );
    return Promise.race([run, wait(STORAGE_TIMEOUT_MS)]);
  }

  // Keeps the newest playlists within the limits. `keep` is never removed.
  function prune(meta, lists, keep) {
    const request = meta.getAll();
    request.onsuccess = () => {
      let count = 0;
      let bytes = 0;
      const newest = request.result.sort(
        (a, b) => (b.id === keep) - (a.id === keep) || (b.saved || 0) - (a.saved || 0),
      );
      for (const { id, saved = 0, size = 0 } of newest) {
        // The age is absolute, so a clock that moved backwards cannot make a record immortal.
        const stale = Math.abs(Date.now() - saved) > MAX_AGE_MS;
        if (id !== keep && (stale || count >= MAX_LISTS || bytes + size > MAX_BYTES)) {
          meta.delete(id);
          lists.delete(id);
        } else {
          count += 1;
          bytes += size;
        }
      }
    };
    return request;
  }

  async function readSaved(id) {
    pruned ||= withStore("readwrite", (meta, lists) => prune(meta, lists));
    const read = await withStore("readonly", (meta, lists) => [meta.get(id), lists.get(id)]);
    const [meta, list] = read ? read.value.map((request) => request.result) : [];
    return meta && list && Array.isArray(list.items) ? { version: meta.version, items: list.items } : undefined;
  }

  function saveList(id, version, items) {
    const size = new TextEncoder().encode(JSON.stringify(items)).length;
    if (size > MAX_BYTES) return tooLarge.add(id);
    void withStore("readwrite", (meta, lists) => {
      meta.put({ id, version, saved: Date.now(), size });
      lists.put({ id, items });
      return prune(meta, lists, id);
    });
  }

  // Signing out must leave nothing behind, so a clear that does not commit is tried again.
  async function clearSaved() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const cleared = await withStore("readwrite", (meta, lists) => (meta.clear(), lists.clear()));
      if (cleared) return;
      await wait(500);
    }
    console.warn("[Sidra] failed to delete saved playlist tracks");
  }

  // MusicKit drops tracks without play parameters, which would shift later queue positions.
  const isPlayable = (item) => Boolean(item && item.attributes && item.attributes.playParams);

  // Throws unless every track was fetched, so a partial list is never queued or saved.
  async function fetchTracks(mk, id) {
    const path = `/v1/me/library/playlists/${id}/tracks`;
    const page = (offset) => retry(async () => ok(await mk.api.music(path, { limit: PAGE_SIZE, offset })));
    const first = await page(0);
    const total = (first.meta && first.meta.total) || 0;
    if (!total && first.next) throw new Error("playlist size unknown");
    const pages = [first.data];
    const offsets = [];
    for (let offset = PAGE_SIZE; offset < total; offset += PAGE_SIZE) offsets.push(offset);
    const workers = Array.from({ length: FETCH_CONCURRENCY }, async () => {
      while (offsets.length) {
        const offset = offsets.shift();
        try {
          pages[offset / PAGE_SIZE] = (await page(offset)).data;
        } catch (error) {
          offsets.length = 0; // one failed page ends the fetch, so the others stop asking
          throw error;
        }
      }
    });
    await Promise.all(workers);
    // A page without a track list, such as an error body, counts for nothing.
    const all = pages.filter(Array.isArray).flat();
    if (all.length < total) throw new Error("playlist incomplete");
    return all.filter(isPlayable);
  }

  function fetchVersion(mk, id) {
    const path = `/v1/me/library/playlists/${id}`;
    return retry(async () => {
      const [playlist, tracks] = (
        await Promise.all([mk.api.music(path), mk.api.music(`${path}/tracks`, { limit: 1 })])
      ).map(ok);
      const { lastModifiedDate } = playlist.data[0].attributes;
      // Without a modified date a change could never be seen.
      if (!lastModifiedDate) throw new Error("playlist has no modified date");
      return `${lastModifiedDate}:${(tracks.meta && tracks.meta.total) || 0}`;
    });
  }

  // The complete, current playable tracks of a playlist: the saved list when the playlist has
  // not changed, otherwise a fresh fetch that is saved for the next play.
  function currentList(mk, id) {
    const account = accountGeneration;
    const key = `${account}:${id}`;
    if (!inflight.has(key)) {
      const run = (async () => {
        const [saved, version] = await Promise.all([readSaved(id), fetchVersion(mk, id)]);
        if (saved && saved.version === version) return saved.items;
        const items = await fetchTracks(mk, id);
        if (account === accountGeneration) saveList(id, version, items);
        return items;
      })().finally(() => inflight.delete(key));
      inflight.set(key, run);
    }
    return inflight.get(key);
  }

  function isLibraryPlaylistRequest(options) {
    if (!options || typeof options !== "object" || options.startPlaying === false) return false;
    if (!Object.keys(options).every((key) => HANDLED_OPTIONS.has(key))) return false;
    const { playlists, startWith } = options;
    if (!Array.isArray(playlists) || playlists.length !== 1) return false;
    if (typeof playlists[0] !== "string" || !playlists[0].startsWith("p.")) return false;
    return (
      startWith === undefined ||
      (Boolean(startWith) && typeof startWith.id === "string" && ["songs", "playlists"].includes(startWith.type))
    );
  }

  // Apple's own request runs for anything this script cannot queue exactly as Apple would. It
  // is sent at most once more, and only after the fast request threw or built an empty queue.
  async function startPlaylist(mk, setQueue, options, generation) {
    const { playlists, startWith, ...rest } = options;
    const songId = startWith && startWith.type === "songs" ? startWith.id : undefined;
    const shuffled = () => mk.shuffleMode === 1;
    // MusicKit ignores startWith while shuffle is on, and only Apple's request can honour it.
    if (songId && shuffled()) return setQueue(options);
    let items;
    try {
      items = await currentList(mk, playlists[0]);
    } catch (_) {
      console.warn("[Sidra] could not prepare playlist tracks, using the standard queue");
    }
    if (generation !== queueGeneration) return mk.queue;
    // Shuffle may have been switched on while the list was fetched.
    if (songId && shuffled()) return setQueue(options);
    // MusicKit keeps one copy of an item ID it is given, but Apple's own queue keeps repeats.
    const exact =
      items &&
      items.length > 0 &&
      new Set(items.map((item) => item.id)).size === items.length &&
      (!songId || items.some((item) => item.id === songId));
    if (!exact) return setQueue(options);

    const startId = songId || (shuffled() ? undefined : items[0].id);
    try {
      const queue = await setQueue({
        ...rest,
        items: structuredClone(items),
        ...(startId ? { startWith: startId } : {}),
      });
      if (!(mk.queue && mk.queue.length === 0)) return queue;
    } catch (_) {
      // Fall through to Apple's request.
    }
    console.warn("[Sidra] fast playlist start failed, using the standard queue");
    return generation === queueGeneration ? setQueue(options) : mk.queue;
  }

  function install(mk) {
    if (installed.has(mk) || typeof mk.setQueue !== "function") return;
    installed.add(mk);
    const setQueue = mk.setQueue.bind(mk);
    mk.setQueue = function (options) {
      const generation = ++queueGeneration;
      return isLibraryPlaylistRequest(options) ? startPlaylist(mk, setQueue, options, generation) : setQueue(options);
    };
    // Starting a station, or signing out, ends a playlist start that is still waiting.
    const before = {
      setStationQueue: () => {},
      unauthorize: () => {
        accountGeneration += 1;
        tooLarge.clear();
        void clearSaved();
      },
    };
    for (const [name, run] of Object.entries(before)) {
      if (typeof mk[name] !== "function") continue;
      const original = mk[name].bind(mk);
      mk[name] = (...args) => {
        queueGeneration += 1;
        run();
        return original(...args);
      };
    }
  }

  // MusicKit can replace its instance without a new document, so keep checking for it.
  setInterval(() => {
    let mk;
    try {
      mk = window.MusicKit && window.MusicKit.getInstance();
    } catch (_) {
      return;
    }
    if (!mk) return;
    install(mk);
    const path = window.location.pathname;
    if (path === prewarmedPath) return;
    prewarmedPath = path;
    const match = PLAYLIST_PATH.exec(path);
    if (match && !tooLarge.has(match[1])) {
      currentList(mk, match[1]).catch(() => console.warn("[Sidra] failed to prepare playlist tracks"));
    }
  }, 1000);
})();
