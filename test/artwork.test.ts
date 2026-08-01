// test/artwork.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import { Readable } from 'stream';

// Mock fs before importing the module under test
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(),
  },
}));

// Mock fs/promises before importing the module under test
vi.mock('fs/promises', () => ({
  default: {
    rename: vi.fn(() => Promise.resolve()),
    unlink: vi.fn(() => Promise.resolve()),
    readdir: vi.fn(() => Promise.resolve([])),
    stat: vi.fn(() => Promise.resolve({ mtimeMs: Date.now() })),
    utimes: vi.fn(() => Promise.resolve()),
  },
}));

import fs from 'fs';
import fsPromises from 'fs/promises';
import { net } from 'electron';

// Helper: create a mock writable stream (file) that behaves like fs.createWriteStream
function createMockFile() {
  const emitter = new EventEmitter();
  const file = Object.assign(emitter, {
    close: vi.fn((cb?: (err?: Error | null) => void) => {
      if (cb) cb(null);
    }),
    destroy: vi.fn(),
  });
  return file;
}

// Helper: create a readable stream from a buffer for use as response.body
function createReadableBody(data: Buffer = Buffer.from('image-data')): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from(data)) as ReadableStream<Uint8Array>;
}

// Helper: create a mock fetch Response
function createMockResponse(status: number, ok: boolean, body?: ReadableStream<Uint8Array> | null) {
  return {
    ok,
    status,
    body: body !== undefined ? body : (ok ? createReadableBody() : null),
  } as unknown as Response;
}

// Helper: install a write stream mock that emits 'finish' once pipe attaches its listener
function mockFinishingWriteStream() {
  const file = createMockFile();
  const origOn = file.on.bind(file);
  file.on = vi.fn((event: string, cb: (...args: unknown[]) => void) => {
    origOn(event, cb);
    if (event === 'finish') {
      process.nextTick(() => file.emit('finish'));
    }
    return file;
  }) as typeof file.on;
  vi.mocked(fs.createWriteStream).mockReturnValue(file as unknown as ReturnType<typeof fs.createWriteStream>);
  return file;
}

// Helper: a successful fetch with a fresh body per call, so a second fetch cannot
// be hidden by two callers draining one shared stream
function mockSuccessfulFetch() {
  vi.mocked(net.fetch).mockImplementation(() => Promise.resolve(createMockResponse(200, true, createReadableBody())));
}

describe('downloadArtwork', () => {
  let downloadArtwork: typeof import('../src/artwork').downloadArtwork;

  beforeEach(async () => {
    vi.resetModules();

    // Re-mock fs and fs/promises after resetModules so the fresh import picks them up
    vi.doMock('fs', () => ({
      default: {
        existsSync: vi.fn(() => false),
        mkdirSync: vi.fn(),
        createWriteStream: vi.fn(),
      },
    }));

    vi.doMock('fs/promises', () => ({
      default: {
        rename: vi.fn(() => Promise.resolve()),
        unlink: vi.fn(() => Promise.resolve()),
        readdir: vi.fn(() => Promise.resolve([])),
        stat: vi.fn(() => Promise.resolve({ mtimeMs: Date.now() })),
        utimes: vi.fn(() => Promise.resolve()),
      },
    }));

    const mod = await import('../src/artwork');
    downloadArtwork = mod.downloadArtwork;

    // Re-import mocked modules so local references point to the same instances
    const fsModule = await import('fs');
    const fsPromisesModule = await import('fs/promises');
    Object.assign(fs, fsModule.default);
    Object.assign(fsPromises, fsPromisesModule.default);
  });

  it('returns cached path without downloading when URL matches and file exists', async () => {
    const url = 'https://example.com/art1.jpg';

    mockFinishingWriteStream();
    vi.mocked(net.fetch).mockResolvedValue(createMockResponse(200, true));

    // First call - triggers download
    const firstResult = await downloadArtwork(url);
    expect(firstResult).toMatch(/\.jpg$/);

    // Set existsSync to return true for the cached file
    vi.mocked(fs.existsSync).mockReturnValue(true);

    // Second call with same URL - should return cached path without calling net.fetch again
    vi.mocked(net.fetch).mockClear();
    const secondResult = await downloadArtwork(url);
    expect(secondResult).toBe(firstResult);
    expect(net.fetch).not.toHaveBeenCalled();
    // Only the disk-cache branch touches mtime, so this fails if the settled
    // in-flight promise was replayed instead
    expect(fsPromises.utimes).toHaveBeenCalledWith(firstResult, expect.any(Date), expect.any(Date));
  });

  it('resolves with filepath on successful download', async () => {
    const url = 'https://example.com/art2.jpg';

    mockFinishingWriteStream();
    vi.mocked(net.fetch).mockResolvedValue(createMockResponse(200, true));

    const result = await downloadArtwork(url);
    expect(result).toMatch(/\.jpg$/);
    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.createWriteStream).toHaveBeenCalled();
    // Verify .tmp file was written and renamed
    const writeCall = vi.mocked(fs.createWriteStream).mock.calls[0][0] as string;
    expect(writeCall).toMatch(/\.tmp$/);
    expect(fsPromises.rename).toHaveBeenCalled();
  });

  it('resolves null on non-200 response', async () => {
    const url = 'https://example.com/missing.jpg';

    vi.mocked(net.fetch).mockResolvedValue(createMockResponse(404, false));

    const result = await downloadArtwork(url);
    expect(result).toBeNull();
    // Should not attempt to write a file on non-200
    expect(fs.createWriteStream).not.toHaveBeenCalled();
  });

  it('resolves null on network error', async () => {
    const url = 'https://example.com/error.jpg';

    vi.mocked(net.fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await downloadArtwork(url);
    expect(result).toBeNull();
    // Should attempt to clean up the tmp file
    expect(fsPromises.unlink).toHaveBeenCalled();
  });

  it('resolves null on empty response body', async () => {
    const url = 'https://example.com/empty.jpg';

    vi.mocked(net.fetch).mockResolvedValue(createMockResponse(200, true, null));

    const result = await downloadArtwork(url);
    expect(result).toBeNull();
  });

  it('resolves null on abort timeout', async () => {
    const url = 'https://example.com/slow.jpg';

    // Simulate an abort error (what AbortController produces)
    vi.mocked(net.fetch).mockRejectedValue(new DOMException('The operation was aborted', 'AbortError'));

    const result = await downloadArtwork(url);
    expect(result).toBeNull();
    expect(fsPromises.unlink).toHaveBeenCalled();
  });

  it('fetches once for three concurrent calls with the same URL', async () => {
    const url = 'https://example.com/concurrent.jpg';

    mockFinishingWriteStream();
    vi.mocked(net.fetch).mockClear();
    mockSuccessfulFetch();

    const results = await Promise.all([downloadArtwork(url), downloadArtwork(url), downloadArtwork(url)]);

    expect(net.fetch).toHaveBeenCalledTimes(1);
    expect(fsPromises.rename).toHaveBeenCalledTimes(1);
    expect(results[0]).toMatch(/\.jpg$/);
    expect(new Set(results).size).toBe(1);
  });

  it('settles every concurrent caller with null on failure and refetches on a later call', async () => {
    const url = 'https://example.com/concurrent-error.jpg';

    vi.mocked(net.fetch).mockClear();
    vi.mocked(net.fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const results = await Promise.all([downloadArtwork(url), downloadArtwork(url), downloadArtwork(url)]);

    expect(results).toEqual([null, null, null]);
    expect(net.fetch).toHaveBeenCalledTimes(1);

    // The failure is not cached: a later call downloads again
    mockFinishingWriteStream();
    mockSuccessfulFetch();

    const retry = await downloadArtwork(url);
    expect(retry).toMatch(/\.jpg$/);
    expect(net.fetch).toHaveBeenCalledTimes(2);
  });

  it('returns cached path without downloading when cache file exists on disk', async () => {
    const url = 'https://example.com/art-a.jpg';

    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(net.fetch).mockClear();

    const result = await downloadArtwork(url);
    expect(result).toMatch(/\.jpg$/);
    expect(net.fetch).not.toHaveBeenCalled();
  });

  it('touches the cache file mtime on a cache hit', async () => {
    const url = 'https://example.com/art-touch.jpg';

    vi.mocked(fs.existsSync).mockReturnValue(true);

    const result = await downloadArtwork(url);
    expect(fsPromises.utimes).toHaveBeenCalledWith(result, expect.any(Date), expect.any(Date));
  });

  it('produces different cache paths for different URLs', async () => {
    const url1 = 'https://example.com/art-a.jpg';
    const url2 = 'https://example.com/art-b.jpg';

    vi.mocked(fs.existsSync).mockReturnValue(true);

    const result1 = await downloadArtwork(url1);
    const result2 = await downloadArtwork(url2);
    expect(result1).toMatch(/\.jpg$/);
    expect(result2).toMatch(/\.jpg$/);
    expect(result1).not.toBe(result2);
  });

  it('extracts UUID and size from Apple CDN URL for cache filename', async () => {
    const url = 'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/69/4d/b4/694db440-1fdd-0112-16a0-ae501501cb32/14UMGIM07610.rgb.jpg/512x512bb.jpg';

    vi.mocked(fs.existsSync).mockReturnValue(true);

    const result = await downloadArtwork(url);
    expect(result).toMatch(/694db440-1fdd-0112-16a0-ae501501cb32-512x512\.jpg$/);
  });

  it('produces different cache paths for two sizes of one artwork', async () => {
    const base =
      'https://is1-ssl.mzstatic.com/image/thumb/Music125/v4/69/4d/b4/694db440-1fdd-0112-16a0-ae501501cb32/14UMGIM07610.rgb.jpg/';

    vi.mocked(fs.existsSync).mockReturnValue(true);

    const small = await downloadArtwork(`${base}512x512bb.jpg`);
    const large = await downloadArtwork(`${base}1024x1024bb.jpg`);
    expect(small).toMatch(/-512x512\.jpg$/);
    expect(large).toMatch(/-1024x1024\.jpg$/);
    expect(small).not.toBe(large);
  });

  it('falls back to hash-based filename when URL contains no UUID', async () => {
    const url = 'https://example.com/some-image.jpg';

    vi.mocked(fs.existsSync).mockReturnValue(true);

    const result = await downloadArtwork(url);
    expect(result).toMatch(/[0-9a-f]{16}\.jpg$/);
    expect(result).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
  });
});
