import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { sessionBus, Variant } from "@holusion/dbus-next";
import { Player } from "../src/player";
import { init } from "../src/integrations/mpris";
import { closeBus } from "../src/utils/closeBus";
import { quit } from "./mocks/appLifecycle";

vi.mock("../src/artwork", () => ({ downloadArtwork: vi.fn(async () => null) }));

// Run only on a disposable session bus, never against the user's Sidra service:
// dbus-run-session -- env SIDRA_TEST_MPRIS_BUS=1 npm test -- test/mprisBus.test.ts
describe.runIf(process.env.SIDRA_TEST_MPRIS_BUS === "1")("MPRIS on a real private D-Bus", () => {
  it("marshals TrackList properties, methods, edit errors and ordered signals", async () => {
    const player = new Player();
    const first = { occurrenceId: "d1_i1_o1", trackId: "duplicate", name: "First", durationInMillis: 123_000 };
    const second = { ...first, occurrenceId: "d1_i1_o2", name: "Second" };
    player.handleHookReady("https://music.apple.com/gb/new");
    player.handleNowPlayingItemDidChange(first);
    player.handleQueueDidChange({ items: [first, second], currentOccurrenceId: first.occurrenceId });
    const send = vi.fn();
    const contents = Object.assign(new EventEmitter(), { send, isDestroyed: () => false });
    const window = Object.assign(new EventEmitter(), { webContents: contents, isDestroyed: () => false });
    const client = sessionBus();
    try {
      init({ player, getMainWindow: () => window as unknown as BrowserWindow });
      const daemon = (await client.getProxyObject("org.freedesktop.DBus", "/org/freedesktop/DBus"))
        .getInterface("org.freedesktop.DBus");
      let ready = false;
      for (let attempt = 0; attempt < 50; attempt++) {
        ready = await daemon.NameHasOwner("org.mpris.MediaPlayer2.sidra") as boolean;
        if (ready) break;
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(ready).toBe(true);
      const object = await client.getProxyObject("org.mpris.MediaPlayer2.sidra", "/org/mpris/MediaPlayer2");
      const properties = object.getInterface("org.freedesktop.DBus.Properties");
      const list = object.getInterface("org.mpris.MediaPlayer2.TrackList");
      const root = "org.mpris.MediaPlayer2";
      const interfaceName = `${root}.TrackList`;
      expect((await properties.Get(root, "HasTrackList") as Variant<boolean>).value).toBe(true);
      expect((await properties.Get(interfaceName, "CanEditTracks") as Variant<boolean>).value).toBe(false);
      const ids = (await properties.Get(interfaceName, "Tracks") as Variant<string[]>).value;
      expect(ids).toHaveLength(2);
      expect(ids[0]).not.toBe(ids[1]);
      const metadata = await list.GetTracksMetadata([ids[1], "/stale", ids[0]]) as Array<Record<string, Variant>>;
      expect(metadata.map(item => item["mpris:trackid"].value)).toEqual([ids[1], ids[0]]);
      expect(metadata[0]["mpris:length"].value).toBe(123_000_000n);
      const current = await properties.Get(`${root}.Player`, "Metadata") as Variant<Record<string, Variant>>;
      expect(current.value["mpris:trackid"].value).toBe(ids[0]);
      await list.GoTo(ids[1]);
      expect(send).toHaveBeenCalledWith("player:goTo", second.occurrenceId);
      await expect(list.AddTrack("https://music.apple.com/song/1", ids[0], true)).rejects.toMatchObject({
        type: "org.freedesktop.DBus.Error.NotSupported",
      });
      await expect(list.RemoveTrack(ids[0])).rejects.toMatchObject({
        type: "org.freedesktop.DBus.Error.NotSupported",
      });
      const signalOrder: string[] = [];
      const replacement = new Promise<void>(resolve => list.once("TrackListReplaced", (tracks: string[], id: string) => {
        expect(tracks).toEqual([ids[1], ids[0]]);
        expect(id).toBe(ids[0]);
        signalOrder.push("replaced");
        resolve();
      }));
      const invalidation = new Promise<void>(resolve => properties.on("PropertiesChanged",
        (name: string, changed: Record<string, Variant>, invalidated: string[]) => {
          if (name !== interfaceName) return;
          expect(changed).toEqual({});
          expect(invalidated).toEqual(["Tracks"]);
          signalOrder.push("invalidated");
          resolve();
        }));
      // Subscription AddMatch requests precede this barrier on the client connection.
      await properties.Get(interfaceName, "Tracks");
      player.handleQueueDidChange({ items: [second, first], currentOccurrenceId: first.occurrenceId });
      await Promise.all([replacement, invalidation]);
      expect(signalOrder).toEqual(["replaced", "invalidated"]);
      const metadataChanged = new Promise<void>(resolve => list.once("TrackMetadataChanged",
        (id: string, changed: Record<string, Variant>) => {
          expect(id).toBe(ids[1]);
          expect(changed["xesam:title"].value).toBe("Corrected");
          resolve();
        }));
      await properties.Get(interfaceName, "Tracks");
      player.handleQueueDidChange({ items: [{ ...second, name: "Corrected" }, first], currentOccurrenceId: first.occurrenceId });
      await metadataChanged;
    } finally {
      quit();
      closeBus(client);
    }
  });
});
