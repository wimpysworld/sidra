import { shell } from 'electron';
import log from 'electron-log/main';

import { errorMessage } from '../utils';

type ScopedLog = ReturnType<typeof log.scope>;

/**
 * Hands a URL to the system browser, refusing anything that is not http or
 * https. Every external-link path goes through here, so a hardening change is
 * made once instead of in each caller.
 *
 * The parsed URL reaches the browser, not the string that came in. Chromium
 * re-parses the argument with its own parser, so passing the raw string would
 * open a URL that nothing checked. Normalisation is the cost: percent-encoding
 * is canonicalised, a default port is dropped, an IDN host is punycoded and dot
 * segments are resolved. For an http(s) URL each of those names the same
 * resource.
 *
 * Both refusals are logged. A silent refusal leaves a dead menu item or a
 * notification click that does nothing, with no record of why.
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
