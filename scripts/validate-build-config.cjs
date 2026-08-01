const fs = require("fs");
const path = require("path");

function main() {
  const projectDir = process.cwd();

  // 1. The whole electron-builder config lives in package.json under "build",
  //    so reading that file reads the whole config. electron-builder exposes no
  //    public API for loading or schema-validating it, so no schema pass runs.
  const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
  const config = pkg.build ?? {};
  console.log("  \u2713 electron-builder config: read from package.json \"build\" (no schema check; electron-builder exposes no public validator)");

  // 2. Check for deprecated options
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

  // 3. Validate package.json author has email (required by RPM/DEB FPM targets)
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

  // 4. Validate Linux desktop actions used for launcher MPRIS controls.
  //    Only the D-Bus wiring is pinned; the labels are free to change.
  //    The MPRIS integration requests "org.mpris.MediaPlayer2." plus
  //    app.getName() lowercased, and Electron prefers productName over name,
  //    so the expected bus name is derived the same way and a rename fails here.
  const desktop = config.linux?.desktop;
  const busName = `org.mpris.MediaPlayer2.${String(pkg.productName ?? pkg.name).toLowerCase()}`;
  const actionMethods = ["PlayPause", "Next", "Previous", "Stop"];
  if (desktop?.entry?.Actions !== "PlayPause;Next;Previous;Stop;") {
    throw new Error("Linux desktop entry Actions must be PlayPause;Next;Previous;Stop;");
  }
  for (const method of actionMethods) {
    const action = desktop.desktopActions?.[method];
    if (action == null || typeof action !== "object") {
      throw new Error(`Linux desktop action ${method} is missing`);
    }
    if (typeof action.Name !== "string" || action.Name.trim() === "") {
      throw new Error(`Linux desktop action ${method}.Name must be a non-empty string`);
    }
    //    The Exec is matched token by token rather than as one whole string, so
    //    extra whitespace or a reordered flag stays harmless while the five
    //    parts that decide whether the launcher control works are all pinned:
    //    the command, the destination, the object path, the member and the
    //    argument count, because all four methods take no arguments.
    const exec = typeof action.Exec === "string" ? action.Exec : "";
    const tokens = exec.split(/\s+/).filter((token) => token !== "");
    const command = tokens.shift() ?? "";
    if (command !== "dbus-send" && !command.endsWith("/dbus-send")) {
      throw new Error(`Linux desktop action ${method}.Exec must run dbus-send`);
    }
    if (!tokens.includes(`--dest=${busName}`)) {
      throw new Error(`Linux desktop action ${method}.Exec must target --dest=${busName}`);
    }
    const operands = tokens.filter((token) => !token.startsWith("-"));
    if (operands[0] !== "/org/mpris/MediaPlayer2") {
      throw new Error(`Linux desktop action ${method}.Exec must use the object path /org/mpris/MediaPlayer2`);
    }
    if (operands[1] !== `org.mpris.MediaPlayer2.Player.${method}`) {
      throw new Error(`Linux desktop action ${method}.Exec must call org.mpris.MediaPlayer2.Player.${method}`);
    }
    if (operands.length > 2) {
      throw new Error(`Linux desktop action ${method}.Exec must pass no arguments to org.mpris.MediaPlayer2.Player.${method}`);
    }
  }
  console.log(`  \u2713 Linux desktop actions: wired to ${busName}`);

  console.log("\nAll configuration checks passed.");
}

try {
  main();
} catch (e) {
  console.error("\n  \u2717 " + e.message);
  process.exit(1);
}
