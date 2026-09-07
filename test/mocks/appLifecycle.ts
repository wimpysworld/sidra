// Shared app lifecycle helper for tests that assert listener cleanup.
import { vi } from 'vitest';
import { app } from 'electron';

/**
 * Runs recorded `will-quit` handlers to simulate shutdown.
 * The Electron mock stores calls in a plain `vi.fn()`, so the cast narrows its overloaded signature to the recorded arguments.
 */
export function quit(): void {
  const registered = vi.mocked(app.on).mock.calls as unknown as Array<[string, () => void]>;
  for (const [event, handler] of registered) if (event === 'will-quit') handler();
}
