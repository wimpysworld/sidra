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

export interface ProductInfo {
  productName: string;
  description: string;
  author: string;
  license: string;
}

let cachedProductInfo: ProductInfo | null = null;

/**
 * Product details taken from package.json, which is the single source for the
 * About window and the tray. The author field keeps only the text before the
 * first '<', because the npm author form is 'Name <email> (url)' and the About
 * window shows the name alone. Cutting at the delimiter rather than deleting a
 * '<...>' match cannot leave part of a bracketed segment behind, which is what
 * CodeQL's incomplete-sanitization check flags about a single-pass replace. require() reads through the asar archive, so
 * package.json is loaded relative to the compiled output and needs no
 * asarUnpack entry, unlike everything getAssetPath() resolves.
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
