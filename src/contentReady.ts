// Hash-immune handles: Apple's data test id on the app container and the amp-* custom element tag survive class hashing.
// The Stencil hydrated attribute on the playback control marks the first render, so JS has executed and chrome is interactive.
export const CONTENT_READY_SELECTOR = '[data-testid="app-container"] amp-playback-controls-play[hydrated]';

/**
 * Build the expression main.ts runs with executeJavaScript() to poll a loading
 * page. It returns a boolean and touches nothing, so it is safe to repeat until
 * the chrome is interactive and the splash can be dismissed. The selector comes
 * in as a parameter because each entry in the music service registry carries its
 * own, and JSON.stringify() quotes it so its own quotes cannot end the literal.
 */
export function contentReadyProbeScript(selector: string = CONTENT_READY_SELECTOR): string {
  return `!!document.querySelector(${JSON.stringify(selector)})`;
}
