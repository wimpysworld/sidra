'use strict';

/**
 * afterPack hook: signs the packaged app with CastLabs EVS production VMP keys.
 * electron-builder runs it from the "build.afterPack" key in package.json.
 *
 * VMP signing must happen BEFORE macOS code-signing, which is why this is an
 * afterPack hook and not afterSign. Without production VMP keys, Widevine
 * refuses DRM licences on macOS.
 * Linux does not enforce VMP so this hook is a no-op there.
 *
 * Absent EVS credentials the signing is skipped rather than failed, so a
 * contributor without an EVS account can still produce an unsigned build.
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

  const { execFileSync } = require('child_process');

  console.log('EVS: Signing package with production VMP keys...');
  try {
    execFileSync('uvx', ['--from', 'castlabs-evs', 'evs-vmp', 'sign-pkg', appOutDir], {
      stdio: 'inherit',
    });
    console.log('EVS: VMP signing complete.');
  } catch (err) {
    console.error('EVS: VMP signing failed. Ensure castlabs_evs is installed:');
    console.error('  uvx --from castlabs-evs evs-account signup');
    throw err;
  }
};
