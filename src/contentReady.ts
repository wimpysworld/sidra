/** Detect rendered playback controls through stable attributes and tags, independent of Apple's hashed classes. */
export const CONTENT_READY_SELECTOR = '[data-testid="app-container"] amp-playback-controls-play[hydrated]';

/**
 * Build a read-only readiness probe for a service's selector.
 * JSON.stringify() prevents quotes in the selector from ending the JavaScript literal.
 */
export function contentReadyProbeScript(selector: string = CONTENT_READY_SELECTOR): string {
  return `!!document.querySelector(${JSON.stringify(selector)})`;
}
