// src/serviceSwitch.ts
// The one service-switch sequence. Both the tray Player submenu and itms:// routing
// go through switchService(), so the order below is the only order that ships.

import type { Tray } from 'electron';
import { getMusicService, setMusicService } from './config';
import type { MusicServiceId } from './musicService';
import { buildAppleMusicURL } from './storefront';
import { setThemeCssKey } from './theme';
import { rebuildTrayMenu } from './tray';
import { reset as resetWedgeDetector } from './wedgeDetector';

// main.ts owns the window and the tray but cannot be imported (it runs app.whenReady()
// at import), so it supplies both here, as it does for setSendCommandCallback and friends.
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
  // Drop the tracked inserted-CSS key. The navigation below replaces the document, so
  // the next injection must not call removeInsertedCSS() with a key from the old one.
  setThemeCssKey(null);
  // Resolved after setMusicService, so the default reads the service just persisted.
  const url = targetUrl ?? buildAppleMusicURL();
  loadURLCallback?.(url);
}

// itms:// links always target the music service. Passing the link to switchService()
// rather than navigating after it keeps the switch to one navigation.
export function routeToMusicService(url: string): void {
  if (getMusicService() !== 'music') {
    switchService('music', url);
    return;
  }
  loadURLCallback?.(url);
}
