// Shared process.platform override for tests that exercise per-platform paths.

let original: PropertyDescriptor | undefined;

/**
 * Overrides `process.platform` through its configurable descriptor because the property is not writable.
 * Saves the whole descriptor so restoration also preserves Node's property flags.
 */
export function setPlatform(platform: string): void {
  original ??= Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/**
 * Restores the captured descriptor. Register with `afterEach` so a thrown test cannot leave the platform override active.
 */
export function restorePlatform(): void {
  if (original) Object.defineProperty(process, 'platform', original);
  original = undefined;
}
