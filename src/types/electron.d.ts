// CastLabs ECS provides these runtime APIs but omits their declarations.
// Central augmentation keeps callers type-checked without local casts.

/** Runtime APIs missing from the bundled CastLabs Electron declarations. */
declare namespace Electron {
 /** Electron application APIs missing from the bundled CastLabs declarations. */
 interface App {
  /**
   * Sets the XDG desktop filename on Linux. CastLabs maps the name to
   * `CHROME_DESKTOP`, which gives Sidra's PulseAudio stream its own name and icon.
   */
  setDesktopName(name: string): void;

  /**
   * Accepts `cache`, which the runtime supports but the CastLabs union omits.
   * Sidra uses this path for the artwork cache.
   */
  getPath(name: "cache"): string;
 }
}
