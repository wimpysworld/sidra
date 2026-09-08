import { describe, it, expect, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

import { errorMessage, liveWebContents, runSteps } from '../src/utils';

/**
 * A window whose webContents getter throws once it is destroyed, as Electron's
 * native getter does. A plain property would let an unguarded read pass.
 */
function stubWindow(options: { destroyed?: boolean; contentsDestroyed?: boolean } = {}): {
  win: BrowserWindow;
  contents: { isDestroyed: () => boolean };
  reads: () => number;
} {
  const contents = { isDestroyed: () => options.contentsDestroyed === true };
  let reads = 0;
  const win = {
    isDestroyed: () => options.destroyed === true,
    get webContents() {
      reads++;
      if (options.destroyed === true) throw new TypeError('Object has been destroyed');
      return contents;
    },
  };
  return { win: win as unknown as BrowserWindow, contents, reads: () => reads };
}

describe('liveWebContents', () => {
  it('returns the renderer of a live window', () => {
    const { win, contents } = stubWindow();
    expect(liveWebContents(win)).toBe(contents);
  });

  it('returns null for null and undefined', () => {
    expect(liveWebContents(null)).toBeNull();
    expect(liveWebContents(undefined)).toBeNull();
  });

  it('returns null without reading the getter of a destroyed window', () => {
    const { win, reads } = stubWindow({ destroyed: true });

    expect(liveWebContents(win)).toBeNull();
    expect(reads()).toBe(0);
  });

  it('returns null when the window is live but its renderer is destroyed', () => {
    const { win } = stubWindow({ contentsDestroyed: true });
    expect(liveWebContents(win)).toBeNull();
  });
});

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
