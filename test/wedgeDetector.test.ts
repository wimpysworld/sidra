import {
  describe,
  it,
  expect,
  expectTypeOf,
  vi,
  beforeEach,
  afterEach,
} from "vitest";
import { BrowserWindow } from "electron";
import type electronLog from "electron-log/main";

import { Player, PlaybackState } from "../src/player";
import type { IntegrationContext } from "../src/player";

type WedgeDetector = typeof import("../src/wedgeDetector");
type ScopedLog = ReturnType<typeof electronLog.scope>;

// init() refuses repeat calls and keeps module-level state, so each test needs a fresh module.
async function loadWedgeDetector(): Promise<WedgeDetector> {
  vi.resetModules();
  return import("../src/wedgeDetector");
}

describe("wedgeDetector", () => {
  let player: Player;
  let mockWin: {
    isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
    webContents: {
      send: ReturnType<typeof vi.fn>;
      executeJavaScript: ReturnType<typeof vi.fn>;
      isDestroyed: ReturnType<typeof vi.fn<() => boolean>>;
    };
  };
  let mainWindow: BrowserWindow | null;
  let getMainWindow: () => BrowserWindow | null;
  let wedgeDetector: WedgeDetector;
  let wedgeLog: ScopedLog;

  beforeEach(async () => {
    vi.useFakeTimers();
    player = new Player();
    mockWin = {
      isDestroyed: vi.fn(() => false),
      webContents: {
        send: vi.fn(),
        // The page reports the playhead where the main process last saw it, so a stall is a real one.
        executeJavaScript: vi.fn(() => Promise.resolve(0)),
        isDestroyed: vi.fn(() => false),
      },
    };
    mainWindow = mockWin as unknown as BrowserWindow;
    getMainWindow = () => mainWindow;

    wedgeDetector = await loadWedgeDetector();
    wedgeLog = (await import("electron-log/main")).default.scope("wedge");
    const ctx: IntegrationContext = { player, getMainWindow };
    wedgeDetector.init(ctx);
    vi.clearAllMocks();
  });

  afterEach(() => {
    wedgeDetector.reset();
    vi.useRealTimers();
  });

  it("fires skip after STALL_THRESHOLD_MS of stalled playback", async () => {
    player.handlePlaybackStateDidChange({
      status: true,
      state: PlaybackState.Playing,
    });

    // The check runs on a 1000ms interval and proceeds once the elapsed time is
    // no longer below the 5000ms threshold, so the 5000ms tick fires the skip.
    // Advance past it to keep the test off the boundary.
    await vi.advanceTimersByTimeAsync(6000);

    expect(mockWin.webContents.send).toHaveBeenCalledWith("player:next");
  });

  it("does not fire skip before stall threshold", async () => {
    player.handlePlaybackStateDidChange({
      status: true,
      state: PlaybackState.Playing,
    });

    await vi.advanceTimersByTimeAsync(4000);

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  it("logs sent command provenance when stalled playback is skipped", async () => {
    player.handlePlaybackStateDidChange({
      status: true,
      state: PlaybackState.Playing,
    });

    await vi.advanceTimersByTimeAsync(6000);

    expect(wedgeLog.warn).toHaveBeenCalledWith(
      "source=wedge channel=player:next reason=playback-stalled attempt=1/3 result=sent",
    );
  });

  it("logs dropped command provenance when the main window is missing", async () => {
    mainWindow = null;
    player.handlePlaybackStateDidChange({
      status: true,
      state: PlaybackState.Playing,
    });

    await vi.advanceTimersByTimeAsync(6000);

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
    expect(wedgeLog.warn).toHaveBeenCalledWith(
      "source=wedge channel=player:next reason=playback-stalled attempt=1/3 result=dropped",
    );
  });

  it("does not fire skip when position advances", async () => {
    player.handlePlaybackStateDidChange({
      status: true,
      state: PlaybackState.Playing,
    });

    for (let i = 1; i <= 8; i++) {
      await vi.advanceTimersByTimeAsync(1000);
      player.handlePlaybackTimeDidChange(i * 1000);
    }

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  it("respects MAX_SKIP_ATTEMPTS (3)", async () => {
    player.handlePlaybackStateDidChange({
      status: true,
      state: PlaybackState.Playing,
    });

    // Each skip resets lastAdvanceTime, so the next attempt needs another full stall interval.
    await vi.advanceTimersByTimeAsync(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(3);

    // The cap is what stops a queue that will not play being skipped end to end.
    await vi.advanceTimersByTimeAsync(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(3);
  });

  it("reset() clears state and stops timer", async () => {
    player.handlePlaybackStateDidChange({
      status: true,
      state: PlaybackState.Playing,
    });

    // Keep the timer active without reaching the stall threshold.
    await vi.advanceTimersByTimeAsync(3000);

    wedgeDetector.reset();

    // reset() stops the timer, so elapsed time alone cannot trigger another skip.
    await vi.advanceTimersByTimeAsync(10000);

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  it("track change resets skip counter", async () => {
    player.handlePlaybackStateDidChange({
      status: true,
      state: PlaybackState.Playing,
    });

    await vi.advanceTimersByTimeAsync(6000);
    await vi.advanceTimersByTimeAsync(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(2);

    // A new track is a fresh recovery budget: the cap bounds the attempts spent
    // on one track, not on the session.
    player.handleNowPlayingItemDidChange({
      name: "New Track",
      durationInMillis: 180000,
    });

    await vi.advanceTimersByTimeAsync(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(3);

    await vi.advanceTimersByTimeAsync(6000);
    expect(mockWin.webContents.send).toHaveBeenCalledTimes(4);
  });

  it("does not fire skip when playback is paused", async () => {
    player.handlePlaybackStateDidChange({
      status: true,
      state: PlaybackState.Playing,
    });
    await vi.advanceTimersByTimeAsync(2000);

    player.handlePlaybackStateDidChange({
      status: true,
      state: PlaybackState.Paused,
    });

    await vi.advanceTimersByTimeAsync(10000);

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  it("does not fire skip near end of track (within END_SAFETY_MARGIN_MS)", async () => {
    player.handleNowPlayingItemDidChange({
      name: "Track",
      durationInMillis: 200000,
    });
    player.handlePlaybackStateDidChange({
      status: true,
      state: PlaybackState.Playing,
    });

    // A track about to finish reports the same still playhead as a stall, so the
    // last END_SAFETY_MARGIN_MS of it are out of scope. The detector compares
    // durationMs against the position in microseconds: with a 200s track and a
    // 10s margin, anything past 190,000,000 is inside it.
    player.handlePlaybackTimeDidChange(191000000);

    await vi.advanceTimersByTimeAsync(10000);

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
  });

  // A stall callback can run after quit destroys the window. liveWebContents()
  // must reject the destroyed window before its native webContents getter throws.
  it("drops the skip without throwing once the window is destroyed", async () => {
    player.handlePlaybackStateDidChange({
      status: true,
      state: PlaybackState.Playing,
    });
    mockWin.isDestroyed.mockReturnValue(true);

    await expect(vi.advanceTimersByTimeAsync(6000)).resolves.not.toThrow();

    expect(mockWin.webContents.send).not.toHaveBeenCalled();
    expect(wedgeLog.warn).toHaveBeenCalledWith(
      expect.stringContaining("result=dropped"),
    );
  });

  describe("a busy page", () => {
    const startPlaying = () =>
      player.handlePlaybackStateDidChange({
        status: true,
        state: PlaybackState.Playing,
      });

    // Apple's Up next panel redraws a long queue after a shuffle or repeat click and the page
    // reports nothing for seconds. It answers the probe when it is free, with the playhead moved on.
    it("does not skip when the page answers with a playhead that moved", async () => {
      mockWin.webContents.executeJavaScript.mockResolvedValue(12);
      startPlaying();

      await vi.advanceTimersByTimeAsync(6000);

      expect(mockWin.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
      expect(mockWin.webContents.send).not.toHaveBeenCalled();
      expect(wedgeLog.info).toHaveBeenCalledWith(
        "source=wedge probe=moved result=no-skip",
      );
    });

    it("waits a full stall interval again after a moved playhead", async () => {
      mockWin.webContents.executeJavaScript.mockResolvedValue(12);
      startPlaying();
      await vi.advanceTimersByTimeAsync(6000);
      mockWin.webContents.executeJavaScript.mockClear();

      await vi.advanceTimersByTimeAsync(3000);

      expect(mockWin.webContents.executeJavaScript).not.toHaveBeenCalled();
    });

    it("still skips a real wedge, where the page reports the same playhead", async () => {
      mockWin.webContents.executeJavaScript.mockResolvedValue(0.2);
      startPlaying();

      await vi.advanceTimersByTimeAsync(6000);

      expect(mockWin.webContents.send).toHaveBeenCalledWith("player:next");
    });

    it("skips when the page gives no usable position", async () => {
      mockWin.webContents.executeJavaScript.mockResolvedValue(null);
      startPlaying();

      await vi.advanceTimersByTimeAsync(6000);

      expect(mockWin.webContents.send).toHaveBeenCalledWith("player:next");
    });

    it("sends one probe while the page has not answered", async () => {
      mockWin.webContents.executeJavaScript.mockReturnValue(
        new Promise(() => {}),
      );
      startPlaying();

      await vi.advanceTimersByTimeAsync(12000);

      expect(mockWin.webContents.executeJavaScript).toHaveBeenCalledTimes(1);
      expect(mockWin.webContents.send).not.toHaveBeenCalled();
    });

    it("gives up on a probe that never answers, without a skip, and asks again", async () => {
      mockWin.webContents.executeJavaScript.mockReturnValue(
        new Promise(() => {}),
      );
      startPlaying();

      await vi.advanceTimersByTimeAsync(5000 + 15000 + 2000);

      expect(mockWin.webContents.executeJavaScript.mock.calls.length).toBe(2);
      expect(mockWin.webContents.send).not.toHaveBeenCalled();
      expect(wedgeLog.warn).toHaveBeenCalledWith(
        "source=wedge probe=timeout result=no-skip",
      );
    });

    it("does not skip when the probe fails", async () => {
      mockWin.webContents.executeJavaScript.mockRejectedValue(
        new Error("Object has been destroyed"),
      );
      startPlaying();

      await vi.advanceTimersByTimeAsync(6000);

      expect(mockWin.webContents.send).not.toHaveBeenCalled();
      expect(wedgeLog.warn).toHaveBeenCalledWith(
        "source=wedge probe=failed result=no-skip",
      );
    });

    it("ignores an answer that arrives after the track changed", async () => {
      let answer: (value: number) => void = () => {};
      mockWin.webContents.executeJavaScript.mockReturnValue(
        new Promise<number>((resolve) => (answer = resolve)),
      );
      startPlaying();
      await vi.advanceTimersByTimeAsync(6000);
      expect(mockWin.webContents.executeJavaScript).toHaveBeenCalledTimes(1);

      player.handleNowPlayingItemDidChange({
        name: "Next Track",
        durationInMillis: 180000,
      });
      answer(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockWin.webContents.send).not.toHaveBeenCalled();
    });

    it("ignores an answer that arrives after reset()", async () => {
      let answer: (value: number) => void = () => {};
      mockWin.webContents.executeJavaScript.mockReturnValue(
        new Promise<number>((resolve) => (answer = resolve)),
      );
      startPlaying();
      await vi.advanceTimersByTimeAsync(6000);

      wedgeDetector.reset();
      answer(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockWin.webContents.send).not.toHaveBeenCalled();
    });

    it("does not skip when playback paused while the probe was out", async () => {
      let answer: (value: number) => void = () => {};
      mockWin.webContents.executeJavaScript.mockReturnValue(
        new Promise<number>((resolve) => (answer = resolve)),
      );
      startPlaying();
      await vi.advanceTimersByTimeAsync(6000);

      player.handlePlaybackStateDidChange({
        status: true,
        state: PlaybackState.Paused,
      });
      answer(0);
      await vi.advanceTimersByTimeAsync(0);

      expect(mockWin.webContents.send).not.toHaveBeenCalled();
    });
  });

  it("requires getMainWindow in context", () => {
    expectTypeOf<IntegrationContext["getMainWindow"]>().toEqualTypeOf<
      () => BrowserWindow | null
    >();
  });

  it("ignores a second init so each listener is attached once", () => {
    // Count registrations because timer reuse and idempotent state writes hide duplicate listeners from playback assertions.
    const events = [
      "playbackStateDidChange",
      "nowPlayingItemDidChange",
      "playbackTimeDidChange",
    ] as const;
    const before = events.map((event) => player.listenerCount(event));

    wedgeDetector.init({ player, getMainWindow });

    expect(events.map((event) => player.listenerCount(event))).toEqual(before);
    expect(before.every((count) => count === 1)).toBe(true);
  });
});
