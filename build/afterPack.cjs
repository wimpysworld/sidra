"use strict";

/**
 * Prepare Flatpak metadata and sign macOS packages before Apple code-signing.
 * package.json registers this hook through build.afterPack.
 */
exports.default = async function afterPack(context) {
 if (context.electronPlatformName === "linux" && context.targets.some((target) => target.name === "flatpak")) {
  const { generateAppStream } = require("./appstream.cjs");
  generateAppStream(context.packager.projectDir);
 }

 if (context.electronPlatformName !== "darwin") {
  return;
 }

 const { signVmp } = require("./signVmp.cjs");
 await signVmp(context.appOutDir);
};
