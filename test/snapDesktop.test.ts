import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { Arch } from "builder-util";
import { describe, expect, it } from "vitest";

const { patchSnapDesktop } = require("../scripts/patch-snap-desktop.cjs") as {
  patchSnapDesktop(source: string): string;
};
const target = require.resolve("app-builder-lib/out/targets/snap/core24.js");
const source = readFileSync(target, "utf8");

describe("Snap desktop backport", () => {
  it("is idempotent and rejects an unknown source layout", () => {
    const patched = patchSnapDesktop(source);
    expect(patchSnapDesktop(patched)).toBe(patched);
    expect(() => patchSnapDesktop("changed upstream source")).toThrow("no longer matches");
    expect(() => patchSnapDesktop(source + source)).toThrow("no longer matches");
  });

  it.each([Arch.x64, Arch.arm64])("keeps the generated desktop entry without an app mapping for arch %s", async (arch) => {
    const exports: Record<string, unknown> = {};
    runInNewContext(patchSnapDesktop(source), {
      exports,
      require: createRequire(target),
      process,
    });
    const SnapCore24 = exports.SnapCore24 as new (
      packager: unknown,
      helper: unknown,
      options: unknown,
    ) => {
      createDescriptor(arch: number): Promise<{ apps: { sidra: Record<string, unknown> } }>;
      buildSnap(params: Record<string, unknown>): Promise<void>;
    };
    const pkg = require("../package.json");
    const helper = {
      getDesktopFileName: () => "sidra",
      isElectronVersionGreaterOrEqualThan: () => true,
      icons: Promise.resolve([]),
      getDescription: () => pkg.description,
      writeDesktopEntry: async (_options: unknown, command: string, file: string) => {
        writeFileSync(file, `[Desktop Entry]\nExec=${command}\n`);
      },
    };
    const core = new SnapCore24({
      executableName: "sidra",
      appInfo: { version: pkg.version, productName: pkg.productName },
      packagerOptions: { effectiveOptionComputed: async () => true },
    }, helper, pkg.build.snapcraft.core24);
    const snap = await core.createDescriptor(arch);
    expect(snap.apps.sidra).not.toHaveProperty("desktop");
    expect(snap.apps.sidra.command).toBe("command.sh");
    const stageDir = mkdtempSync(join(tmpdir(), "sidra-snap-desktop-"));
    try {
      mkdirSync(join(stageDir, "app"));
      await core.buildSnap({ snap, stageDir, appOutDir: join(stageDir, "app") });
      expect(readFileSync(join(stageDir, "snap/gui/sidra.desktop"), "utf8"))
        .toContain("Exec=sidra %U");
      expect(readFileSync(join(stageDir, "snap/snapcraft.yaml"), "utf8"))
        .not.toContain("desktop: meta/gui/");
    } finally {
      rmSync(stageDir, { recursive: true, force: true });
    }
  });
});
