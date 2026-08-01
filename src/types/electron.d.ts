// Module augmentation for CastLabs Electron type gaps. CastLabs ECS exposes
// these APIs at runtime but omits them from its bundled electron.d.ts. They are
// declared once here rather than cast at each call site, so every use is still
// checked against a signature and a genuine mistake is not hidden by a cast.

declare namespace Electron {
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
