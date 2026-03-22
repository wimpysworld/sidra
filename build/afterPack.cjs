'use strict';

/**
 * afterPack hook: signs the packaged app with CastLabs EVS production VMP keys.
 *
 * VMP signing must happen BEFORE macOS code-signing (afterPack, not afterSign).
 * Without production VMP keys, Widevine refuses DRM licences on macOS.
 * Linux does not enforce VMP so this hook is a no-op there.
 *
 * Setup: uvx --from castlabs-evs evs-account signup
 * Docs:  https://github.com/castlabs/electron-releases/wiki/EVS
 */
exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;

  if (electronPlatformName !== 'darwin' && electronPlatformName !== 'win32') {
    return;
  }

  if (!process.env.EVS_ACCOUNT_NAME || !process.env.EVS_PASSWD) {
    console.log('EVS: Skipping VMP signing (credentials not available).');
    return;
  }

  const { execSync } = require('child_process');

  console.log('EVS: Signing package with production VMP keys...');
  try {
    execSync(`uvx --from castlabs-evs evs-vmp sign-pkg "${appOutDir}"`, {
      stdio: 'inherit',
    });
    console.log('EVS: VMP signing complete.');
  } catch (err) {
    console.error('EVS: VMP signing failed. Ensure castlabs_evs is installed:');
    console.error('  uvx --from castlabs-evs evs-account signup');
    throw err;
  }
};
