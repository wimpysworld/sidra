import { app } from 'electron';
import path from 'path';

export function getAssetPath(...parts: string[]): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : path.join(__dirname, '..');
  return path.join(base, ...parts);
}

interface PackageJson {
  author: string | { name: string };
  build?: { productName?: string };
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

export function getProductInfo(): ProductInfo {
  if (cachedProductInfo) {
    return cachedProductInfo;
  }

  const pkg = require(path.join(__dirname, '..', 'package.json')) as PackageJson;
  const author = typeof pkg.author === 'string'
    ? pkg.author.replace(/\s*<[^>]+>/, '')
    : (pkg.author?.name ?? '');

  cachedProductInfo = {
    productName: pkg.build?.productName ?? app.getName(),
    description: pkg.description ?? '',
    author,
    license: pkg.license ?? '',
  };

  return cachedProductInfo;
}
