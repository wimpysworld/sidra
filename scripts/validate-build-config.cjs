// Check packaging settings through just validate and builder.yml's test-config
// job, so configuration faults fail before installers reach users.
const fs = require("fs");
const path = require("path");

function main() {
  const projectDir = process.cwd();

  // package.json holds the complete build configuration. No schema check runs
  // because electron-builder exposes no public validator. Internal paths under
  // app-builder-lib/out/ can break on dependency updates with module-not-found
  // errors instead of configuration errors.
  const pkg = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8"));
  const config = pkg.build ?? {};
  console.log("  \u2713 electron-builder config: read from package.json \"build\" (no schema check; electron-builder exposes no public validator)");

  // Reject obsolete options that electron-builder can otherwise ignore.
  // Each error names the supported replacement.
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

  // FPM requires the author's email for the deb/rpm maintainer field.
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

  // Pin the D-Bus commands for launcher controls, not their labels.
  // Match the MPRIS integration's lowercased app.getName(), which prefers
  // productName over name, so a product rename requires matching commands.
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
    // Match tokens so whitespace and option order can vary without accepting
    // a wrong command, destination, object path or member. The member must be
    // last because dbus-send treats later tokens as message arguments.
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
    if (tokens[tokens.length - 1] !== `org.mpris.MediaPlayer2.Player.${method}`) {
      throw new Error(
        `Linux desktop action ${method}.Exec must end with org.mpris.MediaPlayer2.Player.${method}.\n` +
        "dbus-send stops parsing options at the member, so any later token is read as a\n" +
        "type:value message argument; a trailing flag or argument makes it exit 1 and the\n" +
        "call is never sent."
      );
    }
  }
  console.log(`  \u2713 Linux desktop actions: wired to ${busName}`);

  // electron-builder installs each PNG of the Linux icon set into
  // hicolor/<size>x<size>/apps. A size the hicolor theme does not register is
  // never found, so the desktop shows a generic icon (issue #256). A single PNG
  // file here yields exactly one size, which is how 1024x1024 shipped alone.
  const registeredHicolorSizes = new Set([16, 22, 24, 32, 36, 48, 64, 72, 96, 128, 192, 256, 512]);
  const iconSetting = config.linux?.icon;
  if (typeof iconSetting !== "string" || iconSetting === "") {
    throw new Error("build.linux.icon must name the Linux icon set directory");
  }
  const iconDir = path.join(projectDir, iconSetting);
  if (!fs.existsSync(iconDir) || !fs.statSync(iconDir).isDirectory()) {
    throw new Error(
      `build.linux.icon must be a directory of sized PNGs, not a single file: ${iconSetting}\n` +
      "electron-builder emits one icon from a single PNG and installs it under\n" +
      "hicolor/<size>x<size>/apps, so only that one size reaches the desktop."
    );
  }
  const iconSizes = fs.readdirSync(iconDir)
    .map((name) => /^(\d+)x\1\.png$/.exec(name))
    .filter((match) => match !== null)
    .map((match) => Number(match[1]));
  if (iconSizes.length === 0) {
    throw new Error(`build.linux.icon directory holds no <size>x<size>.png files: ${iconSetting}`);
  }
  const unregistered = iconSizes.filter((size) => !registeredHicolorSizes.has(size)).sort((a, b) => a - b);
  if (unregistered.length > 0) {
    throw new Error(
      `build.linux.icon holds sizes the hicolor theme does not register: ${unregistered.join(", ")}.\n` +
      "Icons installed there are never found. Run just generate-assets."
    );
  }
  if (!iconSizes.includes(512)) {
    throw new Error("build.linux.icon must include 512x512.png, the largest registered hicolor size");
  }
  console.log(`  \u2713 Linux icon set: ${iconSizes.sort((a, b) => a - b).join(", ")} in registered hicolor sizes`);

  console.log("\nAll configuration checks passed.");
}

try {
  main();
} catch (e) {
  console.error("\n  \u2717 " + e.message);
  process.exit(1);
}
