// Write assets/lastfm-credentials.json from SIDRA_LASTFM_API_KEY and
// SIDRA_LASTFM_API_SECRET. npm's prebuild hook and the justfile build recipe
// both call this script, because npx tsc runs no npm hook.
//
// Without environment credentials, local builds keep a populated file or write
// empty values. Packaging needs the file for its asarUnpack entry.
// Tag builds require both values, so official packages include Last.fm.
//
// CI reads repository secrets. The output is gitignored because the shared
// secret belongs in build artefacts, never in the source tree.
const fs = require("fs");
const path = require("path");
const { isOfficialBuild, validateCredentialPair } = require("./release-credentials.cjs");

const apiKey = process.env.SIDRA_LASTFM_API_KEY || "";
const apiSecret = process.env.SIDRA_LASTFM_API_SECRET || "";
const credentialsAvailable = validateCredentialPair(
  process.env,
  "SIDRA_LASTFM_API_KEY",
  "SIDRA_LASTFM_API_SECRET",
  isOfficialBuild()
);

const outPath = path.join(__dirname, "..", "assets", "lastfm-credentials.json");

function alreadyPopulated() {
  try {
    const existing = JSON.parse(fs.readFileSync(outPath, "utf8"));
    return !!(existing.apiKey && existing.apiSecret);
  } catch {
    return false;
  }
}

if (!credentialsAvailable && alreadyPopulated()) {
  console.log("  ✓ Last.fm credentials kept (no env vars set)");
} else {
  fs.writeFileSync(
    outPath,
    JSON.stringify({ apiKey, apiSecret }, null, 2) + "\n"
  );

  console.log(
    credentialsAvailable
      ? "  ✓ Last.fm credentials injected"
      : "  ✓ Last.fm credentials file written empty (no env vars set)"
  );
}
