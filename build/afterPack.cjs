'use strict';

/**
 * Sign macOS and Windows packages with CastLabs EVS production VMP keys.
 * package.json registers this hook through build.afterPack.
 *
 * VMP signing must precede macOS code-signing, so this uses afterPack, not
 * afterSign. Without production VMP keys, Widevine refuses DRM licences on
 * macOS. Linux does not enforce VMP and needs no signing here.
 *
 * Local builds skip signing when both EVS credentials are absent. Tag builds
 * require both credentials, so these packages cannot ship without VMP signing.
 *
 * Setup: read EVS_PACKAGE from build/evs.cjs, then run
 *        uvx --from <package> evs-account signup
 * Docs:  https://github.com/castlabs/electron-releases/wiki/EVS
 */
exports.default = async function afterPack(context) {
  const { appOutDir, electronPlatformName } = context;

  if (electronPlatformName !== 'darwin' && electronPlatformName !== 'win32') {
    return;
  }

  const { EVS_PACKAGE } = require('./evs.cjs');
  const { isOfficialBuild, validateCredentialPair } = require('../scripts/release-credentials.cjs');
  const credentialsAvailable = validateCredentialPair(
    process.env,
    'EVS_ACCOUNT_NAME',
    'EVS_PASSWD',
    isOfficialBuild(),
  );

  if (!credentialsAvailable) {
    console.log('EVS: Skipping VMP signing (credentials not available).');
    return;
  }

  const { execFileSync } = require('child_process');

  console.log('EVS: Signing package with production VMP keys...');
  try {
    execFileSync('uvx', ['--from', EVS_PACKAGE, 'evs-vmp', 'sign-pkg', appOutDir], {
      stdio: 'inherit',
    });
    console.log('EVS: VMP signing complete.');
  } catch (err) {
    console.error('EVS: VMP signing failed. Ensure castlabs_evs is installed:');
    console.error(`  uvx --from ${EVS_PACKAGE} evs-account signup`);
    throw err;
  }
};
