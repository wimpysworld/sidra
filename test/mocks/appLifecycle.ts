// test/mocks/appLifecycle.ts
// Shared app lifecycle helper for tests that assert listener cleanup.
import { vi } from 'vitest';
import { app } from 'electron';

/**
 * Runs the `will-quit` handlers a module registered, as quitting does. The
 * electron mock records them rather than firing them, and its `app.on` is a
 * plain `vi.fn()`, so the overloaded signature is narrowed to what is stored.
 */
export function quit(): void {
  const registered = vi.mocked(app.on).mock.calls as unknown as Array<[string, () => void]>;
  for (const [event, handler] of registered) if (event === 'will-quit') handler();
}
