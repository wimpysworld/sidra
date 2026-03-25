import { app } from 'electron';
import https from 'https';
import { createHash } from 'crypto';
import fs from 'fs';
import fsPromises from 'fs/promises';
import path from 'path';
import log from 'electron-log/main';

const artworkLog = log.scope('artwork');

const ARTWORK_DOWNLOAD_TIMEOUT_MS = 5000;
const ARTWORK_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const ARTWORK_CACHE_DIR = path.join(app.getPath('cache'), app.getName().toLowerCase(), 'artwork');

let lastArtworkUrl: string | null = null;
let lastArtworkPath: string | null = null;

function artworkCachePath(url: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 16);
  return path.join(ARTWORK_CACHE_DIR, `${hash}.jpg`);
}

export function downloadArtwork(url: string): Promise<string | null> {
  const filepath = artworkCachePath(url);

  if (url === lastArtworkUrl && lastArtworkPath && fs.existsSync(filepath)) {
    return Promise.resolve(filepath);
  }

  fs.mkdirSync(ARTWORK_CACHE_DIR, { recursive: true });

  return new Promise((resolve) => {
    const file = fs.createWriteStream(filepath);
    file.on('error', (err) => {
      artworkLog.warn('write error:', err.message);
      resolve(null);
    });
    const request = https.get(url, (response) => {
      if (response.statusCode !== 200) {
        file.close();
        artworkLog.warn('download failed, status:', response.statusCode);
        resolve(null);
        return;
      }
      response.pipe(file);
      file.on('finish', () => {
        file.close();
        lastArtworkUrl = url;
        lastArtworkPath = filepath;
        resolve(filepath);
      });
    });
    request.on('error', (err) => {
      file.close();
      artworkLog.warn('download error:', err.message);
      resolve(null);
    });
    request.setTimeout(ARTWORK_DOWNLOAD_TIMEOUT_MS, () => {
      request.destroy();
      artworkLog.warn('download timed out');
      resolve(null);
    });
  });
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
