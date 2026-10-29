const fs = require("node:fs");

// Backport https://github.com/electron-userland/electron-builder/pull/10176.
// Snapcraft copies snap/gui itself. The extra mapping points at a missing file.
const mapping = '            desktop: `meta/gui/${desktopBaseName}.desktop`,\n';
const replacement = "            // Sidra: use the generated snap/gui desktop entry.\n";

function assertSnapDesktopVersion(version) {
  if (version !== "26.18.1") {
    throw new Error(`Review the Snap desktop backport for app-builder-lib ${version}.`);
  }
}

function patchSnapDesktop(source) {
  if (source.includes(replacement) && !source.includes(mapping)) {
    return source;
  }
  if (source.split(mapping).length !== 2) {
    throw new Error("Snap desktop backport no longer matches electron-builder. Review upstream PR #10176.");
  }
  return source.replace(mapping, replacement);
}

if (require.main === module) {
  assertSnapDesktopVersion(require("app-builder-lib/package.json").version);
  const target = require.resolve("app-builder-lib/out/targets/snap/core24.js");
  fs.writeFileSync(target, patchSnapDesktop(fs.readFileSync(target, "utf8")));
}

module.exports = { assertSnapDesktopVersion, patchSnapDesktop };
