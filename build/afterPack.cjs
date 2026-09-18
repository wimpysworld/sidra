'use strict';

/**
 * Sign macOS packages with CastLabs EVS before Apple code-signing.
 * package.json registers this hook through build.afterPack.
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') {
    return;
  }

  const { signVmp } = require('./signVmp.cjs');
  await signVmp(context.appOutDir);
};
