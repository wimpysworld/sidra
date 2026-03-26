# Sidra

> This file is the authoritative reference for the Sidra project. All agents and tooling should treat it as the single source of truth for architecture, conventions, and configuration.

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
| Test framework | Vitest | Unit tests for src modules |

## Runtime dependencies

Current:

- `electron-store` - Persistent configuration
- `electron-log` - Logging
- `electron-updater` - Auto-update for AppImage and NSIS
- `dbus-next` - MPRIS D-Bus service (Linux)
- `@xhayper/discord-rpc` - Discord Rich Presence

## Project structure (target)

```
sidra/
├── src/
│   ├── main.ts              — Bootstrap, Widevine, window, IPC hub
│   ├── preload.ts           — contextBridge IPC exposure
│   ├── autoUpdate.ts        — Auto-update via electron-updater (AppImage, NSIS)
│   ├── config.ts            — electron-store wrapper
│   ├── i18n.ts              — Locale detection; loads translation records from assets/locales/ JSON files
│   ├── paths.ts             — `getAssetPath()` and `getProductInfo()` utilities
│   ├── player.ts            — TypedEmitter, PlayerEvents, PlaybackState, IntegrationContext
│   ├── storefront.ts        — URL construction and storefront detection
│   ├── types/
│   │   └── electron.d.ts    — Module augmentations for CastLabs type gaps (setDesktopName, getPath('cache'))
│   ├── theme.ts             — Named theme lifecycle: ThemeName, applyTheme(), initThemeCSS(), themeCssMap
│   ├── utils.ts             — `errorMessage()` utility
│   └── integrations/
│       ├── mpris/           — D-Bus MPRIS (Linux)
│       ├── discord-presence/
│       ├── notifications/
│       └── media-session/   — navigator.mediaSession (macOS/Windows)
├── assets/
│   ├── musicKitHook.js      — Injected into music.apple.com
│   ├── navigationBar.js     — Injected browser navigation controls (Back/Forward/Reload)
│   ├── styleFix.css         — Suppress "Get the app" banners
│   ├── icons/
│   ├── locales/             — Translation record JSON files (loaded by src/i18n.ts)
│   │   ├── loading.json     — LOADING_TEXT
│   │   ├── tray.json        — 21 tray menu records
│   │   ├── about.json       — 4 about dialog records
│   │   └── update.json      — 5 auto-update records
│   └── source/              — Gimp XCF masters and SVG source files
├── test/
│   ├── setup.ts             — Vitest global setup (global mocks: electron, electron-log/main, electron-store)
│   ├── mocks/
│   │   └── storefront-deps.ts — Shared vi.mock() fixture for tests that import storefront code
│   ├── i18n.test.ts         — i18n locale detection and string lookup
│   ├── i18n-consistency.test.ts — All records have identical key sets
│   ├── player.test.ts       — Player, TypedEmitter, PlaybackState
│   ├── storefront.test.ts   — buildAppleMusicURL, extractStorefrontFromURL
│   ├── update.test.ts       — Auto-update platform detection
│   ├── url.test.ts          — URL construction edge cases
│   └── utils.test.ts        — errorMessage utility
├── package.json
└── tsconfig.json
```

`assets/source/` contains Gimp XCF masters and SVG source files tracked in git but excluded from packaging. Distributable assets live directly in `assets/` or `assets/icons/`.

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
| Install | `just install` | Install npm dependencies |
| Build | `just build` | Compile TypeScript to `dist/` |
| Run | `just run` | Build and launch the app |
| Run fast | `just run-fast` | Launch without rebuilding (pair with `just watch`) |
| Watch | `just watch` | Rebuild on file changes |
| Lint | `just lint` | Run actionlint and TypeScript type-check |
| Test | `just test` | Run Vitest unit tests (`npm test`) |
| Clean | `just clean` | Remove `dist/` build artefacts |
| Logs | `just logs` | Show log file location and tail recent entries |

### Debug and diagnostics

| Recipe | Command | Purpose |
|---|---|---|
| Debug | `just run-debug` | Launch with `ELECTRON_LOG_LEVEL=debug` (verbose file logging) |
| DevTools | `just run-devtools` | Launch with DevTools open for inspecting CSS and DOM |
| Inspect | `just run-inspect` | Launch with both debug logging and DevTools |

### Style tooling

| Recipe | Command | Purpose |
|---|---|---|
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

## Code quality objectives

These standards are established and must be maintained.

**Electron security**
- `contextIsolation: true`, `nodeIntegration: false` on all windows
- All renderer→main IPC flows through the `SEND_CHANNELS` allowlist in `src/preload.ts`; blocked channels log a warning
- No Node.js APIs exposed to the renderer
- External URLs validated for `http:`/`https:` protocol before opening via `setWindowOpenHandler` and tray links

**TypeScript**
- `strict: true` in `tsconfig.json`; zero `any` annotations, `@ts-ignore`, or `@ts-expect-error` in `src/`
- IPC payloads typed via `TypedEmitter<PlayerEvents>`; no raw string channel dispatch
- CastLabs type gaps resolved via module augmentations in `src/types/electron.d.ts`, not type casts at call sites

**Architecture**
- All integrations follow the `init(ctx: IntegrationContext)` pattern and manage their own lifecycle
- Platform-specific modules (`electron-updater`, MPRIS) lazy-required only when needed; never at module top level
- `playbackTimeDidChange` handlers store position only - never trigger a debounced send (see architecture notes)
- All event listeners and resources cleaned up on `will-quit`

**Tests**
- Tests cover pure logic and event forwarding; shared mock fixtures live in `test/mocks/` to avoid duplication
- Type-level assertions (`expectTypeOf`) used to verify event map contracts at compile time

**Dependencies**
- Minimise runtime dependencies; each must be purpose-driven
- Do not add dependencies that duplicate Electron or Node.js built-ins

## Internationalisation (i18n)

`src/i18n.ts` handles all locale detection and translated strings for Sidra's own UI. Apple Music's web UI localises itself independently.

### Locale detection

- `app.getPreferredSystemLanguages()` returns a BCP 47 ordered list (e.g. `['en-GB', 'en']`)
- `getLoadingText()` walks the list and matches against the `LOADING_TEXT` record - exact tag first, then base language (e.g. `en-GB` → `en`)
- `getStorefront()` uses `app.getLocaleCountryCode()` to extract the region code independently of language (e.g. returns `GB` regardless of whether the language is `en`, `cy`, or `gd`), then lowercases it for use as an Apple Music storefront path segment

### Adding translations

Translation records live in `assets/locales/` as JSON files. Each JSON file contains a map of record names to `Record<string, string>` objects keyed by BCP 47 language tags. `src/i18n.ts` loads these at startup via `fs.readFileSync` + `getAssetPath()` and re-exports all 31 named records.

| File | Records |
|------|---------|
| `assets/locales/loading.json` | `LOADING_TEXT` |
| `assets/locales/tray.json` | `ABOUT_TEXT`, `QUIT_TEXT`, `NOTIFICATIONS_TEXT`, `DISCORD_TEXT`, `START_PAGE_TEXT`, `START_PAGE_HOME_TEXT`, `START_PAGE_NEW_TEXT`, `START_PAGE_RADIO_TEXT`, `START_PAGE_ALL_PLAYLISTS_TEXT`, `START_PAGE_LAST_TEXT`, `ON_TEXT`, `OFF_TEXT`, `STYLE_TEXT`, `ZOOM_TEXT`, `PREVIOUS_TEXT`, `PLAY_TEXT`, `PAUSE_TEXT`, `NEXT_TEXT`, `VOLUME_TEXT`, `MUTE_TEXT`, `SHARE_TEXT` |
| `assets/locales/about.json` | `CLOSE_TEXT`, `VERSION_PREFIX`, `COPYRIGHT_SUFFIX`, `LICENSE_PREFIX` |
| `assets/locales/update.json` | `UPDATE_AVAILABLE_TEXT`, `UP_TO_DATE_TEXT`, `UPDATE_READY_TEXT`, `RESTART_NOW_TEXT`, `LATER_TEXT` |

When adding a language, add an entry to every record in every JSON file.

```json
{
  "LOADING_TEXT": {
    "en": "Loading...",
    "fr": "Chargement...",
    "de": "Wird geladen..."
  }
}
```

All locale JSON files must be listed individually in `asarUnpack` in `package.json` - globs are not supported.

Prefer specific regional tags only when the translation differs from the base language variant (e.g. `zh-CN` vs `zh-TW`). Use the base tag (e.g. `fr`) for languages where one translation covers all regions.

## Configuration

`src/config.ts` is a typed wrapper around `electron-store`. It exposes typed getter/setter pairs and is the single location for all persistent application state.

| Key | Type | Purpose |
|-----|------|---------|
| `storefront` | `string` | Apple Music storefront code (e.g. `gb`, `us`) |
| `language` | `string \| null` | BCP 47 language override for the storefront `?l=` parameter |
| `theme` | `ThemeName` (`'apple-music' \| 'catppuccin'`) | Active theme (default: `'apple-music'`, meaning no override CSS) |
| `notifications.enabled` | `boolean` | Toggle desktop notifications (default: true) |
| `discord.enabled` | `boolean` | Toggle Discord Rich Presence (default: true) |
| `autoUpdate.enabled` | `boolean` | Enable automatic updates (default: true on AppImage and NSIS; disabled on all other platforms) |

Getters return `undefined` when no value has been persisted - absence of a key is intentional and drives the storefront fallback chain in `main.ts`. Do not add default values to the store schema.

When adding new persistent settings, add typed getter/setter pairs to `config.ts` following the existing pattern. Do not use `electron-store` directly elsewhere in the codebase.

## CSS injection

`webContents.insertCSS()` injects at author-level cascade origin. Apple's own stylesheets compete at the same specificity, so all overrides require `!important` or they lose on specificity ties after navigation.

`@media (prefers-color-scheme: dark/light)` resolves correctly against `nativeTheme.shouldUseDarkColors`. A single CSS file with both media blocks covers both variants.

### Elements outside the `:root` cascade

Most Apple Music styling responds to `:root` custom property overrides. These elements do not:

| Element | Selector | Reason |
|---------|----------|--------|
| Player bar background | `.wrapper amp-chrome-player::before` | `::before` pseudo paints the bar |
| Side panels (Lyrics/Up Next) | `.side-panel`, `.side-panel-header-wrapper` | Direct `background-color` |
| Page footer | `.scrollable-page > footer` | Direct `background-color` |
| LCD now-playing widget | `amp-lcd { --lcd-bg-color }` | Shadow DOM scoped variable |
| Accent-coloured buttons | `.button.primary button.click-action` | Direct `background-color: rgb(214, 0, 23)` ignores `--keyColor` |
| Accent CSS variables (`--keyColor` and variants) | `*` | Shadow DOM of `amp-*` elements does not inherit from `:root` |

**Pattern:** when a `:root` variable override has no visible effect, the element either (a) uses a shadow-DOM-scoped custom property (set the variable on the host element), or (b) paints its own background via `::before` or a direct property (use a direct selector with `!important`).

### CSS variable audit

Active Apple Music userstyle repositories provide reliable cross-referenced variable lists: PitchBlack (`sprince0031/PitchBlack-UserStyle-themes`), Native AM (`dantelin2009`), AppleMusic-Tui. Search with `mcp__exa__get_code_context_exa` using `"apple music userstyle css variables site:github.com"`.

### Asset packaging

CSS files read via `fs.readFileSync` at runtime must be listed individually in `asarUnpack` in `package.json`. `asarUnpack` does not support globs - each file must be named explicitly or packaged builds will fail to read them.

## Architecture notes

- Event flow: MusicKit.js events in the renderer are captured by `assets/musicKitHook.js` (injected post-load), forwarded via IPC to `src/player.ts` (EventEmitter), then distributed to integrations; controls flow in reverse via `webContents.send()` to the preload, which uses `window.postMessage()` to bridge the context isolation boundary, and `musicKitHook.js` listens for `sidra:command` messages and dispatches to `window.__sidra` methods
- `assets/musicKitHook.js` is read with `fs.readFileSync` at runtime; it must be listed in `asarUnpack` in the electron-builder config or AppImage builds will crash on startup
- Chromium's built-in `MediaSessionService` must be disabled on Linux to avoid conflicting MPRIS registrations; Sidra registers its own `org.mpris.MediaPlayer2.sidra` service via dbus-next
- macOS and Windows use Chromium's native mediaSession bridges (no extra libraries)
- Authentication is handled entirely by Apple's web flow; use `persist:sidra` partition for cookie persistence
- Volume sync between MPRIS and MusicKit uses a suppression flag to prevent feedback loops
- `volumeDidChange` on the MusicKit instance does not fire when the music.apple.com volume slider is used - the slider writes directly to `HTMLMediaElement.volume`, bypassing MusicKit's setter; the hook script polls `mk.volume` every 250ms as a fallback alongside the event listener
- `Notification.isSupported()` returns `false` in CastLabs Electron even when the platform fully supports notifications; do not gate on it - listen for the `failed` event instead to surface OS-level rejection
- `app.setAppUserModelId()` must be called before `app.whenReady()` on Windows for both GSMTC identity and desktop notifications to work
- Use `app.getPath('cache')` for artwork storage (not `os.tmpdir()`); the cache directory is not guaranteed to exist so call `fs.mkdirSync(..., { recursive: true })` before writing
- On NixOS, `libnotify` must be in `LD_LIBRARY_PATH` or `Notification.show()` will silently do nothing; ensure it is in the Nix dev shell
- `playbackTimeDidChange` fires every ~250ms (MusicKit polling); integrations must NOT call a debounced update function from this event or the debounce timer resets continuously and never expires - only store the updated position, then let other events trigger the debounced send
- `dbus-next` does not automatically emit `PropertiesChanged` signals; call `Interface.emitPropertiesChanged()` explicitly when property values change - never include `Position` in these calls (MPRIS spec forbids it; clients poll or use the `Seeked` signal)
- `dbus-next` property, method, and signal decorators use TC39 stage-2 format which TypeScript does not support; use `configureMembers()` instead - it is the documented alternative API and takes the same type signature descriptors
- `dbus-next` delivers D-Bus `x` (int64) parameters as JavaScript `BigInt`; always convert with `Number()` before mixing with regular arithmetic - `Seek(offset)` and `SetPosition(trackId, position)` are the affected MPRIS methods
- MPRIS `Stop()` must map to `window.__sidra.pause()`, not `MusicKit.stop()`; `stop()` clears the queue, which violates the MPRIS spec requirement that calling `Play()` after `Stop()` resumes from the beginning of the track
- MPRIS `PlaybackStatus` maps all MusicKit states - including transient ones (1=loading, 6=seeking, 7=waiting, 8=stalled) - directly to MPRIS values; transient states fall through to `'Stopped'` intentionally so MPRIS always reflects the actual MusicKit state; do not add early-return guards for transient states
- MPRIS `Volume` controls MusicKit's software volume (`HTMLMediaElement.volume`) only - the PulseAudio/PipeWire sink input volume is independent; this matches the behaviour of Rhythmbox, Spotify, VLC, and every other major Linux music player; do not attempt to sync them
- Chromium hard-codes `application.name = "Chromium"` and `application.icon_name = "chromium-browser"` on PulseAudio streams; `PULSE_PROP_*` environment variables are ineffective (Chromium's explicit API calls override them); the fix is `disable-features=AudioServiceOutOfProcess` (moves audio in-process so `SetGlobalAppName` reaches PulseAudio) combined with `app.setDesktopName('sidra.desktop')` (sets `CHROME_DESKTOP` for `GetXdgAppId()`); see [electron/electron#27581](https://github.com/electron/electron/issues/27581) and `docs/PULSE.md`
- `music.apple.com` registers a `beforeunload` event handler while audio is playing; this silently blocks `BrowserWindow.close()` and `app.quit()` with no dialog or error (standard Chromium/Electron behaviour - unlike Chrome, Electron does not show a confirmation dialog); fix with `win.webContents.on('will-prevent-unload', (event) => event.preventDefault())`; see [electron/electron#8468](https://github.com/electron/electron/issues/8468) and `docs/QUIT.md`
- `electron-updater` must be lazy-required inside `initAutoUpdate()` only - never at module top level; on unsupported platforms the module must never load; verify via log output: `autoUpdate` scope logs must not appear on deb/rpm/Nix builds
- `electron-updater` implements its own download/install pipeline and does not use Electron's built-in `autoUpdater`; all APIs it uses are unmodified in CastLabs ECS; the known `app.relaunch()` bug (CastLabs issue #164) does NOT affect `AppImageUpdater` - it spawns the new binary via `child_process.spawn()` directly
- Platform detection for auto-update: `process.env.APPIMAGE` is set only when running as an AppImage (present = enable updater, absent = notification-only); on Windows, `app.isPackaged` on `win32` indicates an NSIS installation
- `verifyUpdateCodeSignature: false` is required on Windows because the app is unsigned
- `app-update.yml` is present in all packaged builds including deb/rpm/Nix; runtime detection in `isAutoUpdateSupported()` prevents updater initialisation even if the file is present
- electron-updater manifest filenames are hardcoded: `latest.yml` = Windows manifest, `latest-linux.yml` = Linux manifest; these cannot be consolidated
- `SIDRA_DISABLE_AUTO_UPDATE=1` env var disables auto-update for AppImage/NSIS builds; future package managers (Scoop, Chocolatey) must set this in their install manifests
- AppImage `artifactName` must omit the version component (use `${productName}-${os}-${arch}.${ext}`) to prevent filename changes breaking desktop shortcuts after update
- On NixOS, `libxcrypt-legacy` must be in `LD_LIBRARY_PATH` (already added to `flake.nix`) for fpm's bundled Ruby to find `libcrypt.so.1` during deb/rpm builds; without it, deb/rpm targets fail at the fpm stage
- `webContents.reload()` must be preceded by `wedgeDetector.reset()` when called from an IPC handler; without this, the wedge detector's `isPlaying` flag remains `true` through the reload, causing spurious skip-forward attempts after the page re-initialises
- CastLabs Electron type definitions omit `App.setDesktopName()` and `'cache'` from `app.getPath()` - both methods work at runtime; use module augmentations in `src/types/electron.d.ts` rather than type casts at call sites
- `dbus-next` has no public API to fully close its socket; `bus.disconnect()` calls `stream.end()` only (half-close); `(bus as DbusMessageBusInternals)._connection?.stream?.destroy()` is the only way to force-close - the `DbusMessageBusInternals` interface in `src/integrations/mpris/index.ts` documents this and is version-pinned to `@holusion/dbus-next 0.11.2`
- `setupContentHandlers()` uses a single `on('did-finish-load')` handler with an `initialized` flag (not `once`/`on` split) - both `once` and `on` fire on the first load, and async `executeJavaScript` injection cannot rely on script-level idempotency guards to prevent double event listener registration
- Theme system uses `ThemeName = 'apple-music' | 'catppuccin'` and `applyTheme(name)` in `src/theme.ts`; `'apple-music'` means no override CSS is injected; adding a new theme requires: add to `ThemeName` union, add to `themeCssMap`, add CSS file to `assets/`, list in `asarUnpack` in `package.json`, add radio option to tray
- `test/mocks/storefront-deps.ts` contains shared `vi.mock()` declarations for tests that import storefront code; Vitest hoists `vi.mock()` calls within the fixture file itself, so the fixture uses `../../src/` paths (relative to `test/mocks/`, not `test/`) - do not change these paths
