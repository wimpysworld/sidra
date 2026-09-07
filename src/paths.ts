import { app } from 'electron';
import path from 'path';

/**
 * Resolve a path to a bundled asset in both a checkout and a packaged build. A
 * packaged build reads from app.asar.unpacked, so anything resolved here must
 * also be covered by an entry under asarUnpack in package.json. A file left
 * uncovered builds cleanly and fails only at runtime.
 */
export function getAssetPath(...parts: string[]): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : path.join(__dirname, '..');
  return path.join(base, ...parts);
}

interface PackageJson {
  author: string | { name: string };
  description?: string;
  license?: string;
}

/** Product details shared by the About window and tray. */
export interface ProductInfo {
  productName: string;
  description: string;
  author: string;
  license: string;
}

let cachedProductInfo: ProductInfo | null = null;

/**
 * Read and cache product details from package.json and Electron's application name.
 * Keep only author text before '<' so bracketed contact details cannot remain after a partial replacement.
 * require() reads package.json through the asar archive, so it needs no asarUnpack entry.
 */
export function getProductInfo(): ProductInfo {
  if (cachedProductInfo) {
    return cachedProductInfo;
  }

  const pkg = require(path.join(__dirname, '..', 'package.json')) as PackageJson;
  const author = typeof pkg.author === 'string'
    ? pkg.author.split('<')[0].trim()
    : (pkg.author?.name ?? '');

  cachedProductInfo = {
    productName: app.getName(),
    description: pkg.description ?? '',
    author,
    license: pkg.license ?? '',
  };

  return cachedProductInfo;
}
