// test/artwork.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock fs before importing the module under test
vi.mock('fs', () => ({
  default: {
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
    createWriteStream: vi.fn(),
  },
}));

// Mock https before importing the module under test
vi.mock('https', () => ({
  default: {
    get: vi.fn(),
  },
}));

import fs from 'fs';
import https from 'https';

// Helper: create a mock writable stream (file)
function createMockFile() {
  const file = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
  file.close = vi.fn();
  return file;
}

// Helper: create a mock HTTP response
function createMockResponse(statusCode: number) {
  const response = new EventEmitter() as EventEmitter & {
    statusCode: number;
    pipe: ReturnType<typeof vi.fn>;
  };
  response.statusCode = statusCode;
  response.pipe = vi.fn();
  return response;
}

// Helper: create a mock request
function createMockRequest() {
  const request = new EventEmitter() as EventEmitter & {
    setTimeout: ReturnType<typeof vi.fn>;
    destroy: ReturnType<typeof vi.fn>;
  };
  request.setTimeout = vi.fn();
  request.destroy = vi.fn();
  return request;
}

describe('downloadArtwork', () => {
  let downloadArtwork: typeof import('../src/artwork').downloadArtwork;

  beforeEach(async () => {
    vi.resetModules();

    // Re-mock fs and https after resetModules so the fresh import picks them up
    vi.doMock('fs', () => ({
      default: {
        existsSync: vi.fn(() => false),
        mkdirSync: vi.fn(),
        createWriteStream: vi.fn(),
      },
    }));

    vi.doMock('https', () => ({
      default: {
        get: vi.fn(),
      },
    }));

    const mod = await import('../src/artwork');
    downloadArtwork = mod.downloadArtwork;

    // Re-import mocked modules so local references point to the same instances
    const fsModule = await import('fs');
    const httpsModule = await import('https');
    Object.assign(fs, fsModule.default);
    Object.assign(https, httpsModule.default);
  });

  it('returns cached path without downloading when URL matches and file exists', async () => {
    const url = 'https://example.com/art1.jpg';
    const mockFile = createMockFile();
    const mockResponse = createMockResponse(200);
    const mockRequest = createMockRequest();

    vi.mocked(fs.createWriteStream).mockReturnValue(mockFile as unknown as ReturnType<typeof fs.createWriteStream>);
    vi.mocked(https.get).mockImplementation((_url: unknown, cb: unknown) => {
      (cb as (res: unknown) => void)(mockResponse);
      return mockRequest as unknown as ReturnType<typeof https.get>;
    });
    mockResponse.pipe.mockImplementation(() => {
      process.nextTick(() => mockFile.emit('finish'));
      return mockFile as unknown as ReturnType<typeof mockResponse.pipe>;
    });

    // First call - triggers download
    const firstResult = await downloadArtwork(url);
    expect(firstResult).toMatch(/\.jpg$/);

    // Set existsSync to return true for the cached file
    vi.mocked(fs.existsSync).mockReturnValue(true);

    // Second call with same URL - should return cached path without calling https.get again
    vi.mocked(https.get).mockClear();
    const secondResult = await downloadArtwork(url);
    expect(secondResult).toBe(firstResult);
    expect(https.get).not.toHaveBeenCalled();
  });

  it('resolves with filepath on successful download', async () => {
    const url = 'https://example.com/art2.jpg';
    const mockFile = createMockFile();
    const mockResponse = createMockResponse(200);
    const mockRequest = createMockRequest();

    vi.mocked(fs.createWriteStream).mockReturnValue(mockFile as unknown as ReturnType<typeof fs.createWriteStream>);
    vi.mocked(https.get).mockImplementation((_url: unknown, cb: unknown) => {
      (cb as (res: unknown) => void)(mockResponse);
      return mockRequest as unknown as ReturnType<typeof https.get>;
    });
    mockResponse.pipe.mockImplementation(() => {
      process.nextTick(() => mockFile.emit('finish'));
      return mockFile as unknown as ReturnType<typeof mockResponse.pipe>;
    });

    const result = await downloadArtwork(url);
    expect(result).toMatch(/\.jpg$/);
    expect(fs.mkdirSync).toHaveBeenCalled();
    expect(fs.createWriteStream).toHaveBeenCalled();
  });

  it('resolves null on non-200 response', async () => {
    const url = 'https://example.com/missing.jpg';
    const mockFile = createMockFile();
    const mockResponse = createMockResponse(404);
    const mockRequest = createMockRequest();

    vi.mocked(fs.createWriteStream).mockReturnValue(mockFile as unknown as ReturnType<typeof fs.createWriteStream>);
    vi.mocked(https.get).mockImplementation((_url: unknown, cb: unknown) => {
      (cb as (res: unknown) => void)(mockResponse);
      return mockRequest as unknown as ReturnType<typeof https.get>;
    });

    const result = await downloadArtwork(url);
    expect(result).toBeNull();
    expect(mockFile.close).toHaveBeenCalled();
  });

  it('resolves null on network error', async () => {
    const url = 'https://example.com/error.jpg';
    const mockFile = createMockFile();
    const mockRequest = createMockRequest();

    vi.mocked(fs.createWriteStream).mockReturnValue(mockFile as unknown as ReturnType<typeof fs.createWriteStream>);
    vi.mocked(https.get).mockImplementation((_url: unknown, _cb: unknown) => {
      process.nextTick(() => mockRequest.emit('error', new Error('ECONNREFUSED')));
      return mockRequest as unknown as ReturnType<typeof https.get>;
    });

    const result = await downloadArtwork(url);
    expect(result).toBeNull();
    expect(mockFile.close).toHaveBeenCalled();
  });

  it('resolves null and destroys request on timeout', async () => {
    const url = 'https://example.com/slow.jpg';
    const mockFile = createMockFile();
    const mockRequest = createMockRequest();

    vi.mocked(fs.createWriteStream).mockReturnValue(mockFile as unknown as ReturnType<typeof fs.createWriteStream>);
    vi.mocked(https.get).mockImplementation((_url: unknown, _cb: unknown) => {
      return mockRequest as unknown as ReturnType<typeof https.get>;
    });

    // Capture the timeout callback and invoke it
    let timeoutCb: () => void = () => {};
    mockRequest.setTimeout.mockImplementation((_ms: unknown, cb: unknown) => {
      timeoutCb = cb as () => void;
      // Fire timeout immediately
      process.nextTick(() => timeoutCb());
      return mockRequest;
    });

    const result = await downloadArtwork(url);
    expect(result).toBeNull();
    expect(mockRequest.destroy).toHaveBeenCalled();
  });

  it('downloads again when URL changes even if previous URL was cached', async () => {
    const url1 = 'https://example.com/art-a.jpg';
    const url2 = 'https://example.com/art-b.jpg';

    function setupSuccessfulDownload() {
      const mockFile = createMockFile();
      const mockResponse = createMockResponse(200);
      const mockRequest = createMockRequest();

      vi.mocked(fs.createWriteStream).mockReturnValue(mockFile as unknown as ReturnType<typeof fs.createWriteStream>);
      vi.mocked(https.get).mockImplementation((_url: unknown, cb: unknown) => {
        (cb as (res: unknown) => void)(mockResponse);
        return mockRequest as unknown as ReturnType<typeof https.get>;
      });
      mockResponse.pipe.mockImplementation(() => {
        process.nextTick(() => mockFile.emit('finish'));
        return mockFile as unknown as ReturnType<typeof mockResponse.pipe>;
      });
    }

    // Download first URL
    setupSuccessfulDownload();
    const result1 = await downloadArtwork(url1);
    expect(result1).toMatch(/\.jpg$/);

    // Download second URL - should not use cache even if file exists
    vi.mocked(fs.existsSync).mockReturnValue(true);
    setupSuccessfulDownload();
    vi.mocked(https.get).mockClear();

    const result2 = await downloadArtwork(url2);
    expect(result2).toMatch(/\.jpg$/);
    expect(result2).not.toBe(result1);
    expect(https.get).toHaveBeenCalled();
  });
});
