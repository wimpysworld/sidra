import { app, net } from 'electron';
import { createHash } from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import log from 'electron-log/main';
import { errorMessage } from './utils';

const artworkLog = log.scope('artwork');

const ARTWORK_DOWNLOAD_TIMEOUT_MS = 5000;
const ARTWORK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ARTWORK_CACHE_DIR = process.env.SNAP
  ? path.join(process.env.XDG_RUNTIME_DIR ?? app.getPath('cache'), app.getName().toLowerCase(), 'artwork')
  : path.join(app.getPath('cache'), app.getName().toLowerCase(), 'artwork');

function cleanupTmpFile(tmpPath: string): void {
  fsPromises.unlink(tmpPath).catch(() => {});
}

// The filename carries the size token from the final path segment beside the
// UUID, because Apple serves every size of one artwork under the same UUID and
// the UUID alone would collide. SIZE_REGEX is anchored so a segment such as
// mzl.abc123x456.jpg cannot be read as a size. A URL that parses but carries no
// UUID falls back to a hash of the whole URL.
const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const SIZE_REGEX = /^\d+x\d+/;

function hashedFilename(url: string): string {
  return `${createHash('sha256').update(url).digest('hex').slice(0, 16)}.jpg`;
}

function artworkCachePath(url: string): string {
  let filename: string;
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(UUID_REGEX);
    const size = (pathname.split('/').pop() ?? '').match(SIZE_REGEX);
    filename = match ? `${match[0]}${size ? `-${size[0]}` : ''}.jpg` : hashedFilename(url);
  } catch {
    filename = hashedFilename(url);
  }
  return path.join(ARTWORK_CACHE_DIR, filename);
}

const inFlight = new Map<string, Promise<string | null>>();

/**
 * Resolve a cached artwork path, or null for a failed download.
 * Concurrent callers share one promise per URL, avoiding duplicate downloads and competing renames.
 * A competing rename can fail with EPERM on Windows while the tray holds the destination open.
 */
export function downloadArtwork(url: string): Promise<string | null> {
  const existing = inFlight.get(url);
  if (existing) {
    return existing;
  }

  // Delete the in-flight entry before caller continuations run, so later calls
  // check the disk cache again and can retry failed downloads.
  const pending = fetchArtwork(url).finally(() => {
    inFlight.delete(url);
  });
  inFlight.set(url, pending);
  return pending;
}

async function fetchArtwork(url: string): Promise<string | null> {
  const filepath = artworkCachePath(url);

  if (fs.existsSync(filepath)) {
    artworkLog.debug('cache hit: %s', filepath);
    // Refresh mtime so cleanup preserves artwork in daily use.
    // Do not await the timestamp write because notification delivery needs the path.
    const now = new Date();
    fsPromises.utimes(filepath, now, now).catch(() => {});
    return filepath;
  }

  fs.mkdirSync(ARTWORK_CACHE_DIR, { recursive: true });

  // Download to a temp file and rename, so a half-written file can never be
  // read back as a cache hit
  const tmpPath = filepath + '.' + Date.now() + '.tmp';
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ARTWORK_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await net.fetch(url, { signal: controller.signal });

    if (!response.ok) {
      artworkLog.warn('download failed, status:', response.status);
      return null;
    }

    if (!response.body) {
      artworkLog.warn('download failed: empty response body');
      return null;
    }

    // The cast is unavoidable: net.fetch types its body as the DOM ReadableStream
    // and Readable.fromWeb takes the stream/web one, which differ on the reader's
    // ArrayBuffer variance alone
    const body = response.body as import('stream/web').ReadableStream<Uint8Array>;
    await pipeline(Readable.fromWeb(body), fs.createWriteStream(tmpPath));

    await fsPromises.rename(tmpPath, filepath);
    artworkLog.debug('artwork cached: %s', filepath);
    return filepath;
  } catch (error: unknown) {
    cleanupTmpFile(tmpPath);
    artworkLog.warn('download error:', errorMessage(error));
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Evict cached artwork untouched for seven days. Run once at startup and left
 * unawaited, so a slow directory never delays the window.
 */
export async function cleanArtworkCache(): Promise<void> {
  let entries: string[];
  try {
    entries = await fsPromises.readdir(ARTWORK_CACHE_DIR);
  } catch {
    return;
  }

  const now = Date.now();
  let removed = 0;

  for (const entry of entries) {
    const filepath = path.join(ARTWORK_CACHE_DIR, entry);
    try {
      const stat = await fsPromises.stat(filepath);
      if (now - stat.mtimeMs > ARTWORK_MAX_AGE_MS) {
        await fsPromises.unlink(filepath);
        removed++;
      }
    } catch {
      // Concurrent removal or an inaccessible entry must not stop the remaining cleanup.
    }
  }

  artworkLog.debug('cache cleanup: removed %d file(s)', removed);
}
