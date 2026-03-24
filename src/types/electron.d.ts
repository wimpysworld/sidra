// Module augmentation for CastLabs Electron type gaps.
// CastLabs ECS exposes these APIs at runtime but omits them from its bundled
// electron.d.ts declarations.

declare namespace Electron {
  interface App {
    /** Set the XDG desktop filename (Linux). CastLabs exposes this at runtime. */
    setDesktopName(name: string): void;

    /** 'cache' is a valid runtime path but absent from the CastLabs union type. */
    getPath(name: 'cache'): string;
  }
}
