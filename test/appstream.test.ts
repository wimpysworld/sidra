import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const { generateAppStream } = require("../build/appstream.cjs") as {
  generateAppStream(projectDir: string): string;
};
const afterPack = require("../build/afterPack.cjs").default as (context: {
  electronPlatformName: string;
  targets: { name: string }[];
  packager: { projectDir: string };
}) => Promise<void>;
const sourcePackage = JSON.parse(readFileSync("package.json", "utf8")) as typeof import("../package.json");
const directories: string[] = [];

function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "sidra-appstream-"));
  directories.push(directory);
  writeFileSync(path.join(directory, "package.json"), JSON.stringify(sourcePackage));
  return directory;
}

function git(directory: string, args: string[], date = "2026-10-18T12:00:00Z") {
  return execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initialiseGit(directory: string) {
  git(directory, ["init"]);
  git(directory, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "Test"]);
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("AppStream metadata", () => {
  it("derives package fields and escapes XML text", () => {
    const directory = fixture();
    const pkg = { ...structuredClone(sourcePackage), author: { name: "Someone's Music & Co" } };
    pkg.build.appId = "org.example.Music";
    pkg.productName = 'Music & <Friends> "Edition"';
    pkg.license = "MIT";
    pkg.homepage = "https://example.com/?one=1&two=2";
    pkg.build.publish = { provider: "github", owner: "example", repo: "music" };
    pkg.build.snapcraft.core24.summary = "Music & more";
    writeFileSync(path.join(directory, "package.json"), JSON.stringify(pkg));

    const output = generateAppStream(directory);
    const xml = readFileSync(output, "utf8");
    expect(path.basename(output)).toBe("org.example.Music.metainfo.xml");
    expect(xml).toContain("<id>org.example.Music</id>");
    expect(xml).toContain("org.example.Music.desktop</launchable>");
    expect(xml).toContain("Music &amp; &lt;Friends&gt; &quot;Edition&quot;</name>");
    expect(xml).toContain('<developer id="io.github.example"><name>Someone&apos;s Music &amp; Co</name></developer>');
    expect(xml).toContain("<summary>Music &amp; more</summary>");
    expect(xml).toContain("<project_license>MIT</project_license>");
    expect(xml).toContain("https://example.com/?one=1&amp;two=2</url>");
    expect(xml).toContain("https://github.com/example/music/issues</url>");
    expect(xml).not.toMatch(/Discord|controller/);
  });

  it("uses the annotated release tag date, not the source commit date", () => {
    const directory = fixture();
    writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      ...sourcePackage,
      author: "Example Developer <developer@example.com>",
    }));
    initialiseGit(directory);
    git(directory, ["tag", "-a", sourcePackage.version, "-m", "Release"], "2026-10-20T12:00:00Z");
    const xml = readFileSync(generateAppStream(directory), "utf8");
    expect(xml).toContain(`version="${sourcePackage.version}" date="2026-10-20" type="stable"`);
    expect(xml).toContain(`/releases/tag/${sourcePackage.version}</url>`);
    expect(xml).toContain(`/raw/${sourcePackage.version}/assets/sidra-screenshot.png`);
    expect(xml).toContain("<name>Example Developer</name>");
    expect(xml).not.toContain("developer@example.com");
  });

  it("marks an untagged version as development without a release URL", () => {
    const directory = fixture();
    initialiseGit(directory);
    const revision = git(directory, ["rev-parse", "HEAD"]);
    const xml = readFileSync(generateAppStream(directory), "utf8");
    expect(xml).toContain(`version="${sourcePackage.version}" date="2026-10-18" type="development"`);
    expect(xml).not.toContain("/releases/tag/");
    expect(xml).toContain(`/raw/${revision}/assets/sidra-screenshot.png`);
  });

  it("omits release history when a source archive has no Git metadata", () => {
    const xml = readFileSync(generateAppStream(fixture()), "utf8");
    expect(xml).not.toContain("<releases>");
    expect(xml).not.toContain("<screenshots>");
  });

  it("generates the configured Flatpak copy source only for the Flatpak target", async () => {
    const directory = fixture();
    const context = {
      electronPlatformName: "linux",
      targets: [{ name: "deb" }],
      packager: { projectDir: directory },
    };
    await afterPack(context);
    const [source, destination] = sourcePackage.build.flatpak.files[0] as [string, string];
    expect(existsSync(path.join(directory, source))).toBe(false);

    context.targets.push({ name: "flatpak" });
    await afterPack(context);
    expect(destination).toBe("/share/metainfo");
    const xml = readFileSync(path.join(directory, source, `${sourcePackage.build.appId}.metainfo.xml`), "utf8");
    expect(xml).toContain(`<id>${sourcePackage.build.appId}</id>`);
  });
});
