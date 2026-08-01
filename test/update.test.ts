import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/config', () => ({
  getNotificationsEnabled: vi.fn(() => false),
}));

vi.mock('../src/i18n', () => ({
  getUpdateStrings: vi.fn(() => ({ updateAvailable: 'Update available: {version}' })),
}));

import { isNewer } from '../src/update';

describe('isNewer', () => {
  it.each<[string, string, boolean]>([
    // Ordinary numeric comparison.
    ['1.0.0', '0.3.0', true], // major bump
    ['0.4.0', '0.3.0', true], // minor bump
    ['0.3.1', '0.3.0', true], // patch bump
    ['0.3.0', '0.3.0', false], // equal versions
    ['0.2.0', '0.3.0', false], // remote older
    ['0.10.0', '0.9.0', true], // double-digit part, where a string compare would lose
    ['0.3.0', '0.3.1', false], // patch decides when major and minor are equal

    // A part past the end of a short version counts as 0.
    ['1.0', '0.3.0', true], // short remote
    ['0.2', '0.3.0', false], // short remote
    ['1.0.0', '0.3', true], // short local
    ['0.2.0', '0.3', false], // short local
    ['0.3', '0.3.0', false], // equal across differing part counts
    ['0.3.0', '0.3', false], // equal across differing part counts
    ['1', '1.0.0', false], // equal across differing part counts

    // Only the first three parts are compared.
    ['0.3.0.1', '0.3.0', false], // a fourth part never decides
    ['0.3.1.0', '0.3.0.9', true], // the third part decides before the fourth is reached
    ['0.4.0.x', '0.3.0', true], // a non-numeric fourth part is never read, so it cannot refuse

    // A non-numeric part refuses the whole version, on either side.
    ['0.x.0', '0.3.0', false], // non-numeric part
    // NaN > x and NaN < x are both false, so testing NaN in the comparisons let
    // this fall through to the third part and offer an update over 0.3.0.
    ['0.x.99', '0.3.0', false], // non-numeric part before a larger later part
    // The minor part alone says 0.4.x is newer, but a tag Sidra cannot parse
    // must not drive an update prompt, so the whole version is refused.
    ['0.4.x', '0.3.0', false], // non-numeric part after a deciding part
    ['0.4.0', '0.x.0', false], // non-numeric part in the local version
    ['0.4.0', '0.3.x', false], // non-numeric part in the local version

    // Number('') is 0, so 2..0 once read as 2.0.0 and offered an update. A part
    // past the end of a short version still counts as 0; an empty one does not.
    ['2..0', '1.0.0', false], // empty part inside the remote version
    ['1..0', '0.3.0', false], // empty part inside the remote version
    ['2.0.0', '1..0', false], // empty part inside the local version

    // Number(' ') is 0 as well.
    ['1. .0', '0.9.0', false], // whitespace part in the remote version
    ['2.0.0', '1. .0', false], // whitespace part in the local version

    // Number('0x10') is 16.
    ['0x10.0.0', '1.0.0', false], // hexadecimal major part
    ['0.0x10.0', '0.3.0', false], // hexadecimal minor part
    ['2.0.0', '0x1.0.0', false], // hexadecimal part in the local version

    // Number('1e2') is 100.
    ['1e2.0.0', '1.0.0', false], // exponent major part
    ['0.1e2.0', '0.3.0', false], // exponent minor part
    ['2.0.0', '1e0.0.0', false], // exponent part in the local version

    // Deliberate: no Sidra release tag carries a sign, so a part spelling a
    // number Number() would accept is refused along with the rest.
    ['+2.0.0', '1.0.0', false], // leading plus
    ['2.0.0', '-1.0.0', false], // negative part in the local version
  ])('isNewer(%s, %s) is %s', (remote, local, expected) => {
    expect(isNewer(remote, local)).toBe(expected);
  });
});
