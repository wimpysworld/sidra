// Writes assets/lastfm-credentials.json from the SIDRA_LASTFM_API_KEY and
// SIDRA_LASTFM_API_SECRET environment variables. Runs as the npm `prebuild`
// step, so a normal `npm run build` (locally and in CI) always produces the
// file. In CI the env vars come from repository secrets; with no env set the
// file is written empty and the integration stays inert.
//
// The output file is gitignored - the shared secret must never be committed to
// the source tree. The real secret ends up only in official build artefacts.
const fs = require("fs");
const path = require("path");

const apiKey = process.env.SIDRA_LASTFM_API_KEY || "";
const apiSecret = process.env.SIDRA_LASTFM_API_SECRET || "";

const outPath = path.join(__dirname, "..", "assets", "lastfm-credentials.json");
fs.writeFileSync(outPath, JSON.stringify({ apiKey, apiSecret }, null, 2) + "\n");

console.log(
  apiKey && apiSecret
    ? "  ✓ Last.fm credentials injected"
    : "  ✓ Last.fm credentials file written empty (no env vars set)"
);
