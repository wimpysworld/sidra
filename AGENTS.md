# Sidra

Minimal Apple Music desktop client. CastLabs Electron wraps `music.apple.com` directly, injecting a lightweight hook script to bridge MusicKit.js events to native platform media controls.

No code has been written yet. This document describes the target architecture.

## Technology stack

| Component | Technology | Purpose |
|---|---|---|
| Shell | CastLabs Electron (`castlabs/electron-releases`, wvcus) | Widevine CDM for DRM playback |
| Language | TypeScript | Application code |
| Renderer | `music.apple.com` | Apple maintains the UI |
| Package manager | npm | Dependency management |
| Build | electron-builder | Platform installers (AppImage, deb, rpm, DMG, NSIS) |
| Dev environment | Nix flake + direnv | Reproducible tooling |

## Runtime dependencies

Four total:

- `dbus-next` - MPRIS D-Bus service (Linux)
- `@xhayper/discord-rpc` - Discord Rich Presence
- `electron-store` - Persistent configuration
- `electron-log` - Logging

## Project structure (target)

```
sidra/
├── src/
│   ├── main.ts              — Bootstrap, Widevine, window, IPC hub
│   ├── preload.ts           — contextBridge IPC exposure
│   ├── config.ts            — electron-store wrapper
│   ├── player.ts            — EventEmitter for playback state
│   └── integrations/
│       ├── integration.ts   — IIntegration interface
│       ├── mpris/           — D-Bus MPRIS (Linux)
│       ├── discord-presence/
│       ├── notifications/
│       └── media-session/   — navigator.mediaSession (macOS/Windows)
├── assets/
│   ├── musicKitHook.js      — Injected into music.apple.com
│   ├── styleFix.css         — Suppress "Get the app" banners
│   └── icons/
├── package.json
└── tsconfig.json
```

## Configuration files

| File | Purpose |
|---|---|
| `package.json` | Dependencies, scripts, electron-builder config |
| `tsconfig.json` | TypeScript compiler options |
| `flake.nix` | Nix dev shell (actionlint, gh, just, tailor) |
| `justfile` | Task runner recipes |
| `docs/SPECIFICATION.md` | Full architecture specification and design rationale |

## Development environment

Run `direnv allow` in the project root to activate the Nix dev shell automatically. Alternatively, run `nix develop` to enter it manually. Both methods provide all required tooling.

## Development commands

| Recipe | Command | Purpose |
|---|---|---|
| List recipes | `just` | Show all available recipes |
| Lint | `just lint` | Run actionlint against GitHub Actions workflows |
| Measure | `just measure` | Dry-run tailor and report style metrics |
| Alter | `just alter` | Apply tailor style changes |

## Conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
- British English spelling
- The codebase is tightly focused and as lean as possible

## Architecture notes

- Chromium's built-in `MediaSessionService` must be disabled on Linux to avoid conflicting MPRIS registrations; Sidra registers its own `org.mpris.MediaPlayer2.sidra` service via dbus-next
- macOS and Windows use Chromium's native mediaSession bridges (no extra libraries)
- Authentication is handled entirely by Apple's web flow; use `persist:sidra` partition for cookie persistence
- Volume sync between MPRIS and MusicKit uses a suppression flag to prevent feedback loops
