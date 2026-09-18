import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

const childProcess = require('child_process') as typeof import('node:child_process');

interface ReleaseCredentials {
  isOfficialBuild(env?: NodeJS.ProcessEnv): boolean;
  validateCredentialPair(
    env: NodeJS.ProcessEnv,
    firstName: string,
    secondName: string,
    required?: boolean,
  ): boolean;
}

const { isOfficialBuild, validateCredentialPair } = require('../scripts/release-credentials.cjs') as ReleaseCredentials;
const { EVS_PACKAGE } = require('../build/evs.cjs') as { EVS_PACKAGE: string };
interface HookContext {
  appOutDir: string;
  electronPlatformName: string;
}

type BuildHook = (context: HookContext) => Promise<void>;

const afterPack = require('../build/afterPack.cjs').default as BuildHook;
const afterSign = require('../build/afterSign.cjs').default as BuildHook;
const builderWorkflow = readFileSync('.github/workflows/builder.yml', 'utf8');
const manualSnapWorkflow = readFileSync('.github/workflows/publish-snap-manual.yml', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8')) as {
  build: {
    afterPack?: string;
    afterSign?: string;
    win?: { signAndEditExecutable?: boolean };
  };
};
const activeHooks = [
  { name: 'macOS afterPack', hook: afterPack, platform: 'darwin' },
  { name: 'Windows afterSign', hook: afterSign, platform: 'win32' },
] as const;

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('release credential gates', () => {
  it('recognises GitHub tag builds as official', () => {
    expect(isOfficialBuild({ GITHUB_REF_TYPE: 'tag' })).toBe(true);
    expect(isOfficialBuild({ GITHUB_REF_TYPE: 'branch' })).toBe(false);
    expect(isOfficialBuild({})).toBe(false);
  });

  it('allows an unconfigured local build', () => {
    expect(validateCredentialPair({}, 'KEY', 'SECRET')).toBe(false);
  });

  it('rejects a partial credential pair', () => {
    expect(() => validateCredentialPair({ KEY: 'key' }, 'KEY', 'SECRET')).toThrow('KEY and SECRET must be set together');
    expect(() => validateCredentialPair({ SECRET: 'secret' }, 'KEY', 'SECRET')).toThrow(
      'KEY and SECRET must be set together',
    );
  });

  it('requires a complete pair for an official build', () => {
    expect(() => validateCredentialPair({}, 'KEY', 'SECRET', true)).toThrow(
      'KEY and SECRET are required for tag builds',
    );
    expect(validateCredentialPair({ KEY: 'key', SECRET: 'secret' }, 'KEY', 'SECRET', true)).toBe(true);
  });
});

describe('release build scripts', () => {
  it('ignores platforms outside each hook phase before credential validation', async () => {
    vi.stubEnv('GITHUB_REF_TYPE', 'tag');
    vi.stubEnv('EVS_ACCOUNT_NAME', '');
    vi.stubEnv('EVS_PASSWD', '');
    const execFileSync = vi.spyOn(childProcess, 'execFileSync');

    await expect(afterPack({ appOutDir: '/tmp/sidra-test', electronPlatformName: 'win32' })).resolves.toBeUndefined();
    await expect(afterPack({ appOutDir: '/tmp/sidra-test', electronPlatformName: 'linux' })).resolves.toBeUndefined();
    await expect(afterSign({ appOutDir: '/tmp/sidra-test', electronPlatformName: 'darwin' })).resolves.toBeUndefined();
    await expect(afterSign({ appOutDir: '/tmp/sidra-test', electronPlatformName: 'linux' })).resolves.toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it('invokes production VMP signing only in each platform active phase', async () => {
    vi.stubEnv('GITHUB_REF_TYPE', 'tag');
    vi.stubEnv('EVS_ACCOUNT_NAME', 'account');
    vi.stubEnv('EVS_PASSWD', 'password');
    const execFileSync = vi.spyOn(childProcess, 'execFileSync').mockReturnValue(Buffer.alloc(0));

    await afterPack({ appOutDir: '/tmp/sidra-macos', electronPlatformName: 'darwin' });
    await afterSign({ appOutDir: '/tmp/sidra-windows', electronPlatformName: 'win32' });

    expect(execFileSync).toHaveBeenNthCalledWith(
      1,
      'uvx',
      ['--from', EVS_PACKAGE, 'evs-vmp', 'sign-pkg', '/tmp/sidra-macos'],
      { stdio: 'inherit' },
    );
    expect(execFileSync).toHaveBeenNthCalledWith(
      2,
      'uvx',
      ['--from', EVS_PACKAGE, 'evs-vmp', 'sign-pkg', '/tmp/sidra-windows'],
      { stdio: 'inherit' },
    );
    expect(execFileSync).toHaveBeenCalledTimes(2);
  });

  it.each(activeHooks)('$name skips an unconfigured local build', async ({ hook, platform }) => {
    vi.stubEnv('GITHUB_REF_TYPE', 'branch');
    vi.stubEnv('EVS_ACCOUNT_NAME', '');
    vi.stubEnv('EVS_PASSWD', '');
    const execFileSync = vi.spyOn(childProcess, 'execFileSync');

    await expect(hook({ appOutDir: '/tmp/sidra-test', electronPlatformName: platform })).resolves.toBeUndefined();
    expect(execFileSync).not.toHaveBeenCalled();
  });

  it.each(activeHooks)('$name rejects missing credentials for a tag build', async ({ hook, platform }) => {
    vi.stubEnv('GITHUB_REF_TYPE', 'tag');
    vi.stubEnv('EVS_ACCOUNT_NAME', '');
    vi.stubEnv('EVS_PASSWD', '');

    await expect(hook({ appOutDir: '/tmp/sidra-test', electronPlatformName: platform })).rejects.toThrow(
      'EVS_ACCOUNT_NAME and EVS_PASSWD are required for tag builds',
    );
  });

  it.each(activeHooks)('$name rejects partial credentials', async ({ hook, platform }) => {
    vi.stubEnv('GITHUB_REF_TYPE', 'branch');
    vi.stubEnv('EVS_ACCOUNT_NAME', 'account');
    vi.stubEnv('EVS_PASSWD', '');

    await expect(hook({ appOutDir: '/tmp/sidra-test', electronPlatformName: platform })).rejects.toThrow(
      'EVS_ACCOUNT_NAME and EVS_PASSWD must be set together',
    );
  });

  it.each(activeHooks)('$name propagates an EVS failure', async ({ hook, platform }) => {
    vi.stubEnv('GITHUB_REF_TYPE', 'tag');
    vi.stubEnv('EVS_ACCOUNT_NAME', 'account');
    vi.stubEnv('EVS_PASSWD', 'password');
    vi.spyOn(childProcess, 'execFileSync').mockImplementation(() => {
      throw new Error('EVS failed');
    });

    await expect(hook({ appOutDir: '/tmp/sidra-test', electronPlatformName: platform })).rejects.toThrow('EVS failed');
  });

  it('fails Last.fm injection before writing an unconfigured tag build', () => {
    const result = childProcess.spawnSync(process.execPath, ['scripts/inject-lastfm-credentials.cjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: {
        ...process.env,
        GITHUB_REF_TYPE: 'tag',
        SIDRA_LASTFM_API_KEY: '',
        SIDRA_LASTFM_API_SECRET: '',
      },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      'SIDRA_LASTFM_API_KEY and SIDRA_LASTFM_API_SECRET are required for tag builds',
    );
  });
});

it('pins castlabs-evs to an exact release', () => {
  expect(EVS_PACKAGE).toMatch(/^castlabs-evs==\d+\.\d+\.\d+$/);
});

it('registers the platform VMP hooks without disabling Windows executable edits', () => {
  expect(packageJson.build.afterPack).toBe('build/afterPack.cjs');
  expect(packageJson.build.afterSign).toBe('build/afterSign.cjs');
  expect(packageJson.build.win?.signAndEditExecutable).not.toBe(false);
});

it('restricts Last.fm credentials to tag builds', () => {
  expect(builderWorkflow).toContain(
    "SIDRA_LASTFM_API_KEY: ${{ startsWith(github.ref, 'refs/tags/') && secrets.SIDRA_LASTFM_API_KEY || '' }}",
  );
  expect(builderWorkflow).toContain(
    "SIDRA_LASTFM_API_SECRET: ${{ startsWith(github.ref, 'refs/tags/') && secrets.SIDRA_LASTFM_API_SECRET || '' }}",
  );
});

it('does not expose EVS credentials to the Linux Snap build', () => {
  expect(manualSnapWorkflow).not.toContain('EVS_ACCOUNT_NAME');
  expect(manualSnapWorkflow).not.toContain('EVS_PASSWD');
});
