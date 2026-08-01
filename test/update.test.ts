import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/config', () => ({
  getNotificationsEnabled: vi.fn(() => false),
}));

vi.mock('../src/i18n', () => ({
  getUpdateStrings: vi.fn(() => ({ updateAvailable: 'Update available: {version}' })),
}));

import { isNewer } from '../src/update';

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
});
