import { describe, expect, it } from 'vitest';

import { CONTENT_READY_SELECTOR, contentReadyProbeScript } from '../src/contentReady';

describe('content readiness marker', () => {
  it('uses the hydrated amp-playback-controls-play element inside the app container', () => {
    expect(CONTENT_READY_SELECTOR).toBe('[data-testid="app-container"] amp-playback-controls-play[hydrated]');
  });

  it('builds a probe script that queries the new selector and not the stale markers', () => {
    expect(contentReadyProbeScript()).toBe(
      '!!document.querySelector("[data-testid=\\"app-container\\"] amp-playback-controls-play[hydrated]")'
    );
    expect(contentReadyProbeScript()).not.toContain('amp-lcd');
    expect(contentReadyProbeScript()).not.toContain('navigation__header');
  });
});
