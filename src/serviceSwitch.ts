// Shared service-switch sequence for the tray, itms:// routing and MPRIS OpenUri.

import type { Tray } from 'electron';
import { getMusicService, setMusicService } from './config';
import type { MusicServiceId } from './musicService';
import { buildAppleMusicURL } from './storefront';
import { notifyDocumentReplacing } from './theme';
import { rebuildTrayMenu } from './tray';
import { reset as resetWedgeDetector } from './wedgeDetector';

// main.ts supplies accessors because importing it would run app.whenReady().
let getTrayCallback: (() => Tray | null) | null = null;
let loadURLCallback: ((url: string) => void) | null = null;

/** Receives the window and tray accessors from main.ts. Call once, before any switch. */
export function initServiceSwitch(deps: { getTray: () => Tray | null; loadURL: (url: string) => void }): void {
  getTrayCallback = deps.getTray;
  loadURLCallback = deps.loadURL;
}

/**
 * Persist the service and navigate to it. The order is essential: the wedge
 * detector goes first because stopping its timer suppresses a skip-forward into
 * the page as it re-initialises, and the service is persisted before the tray
 * menu and the URL are built, since both read it back.
 */
export function switchService(id: MusicServiceId, targetUrl?: string): void {
  resetWedgeDetector();
  setMusicService(id);
  const tray = getTrayCallback?.() ?? null;
  if (tray) rebuildTrayMenu(tray);
  // The navigation below replaces the document, so the next injection must not call
  // removeInsertedCSS() with a key from the old one.
  notifyDocumentReplacing();
  // Resolved after setMusicService, so the default reads the service just persisted.
  const url = targetUrl ?? buildAppleMusicURL();
  loadURLCallback?.(url);
}

/** Route an itms:// target to music with one navigation, switching services when needed. */
export function routeToMusicService(url: string): void {
  if (getMusicService() !== 'music') {
    switchService('music', url);
    return;
  }
  loadURLCallback?.(url);
}
