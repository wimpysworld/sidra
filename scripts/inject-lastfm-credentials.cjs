// Writes assets/lastfm-credentials.json from the SIDRA_LASTFM_API_KEY and
// SIDRA_LASTFM_API_SECRET environment variables. It runs from npm's `prebuild`
// hook and from the `build` recipe in the justfile, because `npx tsc` fires no
// npm hook. In CI the env vars come from repository secrets.
//
// With no env set the file is written empty rather than left absent, because
// it is named in asarUnpack and packaging fails on a missing entry; an empty
// key leaves the integration inert and the tray hides Last.fm entirely.
//
// An existing file that already holds credentials is left alone when the env is
// unset, so building in a shell without the vars does not blank a working
// local setup.
//
// The output file is gitignored - the shared secret must never be committed to
// the source tree. The real secret ends up only in official build artefacts.
const fs = require("fs");
const path = require("path");

const apiKey = process.env.SIDRA_LASTFM_API_KEY || "";
const apiSecret = process.env.SIDRA_LASTFM_API_SECRET || "";

const outPath = path.join(__dirname, "..", "assets", "lastfm-credentials.json");

function alreadyPopulated() {
  try {
    const existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
    return !!(existing.apiKey && existing.apiSecret);
  } catch {
    return false;
  }
}

if ((!apiKey || !apiSecret) && alreadyPopulated()) {
  console.log("  ✓ Last.fm credentials kept (no env vars set)");
} else {
  fs.writeFileSync(
    outPath,
    JSON.stringify({ apiKey, apiSecret }, null, 2) + "\n"
  );

  console.log(
    apiKey && apiSecret
      ? "  ✓ Last.fm credentials injected"
      : "  ✓ Last.fm credentials file written empty (no env vars set)"
  );
}
