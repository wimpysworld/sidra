import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Readable, Writable } from 'stream';

// Hoisted factories work with both vi.mock and vi.doMock after a module reset.
// Each call creates fresh spies to keep the module instances independent.
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

vi.mock('fs', fsFactory);
vi.mock('fs/promises', fsPromisesFactory);

import fs from 'fs';
import fsPromises from 'fs/promises';
import { net } from 'electron';

// Response.body uses a Web stream rather than a Node stream.
function createReadableBody(data: Buffer = Buffer.from('image-data')): ReadableStream<Uint8Array> {
  return Readable.toWeb(Readable.from(data)) as ReadableStream<Uint8Array>;
}

function createMockResponse(status: number, ok: boolean, body?: ReadableStream<Uint8Array> | null) {
  return {
    ok,
    status,
    body: body !== undefined ? body : (ok ? createReadableBody() : null),
  } as unknown as Response;
}

// Keep pipeline() real so download completion requires a finished Writable.
// Each attempt needs a fresh stream because an ended stream rejects further writes.
// Collected bytes let tests check that the complete body reaches the file.
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

// A fresh body per fetch prevents callers from sharing an already-consumed stream.
function mockSuccessfulFetch() {
  vi.mocked(net.fetch).mockImplementation(() => Promise.resolve(createMockResponse(200, true, createReadableBody())));
}

describe('downloadArtwork', () => {
  let downloadArtwork: typeof import('../src/artwork').downloadArtwork;

  afterEach(() => {
    vi.useRealTimers();
  });

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
    // Only a disk-cache hit touches mtime. Reusing a settled promise skips it.
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
    // The complete body must reach disk before the file becomes a cache entry.
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
    // Reject the status before opening a stream so an error page cannot become cached artwork.
    expect(fs.createWriteStream).not.toHaveBeenCalled();
  });

  it('resolves null on network error', async () => {
    const url = 'https://example.com/error.jpg';

    vi.mocked(net.fetch).mockRejectedValue(new Error('ECONNREFUSED'));

    const result = await downloadArtwork(url);
    expect(result).toBeNull();
    // Remove the temporary file so failed downloads cannot accumulate in the cache.
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

    vi.useFakeTimers();
    vi.mocked(net.fetch).mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      options?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted', 'AbortError'));
      });
    }));

    const result = downloadArtwork(url);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fsPromises.unlink).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBeNull();
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
