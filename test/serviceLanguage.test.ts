import { beforeEach, describe, expect, it, vi } from "vitest";
import { Conf } from "electron-conf/main";
import { MUSIC_SERVICES } from "../src/musicService";
import { transformItmsUrl } from "../src/itms";

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
