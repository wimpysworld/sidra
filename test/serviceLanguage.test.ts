import { beforeEach, describe, expect, it, vi } from "vitest";
import { Conf } from "electron-conf/main";
import { MUSIC_SERVICES } from "../src/musicService";
import { transformItmsUrl } from "../src/itms";
import type { BrowserWindow } from "electron";

vi.mock("../src/i18n", () => ({ getStorefront: () => "gb" }));
vi.mock("../src/theme", () => ({ notifyDocumentReplacing: vi.fn() }));
vi.mock("../src/tray", () => ({ rebuildTrayMenu: vi.fn() }));
vi.mock("../src/wedgeDetector", () => ({ reset: vi.fn() }));

const store = (Conf as unknown as { _data: Map<string, unknown> })._data;

beforeEach(() => {
  store.clear();
  vi.resetModules();
});

describe("service language preferences", () => {
  async function pageLanguageFixture(url = "https://music.apple.com/jp/new") {
    const config = await import("../src/config");
    config.setMusicService("music");
    config.setLanguageFor("music", "en-GB");
    config.setLanguageFor("classical", "en-GB");
    const listeners = new Map<string, (...args: unknown[]) => unknown>();
    const contents = {
      getURL: vi.fn(() => url),
      isDestroyed: vi.fn(() => false),
      executeJavaScript: vi.fn<() => Promise<unknown>>(() => Promise.resolve({ url, language: "ja" })),
      on: (event: string, listener: (...args: unknown[]) => unknown) => listeners.set(event, listener),
    };
    const win = {
      isDestroyed: vi.fn(() => false),
      get webContents() {
        if (win.isDestroyed()) throw new Error("Object has been destroyed");
        return contents;
      },
    };
    const storefront = await import("../src/storefront");
    storefront.initPageLanguageTracking(win as unknown as BrowserWindow);
    const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.(...args);
    return { config, storefront, contents, win, emit };
  }

  it("keeps Japan's default language through service switches and restart without an l query", async () => {
    const { config, storefront, emit } = await pageLanguageFixture();
    storefront.handleStorefrontNavigation("https://music.apple.com/jp/new");
    await emit("did-finish-load");
    expect(config.getLanguageFor("music")).toBe("ja");
    expect(config.getLanguageFor("classical")).toBe("en-GB");
    const serviceSwitch = await import("../src/serviceSwitch");
    const loadURL = vi.fn();
    serviceSwitch.initServiceSwitch({ getTray: () => null, loadURL });
    serviceSwitch.switchService("classical");
    expect(loadURL).toHaveBeenLastCalledWith("https://classical.music.apple.com/jp?l=en-GB");
    serviceSwitch.switchService("music");
    expect(loadURL).toHaveBeenLastCalledWith("https://music.apple.com/jp/new?l=ja");
    vi.resetModules();
    expect((await import("../src/storefront")).buildAppleMusicURL()).toBe("https://music.apple.com/jp/new?l=ja");
  });

  it("captures the Classical default language on main-frame in-page navigation only", async () => {
    const { config, emit } = await pageLanguageFixture("https://classical.music.apple.com/jp");
    config.setMusicService("classical");
    await emit("did-navigate-in-page", {}, "https://classical.music.apple.com/jp", false);
    expect(config.getLanguageFor("classical")).toBe("en-GB");
    await emit("did-navigate-in-page", {}, "https://classical.music.apple.com/jp", true);
    expect(config.getLanguageFor("classical")).toBe("ja");
    expect(config.getLanguageFor("music")).toBe("en-GB");
  });

  it("keeps an explicit query ahead of the document language", async () => {
    const url = "https://music.apple.com/jp/new?l=en-GB";
    const { config, storefront, contents, emit } = await pageLanguageFixture(url);
    storefront.handleStorefrontNavigation(url);
    await emit("did-finish-load");
    expect(config.getLanguageFor("music")).toBe("en-GB");
    expect(contents.executeJavaScript).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "", "not_a_language", "und", 123])("preserves the preference for unavailable or invalid document language %s", async (language) => {
    const { config, contents, emit } = await pageLanguageFixture();
    contents.executeJavaScript.mockResolvedValue({ url: contents.getURL(), language });
    await emit("did-finish-load");
    expect(config.getLanguageFor("music")).toBe("en-GB");
  });

  it.each(["navigation", "same-url reload", "service switch", "window destroyed", "contents destroyed", "different result URL", "newer read"]) (
    "discards a late language read after %s",
    async (change) => {
      const { config, contents, win, emit } = await pageLanguageFixture();
      let resolve!: (value: unknown) => void;
      contents.executeJavaScript.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
      const pending = emit("did-finish-load");
      const url = contents.getURL();
      if (change === "navigation") contents.getURL.mockReturnValue("https://music.apple.com/gb/new");
      if (change === "same-url reload") emit("did-start-navigation", { isMainFrame: true });
      if (change === "service switch") config.setMusicService("classical");
      if (change === "window destroyed") win.isDestroyed.mockReturnValue(true);
      if (change === "contents destroyed") contents.isDestroyed.mockReturnValue(true);
      if (change === "newer read") {
        contents.executeJavaScript.mockResolvedValue({ url, language: "de" });
        await emit("did-navigate-in-page", {}, url, true);
      }
      resolve({ url: change === "different result URL" ? "https://classical.music.apple.com/jp" : url, language: "ja" });
      await pending;
      expect(config.getLanguageFor("music")).toBe(change === "newer read" ? "de" : "en-GB");
      expect(config.getLanguageFor("classical")).toBe("en-GB");
    },
  );

  it.each(["https://idmsa.apple.com/jp", "http://music.apple.com/jp/new", "https://music.apple.com:1234/jp/new"]) (
    "does not read a document outside the service origin: %s",
    async (url) => {
      const { config, contents, emit } = await pageLanguageFixture(url);
      await emit("did-finish-load");
      expect(contents.executeJavaScript).not.toHaveBeenCalled();
      expect(config.getLanguageFor("music")).toBe("en-GB");
    },
  );

  it("contains failed language reads without clearing the preference", async () => {
    const { config, contents, emit } = await pageLanguageFixture();
    contents.executeJavaScript.mockRejectedValue(new Error("document replaced"));
    await expect(emit("did-finish-load")).resolves.toBeUndefined();
    expect(config.getLanguageFor("music")).toBe("en-GB");
  });

  it.each(["music", "classical"] as const)("captures %s navigation independently of the active service", async (id) => {
    const config = await import("../src/config");
    const { handleStorefrontNavigation } = await import("../src/storefront");
    const other = id === "music" ? "classical" : "music";
    config.setMusicService(other);
    config.setLanguageFor(id, "fr");
    config.setLanguageFor(other, "de");

    handleStorefrontNavigation(`${MUSIC_SERVICES[id].origin}/ch?l=it`);
    expect(config.getStorefront()).toBe("ch");
    expect(config.getLanguageFor(id)).toBe("it");
    expect(config.getLanguageFor(other)).toBe("de");
    expect(config.getMusicService()).toBe(other);

    handleStorefrontNavigation(`${MUSIC_SERVICES[id].origin}/gb`);
    expect(config.getLanguageFor(id)).toBe("it");
    expect(config.getLanguageFor(other)).toBe("de");
    expect(config.getStorefront()).toBe("gb");
  });

  it("keeps both choices through switches, a restart and an itms route", async () => {
    store.set("language", "fr");
    const config = await import("../src/config");
    const storefront = await import("../src/storefront");
    const serviceSwitch = await import("../src/serviceSwitch");
    const loadURL = vi.fn();
    serviceSwitch.initServiceSwitch({ getTray: () => null, loadURL });

    storefront.handleStorefrontNavigation("https://music.apple.com/gb/new?l=en-GB");
    serviceSwitch.switchService("classical");
    expect(loadURL).toHaveBeenLastCalledWith("https://classical.music.apple.com/gb?l=fr");
    storefront.handleStorefrontNavigation("https://classical.music.apple.com/gb?l=de");
    serviceSwitch.switchService("music");
    expect(loadURL).toHaveBeenLastCalledWith("https://music.apple.com/gb/new?l=en-GB");
    serviceSwitch.switchService("classical");
    expect(loadURL).toHaveBeenLastCalledWith("https://classical.music.apple.com/gb?l=de");

    vi.resetModules();
    const restarted = await import("../src/storefront");
    expect(restarted.buildAppleMusicURL()).toBe("https://classical.music.apple.com/gb?l=de");
    const restartedSwitch = await import("../src/serviceSwitch");
    restartedSwitch.initServiceSwitch({ getTray: () => null, loadURL });
    restartedSwitch.routeToMusicService(restarted.buildItmsRouteURL("library"));
    expect(loadURL).toHaveBeenLastCalledWith("https://music.apple.com/gb/library?l=en-GB");
    expect(config.getMusicService()).toBe("music");
    restartedSwitch.switchService("classical");
    expect(loadURL).toHaveBeenLastCalledWith("https://classical.music.apple.com/gb?l=de");
  });

  it("preserves the explicit query on an incoming catalogue link", async () => {
    const config = await import("../src/config");
    config.setMusicService("classical");
    config.setLanguageFor("music", "en-GB");
    config.setLanguageFor("classical", "de");
    const serviceSwitch = await import("../src/serviceSwitch");
    const loadURL = vi.fn();
    serviceSwitch.initServiceSwitch({ getTray: () => null, loadURL });
    const result = transformItmsUrl("itms://music.apple.com/ch/album/example/123?i=456&l=fr&app=music");
    expect(result?.kind).toBe("url");
    if (result?.kind !== "url") throw new Error("Expected a catalogue URL");
    serviceSwitch.routeToMusicService(result.url);
    expect(loadURL).toHaveBeenLastCalledWith("https://music.apple.com/ch/album/example/123?i=456&l=fr");
  });

  for (const id of ["music", "classical"] as const) {
    it.each(["de", null, undefined])(`applies ${id}'s %s preference over a stale saved language`, async (language) => {
      const config = await import("../src/config");
      const { buildAppleMusicURL, handleLastPageNavigation } = await import("../src/storefront");
      config.setMusicService(id);
      if (id === "music") config.setStartPage("last");
      else config.setClassicalStartPage("last");
      if (language === undefined) store.delete(id === "music" ? "language" : "classical.language");
      else config.setLanguageFor(id, language);
      handleLastPageNavigation(`${MUSIC_SERVICES[id].origin}/gb/search?term=bach&i=123&l=fr&l=it`);

      const url = new URL(buildAppleMusicURL());
      expect(url.origin).toBe(MUSIC_SERVICES[id].origin);
      expect(url.pathname).toBe("/gb/search");
      expect([...url.searchParams]).toEqual([
        ["term", "bach"], ["i", "123"], ...(language == null ? [] : [["l", language]]),
      ]);
    });
  }

  it.each(["de", null, undefined])("keeps the bare Classical root with preference %s", async (language) => {
    const config = await import("../src/config");
    const { buildAppleMusicURL } = await import("../src/storefront");
    config.setMusicService("classical");
    config.setClassicalStartPage("last");
    config.setClassicalLastPageUrl("?l=fr");
    if (language === undefined) store.delete("classical.language");
    else config.setLanguageFor("classical", language);
    expect(buildAppleMusicURL()).toBe(`https://classical.music.apple.com/gb${language == null ? "" : "?l=de"}`);
  });
});
