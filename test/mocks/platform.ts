// test/mocks/platform.ts
// Shared process.platform override for tests that exercise per-platform paths.

let original: PropertyDescriptor | undefined;

/**
 * Forces `process.platform`. Node declares the property non-writable and
 * configurable, so assignment does nothing and only `defineProperty` moves the
 * value. The descriptor is captured whole on the first call, because a saved
 * value alone has to be put back through a fresh descriptor and every such
 * variant passed `writable: true`, leaving the property writable for the rest
 * of the file in a state Node never has.
 */
export function setPlatform(platform: string): void {
  original ??= Object.getOwnPropertyDescriptor(process, 'platform');
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

/**
 * Puts the captured descriptor back. Register it with `afterEach`, which Vitest
 * runs even when the test throws, so a forced platform cannot reach the next
 * test.
 */
export function restorePlatform(): void {
  if (original) Object.defineProperty(process, 'platform', original);
  original = undefined;
}
