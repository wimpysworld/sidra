/**
 * The message of an Error, or the value itself as a string. A catch binds
 * unknown under strict mode, so this holds the narrowing every log site needs.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Run named steps in order, each isolated so one failure cannot cancel the steps
// after it. The reporter is a parameter to keep this module free of
// electron-log.
export function runSteps(
  steps: readonly (readonly [string, () => void])[],
  report: (name: string, err: unknown) => void,
): void {
  for (const [name, step] of steps) {
    try {
      step();
    } catch (e: unknown) {
      report(name, e);
    }
  }
}
