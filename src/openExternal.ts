import { shell } from 'electron';
import { errorMessage } from './utils';

/**
 * Open a URL in the system browser, but only when it is http or https. This is
 * the single boundary deciding what Sidra hands to the system browser, so every
 * caller that takes a URL from outside must come through here.
 *
 * The report callback receives a message and the offending detail, so each
 * caller logs under its own scope. It returns whether the URL was allowed,
 * which lets a caller add its own logging on the success path without
 * repeating the protocol test.
 */
export function openExternalUrl(
  url: string,
  report: (message: string, detail: string) => void,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    report('blocked malformed external URL:', url);
    return false;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    report('blocked external URL with disallowed protocol:', url);
    return false;
  }
  void shell.openExternal(url).catch((err: unknown) => report('failed to open external URL:', errorMessage(err)));
  return true;
}
