// Shared injection constants live outside main.ts so tests can import them
// without starting Electron through app.whenReady().

/** Placeholder that loadAssets() replaces in assets/authFrameFix.js. */
export const AUTH_FIX_TOKEN = '__SIDRA_AUTH_FIX__';

/**
 * Feature-specific containers shared by the injected stylesheet and closest() lookup.
 * Broad selectors stay in assets/authFrameFix.js, where the lookup starts at a matched button.
 * Used directly in CSS, those selectors would hide unrelated form groups.
 */
export const PASSKEY_CONTAINER_SELECTORS = [
  '[class*="passkey-option" i]',
  '[class*="passkey-section" i]',
  '[class*="passkey-container" i]',
  '[class*="iphone-signin" i]',
  '[class*="cross-device" i]',
  '[data-component-name*="passkey" i]',
  '[data-testid*="passkey" i][role="group"]',
];
