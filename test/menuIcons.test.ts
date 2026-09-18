import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const menuSourceDir = path.join(process.cwd(), "assets", "source", "tray-menu");
const menuIconsDir = path.join(
  process.cwd(),
  "assets",
  "icons",
  "tray",
  "menu",
);

describe("tray menu icon assets", () => {
  it("contains one 64px PNG per SVG and colour variant", () => {
    const names = fs
      .readdirSync(menuSourceDir)
      .filter((name) => name.endsWith(".svg"))
      .map((name) => name.replace(/\.svg$/, ""))
      .sort();

    expect(names).toHaveLength(34);
    expect(fs.readdirSync(menuIconsDir).sort()).toEqual(["dark", "light"]);

    for (const variant of ["dark", "light"]) {
      const variantDir = path.join(menuIconsDir, variant);
      const pngNames = fs
        .readdirSync(variantDir)
        .filter((name) => name.endsWith(".png"))
        .sort();
      expect(pngNames).toEqual(names.map((name) => `${name}.png`).sort());

      for (const pngName of pngNames) {
        const png = fs.readFileSync(path.join(variantDir, pngName));
        expect(png.subarray(1, 4).toString("ascii")).toBe("PNG");
        expect(png.readUInt32BE(16)).toBe(64);
        expect(png.readUInt32BE(20)).toBe(64);
      }
    }
  });
});
