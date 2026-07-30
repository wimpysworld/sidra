import { describe, expect, it } from 'vitest';

import { CONTENT_READY_SELECTOR, contentReadyProbeScript } from '../src/contentReady';

describe('content readiness marker', () => {
  it('uses the hydrated amp-playback-controls-play element inside the app container', () => {
    expect(CONTENT_READY_SELECTOR).toBe('[data-testid="app-container"] amp-playback-controls-play[hydrated]');
  });

  it('builds a probe script that queries the default selector when no argument is passed', () => {
    expect(contentReadyProbeScript()).toBe(
      '!!document.querySelector("[data-testid=\\"app-container\\"] amp-playback-controls-play[hydrated]")'
    );
    expect(contentReadyProbeScript()).not.toContain('amp-lcd');
    expect(contentReadyProbeScript()).not.toContain('navigation__header');
  });

  it('embeds a caller-supplied selector as valid JavaScript', () => {
    // The selector carries double quotes, so raw interpolation would end the string literal
    // early and the probe would fail to parse inside executeJavaScript.
    const customSelector = '[data-testid="app-container"] .my-custom-element[ready]';
    const queried: string[] = [];
    const fakeDocument = {
      querySelector: (selector: string): null => {
        queried.push(selector);
        return null;
      }
    };

    const probe = new Function('document', `return ${contentReadyProbeScript(customSelector)};`);
    const result: unknown = probe(fakeDocument);

    expect(queried).toEqual([customSelector]);
    expect(result).toBe(false);
  });
});
