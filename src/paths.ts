import { app } from 'electron';
import path from 'path';

export function getAssetPath(...parts: string[]): string {
  const base = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar.unpacked')
    : path.join(__dirname, '..');
  return path.join(base, ...parts);
}
