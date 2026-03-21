# Sidra

Minimal Apple Music desktop client. CastLabs Electron wraps `music.apple.com` directly, injecting a lightweight hook script to bridge MusicKit.js events to native platform media controls.

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

## Widevine VMP signing

Widevine enforces VMP (Verified Media Path) production signing on macOS and Windows. Linux does not support VMP and development keys are accepted there. Without production signing, Apple Music returns "Something went wrong" after login on macOS and Windows.

CastLabs ECS ships with development VMP keys. Production signing requires a free [CastLabs EVS](https://github.com/castlabs/electron-releases/wiki/EVS) account.

### One-time setup

```bash
uvx --from castlabs-evs evs-account signup
```

Credentials are stored at `~/.config/evs/config.json`. The account is portable - use `evs-account reauth` on any new machine.

### Build pipeline

`build/afterPack.cjs` runs `evs-vmp sign-pkg` via `uvx` as an electron-builder `afterPack` hook on `darwin` and `win32`. This must execute before macOS code-signing (i.e. `afterPack`, not `afterSign`).

For `just run` (dev mode), `just install` and `just build` both invoke `_sign-evs`, which signs `node_modules/electron/dist` directly so the local Electron binary has production VMP keys.

### Credentials

| Context | Method |
|---------|--------|
| Local machine | `~/.config/evs/config.json` populated by `evs-account signup` or `reauth`; or set `EVS_ACCOUNT_NAME` + `EVS_PASSWD` env vars (e.g. via sops-nix) |
| GitHub Actions | `EVS_ACCOUNT_NAME` and `EVS_PASSWD` repository secrets; passed to the "Build distributables" step in `builder.yml` |

### User-Agent

All platforms send a platform-accurate Chrome UA (`chromeUA()` in `src/main.ts`), stripping Electron identifiers that Apple Music detects and blocks. The `Sec-CH-UA-Platform` Client Hint is sent on every request and must match the UA platform token — a Linux UA on macOS creates a detectable inconsistency. Chrome version is pinned to `144.0.0.0` to match the CastLabs ECS Chromium build.

| Platform | UA platform token |
|----------|------------------|
| macOS | `Macintosh; Intel Mac OS X 10_15_7` |
| Windows | `Windows NT 10.0; Win64; x64` |
| Linux | `X11; Linux x86_64` |

The `10_15_7` macOS version freeze is intentional - Chrome itself freezes this value to reduce fingerprinting surface.

## Conventions

- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
- British English spelling
- The codebase is tightly focused and as lean as possible

## Internationalisation (i18n)

`src/i18n.ts` handles all locale detection and translated strings for Sidra's own UI. Apple Music's web UI localises itself independently.

### Locale detection

- `app.getPreferredSystemLanguages()` returns a BCP 47 ordered list (e.g. `['en-GB', 'en']`)
- `getLoadingText()` walks the list and matches against the `LOADING_TEXT` record - exact tag first, then base language (e.g. `en-GB` → `en`)
- `getStorefront()` uses `app.getLocaleCountryCode()` to extract the region code independently of language (e.g. returns `GB` regardless of whether the language is `en`, `cy`, or `gd`), then lowercases it for use as an Apple Music storefront path segment

### Adding translations

`src/i18n.ts` contains all translation records for Sidra's own UI. Each record is a `Record<string, string>` keyed by BCP 47 language tags. Currently 7 records with 33 languages each: `LOADING_TEXT`, `ABOUT_TEXT`, `QUIT_TEXT`, `CLOSE_TEXT`, `VERSION_PREFIX`, `COPYRIGHT_SUFFIX`, `LICENSE_PREFIX`. When adding a language, add an entry to every record.

```typescript
export const LOADING_TEXT: Record<string, string> = {
  'en': 'Loading...',
  'fr': 'Chargement...',
  // add new entries here
};
```

Prefer specific regional tags only when the translation differs from the base language variant (e.g. `zh-CN` vs `zh-TW`). Use the base tag (e.g. `fr`) for languages where one translation covers all regions.

## Configuration

`src/config.ts` is a typed wrapper around `electron-store`. It exposes typed getter/setter pairs and is the single location for all persistent application state.

| Key | Type | Purpose |
|-----|------|---------|
| `storefront` | `string` | Apple Music storefront code (e.g. `gb`, `us`) |
| `language` | `string \| null` | BCP 47 language override for the storefront `?l=` parameter |

Getters return `undefined` when no value has been persisted - absence of a key is intentional and drives the storefront fallback chain in `main.ts`. Do not add default values to the store schema.

When adding new persistent settings, add typed getter/setter pairs to `config.ts` following the existing pattern. Do not use `electron-store` directly elsewhere in the codebase.

## Architecture notes

- Chromium's built-in `MediaSessionService` must be disabled on Linux to avoid conflicting MPRIS registrations; Sidra registers its own `org.mpris.MediaPlayer2.sidra` service via dbus-next
- macOS and Windows use Chromium's native mediaSession bridges (no extra libraries)
- Authentication is handled entirely by Apple's web flow; use `persist:sidra` partition for cookie persistence
- Volume sync between MPRIS and MusicKit uses a suppression flag to prevent feedback loops
