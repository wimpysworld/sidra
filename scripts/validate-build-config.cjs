const validateSchema = require("@develar/schema-utils");
const { getConfig } = require("app-builder-lib/out/util/config/config");
const { DebugLogger } = require("builder-util");
const fs = require("fs");
const path = require("path");

async function main() {
  const projectDir = process.cwd();

  // 1. Load and resolve the full electron-builder config (merges defaults,
  //    parent configs, and package.json "build" field - same as a real build)
  const config = await getConfig(projectDir, null, null);

  // 2. Validate against electron-builder's JSON schema using @develar/schema-utils
  //    directly. This is the technique electron-builder uses internally and gives
  //    detailed, actionable error messages for any schema violation.
  const schema = require("app-builder-lib/scheme.json");
  validateSchema(schema, config, { name: "electron-builder" });
  console.log("  \u2713 electron-builder config schema: valid");

  // 3. Check for deprecated options that schema validation does not catch
  if (config.npmSkipBuildFromSource === false) {
    throw new Error("npmSkipBuildFromSource is deprecated; use buildDependenciesFromSource");
  }
  if (config.appImage != null && config.appImage.systemIntegration != null) {
    throw new Error("appImage.systemIntegration is deprecated; use AppImageLauncher for desktop integration");
  }
  if (config.extraMetadata != null) {
    if (config.extraMetadata.build != null) {
      throw new Error("extraMetadata.build is deprecated; specify as -c instead");
    }
    if (config.extraMetadata.directories != null) {
      throw new Error("extraMetadata.directories is deprecated; specify as -c.directories instead");
    }
  }
  console.log("  \u2713 no deprecated options detected");

  // 4. Validate package.json author has email (required by RPM/DEB FPM targets)
  const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
  const author = pkg.author;
  const emailRegex = /<[^>]+@[^>]+>/;
  if (typeof author === "string") {
    if (!emailRegex.test(author)) {
      throw new Error(
        "package.json 'author' must include an email (e.g. \"Name <email>\").\n" +
        "Required for Linux .deb/.rpm maintainer field."
      );
    }
  } else if (typeof author === "object" && author !== null) {
    if (!author.email) {
      throw new Error(
        "package.json 'author.email' must be set.\n" +
        "Required for Linux .deb/.rpm maintainer field."
      );
    }
  } else {
    throw new Error("package.json 'author' field is missing.");
  }
  console.log("  \u2713 package.json author email: present");

  console.log("\nAll configuration checks passed.");
}

main().catch(e => {
  console.error("\n  \u2717 " + e.message);
  process.exit(1);
});
