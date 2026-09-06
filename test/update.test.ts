import { afterEach, describe, it, expect, vi } from 'vitest';
import { app, net, Tray } from 'electron';
import { notifyFake, resetNotifyFake } from './mocks/notify';

vi.mock('../src/config', () => ({
  getNotificationsEnabled: vi.fn(() => false),
}));

vi.mock('../src/i18n', () => ({
  getUpdateStrings: vi.fn(() => ({ updateAvailable: 'Update available: {version}' })),
}));

import { checkForUpdates, isNewer } from '../src/update';
import { getNotificationsEnabled } from '../src/config';

describe('update display name', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.mocked(getNotificationsEnabled).mockReturnValue(false);
  });

  it('uses the runtime name in the request and shared notification', async () => {
    vi.spyOn(app, 'getName').mockReturnValue('Test Player');
    vi.mocked(getNotificationsEnabled).mockReturnValue(true);
    resetNotifyFake('record');
    vi.mocked(net.fetch).mockResolvedValue(new Response(JSON.stringify({
      tag_name: 'v1.2.3',
      html_url: 'https://github.com/wimpysworld/sidra/releases/tag/1.2.3',
    })));

    await checkForUpdates(new Tray('icon'), vi.fn());

    expect(net.fetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/wimpysworld/sidra/releases/latest',
      expect.objectContaining({ headers: {
        'User-Agent': 'Test Player/0.3.0',
        'Accept': 'application/vnd.github.v3+json',
      } }),
    );
    expect(notifyFake.built).toHaveLength(1);
    expect(notifyFake.built[0].options).toEqual({
      title: 'Update available: 1.2.3', body: 'Test Player 1.2.3', silent: true,
    });
    expect(notifyFake.built[0].show).toHaveBeenCalledOnce();
  });
});

describe('isNewer', () => {
  it('detects major version bump', () => {
    expect(isNewer('1.0.0', '0.3.0')).toBe(true);
  });

  it('detects minor version bump', () => {
    expect(isNewer('0.4.0', '0.3.0')).toBe(true);
  });

  it('detects patch version bump', () => {
    expect(isNewer('0.3.1', '0.3.0')).toBe(true);
  });

  it('returns false for equal versions', () => {
    expect(isNewer('0.3.0', '0.3.0')).toBe(false);
  });

  it('returns false when remote is older', () => {
    expect(isNewer('0.2.0', '0.3.0')).toBe(false);
  });

  it('handles double-digit components', () => {
    expect(isNewer('0.10.0', '0.9.0')).toBe(true);
  });

  it('compares patch when major and minor are equal', () => {
    expect(isNewer('0.3.0', '0.3.1')).toBe(false);
  });

  it('treats a missing part of a short remote as 0', () => {
    expect(isNewer('1.0', '0.3.0')).toBe(true);
    expect(isNewer('0.2', '0.3.0')).toBe(false);
  });

  it('treats a missing part of a short local as 0', () => {
    expect(isNewer('1.0.0', '0.3')).toBe(true);
    expect(isNewer('0.2.0', '0.3')).toBe(false);
  });

  it('returns false for equal versions of differing part counts', () => {
    expect(isNewer('0.3', '0.3.0')).toBe(false);
    expect(isNewer('0.3.0', '0.3')).toBe(false);
    expect(isNewer('1', '1.0.0')).toBe(false);
  });

  it('compares only the first three parts', () => {
    expect(isNewer('0.3.0.1', '0.3.0')).toBe(false);
    expect(isNewer('0.3.1.0', '0.3.0.9')).toBe(true);
  });

  it('returns false for a non-numeric part', () => {
    expect(isNewer('0.x.0', '0.3.0')).toBe(false);
  });

  it('returns false when a non-numeric part precedes a larger later part', () => {
    expect(isNewer('0.x.99', '0.3.0')).toBe(false);
  });

  it('returns false when a non-numeric part follows a deciding part', () => {
    // The minor part alone says 0.4.x is newer, but a tag Sidra cannot parse
    // must not drive an update prompt, so the whole version is refused.
    expect(isNewer('0.4.x', '0.3.0')).toBe(false);
  });

  it('returns false for a non-numeric part in the local version', () => {
    expect(isNewer('0.4.0', '0.x.0')).toBe(false);
    expect(isNewer('0.4.0', '0.3.x')).toBe(false);
  });

  it('ignores a non-numeric part beyond the third', () => {
    expect(isNewer('0.4.0.x', '0.3.0')).toBe(true);
  });

  it('returns false for an empty part inside the version', () => {
    // Number('') is 0, so 2..0 once read as 2.0.0 and offered an update. A part
    // past the end of a short version still counts as 0; an empty one does not.
    expect(isNewer('2..0', '1.0.0')).toBe(false);
    expect(isNewer('1..0', '0.3.0')).toBe(false);
    expect(isNewer('2.0.0', '1..0')).toBe(false);
  });

  it('returns false for a whitespace part', () => {
    // Number(' ') is 0 as well.
    expect(isNewer('1. .0', '0.9.0')).toBe(false);
    expect(isNewer('2.0.0', '1. .0')).toBe(false);
  });

  it('returns false for a hexadecimal part', () => {
    // Number('0x10') is 16.
    expect(isNewer('0x10.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.0x10.0', '0.3.0')).toBe(false);
    expect(isNewer('2.0.0', '0x1.0.0')).toBe(false);
  });

  it('returns false for an exponent part', () => {
    // Number('1e2') is 100.
    expect(isNewer('1e2.0.0', '1.0.0')).toBe(false);
    expect(isNewer('0.1e2.0', '0.3.0')).toBe(false);
    expect(isNewer('2.0.0', '1e0.0.0')).toBe(false);
  });

  it('returns false for a signed part', () => {
    // Deliberate: no Sidra release tag carries a sign, so a part spelling a
    // number Number() would accept is refused along with the rest.
    expect(isNewer('+2.0.0', '1.0.0')).toBe(false);
    expect(isNewer('2.0.0', '-1.0.0')).toBe(false);
  });
});
