# Sidra - Specification

A minimal Apple Music desktop client. CastLabs Electron wraps `music.apple.com` and `classical.music.apple.com` directly, injecting a lightweight hook script to bridge MusicKit.js events to native platform media controls. `src/musicService.ts` holds the registry of both services. Apple maintains the UI; Sidra maintains the bridge.

The codebase is tightly focused and as lean as possible. Five runtime dependencies.

---

## Table of Contents

- [Technology Stack](#technology-stack)
- [Architecture](#architecture)
- [Source Structure](#source-structure)
- [Dependencies](#dependencies)
- [IPC Event Flow](#ipc-event-flow)
- [MusicKit Hook Script](#musickit-hook-script)
- [Platform Media Controls](#platform-media-controls)
- [MPRIS Specification](#mpris-specification)
- [Volume Sync](#volume-sync)
- [Region and Storefront](#region-and-storefront)
- [Apple Music Classical](#apple-music-classical)
- [Authentication](#authentication)
- [Theming](#theming)
- [Discord Rich Presence](#discord-rich-presence)
- [Last.fm Scrobbling](#lastfm-scrobbling)
- [Track Change Notifications](#track-change-notifications)
- [Tray](#tray)
- [macOS Dock](#macos-dock)
- [Windows Taskbar](#windows-taskbar)
- [Progress Bar](#progress-bar)
- [Share Sheet](#share-sheet)
- [Application Menu](#application-menu)
- [Auto-update](#auto-update)
- [Feature Inventory](#feature-inventory)
- [Risk Assessment](#risk-assessment)

---

## Technology Stack

| Component | Choice | Rationale |
|---|---|---|
| Shell | `castlabs/electron-releases` (wvcus) | Widevine CDM - no alternative exists |
| Language | TypeScript | Type safety, ecosystem match |
| Renderer content | `music.apple.com` and `classical.music.apple.com` | Zero UI code; Apple maintains it |
| MusicKit hook | Injected JS script post-page-load | Hooks `MusicKit.getInstance()` events |
| Preload | `contextBridge` IPC bridge | Standard Electron security pattern |
| MPRIS (Linux) | `dbus-next` directly | Full control, clean service name |
| Windows controls | Chromium `mediaSession` → GSMTC | Built-in bridge, identity via `setAppUserModelId` |
| Windows taskbar | `win.setThumbarButtons()` + `win.setOverlayIcon()` | Thumbnail toolbar and overlay badge |
| macOS controls | Chromium `mediaSession` → MPNowPlayingInfoCenter | Built-in bridge, identity via bundle name |
| macOS dock | `app.dock.setMenu()` + `win.setProgressBar()` | Right-click menu and progress bar |
| Config | `electron-conf` | Persistent config (storefront, theme, preferences) |
| Build | `electron-builder` | AppImage + deb + rpm (Linux), DMG (macOS), NSIS (Windows) |
| Package manager | npm | Simplest option; avoids pnpm's strict semver parsing issues with CastLabs `+wvcus` tag |

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│ CastLabs Electron (Widevine CDM auto-installed)                  │
│                                                                  │
│  ┌──────────────────────┐      ┌─────────────────────────────┐   │
│  │  Main Process        │◄─IPC─│  Renderer Process           │   │
│  │                      │      │  music.apple.com            │   │
│  │  ┌────────────────┐  │      │  classical.music.apple.com  │   │
│  │  │ IPC event hub  │  │      │  ┌──────────────┐           │   │
│  │  │ (player.ts)    │  │      │  │ MusicKit.js  │           │   │
│  │  └───────┬────────┘  │      │  └──────┬───────┘           │   │
│  │          │           │      │         │ events            │   │
│  │  ┌───────▼────────┐  │      │  ┌──────▼───────┐           │   │
│  │  │ Integrations   │  │      │  │ Hook script  │           │   │
│  │  │ ├─ MPRIS       │◄─┼──────┼──┤(injected JS) │           │   │
│  │  │ ├─ Discord RPC │  │      │  └──────────────┘           │   │
│  │  │ ├─ Notifier    │  │      │                             │   │
│  │  │ └─ Taskbar/Dock│  │      │  ┌──────────────┐           │   │
│  │  └───────┬────────┘  │      │  │  preload.ts  │           │   │
│  │          │           │      │  │ (IPC bridge) │           │   │
│  │  ┌───────▼────────┐  │      │  └──────────────┘           │   │
│  │  │ electron-conf  │  │      └─────────────────────────────┘   │
│  │  └────────────────┘  │                                        │
│  └──────────────────────┘                                        │
└──────────────────────────────────────────────────────────────────┘
         │ D-Bus (Linux)
    ┌────▼───────┐
    │  playerctl │
    │  KDE/GNOME │
    │  etc.      │
    └────────────┘
```

---

## Source Structure

```
sidra/
├── src/
│   ├── main.ts                    - bootstrap, Widevine wait, window, IPC hub
│   ├── preload.ts                 - contextBridge IPC exposure (AMWrapper)
│   ├── config.ts                  - electron-conf wrapper
│   ├── i18n.ts                    - locale detection, JSON loader, and re-exported translation records
│   ├── paths.ts                   - getAssetPath() and getProductInfo() utilities
│   ├── player.ts                  - TypedEmitter, PlayerEvents, PlaybackState (0-9), IntegrationContext
│   ├── storefront.ts              - buildAppleMusicURL(), buildItmsRouteURL(), extractStorefrontFromURL(), handleStorefrontNavigation()
│   ├── musicService.ts            - music service registry (MUSIC_SERVICES): host, origin, start pages, navigation allowlist
│   ├── serviceSwitch.ts           - switchService() and routeToMusicService(); the one service-switch sequence
│   ├── contentReady.ts            - CONTENT_READY_SELECTOR and contentReadyProbeScript()
│   ├── itms.ts                    - pure itms:// URL parser and argv extraction
│   ├── types/
│   │   ├── electron.d.ts          - module augmentations for CastLabs type gaps
│   │   └── hook.d.ts              - hook-preload contract: SidraHook, AMWrapperBridge, SendChannel, ReceiveChannel, SidraCommandMessage, Window augmentations
│   ├── theme.ts                   - theme lifecycle: ThemeName, resolveTheme(), getThemeCss(), applyTheme(), injectThemeCss(), initThemeCSS()
│   ├── palettes.ts                - bundled theme registry (BUNDLED_THEMES), BundledThemeName, themeLabel()
│   ├── themeTemplate.ts           - pure palette→CSS renderer (buildThemeCss())
│   ├── artwork.ts                 - downloadArtwork(), cleanArtworkCache(); UUID-based multi-file cache
│   ├── autoUpdate.ts              - isAutoUpdateSupported(), initAutoUpdate(), quitAndInstall(); electron-updater
│   ├── update.ts                  - checkForUpdates() via GitHub API; UpdateInfo state
│   ├── wedgeDetector.ts           - detects playback stalls and auto-skips forward
│   ├── pauseTimer.ts              - createPauseTimer() factory; shared by tray, dock, Discord integrations
│   ├── utils.ts                   - errorMessage() utility
│   ├── notify.ts                  - notification gate: createNotification(), notificationsAvailable(), initNotificationProbe()
│   ├── notificationDaemon.ts      - D-Bus probe for org.freedesktop.Notifications (Linux only)
│   ├── utils/
│   │   └── progressBar.ts         - updateProgressBar() / clearProgressBar(); platform-agnostic win.setProgressBar()
│   ├── aboutWindow.ts             - showAboutWindow() and related constants (extracted from tray.ts)
│   ├── tray.ts                    - system tray icon, context menu, tray state manager
│   └── integrations/
│       ├── mpris/
│       │   └── index.ts           - D-Bus MPRIS service (Linux only)
│       ├── discord-presence/
│       │   └── index.ts           - Discord RPC with retry/debounce
│       ├── lastfm/
│       │   └── index.ts           - Last.fm auth, now-playing and scrobble submission
│       ├── notifications/
│       │   └── index.ts           - Track change desktop notifications
│       ├── macos-dock/
│       │   └── index.ts           - Dock right-click menu + progress bar (macOS only)
│       └── windows-taskbar/
│           └── index.ts           - Thumbnail toolbar + overlay icon + progress bar (Windows only)
├── assets/
│   ├── musicKitHook.js            - Injected post-load into music.apple.com and
│   │                                 classical.music.apple.com. Must be listed in
│   │                                 electron-builder's `asarUnpack`: it is read with
│   │                                 readFileSync at runtime and will crash AppImage
│   │                                 builds if packed inside the asar archive
│   ├── navigationBar.js           - Injected post-load; adds back/forward/reload buttons to sidebar.
│   │                                 Its `__SIDRA_NAV_LABELS__` placeholder is replaced with the
│   │                                 localised aria-labels when src/main.ts reads the file
│   ├── authFrameFix.js            - Injected into Apple's sign-in iframe; hides the passkey and
│   │                                 "Sign in with iPhone" options. Its `__SIDRA_AUTH_FIX__`
│   │                                 placeholder is replaced with the stylesheet and container
│   │                                 selectors when src/main.ts reads the file. Must be listed
│   │                                 in electron-builder's `asarUnpack`
│   ├── about.html                 - About window content, receives product info via query params
│   ├── splash.html                - Splash screen shown during startup
│   ├── windowChrome.css           - Chrome shared by splash.html and about.html: the reset, the
│   │                                 background, the body layout and the icon rule. Both pages
│   │                                 load it with a <link>, so both carry `style-src 'self'` in
│   │                                 their CSP. Must be listed in `asarUnpack`
│   ├── sidra-logo.png             - Product logo used in About window
│   ├── locales/
│   │   ├── loading.json           - 1 translation record: LOADING_TEXT
│   │   ├── tray.json              - 37 translation records: tray menu, dock, Windows taskbar
│   │   │                             and navigation bar labels
│   │   ├── about.json             - 4 translation records: about window labels
│   │   └── update.json            - 5 translation records: auto-update labels
│   ├── styleFix.css               - CSS overrides injected via webContents.insertCSS()
│   │                                 Hides "Get the app" and "Open in Music" banners
│   │                                 that Apple shows to push users toward native apps
│   ├── authStyleFix.css           - CSS injected into Apple auth iframes to hide
│   │                                 unsupported passkey and "Sign in with iPhone" options
│   └── icons/
│       ├── sidraTemplate.png      - macOS tray (template image)
│       ├── sidra-tray.png         - Windows tray
│       ├── sidra-tray-dark.png    - Linux tray (dark theme)
│       ├── sidra-tray-light.png   - Linux tray (light theme)
│       └── tray/menu/
│           ├── dark/              - 18px dark-theme menu item PNGs
│           └── light/             - 18px light-theme menu item PNGs
├── build/
│   ├── icon.png, icon.icns, icon.ico
│   └── afterPack.cjs
├── package.json
└── tsconfig.json
```

---

## Dependencies

Sidra keeps runtime dependencies narrow and purpose-driven. Each package must provide a platform integration or maintenance function that Electron, Node.js, or the standard library does not already cover.

`package.json` is the source of truth for direct dependency names and version ranges. `package-lock.json` is the source of truth for resolved packages.

Current dependency roles:

- CastLabs Electron - application shell and Widevine CDM support
- electron-builder - distributable package creation
- TypeScript and Vitest - type checking and unit tests
- electron-log - application logging
- electron-conf - persistent user configuration
- electron-updater - AppImage and NSIS update checks and installs
- dbus-next - Linux MPRIS integration
- Discord RPC - optional Discord Rich Presence
- shx and npm scripts - cross-platform build helpers

### Logging

`electron-log` handles all application logging. Use structured log levels consistently:

- `log.info` - startup, integration lifecycle (enabled/disabled), MusicKit hook confirmation
- `log.warn` - recoverable issues (Discord RPC disconnection, notification artwork fetch failure)
- `log.error` - unrecoverable issues (D-Bus connection failure, Widevine CDM unavailable)
- `log.debug` - IPC event flow, state transitions (noisy, off by default)

---

## IPC Event Flow

Events flow from the renderer (MusicKit hook script) to the main process (player.ts), which emits to all integrations.

### Renderer → Main (via `ipcRenderer.send`)

| Event | Payload | Consumers |
|---|---|---|
| `playbackStateDidChange` | `{ status: bool, state }` | MPRIS, Discord, Last.fm, Notifications, Dock, Taskbar |
| `nowPlayingItemDidChange` | `NowPlayingPayload` (see `src/player.ts`) or `null` | MPRIS, Discord, Last.fm, Notifications, Dock, Taskbar |
| `playbackTimeDidChange` | Position in microseconds | MPRIS, Dock, Taskbar |
| `repeatModeDidChange` | Mode integer (0/1/2) | MPRIS |
| `shuffleModeDidChange` | Mode integer | MPRIS |
| `volumeDidChange` | Volume float (0.0-1.0) | MPRIS |
| `nav:back` | (none) | Main process navigation |
| `nav:forward` | (none) | Main process navigation |
| `nav:reload` | (none) | Main process navigation |

### MusicKit.js Enum Values

MusicKit.js exposes enums as integer values. These are the concrete mappings observed at runtime:

**`MusicKit.PlaybackStates`:**

| Value | State |
|---|---|
| 0 | none |
| 1 | loading |
| 2 | playing |
| 3 | paused |
| 4 | stopped |
| 5 | ended |
| 6 | seeking |
| 7 | waiting |
| 8 | stalled |
| 9 | completed |

**`MusicKit.PlayerRepeatMode`:**

| Value | Mode |
|---|---|
| 0 | none |
| 1 | one |
| 2 | all |

**`MusicKit.PlayerShuffleMode`:**

| Value | Mode |
|---|---|
| 0 | off |
| 1 | songs |

### Main → Renderer (via `webContents.send` + preload bridge)

Integrations send commands to the renderer via a two-stage bridge:

1. Main process calls `webContents.send(channel, ...args)` for each command channel
2. Preload script receives via `ipcRenderer.on(channel)` for each channel in `RECEIVE_CHANNELS`
3. Preload forwards to the main world via `window.postMessage({ type: 'sidra:command', channel, args }, window.location.origin)`
4. `musicKitHook.js` listens for `sidra:command` messages and dispatches to `window.__sidra` methods

The `window.location.origin` target keeps the bridge service-agnostic: it passes the sandbox same-origin check on both `music.apple.com` and `classical.music.apple.com` without a hardcoded origin.

The command bridge uses the `RECEIVE_CHANNELS` allowlist in `src/preload.ts` and the `COMMANDS` allowlist in `assets/musicKitHook.js`, which must stay in sync. `src/types/hook.d.ts` declares `SendChannel` and `ReceiveChannel` union types used by `src/preload.ts` (`Set<SendChannel>`, `Set<ReceiveChannel>`), enforcing channel sync at compile time. Contract tests in `test/player.test.ts` verify alignment via `expectTypeOf`.

| Control | Method | Triggered by |
|---|---|---|
| Play | `window.__sidra.play()` | MPRIS `Play()` |
| Pause | `window.__sidra.pause()` | MPRIS `Pause()` |
| Play/Pause toggle | `window.__sidra.playPause()` | MPRIS `PlayPause()` |
| Next track | `window.__sidra.next()` | MPRIS `Next()` |
| Previous track | `window.__sidra.previous()` | MPRIS `Previous()` |
| Seek | `window.__sidra.seek(seconds)` | MPRIS `Seek()`, `SetPosition()` |
| Set volume | `window.__sidra.setVolume(float)` | MPRIS volume property |
| Set repeat mode | `window.__sidra.setRepeat(mode)` | MPRIS `LoopStatus` |
| Set shuffle mode | `window.__sidra.setShuffle(mode)` | MPRIS `Shuffle` |

---

## MusicKit Hook Script

Injected into `music.apple.com` and `classical.music.apple.com` after page load via `webContents.executeJavaScript()`. Polls for `MusicKit` availability, hooks events, and exposes the `window.__sidra` control object. `isAllowedNavigationUrl()` gates both injection sites, so the hook never reaches a third host.

`assets/musicKitHook.js` is read with `fs.readFileSync` at runtime in the main process. It must be listed in the `asarUnpack` array in `electron-builder` configuration; without it, AppImage builds will crash on startup because the file is inaccessible inside the packed asar archive.

```javascript
// Structure of assets/musicKitHook.js
// Not inlined in full; see the source file for the complete implementation.

(function () {
  // Injection guard: set synchronously at IIFE top level and never cleared.
  // Re-running the IIFE would install duplicate message listeners (#154, #153).
  if (window.__sidraHookInjected) return;
  window.__sidraHookInjected = true;

  function attachToInstance(mk) {
    // Event listeners: playbackStateDidChange, nowPlayingItemDidChange,
    // playbackTimeDidChange (forwards the position, then calls
    // reportPositionState()), repeatModeDidChange, shuffleModeDidChange,
    // playbackVolumeDidChange

    // reportPositionState() writes navigator.mediaSession.setPositionState().
    // clearPositionState() runs when nowPlayingItemDidChange delivers null.

    // nowPlayingItemDidChange sends ALL fields including:
    // audioTraits, trackNumber, targetBitrate, discNumber, composerName,
    // releaseDate, contentRating, itemType, containerId, containerType,
    // containerName, isrc, queueLength, queueIndex

    // Volume polling: stores lastVolume, sends initial volume on attach,
    // polls mk.volume at 250ms intervals, sends IPC only on change

    // window.__sidra control object:
    //   play, pause, playPause, next, previous, seek,
    //   setVolume, setRepeat, setShuffle

    // sidra:command message listener for preload bridge:
    //   window.addEventListener('message', ...) dispatches
    //   incoming { type: 'sidra:command', channel, args } messages
    //   to the matching window.__sidra method via a COMMANDS allowlist

    // Non-passive wheel listener on window, installed beside the message
    // listener so the injection guard covers it. Steps mk.volume by 5% when
    // the composed path carries the chrome-volume class token.

    // Per-instance marker, read by the 5-second monitor below.
    // This is not an injection guard: __sidraHookInjected is.
    window.__sidraHookedMk = mk;
  }

  const waitForMK = setInterval(() => {
    if (!window.MusicKit) return;
    clearInterval(waitForMK);
    attachToInstance(MusicKit.getInstance());

    // 5-second monitor: compares MusicKit.getInstance() against
    // window.__sidraHookedMk and re-attaches when the singleton is replaced.
    setInterval(() => { /* ... */ }, 5000);
  }, 500);
})();
```

### Media session position state

`reportPositionState()` gives the OS media controls an explicit position rather than letting Chromium infer one. It runs on every `playbackTimeDidChange` tick. Duration comes from `mk.currentPlaybackDuration` when that value is finite and positive, otherwise from `nowPlayingItem.attributes.durationInMillis / 1000`. Position is clamped with `Math.min(position, duration)`.

Every bail-out calls `clearPositionState()`, so no return path leaves the previous item's state installed. An unresolvable duration or position clears the state instead of reporting `duration: Infinity`, because the hook cannot tell genuinely unbounded media (a radio station) from a duration that has not resolved yet.

### Audio Quality Metadata Caveats

MusicKit.js does not expose the actual codec, bitrate, or sample rate of the audio stream. Quality negotiation happens at the HLS/CDN level, invisible to JavaScript. The available properties are misleading if taken at face value:

- `item.attributes.audioTraits` (e.g. `['lossless', 'lossy-stereo']`) indicates what formats the track *supports*, not what is currently playing. Values observed: `atmos`, `lossless`, `lossy-stereo`, `hi-res-lossless`.
- `mk.bitrate` reflects the *target* bitrate preference (`MusicKit.PlaybackBitrate.HIGH` = 256, `STANDARD` = 64), not actual playback quality. Apple's own documentation states it "does not necessarily represent the actual bit rate of the item being played". Log it as `targetBitrate` to make the semantics explicit.

---

## Platform Media Controls

The correct approach differs by platform. Conflating them is what goes wrong.

### Linux: Explicit MPRIS via dbus-next

**Service name**: `org.mpris.MediaPlayer2.sidra`

Chromium has a built-in MPRIS bridge (via `navigator.mediaSession`) that must be disabled to avoid conflicts. It registers as `org.mpris.MediaPlayer2.chromium.instance{PID}`, which is useless for app identity. Both Cider and apple-music-wrapper disable it and implement their own D-Bus service.

```typescript
// In main.ts, before app.whenReady()
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
  app.commandLine.appendSwitch('disable-features', 'MediaSessionService,WaylandWpColorManagerV1,AudioServiceOutOfProcess');
  app.setDesktopName('sidra.desktop');
}
```

**PulseAudio stream identity**: Chromium hard-codes `application.name = "Chromium"` and `application.icon_name = "chromium-browser"` on PulseAudio/PipeWire streams via explicit API calls; `PULSE_PROP_*` environment variables are ineffective. Sidra fixes this by disabling `AudioServiceOutOfProcess` (moves audio in-process so `SetGlobalAppName` reaches PulseAudio) and calling `app.setDesktopName('sidra.desktop')` (sets `CHROME_DESKTOP` for `GetXdgAppId()`). See [electron/electron#27581](https://github.com/electron/electron/issues/27581).

### macOS: Chromium's Built-in mediaSession Bridge

Chromium maps `navigator.mediaSession` to `MPNowPlayingInfoCenter` automatically. The **app bundle name** determines what appears in the Now Playing widget (Control Centre, Lock Screen) - set via `productName: "Sidra"` in electron-builder config.

### macOS: Dock Menu and Progress Bar

`src/integrations/macos-dock/index.ts` adds a right-click dock icon menu via `app.dock.setMenu()`. When a track is playing the menu shows the track and artist name (display-only), a Share item (if a URL is available), and play/pause, next, previous controls. With no track the header is the localised "Not Playing" label. The menu clears to that idle form after 30 seconds of pause (matching the tray timeout). The dock progress bar uses `win.setProgressBar()` via `src/utils/progressBar.ts`, updated on every `playbackTimeDidChange` event and cleared on stop, idle, or pause timeout.

Guarded with `process.platform === 'darwin'`.

### Windows: Chromium's GSMTC Bridge

Chromium maps `navigator.mediaSession` to Global System Media Transport Controls. Identity is set by:

```typescript
// main.ts - must run before app.whenReady()
if (process.platform === 'win32') {
  app.setAppUserModelId('com.wimpysworld.sidra');
}
```

The GSMTC overlay (media flyout on Windows 11) will show "Sidra" as the controlling app. `app.setAppUserModelId()` is also required for desktop notifications to appear on Windows - without it, `Notification.show()` is silently ignored.

### Windows: Taskbar Thumbnail Toolbar and Overlay Icon

`src/integrations/windows-taskbar/index.ts` provides three integrations via the Windows taskbar thumbnail preview:

**Thumbnail toolbar** (`win.setThumbarButtons()`): previous, play/pause, and next buttons, tooltipped from `getTrayStrings()`. Icons are loaded from the 18px tray PNGs via `nativeImage.createFromPath()`, picking the dark or light variant from `nativeTheme.shouldUseDarkColorsForSystemIntegratedUI` and reloading on `nativeTheme.updated`. Button registration is deferred until `win.once('show', ...)` - Windows silently drops `setThumbarButtons()` calls on hidden windows.

**Overlay icon** (`win.setOverlayIcon()`): displays a play or pause badge on the taskbar button, with the matching localised label as its accessibility description. Cleared on stop or idle. Skipped during transient states (Loading, Seeking, Waiting, Stalled) to prevent flicker.

**Progress bar** (`win.setProgressBar()`): uses the shared `src/utils/progressBar.ts` utility.

Guarded with `process.platform === 'win32'`.

---

## MPRIS Specification

Full `org.mpris.MediaPlayer2.Player` property and method checklist. All must work.

### Properties

| Property | Access | Sidra approach |
|---|---|---|
| `PlaybackStatus` | Read | From `playbackStateDidChange` |
| `LoopStatus` | Read/Write | Bidirectional via `repeatModeDidChange` |
| `Rate` | Read | Always 1.0 |
| `Shuffle` | Read/Write | Bidirectional via `shuffleModeDidChange` |
| `Metadata` | Read | Full dict on `nowPlayingItemDidChange` |
| `Volume` | Read/Write | Bidirectional with suppression flag |
| `Position` | Read | Updated from `playbackTimeDidChange` (microseconds) |
| `MinimumRate` | Read | 1.0 |
| `MaximumRate` | Read | 1.0 |
| `CanGoNext` | Read | true |
| `CanGoPrevious` | Read | true |
| `CanPlay` | Read | true |
| `CanPause` | Read | true |
| `CanSeek` | Read | true |
| `CanControl` | Read | true |

### Methods

| Method | Sidra approach |
|---|---|
| `Next()` | `mk.skipToNextItem()` |
| `Previous()` | `mk.skipToPreviousItem()` |
| `PlayPause()` | Toggle based on `mk.isPlaying` |
| `Play()` | `mk.play()` |
| `Pause()` | `mk.pause()` |
| `Stop()` | `window.__sidra.pause()` (not `mk.stop()`, which clears the queue and violates MPRIS spec) |
| `Seek(Offset)` | `mk.seekToTime(currentTime + offsetMicros / 1e6)` |
| `SetPosition(id, pos)` | `mk.seekToTime(posMicros / 1e6)` |

### Signals

| Signal | Behaviour |
|---|---|
| `Seeked` | Emit on user-initiated seeks only. `playbackTimeDidChange` fires every ~250ms. Store the value but only emit `Seeked` when the new position differs from `(lastPosition + elapsed)` by more than ~1s, indicating a real seek. |

### Metadata Mapping

| MPRIS property | MusicKit source |
|---|---|
| `mpris:trackid` | `/org/sidra/track/{item.id}` |
| `mpris:length` | `durationInMillis * 1000` (microseconds) |
| `mpris:artUrl` | `artwork.url` (512x512) |
| `xesam:title` | `attributes.name` |
| `xesam:album` | `attributes.albumName` |
| `xesam:artist` | `[attributes.artistName]` (array) |
| `xesam:genre` | `attributes.genreNames` |
| `xesam:url` | `getShareUrl()` (`attributes.url` → `/song/{catalogId}` → `/song/{globalId}`) |

Library items never carry `attributes.url`; their `catalogId` is always present, so `getShareUrl()` reconstructs the canonical `/song/{id}` URL. Radio stations and Classical tracks carry neither id, so the field is omitted.

---

## Volume Sync

Cider's MPRIS volume sync is one-directional (MPRIS to MusicKit only, no reliable MusicKit to MPRIS), with a feedback loop on `volumeDidChange`. Sidra fixes this with a suppression flag pattern:

```
MPRIS sets volume
  → executeJavaScript sets mk.volume
    → mk fires playbackVolumeDidChange
      → IPC sends volume back to main
        → suppression flag swallows the echo
```

The matching echo clears the flag. A 2000ms safety timeout (`_volumeSafetyMs` in `src/integrations/mpris/index.ts`) clears it when no echo arrives, so a lost echo cannot suppress volume updates for the rest of the session. The epsilon comparison (0.01) absorbs floating-point rounding without masking genuine user-initiated changes.

**PulseAudio sink input volume is intentionally not synced.** MPRIS `Volume` controls MusicKit's software volume (`HTMLMediaElement.volume`) only. The PulseAudio/PipeWire sink input volume shown in pulsemixer and pavucontrol is independent and left to the user via their system mixer. This matches the behaviour of Rhythmbox, Spotify, VLC, mpv, and Clementine. Syncing both would cause double-volume multiplication (e.g. 0.5 × 0.5 = 0.25, −12 dB instead of the expected −6 dB) and would require a `libpulse` binding or fragile `pactl` subprocess calls.

### Volume Event Reporting

`assets/musicKitHook.js` binds `playbackVolumeDidChange`. A CDP session against a running Sidra confirmed that a `mk.volume` write fires that event once and never fires `volumeDidChange`. The hook was bound to `volumeDidChange` until then, so the listener never fired and the 250ms poll was the only reporting path.

The 250ms poll stays as a fallback: nothing has confirmed what the player bar volume control writes. That control is Svelte light DOM with no range input, and `mk._targetElement` is not exposed on the public instance, so its write path could not be observed. The poll sends IPC only when the value differs from the last one sent.

The IPC channel is still named `volumeDidChange`. That is Sidra's own channel name, not the MusicKit event name, and the two differ on purpose.

### Scroll to Change Volume

Pointing at the player bar volume control and scrolling changes the volume in 5% steps, up on wheel-up. One non-passive `wheel` listener on `window` in `assets/musicKitHook.js` does it, installed beside the `message` listener in the `waitForMK` callback so the `__sidraHookInjected` guard covers it and it installs once. Nothing outside the hook changed: the handler writes `mk.volume`, so the value reaches the tray and MPRIS by the existing `volumeDidChange` route, and no `sidra:command` channel was added.

The gate is `event.composedPath()`, matched on the `chrome-volume` class token. The two services differ in the element that carries it:

| Service | Volume control | Carries `chrome-volume` |
|---|---|---|
| `music.apple.com` | `div.chrome-volume` wrapping `div.chrome-volume__slider` and `button.chrome-volume__button` | A `div` |
| `classical.music.apple.com` | `div.chrome-player__volume` wrapping `amp-chrome-volume.chrome-volume`, which contains `button.chrome-volume__indicator` and `amp-volume-control` | An `amp-chrome-volume` element |

Matching the element name alone would work on Classical and do nothing on Apple Music. There is no `input[type=range]` on either page: a CDP walk of all 13 shadow roots on `music.apple.com` found none. Svelte scope hashes are deliberately absent from the selector; they change on any Apple rebuild.

Handler behaviour:

- `event.ctrlKey` returns early, so Ctrl+scroll and pinch still zoom.
- `preventDefault()` fires whenever the gate matches, so the page never scrolls under the control. It fires nowhere else, and nothing calls `stopPropagation()`, so Apple's own handlers still see the event.
- `deltaY` accumulates and each 100 pixels applies one step, carrying the remainder. 100 is Chromium's default `deltaY` for one wheel notch, so a mouse gets exactly one step per notch and a touchpad accumulates smoothly. A direction reversal resets the accumulator. The step is never scaled by `deltaY` magnitude: Chromium reports a wheel and a touchpad identically as `DOM_DELTA_PIXEL`, so magnitude would give a wheel a full-range jump and a touchpad an invisible nudge.
- The value is clamped to 0 and 1 and rounded to two decimal places, because MusicKit throws on an out-of-range value and `0.7 - 0.05` is `0.6499999999999999` in binary floating point.
- The base value is read from `mk.volume` on every event, never from a cached local, so a write MusicKit drops (`capabilities.canSetVolume` false) self-corrects on the next notch.

The listener is on `window`, not on the volume element. That element does not exist when the hook runs and is replaced on navigation and service switches, so binding to it would need a `MutationObserver` in the file whose duplicate listeners once cost 180 MiB/s (#153).

---

## Region and Storefront

Loading bare `https://music.apple.com` causes Apple's server to 301-redirect all clients to `/us/new`, regardless of location. Users outside the US see the wrong catalogue on every launch.

### Storefront detection

`app.getLocaleCountryCode()` returns the OS region as an uppercase ISO 3166-1 alpha-2 code (e.g. `GB`, `CH`). Lowercasing this value produces the Apple Music storefront path segment directly. No validation against Apple's API is required - Apple's server redirects any unrecognised storefront code to `/us/new` with a clean 301, so the failure mode is identical to the current bare-URL behaviour.

Fallback chain at startup:

```
1. Read persisted storefront from electron-conf
2. If found → use it
3. If not found → app.getLocaleCountryCode().toLowerCase()
4. If empty string (LC_ALL=C, unset locale) → 'us'
5. Build URL: https://music.apple.com/{storefront}/new[?l={language}]
```

### Persistence

`electron-conf` holds two keys: `storefront` (e.g. `gb`) and `language` (BCP 47 tag from the `?l=` parameter, e.g. `fr`, or `null`). A `did-navigate` and `did-navigate-in-page` listener on `win.webContents` parses the URL after each navigation. When the storefront or language changes, the new values are written to the store. Same-storefront navigation does not trigger a write.

### Storefront codes

Apple Music storefront codes are ISO 3166-1 alpha-2 codes lowercased (e.g. `gb`, `us`, `ch`). Apple supports 167+ storefronts. The `?l=` parameter accepts BCP 47 language tags from each storefront's `supportedLanguageTags` list and controls UI localisation only - the storefront determines catalogue availability.

---

## Apple Music Classical

Sidra loads two Apple web apps from one shell. `src/musicService.ts` holds the registry that describes them. It imports nothing from `electron`, `electron-log`, or `config`, so `src/itms.ts` and the tests can import it without loading Electron.

### Service registry

`MUSIC_SERVICES` maps each `MusicServiceId` to a record with these fields:

| Field | Purpose |
|---|---|
| `id` | `'music'` or `'classical'` |
| `host` | Hostname, matched exactly by the navigation allowlist |
| `origin` | URL prefix used by `buildAppleMusicURL()` |
| `displayName` | Label shown in the tray Player submenu |
| `authFrameHosts` | Authentication iframe hostnames `setupAuthFrameInjection()` accepts |
| `contentReadySelector` | Selector probed to detect an interactive web app |
| `startPages` | Ordered start page entries rendered in the tray Start Page submenu |
| `defaultStartPage` | Start page id used when nothing is persisted |

`defineService()` infers the page id union from `startPages` alone and wraps `defaultStartPage` in `NoInfer`, so a typo there fails to compile instead of widening the union.

Accessors: `isMusicServiceId()`, `getService()`, `getServiceByHost()` and `allServices()`. `getService()` is total at runtime as well as in the type: `?? MUSIC_SERVICES[DEFAULT_SERVICE_ID]` catches an unknown id. Every call runs while the tray menu is built, and the tray is the app's only settings surface.

### The two services

| | Apple Music | Apple Music Classical |
|---|---|---|
| `id` | `music` | `classical` |
| `host` | `music.apple.com` | `classical.music.apple.com` |
| Start pages | Home (`home`), New (`new`), Radio (`radio`), All Playlists (`library/all-playlists/`) | Home (empty path), Browse (`browse/catalog`), Playlists (`browse/playlists`), Search (`search`) |
| Default | `new` | `home` |

Classical has no library route. Both services accept `last`, which restores the page the user left.

### Navigation allowlist

`ALLOWED_NAVIGATION_HOSTS` is built from every service `host` plus its `authFrameHosts`, so adding a service widens the allowlist without a second edit. `isAllowedNavigationUrl()` takes a URL string, parses it, and compares `URL.hostname` exactly: a subdomain, a suffix, or a userinfo prefix of an allowed host is not an allowed host.

The `will-navigate` handler in `src/main.ts` calls `event.preventDefault()` when the predicate returns false. Main-process `loadURL()` calls do not raise `will-navigate`, so launch, service switching and `itms://` routing are unaffected. The same predicate gates hook injection at both injection sites.

### Persistence and URL building

Each service keeps its own start page and last page. `classical.startPage` and `classical.lastPageUrl` sit alongside `startPage` and `lastPageUrl` in `electron-conf`.

`buildAppleMusicURL()` in `src/storefront.ts` branches on `getMusicService() === 'classical'` to pick the pair to read. The stored path is read only in the `'last'` branch. The Classical home entry has an empty path and must not gain a trailing slash, so the path segment is built as `pageEntry.path === '' ? '' : '/' + pageEntry.path`.

`handleLastPageNavigation()` resolves the host of each navigation through `getServiceByHost()` and writes to `setClassicalLastPageUrl()` or `setLastPageUrl()` accordingly. It stores the path with its query string, so `/gb/search?term=jazz` resumes as the search it was, and drops the fragment, which is renderer state rather than a page address.

`appendLanguage()` adds the `?l=` parameter through `URL` and `searchParams.set()`, so a stored path that already carries a query gets `&l=` rather than a second `?`, and a stored `l=` is replaced rather than duplicated. It returns the string untouched when no language is set, because a `URL` round trip would normalise it and the Classical home URL must keep its bare `/gb` form.

`buildItmsRouteURL()` is pinned to `getService('music').origin`. `itms://` links always target Apple Music, and `transformItmsUrl()` in `src/itms.ts` pins the host on the parsing side.

### Themes across services

Themes are service-agnostic. `resolveTheme()` does not branch on the active service, `injectThemeCss()` runs on every page load, and the tray Style submenu is enabled under both services. Both sites are separate builds of one Svelte design system and share an identical `:root` custom property block, so every token `src/themeTemplate.ts` overrides carries the same value on Classical.

### Switching

`switchService(id, targetUrl?)` in `src/serviceSwitch.ts` is the only switch sequence that ships. Both the tray Player submenu and `itms://` routing call it. In order:

1. `resetWedgeDetector()` clears `skipAttempts` and stops the timer. Stopping the timer suppresses a spurious skip-forward after the page re-initialises
2. `setMusicService(id)` persists the new service
3. `rebuildTrayMenu(tray)` runs when a tray exists
4. `setThemeCssKey(null)` drops the tracked inserted-CSS key. The navigation below replaces the document, so the next injection must not call `removeInsertedCSS()` with a key from the old one
5. `loadURL(targetUrl ?? buildAppleMusicURL())`. The default resolves after step 2, so it reads the service just persisted

`routeToMusicService(url)` handles `itms://` links. When the active service is not `music` it calls `switchService('music', url)`, otherwise it navigates directly. Passing the link into `switchService()` rather than navigating after it keeps the switch to one navigation.

`main.ts` owns the window and the tray but cannot be imported, because it runs `app.whenReady()` at import. It supplies both through `initServiceSwitch({ getTray, loadURL })`.

---

## Authentication

Non-issue by design. Cider's auth breaks because it uses MusicKit.js with a developer token it controls and the OAuth user-token flow. Sidra loads `music.apple.com` - Apple handles authentication entirely. Identical to opening Chrome and navigating to `music.apple.com`.

The only implementation requirement: use a named persistent partition so cookies and localStorage survive between launches.

### Passkeys and "Sign in with iPhone"

Apple's sign-in page can offer passkey and "Sign in with iPhone" options inside auth iframes served from `auth.music.apple.com` and `idmsa.apple.com`. These flows rely on WebAuthn's cross-device hybrid transport (`caBLE`) and expect Chromium's `//chrome` product layer to render the QR-code modal. Electron only ships Chromium's `//content` layer, so the modal never appears and `navigator.credentials.get()` can hang behind a spinner. No command-line switch enables this missing UI; see [electron/electron#24573](https://github.com/electron/electron/issues/24573).

Sidra treats these options as unsupported desktop auth paths and hides them before users can enter the dead-end flow. Password sign-in remains Apple's own web flow.

Implementation:

- `assets/authStyleFix.css` hides known passkey, iPhone, and cross-device button/container variants using attribute selectors that survive Apple's obfuscated class names.
- `setupAuthFrameInjection()` listens for `did-frame-finish-load`, filters subframes to `auth.music.apple.com` and `idmsa.apple.com`, then injects the CSS and fallback script with `webFrameMain.executeJavaScript()`.
- The fallback scans button text and standalone captions, hides only bounded containers, and installs a `MutationObserver` so Apple auth re-renders are handled.
- Iframe console messages prefixed with `[sidra] auth-frame hide:` are forwarded to the `auth-frame` log scope.
- `assets/authStyleFix.css` must stay listed in `asarUnpack`; packaged builds read it from disk at runtime.

### Window close behaviour

`music.apple.com` registers a `beforeunload` event handler while audio is playing. In Electron, this silently blocks `BrowserWindow.close()` and `app.quit()` with no dialog or error - unlike Chrome, Electron does not prompt the user. Fix with:

```typescript
win.webContents.on('will-prevent-unload', (event) => event.preventDefault());
```

This is standard Chromium/Electron behaviour, not CastLabs-specific. The same issue was documented for Google Music in [electron/electron#8468](https://github.com/electron/electron/issues/8468).

---

## Theming

The default colour scheme is Apple Music's own (`'apple-music'`). Bundled themes are registry-driven: `src/palettes.ts` defines `BUNDLED_THEMES` (Catppuccin, Dracula, Gruvbox, Nord, Rosé Pine, Solarized), and `src/themeTemplate.ts` renders each 12-slot palette into a full override stylesheet.

### Persistence

Theme preference is stored in `electron-conf` as `theme` (`ThemeName`: `'apple-music'` | `BundledThemeName` | `'custom'`). `resolveTheme()` guards startup/runtime behaviour:

- The active music service is not consulted; the same theme resolves on Apple Music and Apple Music Classical
- Unknown stored values fall back to `'apple-music'`
- `'custom'` falls back to `'apple-music'` when `custom.css` holds no usable CSS
- Bundled values pass through directly

`hasCustomCss()` is `getThemeCss('custom') !== null`, so a present `custom.css` means a readable, non-blank file rather than one that merely exists.

### Implementation

`theme.ts` exposes `applyTheme(name: ThemeName)` and keeps the existing promise queue inside `initThemeCSS()` to serialise `removeInsertedCSS()/insertCSS()` operations. CSS sourcing now comes from `getThemeCss(name)`:

- `'apple-music'` → `null` (remove any injected override)
- bundled themes → lazily rendered via `buildThemeCss(...)` and cached in memory
- `'custom'` → `userData/custom.css`, cached in memory; missing, unreadable, or whitespace-only files are treated as absent

`custom.css` lifecycle:

- Path: `path.join(app.getPath('userData'), 'custom.css')`
- `initThemeCSS()` ensures the user data directory exists, then installs `fs.watch(..., { persistent: false })`
- Watcher reacts to `filename === 'custom.css'` and `filename === null` (macOS behaviour), debounced by 150ms
- The file contents are cached, because `hasCustomCss()` and `resolveTheme()` both read them on every tray rebuild
- The watcher calls `invalidateCustomCssCache()` before the debounce, not inside it, so a tray rebuild during the debounce window cannot read stale contents from the cache
- A watcher that fails to start, or that errors and closes, calls `disableCustomCssCache()`. Caching switches off, rather than leaving a cache that goes stale for the life of the process
- The debounced callback re-applies `'custom'` when `resolveTheme()` returns it, and falls back to `'apple-music'` when the stored theme is `'custom'` but the file no longer holds usable CSS. Both paths need the window to be alive
- It then calls the tray rebuild callback unconditionally, because creating or deleting `custom.css` adds or removes the tray Style entry whichever theme is stored. `main.ts` supplies that callback through `setRebuildTrayCallback()`, since `tray.ts` imports `theme.ts` and the import cannot run back the other way
- Watcher setup and runtime errors are logged as warnings; they never crash the app
- Timer cleanup and watcher close run on `app.on('will-quit')`

---

## Discord Rich Presence

Uses `@xhayper/discord-rpc`. Discord Application Client ID: `1485248818688688318`. Sidra branding assets (`sidra_logo`) are uploaded to the Discord Developer Portal.

Reference implementation: [ytmdesktop Discord presence](https://github.com/ytmdesktop/ytmdesktop/blob/development/src/main/integrations/discord-presence/index.ts)

### Behaviour

- **Activity type**: `ActivityType.Listening`, which supplies the "Listening to" verb and nothing else
- **Status display type**: `StatusDisplayType.DETAILS` (2), which picks `details` as the field Discord renders after that verb in the member-list line. Discord defaults the field to 0 (Name), which renders the registered application name instead of the track title.
- **Details**: Track name (truncated to 128 chars, padded to 2 chars minimum - Discord rejects shorter strings)
- **State**: `by ArtistName` (truncated to 128 chars, padded to 2 chars minimum)
- **Artwork**: Apple Music CDN URLs work directly as `largeImageKey` if under 256 chars (typical range: 80-130 chars). Fall back to a Discord-hosted `sidra_logo` asset if over the limit.
- **Timestamps**: When playing, calculate `startTimestamp` and `endTimestamp` from current position at send time. Omit when paused.
- **Buttons**: Two buttons - "Sidra" (links to GitHub repo) and "Play on Apple Music" (links to track URL when available).
- **Debounce**: 1s debounce on updates to coalesce rapid events (track change + playback state landing together). `scheduleUpdate()` resets the debounce timer; `sendActivity()` reads the position fresh from the player when it fires.
- **Pause timeout**: Clear activity after 30s paused (ytmdesktop pattern) - courtesy to users who do not want to broadcast a paused state.
- **Retry**: Reconnect with exponential backoff (2s base, 60s cap) on Discord IPC disconnection.
- **Client recreation**: Every reconnect attempt discards the `Client` and builds a fresh one; the backoff itself is unchanged. `Client.connect()` registers a `connected` listener on every call and removes it only when `connected` fires, so both failure paths leave one attached, and a client kept for the life of the process trips the emitter's default limit of 10. Transport rejection also leaves `connectionPromise` set to a rejected promise, so every later `connect()` returns that same rejection without retrying, and one fast transport failure would kill presence for the rest of the session. `destroy()` removes no listeners and does not clear `connectionPromise`, so destroying alone is not enough. The old client's listeners come off before the destroy, because `destroy()` closes the transport and the transport `close` handler emits `disconnected` on the old client, which would otherwise re-enter the reconnect schedule and arm a second backoff chain.
- **Toggle**: `discord.enabled` in `electron-conf` (default: false). Tray menu toggle; when disabled, clears activity immediately.

### `playbackTimeDidChange` pitfall

`playbackTimeDidChange` fires every ~250ms (MusicKit polling). Integrations must NOT call `scheduleUpdate()` (or any debounced function) from this event - doing so resets the debounce timer on every tick, preventing the debounced callback from ever executing. The Discord integration therefore subscribes to no `playbackTimeDidChange` event at all: `sendActivity()` calls `playerRef.playbackSnapshot()` and reads the playing flag and the position from that snapshot.

### Event subscriptions

| Event | Action |
|---|---|
| `nowPlayingItemDidChange` | Cache metadata, cancel pause timer, `scheduleUpdate()` |
| `playbackStateDidChange` | Update `isPlaying`, manage pause timer, `scheduleUpdate()` |

---

## Last.fm Scrobbling

`src/integrations/lastfm` talks to the [Last.fm API 2.0](https://www.last.fm/api) through `net.fetch`. No library. Every request is signed with an MD5 `api_sig` over the sorted parameters plus the shared secret.

### Credentials

Two levels, and they are easy to confuse:

| Credential | Scope | Where it lives |
|---|---|---|
| API key + shared secret | The Sidra application, shared by every user | `SIDRA_LASTFM_API_KEY` / `SIDRA_LASTFM_API_SECRET` env vars, else `assets/lastfm-credentials.json` (gitignored, written at build time, `asarUnpack`ed) |
| Session key | One Last.fm account | `lastfm.sessionKey` in `electron-conf` |

`isConfigured()` is false when the app-level pair is missing, and the tray then omits the Last.fm submenu entirely rather than showing a dead toggle.

### Authentication

The desktop token flow, because Last.fm offers no callback for a desktop app:

1. `auth.getToken` returns a token.
2. Sidra opens `https://www.last.fm/api/auth/` with the API key and token, assembled through `URL.searchParams` so both values are percent-encoded.
3. `auth.getSession` is polled every 4s until the user approves, or 120s elapses.
4. On success the session key and username are persisted, and a notification confirms it when notifications are enabled.

`authGeneration` invalidates in-flight promises, so a late response cannot reconnect an account the user has since disconnected. `cancelAuth()` runs on `will-quit`.

### Scrobbling rules

- Now-playing (`track.updateNowPlaying`) is sent when a track starts or resumes.
- `scrobbleThresholdMs()` returns `null` for a track of 30 seconds or less; those never scrobble.
- Anything longer scrobbles at half its duration or 4 minutes, whichever comes first, measured against accumulated play time rather than wall time since the track began.
- `trackStartUnix` is captured at the first real play transition, so a track queued while paused carries an honest timestamp.
- A track scrobbles once. A failed submission is dropped, never retried.

### Error handling

`apiCall()` reads the response body and checks the API error code before the HTTP status, because Last.fm returns several of its own codes with a non-2xx status. Error 9 (invalid session key) means the user revoked Sidra at Last.fm: the session is cleared, the tray returns to **Connect to Last.fm…**, and a notification says so even when notifications are switched off.

### Playback verification

The scrobble timer is wall-clock and a page load cancels nothing - a reload, a service switch and `itms://` routing all emit no playback state transition. `doScrobble()` therefore re-reads `player.playbackSnapshot()` at submission time and refuses unless playback is still live and the playhead has reached the threshold. The comparison is absolute, never a delta against a position sampled when the timer was armed.

### Event subscriptions

| Event | Action |
|---|---|
| `nowPlayingItemDidChange` | Reset track state, send now-playing and arm the timer if already playing |
| `playbackStateDidChange` | Arm the timer on a play transition; bank the play time and clear the timer on a pause |

---

## Track Change Notifications

Electron's built-in `Notification` API, works on all three platforms. Notification source shows as "Sidra" (app name) automatically.

**Do not gate on `Notification.isSupported()`** - in CastLabs Electron this returns `false` even when the platform fully supports notifications. Rely on the `failed` event to surface OS-level rejection instead.

On Windows, `app.setAppUserModelId()` must be called before `app.whenReady()` or notifications will not appear (see [Windows: Chromium's GSMTC Bridge](#windows-chromiums-gsmtc-bridge)).

### The notification daemon gate

On Linux, `Notification.show()` blocks the browser UI thread when nothing owns `org.freedesktop.Notifications`. Electron calls `notify_notification_show()` inline, and libnotify builds its `GDBusProxy` without `DO_NOT_AUTO_START`, so GLib runs `StartServiceByName` in a nested main loop and each attempt waits the 25 second D-Bus activation timeout. Electron queries server capabilities three times before the show, so a single notification freezes the window for about 100 seconds.

`createNotification()` in `src/notify.ts` is the only place a `Notification` is constructed. It returns `null` when the gate is closed, and all four call sites (`src/integrations/notifications/index.ts`, `src/integrations/lastfm/index.ts`, `src/update.ts`, `src/autoUpdate.ts`) skip the notification on `null`. The Last.fm `force` flag bypasses the user's notifications preference but not this gate.

`src/notificationDaemon.ts` drives the gate on Linux. It holds its own session bus, subscribes to `NameOwnerChanged` for the notification name, then asks `NameHasOwner`: one round trip that never triggers activation. A daemon started mid-session re-enables notifications with no restart. The gate starts closed on Linux and opens on the first probe reply; off Linux it is open from the start and no bus is opened. `main.ts` calls `initNotificationProbe()` in `app.whenReady()`, before the window exists.

The `failed` listener latches the gate closed on Linux only, as a second line behind the probe. macOS and Windows have no `NameOwnerChanged` recovery path, so a latch there would kill notifications for the rest of the session.

One case remains unfixable from JavaScript: a daemon that owns the name and then hangs mid-`Notify`. `NameHasOwner` returns true and Electron waits on `g_dbus_proxy_call_sync` with an infinite timeout.

The implementation lives in `src/integrations/notifications/index.ts`:

- **Gate check**: `notificationsAvailable()` is checked before the artwork download, so a daemon-less session does no repeated network and disk work per track
- **Artwork**: Uses `downloadArtwork()` from `src/artwork.ts`, which fetches via `net.fetch`, writes to a UUID-based cache with atomic writes, and expires files after 7 days
- **Debounce**: 1500ms debounce on `nowPlayingItemDidChange` to coalesce rapid events
- **Artwork race timeout**: 500ms - if artwork download takes longer, the notification fires without an icon
- **Body format**: `artistName - albumName` (fields joined with ` - ` via `filter(Boolean).join(' - ')`)
- **Handlers**: Registers `show`, `failed`, and `click` event handlers; `click` focuses the main window
- **Silent**: `silent: true` suppresses notification sounds

On NixOS (dev shell), `libnotify` must be present in `LD_LIBRARY_PATH` or `notification.show()` will silently do nothing. This is a dev shell concern, not an app code concern - ensure `libnotify` is in the Nix dev shell's `LD_LIBRARY_PATH`.

Notifications are toggleable via an `electron-conf` boolean setting (default: on).

---

## Tray

`src/tray.ts` manages the system tray icon and context menu. The menu is built from localised strings (`assets/locales/tray.json`) and rebuilds itself on state changes.

### Now Playing

When a track is active, the top of the context menu shows metadata and playback controls. This section is absent when nothing is playing or after 30 seconds of pause (mirrors the Discord integration timeout).

**Metadata items** (disabled, display-only):

| Item | Format | Notes |
|------|--------|-------|
| Track name | Label text | Album artwork icon via `getMenuIcon()` (18x18px `nativeImage`); degrades gracefully if artwork file is unavailable |
| Artist name | Label text | Icon via `getMenuIcon()` |
| Album name | Label text | Icon via `getMenuIcon()` |

All metadata labels are truncated at 32 characters via `truncateMenuLabel()`: splits on the first `(` or `[` character, falls back to hard truncation with ellipsis (`…`).

**Playback controls:**

| Item | Label | Action |
|------|-------|--------|
| Previous | `Previous` | `player:previous` |
| Play/Pause | `Play` (paused) / `Pause` (playing) | `player:playPause` |
| Next | `Next` | `player:next` |

All playback control items use icon images via `getMenuIcon(action)` on all platforms.

**Volume submenu:**

Parent label shows current volume, e.g. `Volume: 23%`, with icon via `getMenuIcon()`. Five radio items: Mute, 25%, 50%, 75%, 100%. The checked item reflects the current volume level. Each item sends `player:setVolume` with the corresponding float (0, 0.25, 0.5, 0.75, 1.0).

### Menu rebuild triggers

The context menu rebuilds on track change, playback state change, and volume change. Each rebuild calls `rebuildTrayMenu()`, which reconstructs the full menu template from current state.

### Tray icon

| Platform | Icon | Notes |
|----------|------|-------|
| macOS | `sidraTemplate.png` | Template image; OS handles dark/light automatically |
| Windows | `sidra-tray.png` | Static icon |
| Linux | `sidra-tray-dark.png` or `sidra-tray-light.png` | Switches on `nativeTheme.shouldUseDarkColors`; listens for theme changes |

### Tooltip

When a track is active, the tooltip shows `TrackName - ArtistName`. Falls back to the product name when nothing is playing.

### Tray menu icons

On macOS Tahoe (macOS 26) and later, tray menu items display SF Symbol icons. `getMenuIcon(action)` in `src/tray.ts` calls `nativeImage.createFromNamedImage(symbolName, [-1, 0, 1])` - the `[-1, 0, 1]` hsl shift marks the image as a template so macOS automatically adapts its colour to match the menu text in dark and light mode. SF Symbols render at their intrinsic size, which is too large for menu items; the result is resized to 18x18 px with a 2× HiDPI representation added.

On earlier macOS versions, and on Linux and Windows, `getMenuIcon()` loads themed 18px PNGs from `assets/icons/tray/menu/{dark,light}/`.

---

## macOS Dock

`src/integrations/macos-dock/index.ts` manages the macOS dock menu and progress bar. It is a no-op on non-darwin platforms.

### Dock menu

`app.dock.setMenu()` receives a `Menu` built from current player state on every rebuild trigger (track change, playback state change). When a track is active the menu shows:

1. `"TrackName - ArtistName"` (disabled, display-only)
2. Separator
3. Share item via `ShareMenu` (present only when `getShareUrl()` resolves a URL)
4. Separator
5. Play/Pause, Next, Previous controls

When nothing is playing the menu shows the localised "Not Playing" label (`NOT_PLAYING_TEXT` via `getTrayStrings().notPlaying`) as a disabled header, followed by the controls. The menu reverts to that idle form after 30 seconds of pause.

### Dock progress bar

`win.setProgressBar()` is updated on every `playbackTimeDidChange` event via `src/utils/progressBar.ts`. The bar is cleared on stop, idle states (None, Stopped, Ended, Completed), and pause timeout.

---

## Windows Taskbar

`src/integrations/windows-taskbar/index.ts` provides three Windows taskbar integrations. It is a no-op on non-win32 platforms.

### Thumbnail toolbar

`win.setThumbarButtons()` adds previous, play/pause, and next buttons to the thumbnail preview that appears when hovering the taskbar button. Tooltips come from `getTrayStrings()`, so they follow the system language. Icons are 18px PNGs loaded from `assets/icons/tray/menu/{dark,light}/` via `nativeImage.createFromPath()`. `loadIcon()` chooses the variant from `nativeTheme.shouldUseDarkColorsForSystemIntegratedUI`, not `shouldUseDarkColors`: the thumbar and the overlay badge are painted on the taskbar, which follows the Windows system colour mode, while `shouldUseDarkColors` reports the app colour mode, and a light app with a dark taskbar is the default on a fresh install. The icon set reloads on `nativeTheme.updated` to track theme changes. An unreadable PNG makes `loadIcon()` log a warning and return `null`, and a button with no icon is dropped from the set.

Registration is deferred until `win.once('show', ...)`. Windows silently drops `setThumbarButtons()` calls made before the window is visible; deferring avoids this failure mode.

### Overlay icon

`win.setOverlayIcon()` places a small badge on the taskbar button:

| State | Badge |
|-------|-------|
| Playing | play icon |
| Paused | pause icon |
| Stopped / None / Ended / Completed | cleared |
| Loading, Seeking, Waiting, Stalled (transient) | unchanged (previous value kept to prevent flicker) |

The badge description passed to `win.setOverlayIcon()` is the localised play or pause label from `getTrayStrings()`, which is what a screen reader announces.

### Taskbar progress bar

`win.setProgressBar()` is driven by `src/utils/progressBar.ts`, identical to the macOS dock integration. Cleared on stop or when track metadata is absent.

---

## Progress Bar

`src/utils/progressBar.ts` is a platform-agnostic utility used by both the macOS dock and Windows taskbar integrations.

```typescript
updateProgressBar(win: BrowserWindow, positionUs: number, durationMs: number | undefined): void
clearProgressBar(win: BrowserWindow): void
```

`positionUs` is in **microseconds** (the unit emitted by `playbackTimeDidChange`). `durationMs` is in **milliseconds** (the unit in `NowPlayingPayload.durationInMillis`). The function converts both to seconds before dividing.

Guard conditions: if `durationMs` is absent or `<= 0`, the bar is cleared (avoids divide-by-zero). Output is clamped to [0, 1] before passing to `win.setProgressBar()`.

---

## Share Sheet

On macOS, the tray menu and dock menu both include a Share item using Electron's `ShareMenu`. The URL is resolved via `getShareUrl(payload)` in `src/player.ts`, which falls back through:

```
payload.url → playParams.catalogId → playParams.globalId → undefined
```

When `getShareUrl()` returns `undefined`, the Share item is omitted from the menu. When present, clicking it calls `shareMenu.popup()` to display the native macOS Share sheet with the Apple Music URL.

`SHARE_TEXT` is a localised string added to `assets/locales/tray.json` across all 32 supported languages.

---

## Application Menu

`setupApplicationMenu()` in `src/main.ts` sets the application menu on startup:

| Context | Menu |
|---------|------|
| `SIDRA_DEVTOOLS=1` | View menu with "Toggle Developer Tools" |
| macOS (normal) | Single app-name menu: "About Sidra" + separator + "Quit Sidra" (Cmd+Q via `role: 'quit'`) |
| Linux / Windows | `Menu.setApplicationMenu(null)` - no menu bar |

The About item uses `getMenuIcon('about')`, which resolves to the `info.circle` SF Symbol on macOS Tahoe or later (undefined on earlier versions, in which case the icon property is omitted entirely).

`productName: "Sidra"` in `package.json` sets `app.name` to `"Sidra"`; electron-builder derives the menu label from this field.

`showAboutWindow()` is exported from `src/aboutWindow.ts` and imported by `src/main.ts` for use in the app menu. Both the About window and the splash window set `fullscreenable: false` and `fullscreen: false` to prevent them entering full-screen mode.

---

## Auto-update

`src/autoUpdate.ts` provides automatic update delivery for AppImage (Linux) and NSIS (Windows) builds via `electron-updater`. All other packaging formats (deb, rpm, Nix, DMG) receive a tray notification pointing to the GitHub releases page instead.

### Platform detection

`isAutoUpdateSupported()` determines at runtime whether the updater should initialise:

| Condition | Result |
|---|---|
| `process.env.APPIMAGE` is set | AppImage - enable updater |
| `process.platform === 'win32' && app.isPackaged` | NSIS - enable updater |
| `SIDRA_DISABLE_AUTO_UPDATE=1` env var set | Force-disable regardless of packaging |
| All other cases | Notification-only mode |

`app-update.yml` is present in all packaged builds including deb/rpm/Nix. Runtime detection in `isAutoUpdateSupported()` prevents updater initialisation even when the file is present; log noise is not a concern in practice.

### Lazy require constraint

`electron-updater` must be `require()`d inside `initAutoUpdate()` only - never at module top level. On unsupported platforms the module must never load. Verify correct behaviour by checking log output: `autoUpdate` scope messages must not appear on deb, rpm, or Nix builds.

### CastLabs ECS compatibility

`electron-updater` implements its own download/install pipeline and does not use Electron's built-in `autoUpdater`. All APIs it uses are unmodified in CastLabs ECS. The known `app.relaunch()` bug (CastLabs issue #164) does not affect `AppImageUpdater` - it spawns the new binary via `child_process.spawn()` directly.

### Manifest filenames

electron-updater manifest filenames are hardcoded and cannot be changed:

- `latest.yml` - Windows (NSIS) update manifest
- `latest-linux.yml` - Linux (AppImage) update manifest

### Configuration

- `verifyUpdateCodeSignature: false` is required on Windows because the app is unsigned.
- AppImage `artifactName` must omit the version component - use `${productName}-${os}-${arch}.${ext}`. Including the version causes filename changes that break desktop shortcuts after update.
- Future package managers (Scoop, Chocolatey) must set `SIDRA_DISABLE_AUTO_UPDATE=1` in their install manifests to suppress the updater.

---

## Feature Inventory

### v0.1 - Linux MLP

| Feature | Implementation | Notes |
|---|---|---|
| Apple Music web app (DRM) | CastLabs Electron + `music.apple.com` | Widevine CDM auto-installs |
| Auth | Apple's own web flow | Persistent partition; no developer tokens |
| MPRIS (Linux) | `dbus-next` D-Bus service | `org.mpris.MediaPlayer2.sidra` |
| MPRIS primitives | play/pause/next/prev/seek/stop | From MusicKit events via IPC |
| MPRIS metadata | title/artist/album/artwork/duration/trackId | From `nowPlayingItemDidChange` |
| MPRIS volume | Two-way with suppression flag | musicKitHook.js + main MPRIS plugin |
| MPRIS repeat/shuffle | Two-way | `repeatModeDidChange` + `shuffleModeDidChange` |
| Discord Rich Presence | `@xhayper/discord-rpc` | With debounce + pause timeout + retry |
| Track change notifications | Electron `Notification` | With artwork, suppressable in settings |
| Regional storefront detection | `app.getLocaleCountryCode()` → `/gb/new`, `/ch/new` etc. | Fallback chain: persisted → detected → `us` |
| Storefront preference persistence | `electron-conf` + `did-navigate` listener | Survives restarts; language parameter preserved |
| User-agent spoofing | `webRequest.onBeforeSendHeaders` | Standard Chrome UA |
| Wayland support | `--enable-features=UseOzonePlatform` | Auto-detected via platform check |
| App identity | `productName` in `package.json` | Consistent across all platform controls |

### v0.2 - macOS + Windows Builds

| Feature | Implementation | Notes |
|---|---|---|
| macOS Now Playing | Chromium mediaSession → MPNowPlayingInfoCenter | Bundle name "Sidra" from productName |
| Windows GSMTC | Chromium mediaSession → GSMTC | `app.setAppUserModelId('com.wimpysworld.sidra')` |
| Explicit `navigator.mediaSession` updates | musicKitHook.js | Supplement Apple's own updates |
| System tray | Electron `Tray` | Prev/play-pause/next + show/hide |
| macOS `.app` build | electron-builder | DMG |
| Windows build | electron-builder | NSIS installer |
| macOS dock menu | `app.dock.setMenu()` | Now Playing info + playback controls |
| macOS dock progress bar | `win.setProgressBar()` via `progressBar.ts` | Updated on `playbackTimeDidChange` |
| macOS share sheet | `ShareMenu` with Apple Music URL | In tray and dock menus; URL from `getShareUrl()` |
| macOS app menu | `Menu.setApplicationMenu()` | About + Quit; `info.circle` SF Symbol on Tahoe+ |
| macOS tray menu SF Symbol icons | `nativeImage.createFromNamedImage()` | Template images; macOS Tahoe+ only |
| Windows thumbnail toolbar | `win.setThumbarButtons()` | Previous, play/pause, next; deferred to `win.once('show')` |
| Windows overlay icon | `win.setOverlayIcon()` | Play/pause badge; skipped during transient states |
| Windows taskbar progress bar | `win.setProgressBar()` via `progressBar.ts` | Same utility as macOS dock |
| Splash screen | `assets/splash.html` | Localised loading text via `loading.json` |
| Content readiness polling | `CONTENT_READY_SELECTOR` in `src/contentReady.ts`: `[data-testid="app-container"] amp-playback-controls-play[hydrated]` | Waits for the UI to hydrate before removing splash; both services share the selector |
| About window | Frameless `BrowserWindow` + `assets/about.html` | Localised labels via `about.json` |
| Navigation bar | `assets/navigationBar.js` injected post-load | Back/forward/reload buttons in sidebar; localised aria-labels substituted for `__SIDRA_NAV_LABELS__` at read time |
| Auth iframe filtering | `authStyleFix.css` + `webFrameMain.executeJavaScript()` | Hides unsupported passkey and "Sign in with iPhone" desktop flows |
| Zoom factor preference | `zoom` in `electron-conf` | 1.0x to 2.0x via tray submenu |
| Wedge detector | `src/wedgeDetector.ts` | Auto-skip on playback stall |
| Artwork cache | `src/artwork.ts` | UUID-based filenames, 7-day expiry, atomic writes |
| Pause timer utility | `src/pauseTimer.ts` | `createPauseTimer()` shared by tray, dock, Discord |
| Update checking (non-auto-update) | `src/update.ts` | GitHub API check for deb/rpm/Nix/DMG platforms |
| Service worker cache clearing | `session.defaultSession.clearStorageData` | Clears on startup to prevent stale assets |
| Last.fm scrobbling | `src/integrations/lastfm` + Last.fm API 2.0 | Opt-in; browser auth from the tray, per-user session key in `electron-conf` |

#### Tray Menu Implementation Notes

- Use `type: 'radio'` within submenus for all toggle items (e.g. notifications on/off, theme selection, start page). On all platforms this renders a native radio indicator for the active selection.

### v0.3 - Nice to Have

| Feature | Notes |
|---|---|
| AirPlay casting | `airtunes2` node module (Cider v1 has this) |

### Explicitly Out of Scope

- Custom UI, component overrides, or plugin-based theme engines
- Audio effects or EQ
- Plugin/extension system
- Lossless upgrade (already works via the web player)

---

## Risk Assessment

| Risk | Severity | Likelihood | Mitigation |
|---|---|---|---|
| Apple blocks Electron user agent | High | Low | Spoof Chrome UA on all requests |
| Apple changes MusicKit.js API | Medium | Low | MusicKit.js is a public developer API with versioning |
| Apple renames the `chrome-volume` class | Low | Medium | Scroll-to-change-volume stops responding; every other volume path is unaffected. The token is the only DOM detail the hook depends on, and no Svelte scope hash is matched, so an Apple rebuild alone does not break it |
| CastLabs Electron lags Electron releases | Low | Medium | Only affects security patching cadence; v40.7.0+wvcus, tracking close to mainline |
| Live radio stations crash | Medium | Confirmed | Known issue in apple-music-wrapper; investigate `did-crash` handler |
| CSP blocks script injection | Low | Very low | `executeJavaScript()` bypasses page CSP in Electron |
| Apple legal action | Medium | Very low | Multiple similar apps exist and have for years; requires Apple Music subscription |
