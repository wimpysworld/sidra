'use strict';

/**
 * Sign Windows packages with CastLabs EVS after PE resource edits and Authenticode.
 * package.json registers this hook through build.afterSign.
 */
exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'win32') {
    return;
  }

  const { signVmp } = require('./signVmp.cjs');
  await signVmp(context.appOutDir);
};
