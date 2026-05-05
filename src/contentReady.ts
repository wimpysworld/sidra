export const CONTENT_READY_SELECTOR = '.app-container .navigation__header .logo';

export function contentReadyProbeScript(): string {
  return `!!document.querySelector(${JSON.stringify(CONTENT_READY_SELECTOR)})`;
}
