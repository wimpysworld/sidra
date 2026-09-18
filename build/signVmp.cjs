'use strict';

/** Sign a packaged application directory with CastLabs EVS production VMP keys. */
exports.signVmp = async function signVmp(appOutDir) {
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
