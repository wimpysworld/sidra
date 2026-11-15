import { app, BrowserWindow } from "electron";
import log from "electron-log/main";
import {
  Player,
  PlaybackState,
  PlaybackStatePayload,
  NowPlayingPayload,
  IntegrationContext,
} from "./player";
import { liveWebContents } from "./utils";

const wedgeLog = log.scope("wedge");

// Recovery for a wedged player: the web player can keep reporting Playing while
// the playhead stops advancing, and nothing on the page recovers from it. A one
// second check skips forward when nothing has advanced for STALL_THRESHOLD_MS.
// END_SAFETY_MARGIN_MS holds the end of a track out of scope, where a track
// about to finish looks the same as a stall, and MAX_SKIP_ATTEMPTS bounds the
// recovery so a queue that will not play cannot be skipped through end to end.
const STALL_THRESHOLD_MS = 5000;
const END_SAFETY_MARGIN_MS = 10000;
const CHECK_INTERVAL_MS = 1000;
const MAX_SKIP_ATTEMPTS = 3;
// A busy renderer answers the position probe only once it is free again. The
// probe is dropped after this long, and the next check asks again.
const PROBE_TIMEOUT_MS = 15000;
// The playhead counts as moved when the page reports more than this many
// seconds past the position the main process last saw.
const PROBE_MOVED_SECONDS = 0.5;

// Runs in the page. A fixed string with no input, so nothing untrusted reaches it.
const PROBE_SCRIPT =
  "(() => { try { return window.MusicKit.getInstance().currentPlaybackTime; } catch (_) { return null; } })()";

let playerRef: Player | null = null;
let lastAdvanceTime = 0;
let durationMs = 0;
let checkTimer: ReturnType<typeof setInterval> | null = null;
let skipAttempts = 0;
let initialised = false;
// Advances whenever an answer in flight stops being valid: a new state, a new
// track, a reset. A late answer from an older generation is ignored.
let probeGeneration = 0;
let probePending = false;

function startTimer(getWin: () => BrowserWindow | null): void {
  if (checkTimer) return;
  checkTimer = setInterval(() => checkForWedge(getWin), CHECK_INTERVAL_MS);
}

function stopTimer(): void {
  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }
}

function sendSkip(getWin: () => BrowserWindow | null): void {
  skipAttempts++;
  lastAdvanceTime = Date.now();
  const contents = liveWebContents(getWin());
  const result = contents ? "sent" : "dropped";
  wedgeLog.warn(
    `source=wedge channel=player:next reason=playback-stalled attempt=${skipAttempts}/${MAX_SKIP_ATTEMPTS} result=${result}`,
  );

  contents?.send("player:next" satisfies ReceiveChannel);
}

/**
 * The main process only knows that no position report arrived. A renderer that
 * is busy, such as Apple's Up next panel redrawing a long queue after a shuffle
 * or repeat click, reports nothing for seconds and looks the same. The probe
 * asks the page itself where the playhead is. It runs on the page's own
 * timeline, so a busy page answers when it is free again and by then the
 * playhead has moved. Only an answer that matches the stalled position is a
 * wedge.
 */
function checkForWedge(getWin: () => BrowserWindow | null): void {
  if (!playerRef?.playbackSnapshot().isPlaying) return;
  if (probePending) return;
  if (Date.now() - lastAdvanceTime < STALL_THRESHOLD_MS) return;
  const positionUs = playerRef.playbackSnapshot().positionUs;
  if (durationMs > 0 && durationMs - positionUs / 1000 < END_SAFETY_MARGIN_MS)
    return;
  if (skipAttempts >= MAX_SKIP_ATTEMPTS) return;

  const contents = liveWebContents(getWin());
  if (!contents) {
    sendSkip(getWin);
    return;
  }

  const generation = probeGeneration;
  probePending = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), PROBE_TIMEOUT_MS);
  });
  const answer = Promise.resolve(
    contents.executeJavaScript(PROBE_SCRIPT) as Promise<unknown>,
  );
  void Promise.race([answer, timeout])
    .then((value) => {
      if (generation !== probeGeneration) return;
      if (value === "timeout") {
        wedgeLog.warn("source=wedge probe=timeout result=no-skip");
        return;
      }
      const seconds = typeof value === "number" ? value : NaN;
      const moved =
        Number.isFinite(seconds) &&
        Math.abs(seconds - positionUs / 1_000_000) > PROBE_MOVED_SECONDS;
      if (moved) {
        lastAdvanceTime = Date.now();
        wedgeLog.info("source=wedge probe=moved result=no-skip");
        return;
      }
      if (!playerRef?.playbackSnapshot().isPlaying) return;
      if (skipAttempts >= MAX_SKIP_ATTEMPTS) return;
      sendSkip(getWin);
    })
    .catch(() => {
      // The page could not answer. Nothing says it is wedged, so no skip.
      if (generation !== probeGeneration) return;
      wedgeLog.warn("source=wedge probe=failed result=no-skip");
    })
    .finally(() => {
      clearTimeout(timer);
      if (generation === probeGeneration) probePending = false;
    });
}

/**
 * Clear the skip count and stop the check timer. A reload and a service switch
 * must call this first: the timer otherwise survives the navigation and fires a
 * spurious skip-forward once the page has re-initialised.
 */
export function reset(): void {
  skipAttempts = 0;
  probeGeneration++;
  probePending = false;
  stopTimer();
}

/** Attach the detector once because its state and listeners are module-scoped. */
export function init(ctx: IntegrationContext): void {
  const { player, getMainWindow: getWin } = ctx;

  // Module-scoped state requires one set of listeners and one will-quit handler,
  // regardless of whether the caller guards repeated initialisation.
  if (initialised) {
    wedgeLog.warn("wedge detector already initialised, ignoring repeat init");
    return;
  }
  initialised = true;

  playerRef = player;

  let lastSeenPositionUs = 0;

  // Named references let will-quit remove the same listeners.
  const onPlaybackStateDidChange = (payload: PlaybackStatePayload): void => {
    const nowPlaying = payload?.state === PlaybackState.Playing;
    lastAdvanceTime = Date.now();
    skipAttempts = 0;
    probeGeneration++;
    probePending = false;

    if (nowPlaying) {
      startTimer(getWin);
    } else {
      stopTimer();
    }
  };

  const onNowPlayingItemDidChange = (
    payload: NowPlayingPayload | null,
  ): void => {
    durationMs = payload?.durationInMillis ?? 0;
    lastAdvanceTime = Date.now();
    skipAttempts = 0;
    probeGeneration++;
    probePending = false;
  };

  const onPlaybackTimeDidChange = (payload: number): void => {
    if (payload !== lastSeenPositionUs) {
      lastSeenPositionUs = payload;
      lastAdvanceTime = Date.now();
    }
  };

  player.on("playbackStateDidChange", onPlaybackStateDidChange);
  player.on("nowPlayingItemDidChange", onNowPlayingItemDidChange);
  player.on("playbackTimeDidChange", onPlaybackTimeDidChange);

  app.on("will-quit", () => {
    stopTimer();
    player.removeListener("playbackStateDidChange", onPlaybackStateDidChange);
    player.removeListener("nowPlayingItemDidChange", onNowPlayingItemDidChange);
    player.removeListener("playbackTimeDidChange", onPlaybackTimeDidChange);
  });

  wedgeLog.info("wedge detector initialised");
}
