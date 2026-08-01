import { describe, it, expect, vi } from 'vitest';

import { errorMessage, runSteps } from '../src/utils';

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

describe('runSteps', () => {
  it('runs later steps after an earlier one throws, and reports instead of propagating', () => {
    const second = vi.fn();
    const third = vi.fn();
    const report = vi.fn();
    const boom = new Error('boom');

    expect(() => runSteps([
      ['first', () => { throw boom; }],
      ['second', second],
      ['third', third],
    ], report)).not.toThrow();

    expect(second).toHaveBeenCalledOnce();
    expect(third).toHaveBeenCalledOnce();
    expect(report).toHaveBeenCalledExactlyOnceWith('first', boom);
  });

  it('runs every step in order when none throw', () => {
    const order: string[] = [];
    const report = vi.fn();

    runSteps([
      ['a', () => { order.push('a'); }],
      ['b', () => { order.push('b'); }],
    ], report);

    expect(order).toEqual(['a', 'b']);
    expect(report).not.toHaveBeenCalled();
  });
});
