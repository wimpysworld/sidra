// src/utils/openExternal.ts is the single gate every external-link path passes
// through: the tray update item, the update notification click and the
// setWindowOpenHandler in main.ts all call it. One gate means one place to
// break, so the protocol allowlist and the argument handed to Chromium are
// pinned here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shell } from 'electron';

import { openExternalUrl } from '../src/utils/openExternal';

const openExternal = vi.mocked(shell.openExternal);

// The electron-log stand-in in test/setup.ts shares one mock across every scope
// method, so warn and debug cannot be told apart there. This fake gives each
// level its own mock, which is what separates a refusal from an open. It is
// typed off the function under test, so a change to the parameter type fails
// the build rather than passing through a cast.
type ScopedLog = Parameters<typeof openExternalUrl>[1];

function fakeLog(): ScopedLog {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    verbose: vi.fn(),
    debug: vi.fn(),
    silly: vi.fn(),
    log: vi.fn(),
  };
}

let scopedLog: ScopedLog;

/** The text of every warning, one string per call. */
function warnings(): string[] {
  return vi.mocked(scopedLog.warn).mock.calls.map((call) => call.join(' '));
}

/** Runs after the rejection handler openExternalUrl attached has settled. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

beforeEach(() => {
  vi.clearAllMocks();
  openExternal.mockImplementation(() => Promise.resolve());
  scopedLog = fakeLog();
});

describe('openExternalUrl allowed protocols', () => {
  it('opens an https URL', () => {
    openExternalUrl('https://music.apple.com/gb/browse', scopedLog);

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('https://music.apple.com/gb/browse');
    expect(scopedLog.warn).not.toHaveBeenCalled();
  });

  it('opens an http URL', () => {
    openExternalUrl('http://example.com/notes', scopedLog);

    expect(openExternal).toHaveBeenCalledTimes(1);
    expect(openExternal).toHaveBeenCalledWith('http://example.com/notes');
    expect(scopedLog.warn).not.toHaveBeenCalled();
  });
});

describe('openExternalUrl refusals', () => {
  // A javascript: URL handed to the browser is the payload this gate exists to
  // stop, so it gets its own case rather than a row in the table below.
  it('refuses a javascript URL, opens nothing and warns', () => {
    openExternalUrl('javascript:alert(1)', scopedLog);

    expect(openExternal).not.toHaveBeenCalled();
    expect(scopedLog.warn).toHaveBeenCalledTimes(1);
    expect(scopedLog.warn).toHaveBeenCalledWith(
      'blocked external URL with disallowed protocol:',
      'javascript:alert(1)',
    );
  });

  it.each([
    ['file', 'file:///etc/passwd'],
    ['itms', 'itms://music.apple.com/gb/album/1'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
  ])('refuses a %s URL', (_name, url) => {
    openExternalUrl(url, scopedLog);

    expect(openExternal).not.toHaveBeenCalled();
    expect(warnings()).toEqual([`blocked external URL with disallowed protocol: ${url}`]);
  });

  // The two refusals log different lines and the distinction is what tells a
  // user reading the log a typo from a blocked scheme. A single "blocked"
  // assertion would pass with either branch taken.
  it('refuses a malformed URL with the malformed warning, not the protocol one', () => {
    openExternalUrl('not a url', scopedLog);

    expect(openExternal).not.toHaveBeenCalled();
    expect(scopedLog.warn).toHaveBeenCalledTimes(1);
    expect(scopedLog.warn).toHaveBeenCalledWith('blocked malformed external URL:', 'not a url');
    expect(warnings()[0]).not.toContain('disallowed protocol');
  });
});

describe('openExternalUrl normalisation', () => {
  // Chromium re-parses whatever string it is given, so the checked URL and the
  // opened URL must be the same object. Each row is an input whose re-serialised
  // form differs from the caller's string: if the raw string were passed on, the
  // assertion reads back the input instead.
  it.each([
    ['drops a default port', 'https://music.apple.com:443/gb/browse', 'https://music.apple.com/gb/browse'],
    ['lowercases the host', 'https://Music.Apple.COM/gb/browse', 'https://music.apple.com/gb/browse'],
    ['resolves dot segments', 'https://music.apple.com/gb/../us/browse', 'https://music.apple.com/us/browse'],
    ['adds the root path', 'https://music.apple.com', 'https://music.apple.com/'],
  ])('%s', (_name, input, expected) => {
    openExternalUrl(input, scopedLog);

    expect(openExternal).toHaveBeenCalledWith(expected);
    expect(openExternal).not.toHaveBeenCalledWith(input);
  });
});

describe('openExternalUrl failure handling', () => {
  it('catches a rejected open and logs the reason', async () => {
    openExternal.mockImplementation(() => Promise.reject(new Error('no browser')));

    expect(() => { openExternalUrl('https://example.com/', scopedLog); }).not.toThrow();
    await flush();

    expect(warnings()).toEqual(['failed to open browser: no browser']);
  });

  it('logs a non-Error rejection as text', async () => {
    openExternal.mockImplementation(() => Promise.reject('spawn failed'));

    openExternalUrl('https://example.com/', scopedLog);
    await flush();

    expect(warnings()).toEqual(['failed to open browser: spawn failed']);
  });
});
