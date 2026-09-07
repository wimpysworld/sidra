// The tray update link, update notification and main.ts window-open handler share openExternalUrl().
// Check its protocol allowlist and the URL that it passes to Chromium.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { shell } from 'electron';

import { openExternalUrl } from '../src/utils/openExternal';

const openExternal = vi.mocked(shell.openExternal);

// Separate logging mocks distinguish refusals from successful opens, unlike the shared mock in test/setup.ts.
// Deriving the type from openExternalUrl() keeps parameter changes checked without a cast.
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
  // The protocol gate must prevent JavaScript execution through external links.
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

  // Distinct warnings tell malformed URLs apart from blocked schemes. Check both so either branch cannot satisfy the other assertion.
  it('refuses a malformed URL with the malformed warning, not the protocol one', () => {
    openExternalUrl('not a url', scopedLog);

    expect(openExternal).not.toHaveBeenCalled();
    expect(scopedLog.warn).toHaveBeenCalledTimes(1);
    expect(scopedLog.warn).toHaveBeenCalledWith('blocked malformed external URL:', 'not a url');
    expect(warnings()[0]).not.toContain('disallowed protocol');
  });
});

describe('openExternalUrl normalisation', () => {
  // Chromium re-parses its argument, so open the parsed URL instead of the unchecked input string.
  // These inputs change during serialisation, which makes passing the raw string detectable.
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
