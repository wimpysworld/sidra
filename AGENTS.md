# Sidra

Minimal Apple Music desktop client. CastLabs Electron wraps `music.apple.com` and `classical.music.apple.com` directly, injecting a lightweight hook script to bridge MusicKit.js events to native platform media controls. `src/musicService.ts` holds the registry of both services.

## Technology stack

| Component | Technology | Purpose |
|---|---|---|
| Shell | CastLabs Electron (`castlabs/electron-releases`, wvcus) | Widevine CDM for DRM playback |
| Language | TypeScript | Application code |
| Renderer | `music.apple.com` and `classical.music.apple.com` | Apple maintains the UI |
| Package manager | npm | Dependency management |
| Build | electron-builder | Platform installers (AppImage, deb, rpm, DMG, NSIS) |
| Dev environment | Nix flake + direnv | Reproducible tooling |
| Test framework | Vitest | Unit tests for src modules |

## Development commands

Run `just --list` to see all available recipes. Key entry points: `just install` → `just run` for a dev build; `just test` for unit tests; `just lint` for type-check and actionlint. Debug variants (`run-debug`, `run-devtools`, `run-inspect`) and style tooling (`measure`, `alter`) are also available.

## User-Agent

All platforms send a platform-accurate Chrome UA (`chromeUA()` in `src/main.ts`), stripping Electron identifiers that Apple Music detects and blocks. Chrome version is pinned to `144.0.0.0` to match the CastLabs ECS Chromium build.

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

**Electron security**
- `contextIsolation: true`, `nodeIntegration: false` on all windows
- All renderer→main IPC flows through the `SEND_CHANNELS` allowlist in `src/preload.ts`; blocked channels log a warning
- No Node.js APIs exposed to the renderer
- External URLs validated for `http:`/`https:` protocol before opening via `setWindowOpenHandler` and tray links

**TypeScript**
- `strict: true` in `tsconfig.json`; zero `any` annotations, `@ts-ignore`, or `@ts-expect-error` in `src/`
- IPC payloads typed via `TypedEmitter<PlayerEvents>`; no raw string channel dispatch
- CastLabs type gaps resolved via module augmentations in `src/types/electron.d.ts`, not type casts at call sites
- Hook-preload contract typed via `src/types/hook.d.ts` - declares `SidraHook`, `AMWrapperBridge`, `SendChannel`, `ReceiveChannel`, `SidraCommandMessage`, and `Window` augmentations; preload uses `Set<SendChannel>` and `Set<ReceiveChannel>` so tsc enforces channel sync at compile time

**Architecture**
- All integrations follow the `init(ctx: IntegrationContext)` pattern and manage their own lifecycle
- Platform-specific modules (`electron-updater`, MPRIS) lazy-required only when needed; never at module top level
- `playbackTimeDidChange` handlers store position only - never trigger a debounced send (see architecture notes)
- All event listeners and resources cleaned up on `will-quit`

**Tests**
- Tests cover pure logic and event forwarding; shared mock fixtures live in `test/mocks/` to avoid duplication
- Type-level assertions (`expectTypeOf`) used to verify event map contracts at compile time
- `src/config.ts` is exercised directly, never through a hand-written stand-in; `electron-conf/main` is mocked in `test/setup.ts` so the real module loads, and a self-mock makes every assertion read its own defaults back
- `tsconfig.json` sets `"include": ["src/**/*.ts"]`, so `just lint` type-checks `src/` only and Vitest transpiles without type-checking; a type error in `test/` is invisible to both gates

**Dependencies**
- Minimise runtime dependencies; each must be purpose-driven
- Do not add dependencies that duplicate Electron or Node.js built-ins

## Internationalisation (i18n)

`src/i18n.ts` handles locale detection and translated strings for Sidra's own UI. Apple Music's web UI localises itself independently.

### Locale detection

- `app.getPreferredSystemLanguages()` returns a BCP 47 ordered list (e.g. `['en-GB', 'en']`)
- `getLoadingText()` walks the list and matches against the `LOADING_TEXT` record - exact tag first, then base language (e.g. `en-GB` → `en`)
- `getStorefront()` uses `app.getLocaleCountryCode()` to extract the region code independently of language (e.g. returns `GB` regardless of whether the language is `en`, `cy`, or `gd`), then lowercases it for use as an Apple Music storefront path segment

### Adding translations

Translation records live in `assets/locales/` as JSON files. Each file contains a map of record names to `Record<string, string>` objects keyed by BCP 47 language tags. `src/i18n.ts` loads these at startup via `fs.readFileSync` + `getAssetPath()` and re-exports all 43 named records.

| File | Records |
|------|---------|
| `assets/locales/loading.json` | `LOADING_TEXT` |
| `assets/locales/tray.json` | `ABOUT_TEXT`, `QUIT_TEXT`, `NOTIFICATIONS_TEXT`, `DISCORD_TEXT`, `LASTFM_CONNECT_TEXT`, `LASTFM_CONNECTED_TEXT`, `LASTFM_CONNECT_FAILED_TEXT`, `LASTFM_DISCONNECT_TEXT`, `START_PAGE_TEXT`, `START_PAGE_HOME_TEXT`, `START_PAGE_NEW_TEXT`, `START_PAGE_RADIO_TEXT`, `START_PAGE_ALL_PLAYLISTS_TEXT`, `START_PAGE_LAST_TEXT`, `ON_TEXT`, `OFF_TEXT`, `STYLE_TEXT`, `ZOOM_TEXT`, `PREVIOUS_TEXT`, `PLAY_TEXT`, `PAUSE_TEXT`, `NEXT_TEXT`, `VOLUME_TEXT`, `SHARE_TEXT`, `MUTE_TEXT`, `HIDE_WINDOW_TEXT`, `SHOW_WINDOW_TEXT`, `CLOSE_TO_TRAY_TEXT`, `PLAYER_TEXT`, `START_PAGE_BROWSE_TEXT`, `START_PAGE_LIBRARY_TEXT`, `START_PAGE_PLAYLISTS_TEXT`, `START_PAGE_SEARCH_TEXT` |
| `assets/locales/about.json` | `CLOSE_TEXT`, `VERSION_PREFIX`, `COPYRIGHT_SUFFIX`, `LICENSE_PREFIX` |
| `assets/locales/update.json` | `UPDATE_AVAILABLE_TEXT`, `UP_TO_DATE_TEXT`, `UPDATE_READY_TEXT`, `RESTART_NOW_TEXT`, `LATER_TEXT` |

When adding a language, add an entry to every record in every JSON file:

```json
{
  "LOADING_TEXT": {
    "en": "Loading...",
    "fr": "Chargement...",
    "de": "Wird geladen..."
  }
}
```

- All locale JSON files must be listed individually in `asarUnpack` in `package.json` - globs are not supported
- Prefer specific regional tags only when the translation differs from the base language variant (e.g. `zh-CN` vs `zh-TW`); use the base tag (e.g. `fr`) for languages where one translation covers all regions

## Configuration

`src/config.ts` is a typed wrapper around `electron-conf` and the single location for all persistent application state.

| Key | Type | Purpose |
|-----|------|---------|
| `storefront` | `string` | Apple Music storefront code (e.g. `gb`, `us`) |
| `language` | `string \| null` | BCP 47 language override for the storefront `?l=` parameter |
| `theme` | `ThemeName` (`'apple-music' \| BundledThemeName \| 'custom'`) | Active theme (default: `'apple-music'`, meaning no override CSS) |
| `zoomFactor` | `number` | Renderer zoom factor (default: `1.0`) |
| `closeToTray.enabled` | `boolean` | Keep Sidra running in the tray when the window closes (default: false); gates the Hide/Show Window tray items and the tray left-click handler, so with it off, clicking the tray icon does nothing |
| `notifications.enabled` | `boolean` | Toggle desktop notifications (default: true) |
| `discord.enabled` | `boolean` | Toggle Discord Rich Presence (default: false) |
| `lastfm.enabled` | `boolean` | Toggle Last.fm scrobbling (default: false) |
| `lastfm.sessionKey` | `string \| null` | Last.fm session key obtained via the desktop auth flow |
| `lastfm.username` | `string \| null` | Authenticated Last.fm username (shown in the tray) |
| `autoUpdate.enabled` | `boolean` | Enable automatic updates (default: true on AppImage and NSIS; disabled on all other platforms) |
| `startPage` | `'home' \| 'new' \| 'radio' \| 'all-playlists' \| 'last'` | Page to load on launch (default: `'new'`) |
| `lastPageUrl` | `string` | Last visited page URL; used when `startPage` is `'last'` |
| `musicService` | `MusicServiceId` (`'music' \| 'classical'`) | Active music service (default: `'music'`) |
| `classical.startPage` | `string` | Start page for Apple Music Classical (default: `'home'`); valid values: `'home'`, `'browse'`, `'playlists'`, `'search'`, `'last'`. Classical has no library route on the web, so none is offered; an unknown stored id falls back to `'home'` |
| `classical.lastPageUrl` | `string` | Last visited Classical page URL; used when `classical.startPage` is `'last'` |

- Getters return `undefined` when no value has been persisted - absence of a key is intentional and drives the storefront fallback chain in `main.ts`; do not add default values to the store schema
- When adding new persistent settings, add typed getter/setter pairs to `config.ts` following the existing pattern; do not use `electron-conf` directly elsewhere

### Service switching

`switchService(id, targetUrl?)` in `src/serviceSwitch.ts` is the only switch sequence that ships. The tray Player submenu and `itms://` routing both call it; the tray click passes the id and nothing else, so the click itself neither persists the service nor rebuilds the menu. The steps, in order:

1. `resetWedgeDetector()` - `reset()` sets `skipAttempts` to 0 and stops the timer; stopping the timer suppresses the spurious skip-forward after the page re-initialises
2. `setMusicService(id)` - persists the new service id
3. `rebuildTrayMenu(tray)` - runs when a tray exists, so the menu reflects the new service
4. `setThemeCssKey(null)` - the navigation replaces the document, so the next injection must not call `removeInsertedCSS()` with a key from the old one
5. `loadURL(targetUrl ?? buildAppleMusicURL())` - `buildAppleMusicURL()` resolves after `setMusicService`, so the default reads the service just persisted

`main.ts` supplies the window and the tray through `initServiceSwitch({ getTray, loadURL })`, because `serviceSwitch.ts` cannot import `main.ts`: it runs `app.whenReady()` at import.

`routeToMusicService(url)` in the same module handles `itms://` links, which always target the music service. It calls `switchService('music', url)` when Classical is active and navigates directly otherwise, so the switch costs one navigation.

### Theme gating

`resolveTheme()` in `src/theme.ts` forces `'apple-music'` when the classical service is active, so no override CSS is injected. The stored `theme` value is left unchanged, so switching back to the music service restores the user's preferred theme. The Style submenu in the tray is disabled (`enabled: false`) when Classical is active.

### postMessage target origin

Playback controls are forwarded to the renderer via `window.postMessage(msg, window.location.origin)`. Using `window.location.origin` (rather than a hardcoded service origin) makes the bridge service-agnostic and passes the Chromium sandbox same-origin check for both `music.apple.com` and `classical.music.apple.com` without any conditional logic.

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
| Accent-coloured buttons | `.button.primary button.click-action` | Direct `background-color: rgb(214, 0, 23)` ignores `--keyColor` |
| Accent CSS variables (`--keyColor` and variants) | `*` | Shadow DOM of `amp-*` elements does not inherit from `:root` |

**Pattern:** when a `:root` variable override has no visible effect, the element either (a) uses a shadow-DOM-scoped custom property (set the variable on the host element), or (b) paints its own background via `::before` or a direct property (use a direct selector with `!important`).

### CSS variable audit

Active Apple Music userstyle repositories provide reliable cross-referenced variable lists: PitchBlack (`sprince0031/PitchBlack-UserStyle-themes`), Native AM (`dantelin2009`), AppleMusic-Tui. Search with `mcp__exa__get_code_context_exa` using `"apple music userstyle css variables site:github.com"`.

### Asset packaging

CSS files read via `fs.readFileSync` at runtime must be listed individually in `asarUnpack` in `package.json`. `asarUnpack` does not support globs - each file must be named explicitly or packaged builds will fail to read them.

## Architecture notes

- `just install` and `just build` invoke `_sign-evs`, signing `node_modules/electron/dist` with production VMP keys; this is a side-effect of both commands
- `build/afterPack.cjs` runs EVS VMP signing as an electron-builder `afterPack` hook on `darwin` and `win32`; it must execute before macOS code-signing (`afterPack`, not `afterSign`)
- Last.fm scrobbling (`src/integrations/lastfm`) uses one app-level API key and shared secret shared by all users (the user-level credential is the per-account session key, obtained via auth and stored locally). The shared secret must NOT be committed: `loadCredentials()` resolves it from the `SIDRA_LASTFM_API_KEY`/`SIDRA_LASTFM_API_SECRET` env vars (local dev) or from `assets/lastfm-credentials.json`, which is gitignored and written at build time by `scripts/inject-lastfm-credentials.cjs` from those same env vars. That script runs from npm's `prebuild` hook and from the `build` recipe in the `justfile`, which needs its own call because `npx tsc` fires no npm hook; with the env unset it leaves an already-populated file alone rather than blanking it. In CI the env comes from the `SIDRA_LASTFM_API_KEY`/`SIDRA_LASTFM_API_SECRET` repository secrets (wired into the "Compile TypeScript" step of both `builder.yml` and `publish-snap-manual.yml`), so the real secret ships only in official build artefacts. The generated JSON is listed in `asarUnpack`. End users never enter a key: they click "Connect to Last.fm…" in the tray, approve in the browser, and each gets their own session key stored locally. `isConfigured()` gates the whole tray menu, so builds without credentials hide the feature entirely rather than showing a dead toggle. Auth uses the desktop token flow (`auth.getToken` → browser approval → polled `auth.getSession`); the success notification is gated on `notifications.enabled`, the connect-failure one is not (see below). Now-playing is sent on track start/resume. `scrobbleThresholdMs()` returns `null` for a track of 30 seconds or less, so those never scrobble at all; anything longer is scrobbled once it has played for half its duration or 4 minutes (whichever first), and never twice. That matches Last.fm's scrobbling rules. All requests go through `net.fetch` and are signed with an MD5 `api_sig`
- The Last.fm scrobble timer is wall-clock and nothing cancels it on a page load (a reload, a service switch and `itms://` routing all emit no playback state transition), so `doScrobble()` re-reads `playerRef.playbackSnapshot()` at submission time and refuses unless playback is still live and the playhead has reached the threshold; the cached playing flag and position both freeze at their pre-reload values, and the playhead of an abandoned track sits short of the threshold. The check is absolute, never a delta against a position sampled when the timer was armed: an abandoned track has still moved its playhead, and repeat-one re-arms on the play transition that precedes the first position report of the new loop. The playhead belongs to the player, not to the track the integration holds, so it counts only once `positionReported` is set by a `playbackTimeDidChange` listener; `resetTrack()` clears the flag, so a fresh page that announces a new track while the frozen playhead still carries the previous one's play time cannot scrobble off it. That listener sets the flag and nothing else, per the rule against debounced sends from this event
- `apiCall()` in `src/integrations/lastfm/index.ts` reads the response body and inspects the API error code before it looks at the HTTP status; Last.fm sends several of its own error codes with a non-2xx status, so an `response.ok` check placed first would collapse error 9 into a generic failure and leave a revoked session connected. The status is only reported when the body carries no code
- A failed `track.scrobble` is not retried: `scrobbled` stays set, so each track is submitted once. Rolling the flag back re-opened the submission without re-arming anything, and any timer that fires on a failure is a retry loop, which this project does not want
- Last.fm connect-failure notifications are sent with `notify(..., true)`, which bypasses `notifications.enabled`: the failure answers an action the user just took in the tray, and silence there leaves the menu back at "Connect" with no explanation. Success and routine notifications stay gated on the preference
- Event flow: MusicKit.js events in the renderer are captured by `assets/musicKitHook.js` (injected post-load), forwarded via IPC to `src/player.ts` (EventEmitter), then distributed to integrations; controls flow in reverse via `webContents.send()` to the preload, which uses `window.postMessage()` to bridge the context isolation boundary, and `musicKitHook.js` listens for `sidra:command` messages and dispatches to `window.__sidra` methods
- Three artefacts define the hook-preload contract and must stay in sync: `src/types/hook.d.ts` (type declarations), `assets/musicKitHook.js` (JSDoc-annotated runtime), and `src/preload.ts` (typed channel sets); contract tests in `test/player.test.ts` verify alignment at compile time via `expectTypeOf`. The hook sets `window.__sidraHookInjected` synchronously at the top of its IIFE and never clears it; re-running the IIFE installs duplicate message listeners (#154 and issue #153). `window.__sidraHookedMk`, assigned at the end of `attachToInstance`, is a different marker: the 5-second monitor compares the current `MusicKit.getInstance()` against it to detect a replaced singleton. The top-of-IIFE guard that read `__sidraHookedMk` was removed; do not reintroduce one
- `reportPositionState()` in `assets/musicKitHook.js` reports explicit media session position state. Duration comes from `mk.currentPlaybackDuration` when finite and positive, else from `nowPlayingItem.attributes.durationInMillis / 1000`; the reported position is clamped with `Math.min(position, duration)`. Every bail-out calls `clearPositionState()`, so no return path leaves a previous item's state installed; it clears rather than reporting `duration: Infinity` because the hook cannot tell genuinely unbounded media (a radio station) from a duration not yet resolved. The `playbackTimeDidChange` listener calls it on every tick, and that frequency is deliberate: `music.apple.com` writes to the same MediaSession from the same world, and the repeated call keeps Sidra's value in place. Do not debounce it. That does not breach the `playbackTimeDidChange` rule below, which is about debounce-timer starvation: this call starts no debounce
- `isAllowedNavigationUrl()` in `src/musicService.ts` gates the `will-navigate` handler in `src/main.ts`, which calls `event.preventDefault()` when the predicate is false. `ALLOWED_NAVIGATION_HOSTS` is derived from every service host plus its `authFrameHosts`, so a new service widens the allowlist automatically. The match is on `URL.hostname` and exact: a subdomain, a suffix or a userinfo prefix of an allowed host is rejected. Main-process `loadURL()` calls raise no `will-navigate` event, so launch, service switching and `itms://` routing are unaffected. The same predicate gates hook injection at both sites: `injectContent()` and the `did-navigate-in-page` handler each skip `hookScript` on a disallowed host
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
- `playbackTimeDidChange` is a standard MusicKit event (not a timer); integrations must NOT call a debounced update function from this event or the debounce timer resets continuously and never expires - only store the updated position, then let other events trigger the debounced send
- `dbus-next` does not automatically emit `PropertiesChanged` signals; call `Interface.emitPropertiesChanged()` explicitly when property values change - never include `Position` in these calls (MPRIS spec forbids it; clients poll or use the `Seeked` signal)
- `dbus-next` property, method, and signal decorators use TC39 stage-2 format which TypeScript does not support; use `configureMembers()` instead - it is the documented alternative API and takes the same type signature descriptors
- `dbus-next` delivers D-Bus `x` (int64) parameters as JavaScript `BigInt`; always convert with `Number()` before mixing with regular arithmetic - `Seek(offset)` and `SetPosition(trackId, position)` are the affected MPRIS methods
- MPRIS `Stop()` must map to `window.__sidra.pause()`, not `MusicKit.stop()`; `stop()` clears the queue, which violates the MPRIS spec requirement that calling `Play()` after `Stop()` resumes from the beginning of the track
- MPRIS `PlaybackStatus` maps all MusicKit states - including transient ones (1=loading, 6=seeking, 7=waiting, 8=stalled) - directly to MPRIS values; transient states fall through to `'Stopped'` intentionally so MPRIS always reflects the actual MusicKit state; do not add early-return guards for transient states
- MPRIS `Volume` controls MusicKit's software volume (`HTMLMediaElement.volume`) only - the PulseAudio/PipeWire sink input volume is independent; this matches the behaviour of Rhythmbox, Spotify, VLC, and every other major Linux music player; do not attempt to sync them
- Chromium hard-codes `application.name = "Chromium"` and `application.icon_name = "chromium-browser"` on PulseAudio streams; `PULSE_PROP_*` environment variables are ineffective (Chromium's explicit API calls override them); the fix is `disable-features=AudioServiceOutOfProcess` (moves audio in-process so `SetGlobalAppName` reaches PulseAudio) combined with `app.setDesktopName('sidra.desktop')` (sets `CHROME_DESKTOP` for `GetXdgAppId()`); see [electron/electron#27581](https://github.com/electron/electron/issues/27581)
- `music.apple.com` registers a `beforeunload` event handler while audio is playing; this silently blocks `BrowserWindow.close()` and `app.quit()` with no dialog or error (standard Chromium/Electron behaviour - unlike Chrome, Electron does not show a confirmation dialog); fix with `win.webContents.on('will-prevent-unload', (event) => event.preventDefault())`; see [electron/electron#8468](https://github.com/electron/electron/issues/8468)
- `electron-updater` must be lazy-required inside `initAutoUpdate()` only - never at module top level; on unsupported platforms the module must never load; verify via log output: `autoUpdate` scope logs must not appear on deb/rpm/Nix builds
- `electron-updater` implements its own download/install pipeline and does not use Electron's built-in `autoUpdater`; all APIs it uses are unmodified in CastLabs ECS; the known `app.relaunch()` bug (CastLabs issue #164) does NOT affect `AppImageUpdater` - it spawns the new binary via `child_process.spawn()` directly
- Platform detection for auto-update: `process.env.APPIMAGE` is set only when running as an AppImage (present = enable updater, absent = notification-only); on Windows, `app.isPackaged` on `win32` indicates an NSIS installation
- `verifyUpdateCodeSignature: false` is required on Windows because the app is unsigned
- `app-update.yml` is present in all packaged builds including deb/rpm/Nix; runtime detection in `isAutoUpdateSupported()` prevents updater initialisation even if the file is present
- electron-updater manifest filenames are hardcoded: `latest.yml` = Windows manifest, `latest-linux.yml` = Linux manifest; these cannot be consolidated
- `SIDRA_DISABLE_AUTO_UPDATE=1` env var disables auto-update for AppImage/NSIS builds; future package managers (Scoop, Chocolatey) must set this in their install manifests
- AppImage `artifactName` must omit the version component (use `${productName}-${os}-${arch}.${ext}`) to prevent filename changes breaking desktop shortcuts after update
- On NixOS, `libxcrypt-legacy` must be in `LD_LIBRARY_PATH` (already added to `flake.nix`) for fpm's bundled Ruby to find `libcrypt.so.1` during deb/rpm builds; without it, deb/rpm targets fail at the fpm stage
- `webContents.reload()` must be preceded by `wedgeDetector.reset()` when called from an IPC handler; without it the detector's timer survives the reload and attempts a spurious skip-forward after the page re-initialises
- CastLabs Electron type definitions omit `App.setDesktopName()` and `'cache'` from `app.getPath()` - both methods work at runtime; use module augmentations in `src/types/electron.d.ts` rather than type casts at call sites
- `dbus-next` has no public API to fully close its socket; `bus.disconnect()` calls `stream.end()` only (half-close); `(bus as DbusMessageBusInternals)._connection?.stream?.destroy()` is the only way to force-close - the `DbusMessageBusInternals` interface in `src/integrations/mpris/index.ts` documents this and is compatible with `@holusion/dbus-next ^0.11.2`
- `setupContentHandlers()` uses a single `on('did-finish-load')` handler with an `initialized` flag (not a `once`/`on` split) - both `once` and `on` fire on the first load, so the flag guards one-time integration initialisation while `injectContent()` runs on every load; the hook's own `__sidraHookInjected` guard stops duplicate listener registration, not this flag
- Theme system uses `ThemeName = 'apple-music' | BundledThemeName | 'custom'` and `applyTheme(name)` in `src/theme.ts`; `'apple-music'` means no override CSS is injected. A new bundled theme needs a palette entry in `src/palettes.ts` that also passes `test/themes.test.ts`: keep `overlay` distinct from `subtext0` and `crust` distinct from `surface0` in both schemes, and reach 4.5:1 WCAG contrast against `pageBG` on `--systemPrimary` and `--systemSecondary-vibrant` (Catppuccin Latte's secondary is the one documented exception, at 4.37:1)
- `hasCustomCss()` is `getThemeCss('custom') !== null`, so presence means readable and non-blank, not merely existing. `getThemeCss('custom')` caches the file contents. The `fs.watch` callback calls `invalidateCustomCssCache()` before the 150ms debounce, so a tray rebuild inside the debounce window cannot read the previous contents back. A watcher that never starts or dies calls `disableCustomCssCache()`, which switches caching off rather than leaving a stale cache for the life of the process. The debounced callback re-applies CSS when needed, then calls `rebuildTrayCallback()` unconditionally: creating or deleting `custom.css` adds or removes the tray Style entry whichever theme is stored. `main.ts` supplies that callback through `setRebuildTrayCallback()`, because `tray.ts` imports `theme.ts` and `theme.ts` cannot import it back
- `test/mocks/storefront-deps.ts` contains shared `vi.mock()` declarations for tests that import storefront code; Vitest hoists `vi.mock()` calls within the fixture file itself, so the fixture uses `../../src/` paths (relative to `test/mocks/`, not `test/`) - do not change these paths
- `API_KEY` and `API_SECRET` in `src/integrations/lastfm/index.ts` resolve once at module load and are empty under test, so `isConfigured()` is false and every request path short-circuits; behavioural tests must take the module from `loadLastfm()` in `test/lastfm.test.ts` (`vi.resetModules()`, `vi.stubEnv(...)`, then a dynamic `import()`) rather than the static import
- Electron fixtures in `test/setup.ts` that stand in for a promise-returning API must return a promise: production code attaches `.catch()` to `shell.openExternal()`, and a bare `vi.fn()` makes that throw inside a `try`/`catch` that silently abandons the flow
- `itms://` is registered as a default protocol handler on Linux and Windows only; macOS uses Music.app natively and is intentionally excluded
- Single-instance lock (`app.requestSingleInstanceLock()`) is acquired synchronously before `app.whenReady()` on non-macOS platforms; the `second-instance` handler forwards the launch URL via `extractItmsUrlFromArgv(argv)` and focuses the existing window
- URL parsing and argv extraction live in `src/itms.ts` as a pure module (no `electron`, `electron-log`, or `config` imports) so it is trivially unit-testable; `transformItmsUrl` validates scheme (`itms:`), host (`music.apple.com` exact match, no subdomain wildcards), and route-token allowlist; catalogue URLs are rebuilt as `https:` with the `app` query parameter stripped
- Route-token to in-app URL mapping (`buildItmsRouteURL`) lives in `src/storefront.ts` so it shares the existing storefront and language resolution path
- Dev caveat: `app.setAsDefaultProtocolClient('itms')` only takes effect when Sidra is installed system-wide via `.deb`/`.rpm`/Nix or NSIS - it writes `.local/share/applications/mimeapps.list` via `xdg-mime` on Linux; running `just run` from a checkout will NOT register the handler
- AppImage caveat: `linux.desktop.entry.MimeType` populates the `.desktop` file inside the AppImage but AppImage does not auto-register on the host; users need AppImageLauncher or a manual `xdg-mime default sidra.desktop x-scheme-handler/itms` invocation for itms:// links to launch the AppImage directly. Works automatically on `.deb`/`.rpm`/Nix-installed builds.
