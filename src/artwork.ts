import { app, net } from 'electron';
import { createHash } from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import { Readable } from 'stream';
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

const UUID_REGEX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function artworkCachePath(url: string): string {
  let filename: string;
  try {
    const pathname = new URL(url).pathname;
    const match = pathname.match(UUID_REGEX);
    filename = match
      ? `${match[0]}.jpg`
      : `${createHash('sha256').update(url).digest('hex').slice(0, 16)}.jpg`;
  } catch {
    filename = `${createHash('sha256').update(url).digest('hex').slice(0, 16)}.jpg`;
  }
  return path.join(ARTWORK_CACHE_DIR, filename);
}

export async function downloadArtwork(url: string): Promise<string | null> {
  const filepath = artworkCachePath(url);

  if (fs.existsSync(filepath)) {
    artworkLog.debug('cache hit: %s', filepath);
    return filepath;
  }

  fs.mkdirSync(ARTWORK_CACHE_DIR, { recursive: true });

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

    const file = fs.createWriteStream(tmpPath);

    await new Promise<void>((resolve, reject) => {
      file.on('error', (err) => {
        reject(err);
      });
      const readable = Readable.fromWeb(response.body! as import('stream/web').ReadableStream);
      readable.on('error', (err) => {
        file.destroy();
        reject(err);
      });
      readable.pipe(file);
      file.on('finish', () => {
        file.close((err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    });

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
      // File may have been removed between readdir and stat/unlink
    }
  }

  artworkLog.debug('cache cleanup: removed %d file(s)', removed);
}
