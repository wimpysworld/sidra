// CastLabs ECS exposes these APIs but omits their types. Shared declarations
// keep call sites type-checked without casts.

/** Runtime APIs missing from the bundled CastLabs Electron declarations. */
declare namespace Electron {
  /** CastLabs additions to the Electron application API. */
  interface App {
    /**
     * Set the XDG desktop filename (Linux). It sets CHROME_DESKTOP, which is
     * what gives Sidra's audio stream its own name and icon in PulseAudio.
     */
    setDesktopName(name: string): void;

    /**
     * 'cache' is a valid runtime path, used for the artwork cache, but is
     * absent from the CastLabs union type.
     */
    getPath(name: 'cache'): string;
  }
}
