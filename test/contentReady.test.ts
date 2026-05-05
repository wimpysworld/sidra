import { describe, expect, it } from 'vitest';

import { CONTENT_READY_SELECTOR, contentReadyProbeScript } from '../src/contentReady';

describe('content readiness marker', () => {
  it('uses the Apple Music app shell navigation logo', () => {
    expect(CONTENT_READY_SELECTOR).toBe('.app-container .navigation__header .logo');
  });

  it('does not use the stale amp-lcd hydration marker', () => {
    expect(contentReadyProbeScript()).toBe('!!document.querySelector(".app-container .navigation__header .logo")');
    expect(contentReadyProbeScript()).not.toContain('amp-lcd');
  });
});
