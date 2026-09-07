import { shell } from 'electron';
import log from 'electron-log/main';

import { errorMessage } from '../utils';

type ScopedLog = ReturnType<typeof log.scope>;

/**
 * Opens an HTTP(S) URL in the system browser and logs malformed or disallowed URLs.
 * Passes the parsed URL string, not the raw input, because Chromium parses the
 * argument again and must receive the URL that passed validation.
 */
export function openExternalUrl(url: string, scopedLog: ScopedLog): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    scopedLog.warn('blocked malformed external URL:', url);
    return;
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    scopedLog.warn('blocked external URL with disallowed protocol:', url);
    return;
  }

  scopedLog.debug('opening external URL in browser:', url);
  shell.openExternal(parsed.toString()).catch((err: unknown) => {
    scopedLog.warn('failed to open browser:', errorMessage(err));
  });
}
