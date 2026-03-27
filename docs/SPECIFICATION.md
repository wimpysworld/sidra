# Sidra - Specification

A minimal Apple Music desktop client. CastLabs Electron wraps `music.apple.com` directly, injecting a lightweight hook script to bridge MusicKit.js events to native platform media controls. Apple maintains the UI; Sidra maintains the bridge.

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
- [Authentication](#authentication)
- [Theming](#theming)
- [Discord Rich Presence](#discord-rich-presence)
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
| Renderer content | `music.apple.com` | Zero UI code; Apple maintains it |
| MusicKit hook | Injected JS script post-page-load | Hooks `MusicKit.getInstance()` events |
| Preload | `contextBridge` IPC bridge | Standard Electron security pattern |
| MPRIS (Linux) | `dbus-next` directly | Full control, clean service name |
| Windows controls | Chromium `mediaSession` → GSMTC | Built-in bridge, identity via `setAppUserModelId` |
| Windows taskbar | `win.setThumbarButtons()` + `win.setOverlayIcon()` | Thumbnail toolbar and overlay badge |
| macOS controls | Chromium `mediaSession` → MPNowPlayingInfoCenter | Built-in bridge, identity via bundle name |
| macOS dock | `app.dock.setMenu()` + `win.setProgressBar()` | Right-click menu and progress bar |
| Config | `electron-store` | Persistent config (storefront, theme, preferences) |
| Build | `electron-builder` | AppImage + deb + rpm (Linux), DMG (macOS), NSIS (Windows) |
| Package manager | npm | Simplest option; avoids pnpm's strict semver parsing issues with CastLabs `+wvcus` tag |

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│ CastLabs Electron (Widevine CDM auto-installed)         │
│                                                         │
│  ┌──────────────────────┐      ┌────────────────────┐  │
│  │  Main Process        │◄─IPC─│  Renderer Process  │  │
│  │                      │      │                    │  │
│  │  ┌────────────────┐  │      │  music.apple.com   │  │
│  │  │ IPC event hub  │  │      │  ┌──────────────┐  │  │
│  │  │ (player.ts)    │  │      │  │ MusicKit.js  │  │  │
│  │  └───────┬────────┘  │      │  └──────┬───────┘  │  │
│  │          │           │      │         │ events   │  │
│  │  ┌───────▼────────┐  │      │  ┌──────▼───────┐  │  │
│  │  │ Integrations   │  │      │  │ Hook script  │  │  │
│  │  │ ├─ MPRIS       │◄─┼──────┼──┤(injected JS) │  │  │
│  │  │ ├─ Discord RPC │  │      │  └──────────────┘  │  │
│  │  │ ├─ Notifier    │  │      │                    │  │
│  │  │ └─ Taskbar/Dock│  │      │  ┌──────────────┐  │  │
│  │  └───────┬────────┘  │      │  │  preload.ts  │  │  │
│  │          │           │      │  │ (IPC bridge) │  │  │
│  │  ┌───────▼────────┐  │      │  └──────────────┘  │  │
│  │  │ electron-store │  │      └────────────────────┘  │
│  │  └────────────────┘  │                               │
│  └──────────────────────┘                               │
└─────────────────────────────────────────────────────────┘
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
│   ├── main.ts                    — bootstrap, Widevine wait, window, IPC hub
│   ├── preload.ts                 — contextBridge IPC exposure (AMWrapper)
│   ├── config.ts                  — electron-store wrapper
│   ├── i18n.ts                    — locale detection, JSON loader, and re-exported translation records
│   ├── paths.ts                   — getAssetPath() and getProductInfo() utilities
│   ├── player.ts                  — TypedEmitter, PlayerEvents, PlaybackState (0-9), IntegrationContext
│   ├── storefront.ts              — buildAppleMusicURL(), extractStorefrontFromURL(), handleStorefrontNavigation()
│   ├── types/
│   │   └── electron.d.ts          — module augmentations for CastLabs type gaps
│   ├── theme.ts                   — named theme lifecycle: ThemeName, applyTheme(), initThemeCSS(), themeCssMap
│   ├── artwork.ts                 — downloadArtwork(), cleanArtworkCache(); UUID-based multi-file cache
│   ├── autoUpdate.ts              — isAutoUpdateSupported(), initAutoUpdate(), quitAndInstall(); electron-updater
│   ├── update.ts                  — checkForUpdates() via GitHub API; UpdateInfo state
│   ├── wedgeDetector.ts           — detects playback stalls and auto-skips forward
│   ├── pauseTimer.ts              — createPauseTimer() factory; shared by tray, dock, Discord integrations
│   ├── utils.ts                   — errorMessage() utility
│   ├── utils/
│   │   └── progressBar.ts         — updateProgressBar() / clearProgressBar(); platform-agnostic win.setProgressBar()
│   ├── tray.ts                    — system tray icon, context menu, About window, tray state manager
│   └── integrations/
│       ├── mpris/
│       │   └── index.ts           — D-Bus MPRIS service (Linux only)
│       ├── discord-presence/
│       │   └── index.ts           — Discord RPC with retry/debounce
│       ├── notifications/
│       │   └── index.ts           — Track change desktop notifications
│       ├── macos-dock/
│       │   └── index.ts           — Dock right-click menu + progress bar (macOS only)
│       └── windows-taskbar/
│           └── index.ts           — Thumbnail toolbar + overlay icon + progress bar (Windows only)
├── assets/
│   ├── musicKitHook.js            — Injected into music.apple.com post-load
│   │                                 Must be listed in electron-builder's `asarUnpack` —
│   │                                 it is read with readFileSync at runtime and will crash
│   │                                 AppImage builds if packed inside the asar archive
│   ├── navigationBar.js           — Injected post-load; adds back/forward/reload buttons to sidebar
│   ├── about.html                 — About window content, receives product info via query params
│   ├── splash.html                — Splash screen shown during startup
│   ├── sidra-logo.png             — Product logo used in About window
│   ├── locales/
│   │   ├── loading.json           — 1 translation record: LOADING_TEXT
│   │   ├── tray.json              — 21 translation records: tray menu labels
│   │   ├── about.json             — 4 translation records: about window labels
│   │   └── update.json            — 5 translation records: auto-update labels
│   ├── styleFix.css               — CSS overrides injected via webContents.insertCSS()
│   │                                 Hides "Get the app" and "Open in Music" banners
│   │                                 that Apple shows to push users toward native apps
│   ├── catppuccin.css             — Optional Catppuccin palette overrides; injected when
│   │                                 the theme preference is set to catppuccin
│   └── icons/
│       ├── sidraTemplate.png      — macOS tray (template image)
│       ├── sidra-tray.png         — Windows tray
│       ├── sidra-tray-dark.png    — Linux tray (dark theme)
│       ├── sidra-tray-light.png   — Linux tray (light theme)
│       └── tray/menu/
│           ├── dark/              — 18px dark-theme menu item PNGs
│           └── light/             — 18px light-theme menu item PNGs
├── build/
│   ├── icon.png, icon.icns, icon.ico
│   └── afterPack.cjs
├── package.json
└── tsconfig.json
```

---

## Dependencies

```json
{
  "devDependencies": {
    "electron": "github:castlabs/electron-releases#v40.7.0+wvcus",
    "electron-builder": "^26.8.2",
    "shx": "^0.4.0",
    "typescript": "^5.x",
    "vitest": "^4.1.1"
  },
  "dependencies": {
    "@holusion/dbus-next": "^0.11.2",
    "@xhayper/discord-rpc": "^1.3.1",
    "electron-log": "^5.x",
    "electron-store": "^10.x",
    "electron-updater": "^6.8.3"
  }
}
```

Five runtime dependencies. Compare to Cider v1's 25+.

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
| `playbackStateDidChange` | `{ status: bool, state }` | MPRIS, Discord, Notifications, Dock, Taskbar |
| `nowPlayingItemDidChange` | `NowPlayingPayload` (see `src/player.ts`) or `null` | MPRIS, Discord, Notifications, Dock, Taskbar |
| `playbackTimeDidChange` | Position in microseconds | MPRIS, Discord (position only), Dock, Taskbar |
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
3. Preload forwards to the main world via `window.postMessage({ type: 'sidra:command', channel, args }, '*')`
4. `musicKitHook.js` listens for `sidra:command` messages and dispatches to `window.__sidra` methods

The command bridge uses the `RECEIVE_CHANNELS` allowlist in `src/preload.ts` and the `COMMANDS` allowlist in `assets/musicKitHook.js`, which must stay in sync.

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

Injected into `music.apple.com` after page load via `webContents.executeJavaScript()`. Polls for `MusicKit` availability, hooks events, and exposes the `window.__sidra` control object.

`assets/musicKitHook.js` is read with `fs.readFileSync` at runtime in the main process. It must be listed in the `asarUnpack` array in `electron-builder` configuration; without it, AppImage builds will crash on startup because the file is inaccessible inside the packed asar archive.

```javascript
// Structure of assets/musicKitHook.js (~153 lines)
// Not inlined in full; see the source file for the complete implementation.

(function () {
  function attachToInstance(mk) {
    // Idempotency guard
    if (window.MusicKit && window.__sidraHookedMk === MusicKit.getInstance()) return;
    window.__sidraHookedMk = mk;

    // Event listeners: playbackStateDidChange, nowPlayingItemDidChange,
    // playbackTimeDidChange, repeatModeDidChange, shuffleModeDidChange,
    // volumeDidChange

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
  }

  // 5-second interval monitors for MusicKit instance replacement
  // and re-calls attachToInstance() when a new instance is detected
  const waitForMK = setInterval(() => {
    if (!window.MusicKit) return;
    attachToInstance(MusicKit.getInstance());
  }, 5000);
})();
```

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

**PulseAudio stream identity**: Chromium hard-codes `application.name = "Chromium"` and `application.icon_name = "chromium-browser"` on PulseAudio/PipeWire streams via explicit API calls; `PULSE_PROP_*` environment variables are ineffective. Sidra fixes this by disabling `AudioServiceOutOfProcess` (moves audio in-process so `SetGlobalAppName` reaches PulseAudio) and calling `app.setDesktopName('sidra.desktop')` (sets `CHROME_DESKTOP` for `GetXdgAppId()`). See [electron/electron#27581](https://github.com/electron/electron/issues/27581) and `docs/PULSE.md` for full details.

### macOS: Chromium's Built-in mediaSession Bridge

Chromium maps `navigator.mediaSession` to `MPNowPlayingInfoCenter` automatically. The **app bundle name** determines what appears in the Now Playing widget (Control Centre, Lock Screen) - set via `productName: "Sidra"` in electron-builder config.

### macOS: Dock Menu and Progress Bar

`src/integrations/macos-dock/index.ts` adds a right-click dock icon menu via `app.dock.setMenu()`. When a track is playing the menu shows the track and artist name (display-only), a Share item (if a URL is available), and play/pause, next, previous controls. The menu clears to a stub after 30 seconds of pause (matching the tray timeout). The dock progress bar uses `win.setProgressBar()` via `src/utils/progressBar.ts`, updated on every `playbackTimeDidChange` event and cleared on stop, idle, or pause timeout.

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

**Thumbnail toolbar** (`win.setThumbarButtons()`): previous, play/pause, and next buttons. Icons are loaded from the 18px tray PNGs via `nativeImage.createFromPath()`, switching dark/light variants on `nativeTheme.updated`. Button registration is deferred until `win.once('show', ...)` - Windows silently drops `setThumbarButtons()` calls on hidden windows.

**Overlay icon** (`win.setOverlayIcon()`): displays a play or pause badge on the taskbar button. Cleared on stop or idle. Skipped during transient states (Loading, Seeking, Waiting, Stalled) to prevent flicker.

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

---

## Volume Sync

Cider's MPRIS volume sync is one-directional (MPRIS to MusicKit only, no reliable MusicKit to MPRIS), with a feedback loop on `volumeDidChange`. Sidra fixes this with a suppression flag pattern:

```
MPRIS sets volume
  → executeJavaScript sets mk.volume
    → mk fires volumeDidChange
      → IPC sends volume back to main
        → suppression flag swallows the echo
```

The suppression timeout is 500ms (2× the 250ms `musicKitHook.js` poll interval). The epsilon comparison (0.01) absorbs floating-point rounding without masking genuine user-initiated changes.

Also update `navigator.mediaSession` volume whenever MusicKit volume changes - `music.apple.com` does not always do this itself.

**PulseAudio sink input volume is intentionally not synced.** MPRIS `Volume` controls MusicKit's software volume (`HTMLMediaElement.volume`) only. The PulseAudio/PipeWire sink input volume shown in pulsemixer and pavucontrol is independent and left to the user via their system mixer. This matches the behaviour of Rhythmbox, Spotify, VLC, mpv, and Clementine. Syncing both would cause double-volume multiplication (e.g. 0.5 × 0.5 = 0.25, −12 dB instead of the expected −6 dB) and would require a `libpulse` binding or fragile `pactl` subprocess calls.

### Volume Event Workaround

The `music.apple.com` volume slider writes directly to `HTMLMediaElement.volume`, bypassing MusicKit's setter. As a result, `volumeDidChange` never fires on user-initiated slider changes. The workaround is to poll `mk.volume` at 250ms intervals and send IPC only when the value changes. Keep `addEventListener('volumeDidChange', ...)` in place for programmatic volume changes (e.g. from `window.__sidra.setVolume()`).

---

## Region and Storefront

Loading bare `https://music.apple.com` causes Apple's server to 301-redirect all clients to `/us/new`, regardless of location. Users outside the US see the wrong catalogue on every launch.

### Storefront detection

`app.getLocaleCountryCode()` returns the OS region as an uppercase ISO 3166-1 alpha-2 code (e.g. `GB`, `CH`). Lowercasing this value produces the Apple Music storefront path segment directly. No validation against Apple's API is required - Apple's server redirects any unrecognised storefront code to `/us/new` with a clean 301, so the failure mode is identical to the current bare-URL behaviour.

Fallback chain at startup:

```
1. Read persisted storefront from electron-store
2. If found → use it
3. If not found → app.getLocaleCountryCode().toLowerCase()
4. If empty string (LC_ALL=C, unset locale) → 'us'
5. Build URL: https://music.apple.com/{storefront}/new[?l={language}]
```

### Persistence

`electron-store` holds two keys: `storefront` (e.g. `gb`) and `language` (BCP 47 tag from the `?l=` parameter, e.g. `fr`, or `null`). A `did-navigate` and `did-navigate-in-page` listener on `win.webContents` parses the URL after each navigation. When the storefront or language changes, the new values are written to the store. Same-storefront navigation does not trigger a write.

### Storefront codes

Apple Music storefront codes are ISO 3166-1 alpha-2 codes lowercased (e.g. `gb`, `us`, `ch`). Apple supports 167+ storefronts. The `?l=` parameter accepts BCP 47 language tags from each storefront's `supportedLanguageTags` list and controls UI localisation only - the storefront determines catalogue availability.

---

## Authentication

Non-issue by design. Cider's auth breaks because it uses MusicKit.js with a developer token it controls and the OAuth user-token flow. Sidra loads `music.apple.com` - Apple handles authentication entirely. Identical to opening Chrome and navigating to `music.apple.com`.

The only implementation requirement: use a named persistent partition so cookies and localStorage survive between launches.

### Window close behaviour

`music.apple.com` registers a `beforeunload` event handler while audio is playing. In Electron, this silently blocks `BrowserWindow.close()` and `app.quit()` with no dialog or error - unlike Chrome, Electron does not prompt the user. Fix with:

```typescript
win.webContents.on('will-prevent-unload', (event) => event.preventDefault());
```

This is standard Chromium/Electron behaviour, not CastLabs-specific. The same issue was documented for Google Music in [electron/electron#8468](https://github.com/electron/electron/issues/8468). See `docs/QUIT.md` for full research.

---

## Theming

The default colour scheme is Apple Music's own. When the `catppuccin` theme is selected, a CSS override file is injected via `webContents.insertCSS()` immediately after `styleFix.css`. No custom UI components are introduced - colour tokens only.

### Palette

| Context | Variant | Background | Text | Accent |
|---|---|---|---|---|
| Dark | Catppuccin Mocha | `#1e1e2e` (Base) | `#cdd6f4` (Text) | `#f38ba8` (Red) |
| Light | Catppuccin Latte | `#eff1f5` (Base) | `#4c4f69` (Text) | `#d20f39` (Red) |

The red accent is used in both variants to preserve Apple Music brand association. Light/dark variant selection follows the system `prefers-color-scheme` media query.

### Persistence

Theme preference is stored in `electron-store` as `theme` (`ThemeName`: `'apple-music'` | `'catppuccin'`). Default is `'apple-music'`. Applied immediately via `applyTheme(name)` - no restart required.

### Implementation

`theme.ts` exposes `applyTheme(name: ThemeName)`: unloads the current CSS key (if any) then injects the new theme's CSS via `webContents.insertCSS()`. `'apple-music'` maps to `null` in `themeCssMap` - no CSS is injected. A promise queue inside `initThemeCSS()` serialises all inject/remove operations to prevent race conditions. Adding a new theme: add the name to `ThemeName`, add the CSS string to `themeCssMap`, add the CSS file to `assets/`, and list it in `asarUnpack` in `package.json`.

`catppuccin.css` overrides CSS custom properties on `:root` and targets specific elements that fall outside the normal cascade. `webContents.insertCSS()` injects at author-level cascade origin, so all overrides use `!important` to win specificity ties against Apple's own stylesheets after navigation.

`@media (prefers-color-scheme: dark)` and `@media (prefers-color-scheme: light)` resolve correctly in Electron's Chromium renderer against `nativeTheme.shouldUseDarkColors`. A single CSS file with both blocks covers both variants.

---

## Discord Rich Presence

Uses `@xhayper/discord-rpc`. Discord Application Client ID: `1485248818688688318`. Sidra branding assets (`sidra_logo`) are uploaded to the Discord Developer Portal.

Reference implementation: [ytmdesktop Discord presence](https://github.com/ytmdesktop/ytmdesktop/blob/development/src/main/integrations/discord-presence/index.ts)

### Behaviour

- **Activity type**: `ActivityType.Listening` ("Listening to" status text)
- **Details**: Track name (truncated to 128 chars, padded to 2 chars minimum - Discord rejects shorter strings)
- **State**: `by ArtistName` (truncated to 128 chars, padded to 2 chars minimum)
- **Artwork**: Apple Music CDN URLs work directly as `largeImageKey` if under 256 chars (typical range: 80-130 chars). Fall back to a Discord-hosted `sidra_logo` asset if over the limit.
- **Timestamps**: When playing, calculate `startTimestamp` and `endTimestamp` from current position at send time. Omit when paused.
- **Buttons**: Two buttons - "Sidra" (links to GitHub repo) and "Play on Apple Music" (links to track URL when available).
- **Debounce**: 1s debounce on updates to coalesce rapid events (track change + playback state landing together). `scheduleUpdate()` resets the debounce timer; `sendActivity()` calculates timestamps fresh from the cached position.
- **Pause timeout**: Clear activity after 30s paused (ytmdesktop pattern) - courtesy to users who do not want to broadcast a paused state.
- **Retry**: Reconnect with exponential backoff (2s base, 60s cap) on Discord IPC disconnection.
- **Toggle**: `discord.enabled` in `electron-store` (default: false). Tray menu toggle; when disabled, clears activity immediately.

### `playbackTimeDidChange` pitfall

`playbackTimeDidChange` fires every ~250ms (MusicKit polling). Integrations must NOT call `scheduleUpdate()` (or any debounced function) from this event - doing so resets the debounce timer on every tick, preventing the debounced callback from ever executing. The Discord integration stores the updated position only; timestamps are calculated from the cached position when `sendActivity()` fires.

### Event subscriptions

| Event | Action |
|---|---|
| `nowPlayingItemDidChange` | Cache metadata, cancel pause timer, `scheduleUpdate()` |
| `playbackStateDidChange` | Update `isPlaying`, manage pause timer, `scheduleUpdate()` |
| `playbackTimeDidChange` | Store position only (no `scheduleUpdate()`) |

---

## Track Change Notifications

Electron's built-in `Notification` API, works on all three platforms. Notification source shows as "Sidra" (app name) automatically.

**Do not gate on `Notification.isSupported()`** - in CastLabs Electron this returns `false` even when the platform fully supports notifications. Rely on the `failed` event to surface OS-level rejection instead.

On Windows, `app.setAppUserModelId()` must be called before `app.whenReady()` or notifications will not appear (see [Windows: Chromium's GSMTC Bridge](#windows-chromiums-gsmtc-bridge)).

The implementation lives in `src/integrations/notifications/index.ts`:

- **Artwork**: Uses `downloadArtwork()` from `src/artwork.ts`, which fetches via `net.fetch`, writes to a UUID-based cache with atomic writes, and expires files after 7 days
- **Debounce**: 1500ms debounce on `nowPlayingItemDidChange` to coalesce rapid events
- **Artwork race timeout**: 500ms - if artwork download takes longer, the notification fires without an icon
- **Body format**: `artistName - albumName` (fields joined with ` - ` via `filter(Boolean).join(' - ')`)
- **Handlers**: Registers `show`, `failed`, and `click` event handlers; `click` focuses the main window
- **Silent**: `silent: true` suppresses notification sounds

On NixOS (dev shell), `libnotify` must be present in `LD_LIBRARY_PATH` or `notification.show()` will silently do nothing. This is a dev shell concern, not an app code concern - ensure `libnotify` is in the Nix dev shell's `LD_LIBRARY_PATH`.

Notifications are toggleable via an `electron-store` boolean setting (default: on).

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

When nothing is playing the menu shows a stub placeholder. The menu reverts to the stub after 30 seconds of pause.

### Dock progress bar

`win.setProgressBar()` is updated on every `playbackTimeDidChange` event via `src/utils/progressBar.ts`. The bar is cleared on stop, idle states (None, Stopped, Ended, Completed), and pause timeout.

---

## Windows Taskbar

`src/integrations/windows-taskbar/index.ts` provides three Windows taskbar integrations. It is a no-op on non-win32 platforms.

### Thumbnail toolbar

`win.setThumbarButtons()` adds previous, play/pause, and next buttons to the thumbnail preview that appears when hovering the taskbar button. Icons are 18px PNGs loaded from `assets/icons/tray/menu/{dark,light}/` via `nativeImage.createFromPath()`. The icon set reloads on `nativeTheme.updated` to track system theme changes.

Registration is deferred until `win.once('show', ...)`. Windows silently drops `setThumbarButtons()` calls made before the window is visible; deferring avoids this failure mode.

### Overlay icon

`win.setOverlayIcon()` places a small badge on the taskbar button:

| State | Badge |
|-------|-------|
| Playing | play icon |
| Paused | pause icon |
| Stopped / None / Ended / Completed | cleared |
| Loading, Seeking, Waiting, Stalled (transient) | unchanged (previous value kept to prevent flicker) |

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

`showAboutWindow()` is exported from `src/tray.ts` and imported by `src/main.ts` for use in the app menu. Both the About window and the splash window set `fullscreenable: false` and `fullscreen: false` to prevent them entering full-screen mode.

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
| Storefront preference persistence | `electron-store` + `did-navigate` listener | Survives restarts; language parameter preserved |
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
| Content readiness polling | `amp-lcd[hydrated]` selector | Waits for Apple Music UI to hydrate before removing splash |
| About window | Frameless `BrowserWindow` + `assets/about.html` | Localised labels via `about.json` |
| Navigation bar | `assets/navigationBar.js` injected post-load | Back/forward/reload buttons in sidebar |
| Zoom factor preference | `zoom` in `electron-store` | 1.0x to 2.0x via tray submenu |
| Wedge detector | `src/wedgeDetector.ts` | Auto-skip on playback stall |
| Artwork cache | `src/artwork.ts` | UUID-based filenames, 7-day expiry, atomic writes |
| Pause timer utility | `src/pauseTimer.ts` | `createPauseTimer()` shared by tray, dock, Discord |
| Update checking (non-auto-update) | `src/update.ts` | GitHub API check for deb/rpm/Nix/DMG platforms |
| Service worker cache clearing | `session.defaultSession.clearStorageData` | Clears on startup to prevent stale assets |

#### Tray Menu Implementation Notes

- Use `type: 'radio'` within submenus for all toggle items (e.g. notifications on/off, theme selection, start page). On all platforms this renders a native radio indicator for the active selection.

### v0.3 - Nice to Have

| Feature | Notes |
|---|---|
| Last.fm scrobbling | ~100 lines, proven pattern from Cider/apple-music-wrapper |
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
| CastLabs Electron lags Electron releases | Low | Medium | Only affects security patching cadence; v40.7.0+wvcus, tracking close to mainline |
| Live radio stations crash | Medium | Confirmed | Known issue in apple-music-wrapper; investigate `did-crash` handler |
| CSP blocks script injection | Low | Very low | `executeJavaScript()` bypasses page CSP in Electron |
| Apple legal action | Medium | Very low | Multiple similar apps exist and have for years; requires Apple Music subscription |

