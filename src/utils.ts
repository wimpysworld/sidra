export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Each step is isolated so one failure cannot cancel the steps after it. The
// reporter is a parameter to keep this module free of electron-log.
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
