// Constants shared between loadAssets() in src/main.ts and the injected
// assets/authFrameFix.js. They live here rather than in main.ts so
// test/authFrameFix.test.ts can import them: main.ts calls app.whenReady() at
// import and no test can load it. src/i18n.ts exports NAV_LABELS_TOKEN for the
// same reason.

// Substituted by loadAssets() in src/main.ts; assets/authFrameFix.js carries
// the same spelling.
export const AUTH_FIX_TOKEN = '__SIDRA_AUTH_FIX__';

// Containers that name the passkey or "Sign in with iPhone" option. Both jobs
// in assets/authFrameFix.js need them: the injected stylesheet hides a match on
// sight, and closest() walks up to one from a button it has already matched.
// Only selectors that name the feature belong here. The broad class prefixes
// and the structural [role="group"] and fieldset entries stay in the script,
// where the walk starts at a matched button; in the stylesheet they would hide
// unrelated form groups.
export const PASSKEY_CONTAINER_SELECTORS = [
  '[class*="passkey-option" i]',
  '[class*="passkey-section" i]',
  '[class*="passkey-container" i]',
  '[class*="iphone-signin" i]',
  '[class*="cross-device" i]',
  '[data-component-name*="passkey" i]',
  '[data-testid*="passkey" i][role="group"]',
];
