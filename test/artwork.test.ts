// test/artwork.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Readable, Writable } from 'stream';

// One factory per module, used by the vi.mock below and again by the vi.doMock
// that re-installs it after each vi.resetModules(). vi.mock is hoisted above the
// imports, so the factories must be too: vi.hoisted() is the supported way.
// Each call still builds fresh vi.fn()s, so the two sites stay independent.
const { fsFactory, fsPromisesFactory } = vi.hoisted(() => ({
  fsFactory: () => ({
    default: {
      existsSync: vi.fn(() => false),
      mkdirSync: vi.fn(),
      createWriteStream: vi.fn(),
    },
  }),
  fsPromisesFactory: () => ({
    default: {
      rename: vi.fn(() => Promise.resolve()),
      unlink: vi.fn(() => Promise.resolve()),
      readdir: vi.fn(() => Promise.resolve([])),
      stat: vi.fn(() => Promise.resolve({ mtimeMs: Date.now() })),
      utimes: vi.fn(() => Promise.resolve()),
    },
  }),
}));

// Mock fs and fs/promises before importing the module under test
vi.mock('fs', fsFactory);
vi.mock('fs/promises', fsPromisesFactory);

import fs from 'fs';
import fsPromises from 'fs/promises';
import { net } from 'electron';

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

// Helper: install a write stream mock that collects the bytes written to it and
// returns them. The module under test pipes the body with pipeline() from
// stream/promises, which is left unmocked: it drives a real Writable, so the
// download resolves only when the whole body has been written and the stream has
// finished. A fresh Writable per call, because a download after a retry gets its
// own stream and an already-ended one would reject.
function mockWriteStream(): Buffer[][] {
  const files: Buffer[][] = [];
  vi.mocked(fs.createWriteStream).mockImplementation(() => {
    const written: Buffer[] = [];
    files.push(written);
    return new Writable({
      write(chunk: Buffer, _encoding, callback) {
        written.push(Buffer.from(chunk));
        callback();
      },
    }) as unknown as ReturnType<typeof fs.createWriteStream>;
  });
  return files;
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
    vi.doMock('fs', fsFactory);
    vi.doMock('fs/promises', fsPromisesFactory);

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

    mockWriteStream();
    vi.mocked(net.fetch).mockResolvedValue(createMockResponse(200, true));

    const firstResult = await downloadArtwork(url);
    expect(firstResult).toMatch(/\.jpg$/);

    vi.mocked(fs.existsSync).mockReturnValue(true);

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

    const files = mockWriteStream();
    vi.mocked(net.fetch).mockResolvedValue(createMockResponse(200, true, createReadableBody(Buffer.from('image-data'))));

    const result = await downloadArtwork(url);
    expect(result).toMatch(/\.jpg$/);
    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.createWriteStream).toHaveBeenCalled();
    // The whole body reaches the file, so a pipe that resolved early or dropped
    // the stream would leave truncated artwork renamed onto the cache path.
    expect(Buffer.concat(files[0]).toString()).toBe('image-data');
    // The download lands on a .tmp path and is renamed onto the cache path, so
    // a half-written file can never be read back as a cache hit.
    const writeCall = vi.mocked(fs.createWriteStream).mock.calls[0][0] as string;
    expect(writeCall).toMatch(/\.tmp$/);
    expect(fsPromises.rename).toHaveBeenCalled();
  });

  it('resolves null on non-200 response', async () => {
    const url = 'https://example.com/missing.jpg';

    vi.mocked(net.fetch).mockResolvedValue(createMockResponse(404, false));

    const result = await downloadArtwork(url);
    expect(result).toBeNull();
    // The status is checked before the stream is opened, so an error page body
    // is never written and renamed onto the cache path, where it would be
    // served as this track's artwork until the seven day sweep took it.
    expect(fs.createWriteStream).not.toHaveBeenCalled();
  });

  it('resolves null on network error', async () => {
    const url = 'https://example.com/error.jpg';

    vi.mocked(net.fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await downloadArtwork(url);
    expect(result).toBeNull();
    // The tmp name carries a timestamp, so it is distinct on every attempt and
    // a failure that skipped the unlink would add a file to the cache
    // directory each time the network dropped.
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

    const files = mockWriteStream();
    vi.mocked(net.fetch).mockClear();
    mockSuccessfulFetch();

    const results = await Promise.all([downloadArtwork(url), downloadArtwork(url), downloadArtwork(url)]);

    expect(net.fetch).toHaveBeenCalledTimes(1);
    expect(fsPromises.rename).toHaveBeenCalledTimes(1);
    // One temp file, not three: three callers sharing one promise open one stream
    expect(files).toHaveLength(1);
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
    mockWriteStream();
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
