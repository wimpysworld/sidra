# Sidra - Specification

A minimal Apple Music desktop client. CastLabs Electron wraps `music.apple.com` directly, injecting a lightweight hook script to bridge MusicKit.js events to native platform media controls. Apple maintains the UI; Sidra maintains the bridge.

The codebase is tightly focused and as lean as possible. Four runtime dependencies.

---

## Table of Contents

- [Design Rationale](#design-rationale)
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
- [Auto-update](#auto-update)
- [Feature Inventory](#feature-inventory)
- [Risk Assessment](#risk-assessment)
- [Prior Art](#prior-art)
- [Sources](#sources)

---

## Design Rationale

Cider builds a custom UI on top of MusicKit.js and maintains thousands of components, custom DRM workarounds, authentication flows, a plugin marketplace, and a theme engine. Sidra does none of this.

| Concern | Cider | Sidra |
|---|---|---|
| UI maintenance | Full custom Vue.js UI | Apple maintains it |
| Feature completeness | Lossless requires custom audio engine | Works out of the box |
| Stability | Complex custom stack with many moving parts | Minimal surface area |
| Apple API changes | Broken the app entirely (Dec 2022) | Web app just updates silently |
| Cross-platform effort | Different backends per platform | Same shell everywhere |
| Code volume | ~5000+ commits | Tightly focused, as lean as possible |

Cider's MPRIS is broken because it is a fragile IPC relay built on top of a custom UI layer built on top of MusicKit.js. Every layer adds failure modes. Sidra bypasses all of that - Apple's own web app handles playback state, and we observe it.

MusicKit.js cannot decrypt lossless audio or manage crossfade. Cider v3 built a custom audio engine to work around this. When wrapping `music.apple.com` directly, this is not a limitation - the web player uses Apple's own audio pipeline and lossless works exactly as it does in Chrome.

### Why Not Wails?

Wails (Go + WebView) is the preferred stack for other projects, but platform WebViews lack the DRM support Sidra requires:

| Platform | Wails WebView | DRM Support |
|---|---|---|
| Linux | WebKitGTK | No Widevine |
| macOS | WKWebView | Restricted (FairPlay, Apple apps only) |
| Windows | WebView2 | PlayReady only, not Widevine |

Standard Electron also won't work. CastLabs Electron is non-negotiable for Linux DRM support.

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
| macOS controls | Chromium `mediaSession` → MPNowPlayingInfoCenter | Built-in bridge, identity via bundle name |
| Config | `electron-store` | Persistent config (window bounds, settings) |
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
│  │  │ └─ MediaSession│  │      │  ┌──────────────┐  │  │
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
│   ├── player.ts                  — EventEmitter: nowPlaying, playbackState, volume, etc.
│   └── integrations/
│       ├── integration.ts         — IIntegration interface (enable/disable)
│       ├── mpris/
│       │   └── index.ts           — D-Bus MPRIS service (Linux only)
│       ├── discord-presence/
│       │   └── index.ts           — Discord RPC with retry/debounce
│       ├── notifications/
│       │   └── index.ts           — Track change desktop notifications
│       └── media-session/
│           └── index.ts           — navigator.mediaSession updates (macOS/Win)
├── assets/
│   ├── musicKitHook.js            — Injected into music.apple.com post-load
│   │                                 Must be listed in electron-builder's `asarUnpack` —
│   │                                 it is read with readFileSync at runtime and will crash
│   │                                 AppImage builds if packed inside the asar archive
│   ├── styleFix.css               — CSS overrides injected via webContents.insertCSS()
│   │                                 Hides "Get the app" and "Open in Music" banners
│   │                                 that Apple shows to push users toward native apps
│   ├── catppuccin.css             — Optional Catppuccin palette overrides; injected when
│   │                                 the theme preference is set to catppuccin
│   └── icons/
│       ├── icon.png, icon.icns, icon.ico
│       └── tray.png, tray@2x.png
├── package.json
└── tsconfig.json
```

---

## Dependencies

```json
{
  "devDependencies": {
    "electron": "github:castlabs/electron-releases#v40.1.0+wvcus",
    "electron-builder": "^25.x",
    "typescript": "^5.x"
  },
  "dependencies": {
    "dbus-next": "^0.10.x",
    "@xhayper/discord-rpc": "^1.x",
    "electron-store": "^9.x",
    "electron-log": "^5.x"
  }
}
```

Four runtime dependencies. Compare to Cider v1's 25+.

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
| `playbackStateDidChange` | `{ status: bool, state }` | MPRIS, Discord, Notifications |
| `nowPlayingItemDidChange` | `{ name, albumName, artistName, durationInMillis, artworkUrl, genreNames, trackId }` or `null` | MPRIS, Discord, Notifications |
| `playbackTimeDidChange` | Position in microseconds | MPRIS, Discord (position only) |
| `repeatModeDidChange` | Mode integer (0/1/2) | MPRIS |
| `shuffleModeDidChange` | Mode integer | MPRIS |
| `volumeDidChange` | Volume float (0.0-1.0) | MPRIS |

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

### Main → Renderer (via `webContents.executeJavaScript`)

Integrations call back into the renderer through the `window.__sidra` control object:

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
(function () {
  const waitForMK = setInterval(() => {
    if (!window.MusicKit) return;
    clearInterval(waitForMK);

    const mk = MusicKit.getInstance();

    mk.addEventListener('playbackStateDidChange', ({ state }) => {
      window.AMWrapper.ipcRenderer.send('playbackStateDidChange', {
        status: state === MusicKit.PlaybackStates.playing,
        state,
      });
    });

    mk.addEventListener('nowPlayingItemDidChange', ({ item }) => {
      if (!item) {
        window.AMWrapper.ipcRenderer.send('nowPlayingItemDidChange', null);
        return;
      }
      window.AMWrapper.ipcRenderer.send('nowPlayingItemDidChange', {
        name: item.attributes.name,
        albumName: item.attributes.albumName,
        artistName: item.attributes.artistName,
        durationInMillis: item.attributes.durationInMillis,
        artworkUrl: item.attributes.artwork?.url
          ?.replace('{w}', '512').replace('{h}', '512'),
        genreNames: item.attributes.genreNames,
        trackId: item.id,
      });
    });

    mk.addEventListener('playbackTimeDidChange', () => {
      window.AMWrapper.ipcRenderer.send('playbackTimeDidChange',
        mk.currentPlaybackTime * 1_000_000  // microseconds for MPRIS
      );
    });

    mk.addEventListener('repeatModeDidChange', () => {
      window.AMWrapper.ipcRenderer.send('repeatModeDidChange', mk.repeatMode);
    });

    mk.addEventListener('shuffleModeDidChange', () => {
      window.AMWrapper.ipcRenderer.send('shuffleModeDidChange', mk.shuffleMode);
    });

    mk.addEventListener('volumeDidChange', () => {
      window.AMWrapper.ipcRenderer.send('volumeDidChange', mk.volume);
    });

    window.__sidra = {
      play:       () => mk.play(),
      pause:      () => mk.pause(),
      playPause:  () => mk.isPlaying ? mk.pause() : mk.play(),
      next:       () => mk.skipToNextItem(),
      previous:   () => mk.skipToPreviousItem(),
      seek:       (secs) => mk.seekToTime(secs),
      setVolume:  (v) => { mk.volume = v; },
      setRepeat:  (m) => { mk.repeatMode = m; },
      setShuffle: (m) => { mk.shuffleMode = m; },
    };

    console.log('[Sidra] MusicKit hooked successfully');
  }, 500);
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
  app.commandLine.appendSwitch('disable-features', 'MediaSessionService');
  app.commandLine.appendSwitch('enable-features', 'UseOzonePlatform,WaylandWindowDecorations');
}
```

**PulseAudio stream identity**: Chromium hard-codes `application.name = "Chromium"` and `application.icon_name = "chromium-browser"` on PulseAudio/PipeWire streams via explicit API calls; `PULSE_PROP_*` environment variables are ineffective. Sidra fixes this by disabling `AudioServiceOutOfProcess` (moves audio in-process so `SetGlobalAppName` reaches PulseAudio) and calling `app.setDesktopName('sidra.desktop')` (sets `CHROME_DESKTOP` for `GetXdgAppId()`). See [electron/electron#27581](https://github.com/electron/electron/issues/27581) and `docs/PULSE.md` for full details.

### macOS: Chromium's Built-in mediaSession Bridge

Chromium maps `navigator.mediaSession` to `MPNowPlayingInfoCenter` automatically. The **app bundle name** determines what appears in the Now Playing widget (Control Centre, Lock Screen) - set via `productName: "Sidra"` in electron-builder config.

```typescript
app.setName('Sidra'); // Belt and braces; actual identity comes from the bundle
```

`music.apple.com` already calls `navigator.mediaSession` internally, but its updates can lag. The hook script should also update `navigator.mediaSession` explicitly to ensure macOS sees correct metadata promptly.

### Windows: Chromium's GSMTC Bridge

Chromium maps `navigator.mediaSession` to Global System Media Transport Controls. Identity is set by:

```typescript
// main.ts - must run before app.whenReady()
if (process.platform === 'win32') {
  app.setAppUserModelId('sh.cider.sidra');
}
app.setName('Sidra');
```

The GSMTC overlay (media flyout on Windows 11) will show "Sidra" as the controlling app. `app.setAppUserModelId()` is also required for desktop notifications to appear on Windows - without it, `Notification.show()` is silently ignored.

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
| `Stop()` | `mk.stop()` |
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

### Main process (MPRIS integration)

```typescript
let pendingVolume: number | null = null;
let volumeSuppressionTimer: ReturnType<typeof setTimeout> | null = null;
const VOLUME_SUPPRESSION_MS = 500; // 2× the 250ms musicKitHook poll interval

// MPRIS → UI
player.on('volume', (volume: number) => {
  const v = Math.min(1, Math.max(0, volume));
  pendingVolume = v;
  if (volumeSuppressionTimer) clearTimeout(volumeSuppressionTimer);
  volumeSuppressionTimer = setTimeout(() => { pendingVolume = null; }, VOLUME_SUPPRESSION_MS);
  win.webContents.executeJavaScript(`window.__sidra.setVolume(${v})`);
});

// UI → MPRIS
player.on('volumeDidChange', (volume: number) => {
  if (pendingVolume !== null && Math.abs(volume - pendingVolume) < 0.01) {
    pendingVolume = null; // echo suppressed
    return;
  }
  // update MPRIS Volume property and emit PropertiesChanged
});
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

```typescript
const win = new BrowserWindow({
  webPreferences: {
    partition: 'persist:sidra',
    preload: path.join(__dirname, 'preload.js'),
    nodeIntegration: false,
    contextIsolation: true,
  }
});
```

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

Theme preference is stored in `electron-store` as `theme` (`'default'` | `'catppuccin'`). Default is `'default'`. Restart required - the preference is applied on next launch.

### Implementation

`catppuccin.css` overrides CSS custom properties on `:root` and targets specific elements that fall outside the normal cascade. `webContents.insertCSS()` injects at author-level cascade origin, so all overrides use `!important` to win specificity ties against Apple's own stylesheets after navigation.

`@media (prefers-color-scheme: dark)` and `@media (prefers-color-scheme: light)` resolve correctly in Electron's Chromium renderer against `nativeTheme.shouldUseDarkColors`. A single CSS file with both blocks covers both variants.

#### `:root` variable overrides

Most Apple Music styling responds to `:root` custom property overrides. The CSS file sets colour tokens on `:root` within each `@media (prefers-color-scheme)` block.

#### Elements requiring direct selectors

Several elements render outside the normal `:root` cascade and require direct element selectors:

| Element | Selector | Notes |
|---------|----------|-------|
| Player bar background | `.wrapper amp-chrome-player::before` | `::before` pseudo-element paints the bar, ignores `:root` |
| Side panels (Lyrics + Up Next) | `.side-panel`, `.side-panel-header-wrapper` | Both panels share one container element |
| Page footer | `.scrollable-page > footer` | Paints its own `background-color` directly |
| LCD now-playing widget | `amp-lcd { --lcd-bg-color }` | Shadow DOM scoped variable; must be set on the host element, not `:root` |

When a `:root` variable override has no visible effect, the element is either (a) using a shadow-DOM-scoped custom property - set the variable on the host element directly, or (b) painting its own `background-color` via a `::before` pseudo or direct property - use a direct element selector with `!important`.

#### CSS variable audit

A live DevTools audit (`just run-devtools`) is the primary tool for discovering variable names. Active Apple Music userstyle repositories provide reliable cross-referenced variable lists: PitchBlack (`sprince0031/PitchBlack-UserStyle-themes`), Native AM (`dantelin2009`), AppleMusic-Tui.

#### Asset packaging

`asarUnpack` in `package.json` lists files individually (not via glob). Any new CSS asset files read via `fs.readFileSync` at runtime must be added explicitly to `asarUnpack` or they will be inaccessible in packaged builds.

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
- **Toggle**: `discord.enabled` in `electron-store` (default: true). Tray menu toggle; when disabled, clears activity immediately.

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

```typescript
import { Notification, app } from 'electron';
import https from 'https';
import fs from 'fs';
import path from 'path';

let lastArtworkUrl = '';
let cachedArtworkPath = '';

async function getArtworkPath(url: string): Promise<string> {
  if (url === lastArtworkUrl && cachedArtworkPath) return cachedArtworkPath;
  const cacheDir = path.join(app.getPath('cache'), 'artwork');
  fs.mkdirSync(cacheDir, { recursive: true });
  const dest = path.join(cacheDir, 'sidra-artwork.jpg');
  await new Promise<void>((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    https.get(url, res => res.pipe(file).on('finish', resolve)).on('error', reject);
  });
  lastArtworkUrl = url;
  cachedArtworkPath = dest;
  return dest;
}

async function showTrackNotification(metadata: TrackMetadata, enabled: boolean) {
  if (!enabled) return;
  const iconPath = await getArtworkPath(metadata.artworkUrl);
  const n = new Notification({
    title: metadata.name,
    body: `${metadata.artistName} — ${metadata.albumName}`,
    icon: iconPath,
    silent: true,
  });
  n.on('show', () => log.debug('Notification shown'));
  n.on('failed', (_event, error) => log.warn('Notification failed', error));
  n.show();
}
```

`app.getPath('cache')` maps to `~/.cache/<appName>/` on Linux (respects `$XDG_CACHE_HOME`), `~/Library/Caches/<appName>/` on macOS, and `%LOCALAPPDATA%/<appName>/Cache/` on Windows. The directory is not guaranteed to exist; `fs.mkdirSync(..., { recursive: true })` is required before writing.

On NixOS (dev shell), `libnotify` must be present in `LD_LIBRARY_PATH` or `notification.show()` will silently do nothing. This is a dev shell concern, not an app code concern - ensure `libnotify` is in the Nix dev shell's `LD_LIBRARY_PATH`.

Notifications are toggleable via an `electron-store` boolean setting (default: on).

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
| Window state persistence | `electron-store` | Bounds, maximised state |
| Wayland support | `--enable-features=UseOzonePlatform` | Auto-detected via platform check |
| App identity | `app.setName('Sidra')` | Consistent across all platform controls |

### v0.2 - macOS + Windows Builds

| Feature | Implementation | Notes |
|---|---|---|
| macOS Now Playing | Chromium mediaSession → MPNowPlayingInfoCenter | Bundle name "Sidra" from productName |
| Windows GSMTC | Chromium mediaSession → GSMTC | `app.setAppUserModelId('sh.cider.sidra')` |
| Explicit `navigator.mediaSession` updates | musicKitHook.js | Supplement Apple's own updates |
| System tray | Electron `Tray` | Prev/play-pause/next + show/hide |
| macOS `.app` build | electron-builder | DMG |
| Windows build | electron-builder | NSIS installer |

#### Tray Menu Implementation Notes

- Use `type: 'checkbox'` for toggle items (e.g. notifications on/off). On macOS and Windows this renders a native checkmark. Do not combine it with a `●`/`○` glyph prefix on those platforms - that creates double indication. Glyphs should be Linux-only.
- For any Unicode symbols used as glyphs in menu labels, prefer early Unicode blocks (Letterlike Symbols U+2100-214F, Miscellaneous Technical U+2300-23FF, etc.) over emoji codepoints (U+1F000+). Emoji have poor coverage in native menu rendering stacks (GDI/Uniscribe on Windows, inconsistent on macOS); early Unicode symbols are safer. Conditionalise any glyphs on `process.platform === 'linux'`.

### v0.3 - Nice to Have

| Feature | Notes |
|---|---|
| Last.fm scrobbling | ~100 lines, proven pattern from Cider/apple-music-wrapper |
| AirPlay casting | `airtunes2` node module (Cider v1 has this) |
| Catppuccin theme | CSS variable overrides injected at startup; mocha/latte red accent; stored in electron-store |

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
| CastLabs Electron lags Electron releases | Low | Medium | Only affects security patching cadence; v40.1.0+wvcus released Feb 2026, tracking close to mainline |
| Live radio stations crash | Medium | Confirmed | Known issue in apple-music-wrapper; investigate `did-crash` handler |
| CSP blocks script injection | Low | Very low | `executeJavaScript()` bypasses page CSP in Electron |
| Apple legal action | Medium | Very low | Multiple similar apps exist and have for years; requires Apple Music subscription |

---

## Prior Art

### apple-music-wrapper

**Repository**: https://github.com/Nightdavisao/apple-music-wrapper
**Licence**: MPL-2.0

Working implementation of exactly the Sidra approach. CastLabs Electron wrapping `music.apple.com` with injected MusicKit hooks. Features implemented and working: Linux MPRIS, Discord RPC, Last.fm, tray controls, Apple Music Classical switching. Known limitation: live radio stations cause crashes.

Key reference files:
- [main.ts](https://github.com/Nightdavisao/apple-music-wrapper/blob/main/src/main.ts) - `--disable-features=MediaSessionService` pattern, CastLabs Electron, Widevine wait
- [preload.ts](https://github.com/Nightdavisao/apple-music-wrapper/blob/main/src/preload.ts) - IPC bridge
- [package.json](https://github.com/Nightdavisao/apple-music-wrapper/blob/main/package.json) - CastLabs Electron + dbus-next deps

### Cider v1

**Repository**: https://github.com/ciderapp/Cider
**Licence**: AGPL-3.0 (archived Dec 2024)

Full custom UI on MusicKit.js. Plugin-based architecture with MPRIS, Discord, Last.fm, AirPlay, Chromecast integrations. Instructive as a reference for what to do and what to avoid.

Key reference files:
- [package.json](https://github.com/ciderapp/Cider/blob/main/package.json) - CastLabs Electron, mpris-service, all deps
- [MPRIS plugin](https://github.com/ciderapp/Cider/blob/main/src/main/plugins/mpris.ts) - one-directional volume sync flaw visible in source
- [main index.ts](https://github.com/ciderapp/Cider/blob/main/src/main/index.ts) - bootstrap pattern
- [thumbar plugin](https://github.com/ciderapp/Cider/blob/main/src/main/plugins/thumbar.ts) - Windows taskbar integration
- [mpris-service fork](https://github.com/ciderapp/mpris-service)

### ytmdesktop

**Repository**: https://github.com/ytmdesktop/ytmdesktop
**Stars**: 5.6k, actively maintained (v2.0.11 Feb 2026)

Uses Chromium's built-in mediaSession bridges for macOS/Windows with no explicit MPRIS or SMTC library. Has a hand-rolled minimal Discord IPC client (~200 lines) instead of an npm dependency. No MPRIS on Linux - relies on Chromium's bridge, which shows as "chromium".

Key reference files:
- [Discord presence](https://github.com/ytmdesktop/ytmdesktop/blob/development/src/main/integrations/discord-presence/index.ts) - debounce, pause timeout, artwork URL pattern
- [package.json](https://github.com/ytmdesktop/ytmdesktop/blob/development/package.json) - confirmed no explicit MPRIS/SMTC library

### Cider Version History

| Version | Period | Stack | Status |
|---|---|---|---|
| Apple-Music-Electron | Pre-2022 | Electron + plain JS | Deprecated |
| Cider v1 | 2022-2023 | Electron (CastLabs) + Vue.js 2 + TypeScript + Webpack | AGPL-3.0, archived Dec 2024 |
| Cider v2 | 2023-2025 | Electron (CastLabs, non-Windows) + .NET/WebView2 (Windows) + Vue.js + TypeScript | Proprietary |
| Cider v3 | July 2025-present | Same base + new audio engine + Taproom auth | Proprietary, current |

---

## Sources

1. **Cider v1 open source repo (AGPL-3.0)** - https://github.com/ciderapp/Cider
2. **Cider v2 issue tracker** - https://github.com/ciderapp/Cider-2
3. **Cider v1 package.json** - https://github.com/ciderapp/Cider/blob/main/package.json
4. **Cider v1 MPRIS plugin** - https://github.com/ciderapp/Cider/blob/main/src/main/plugins/mpris.ts
5. **Cider v1 main index.ts** - https://github.com/ciderapp/Cider/blob/main/src/main/index.ts
6. **Cider v1 thumbar plugin** - https://github.com/ciderapp/Cider/blob/main/src/main/plugins/thumbar.ts
7. **Cider mpris-service fork** - https://github.com/ciderapp/mpris-service
8. **Cider changelogs** - https://cider.sh/changelogs
9. **Cider 3.0.0 changelog** - https://cider.sh/changelogs/3.0.0
10. **CastLabs Electron for Content Security** - https://github.com/castlabs/electron-releases
11. **apple-music-wrapper** - https://github.com/Nightdavisao/apple-music-wrapper
12. **apple-music-wrapper package.json** - https://github.com/Nightdavisao/apple-music-wrapper/blob/main/package.json
13. **apple-music-wrapper preload.ts** - https://github.com/Nightdavisao/apple-music-wrapper/blob/main/src/preload.ts
14. **apple-music-wrapper main.ts** - https://github.com/Nightdavisao/apple-music-wrapper/blob/main/src/main.ts
15. **Nativefier Apple Music DRM issue** - https://github.com/nativefier/nativefier/issues/989
16. **Chromium MPRIS service name discussion** - https://groups.google.com/a/chromium.org/g/media-dev/c/v8JtLAvZiIQ
17. **Apple Music API break (9to5Mac)** - https://9to5mac.com/2022/12/08/apple-music-third-party-app-api-change/
18. **Cider on OMG! Ubuntu** - https://www.omgubuntu.co.uk/2022/07/cider-is-an-open-source-apple-music-client-for-linux-desktops
19. **ytmdesktop Discord presence** - https://github.com/ytmdesktop/ytmdesktop/blob/development/src/main/integrations/discord-presence/index.ts
20. **ytmdesktop package.json** - https://github.com/ytmdesktop/ytmdesktop/blob/development/package.json
