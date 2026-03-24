import { describe, it, expect } from 'vitest';

import { errorMessage } from '../src/utils';

describe('errorMessage', () => {
  it('extracts message from Error instances', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
  });

  it('returns plain strings as-is', () => {
    expect(errorMessage('plain string')).toBe('plain string');
  });

  it('converts numbers to string', () => {
    expect(errorMessage(42)).toBe('42');
  });

  it('converts null to string', () => {
    expect(errorMessage(null)).toBe('null');
  });

  it('converts undefined to string', () => {
    expect(errorMessage(undefined)).toBe('undefined');
  });

  it('uses toString() on objects', () => {
    expect(errorMessage({ toString() { return 'custom'; } })).toBe('custom');
  });
});
