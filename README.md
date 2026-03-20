# Sidra 🍎

Apple Music with less Cider, no music interupptions, lean code, and no hangover.

> 🚧 **Work in progress** - no code yet. This README describes what Sidra will be. 🚧

Apple Music as a desktop app. Sidra wraps `music.apple.com` in a [CastLabs Electron](https://github.com/castlabs/electron-releases) shell and bridges MusicKit.js events to native platform media controls. Apple maintains the UI, lossless audio just works, and authentication is a non-issue - it is identical to signing in at music.apple.com in Chrome.

**Linux**: full MPRIS (`org.mpris.MediaPlayer2.sidra`) via D-Bus, Wayland native.
**macOS**: Now Playing widget via Chromium's built-in mediaSession bridge.
**Windows**: GSMTC media flyout via Chromium's built-in mediaSession bridge.

---

## Requirements

- An Apple Music subscription (all platforms)
- Linux (supported from v0.1), macOS or Windows (supported from v0.2)

---

## Features

### v0.1 - Linux

- Apple Music with Widevine DRM (lossless, Dolby Atmos - everything the web player supports)
- Full MPRIS support: play, pause, next, previous, seek, stop, volume (bidirectional), repeat, shuffle
- Complete MPRIS metadata: title, artist, album, artwork, duration, track ID
- Discord Rich Presence with debounce and 30s pause timeout
- Track change desktop notifications with album art
- Wayland and X11 support
- Window state persistence (bounds, maximised)
- Persistent login - sign in once, stay signed in

### v0.2 - macOS + Windows

- macOS Now Playing (Control Centre, Lock Screen, media keys)
- Windows GSMTC (media flyout, taskbar controls, media keys)
- System tray with prev/play-pause/next controls

### Planned (v0.3)

- Last.fm scrobbling
- AirPlay casting

### Not planned

- Custom UI or theming
- Audio effects or EQ
- Plugin/extension system

---

## How It Works

Sidra loads `music.apple.com` directly inside CastLabs Electron (required for Widevine DRM on Linux - no other shell supports this). A lightweight hook script is injected after page load that taps `MusicKit.getInstance()` events and forwards them over Electron IPC to the main process, which distributes them to platform integrations.

```
music.apple.com
  └── MusicKit.js events
        └── musicKitHook.js (injected)
              └── IPC → player.ts (EventEmitter)
                    ├── MPRIS (Linux, dbus-next, D-Bus session bus)
                    ├── Discord Rich Presence
                    ├── Desktop notifications
                    └── navigator.mediaSession (macOS/Windows)
```

Controls flow in reverse: MPRIS method calls reach `window.__sidra` via `webContents.executeJavaScript()`, which calls the appropriate MusicKit method directly.

Four runtime dependencies. The codebase is tightly focused and as lean as possible.

---

## Why Not Cider?

[Cider](https://github.com/ciderapp/Cider) builds a full custom UI on top of MusicKit.js. This means maintaining thousands of UI components, custom DRM workarounds for lossless, authentication flows, and a plugin marketplace. Cider v3 needed a custom audio engine to get lossless working. When loading `music.apple.com` directly, lossless works out of the box because Apple's own audio pipeline handles it.

Sidra has no UI to maintain. Apple ships updates silently.

---

## Why Sidra?

Sidra is the Spanish word for cider, specifically the traditional dry cider from Asturias in northern Spain. The name came from a trip to the region for UbuCon Europe 2018, where the local sidra made a lasting impression. It seemed a fitting name for a leaner, more honest alternative to the other one.

---

## Development

> Build instructions will be added once the initial implementation is in place.

The project uses a Nix flake with direnv for a reproducible dev environment. Run `direnv allow` in the project root to activate it. `just` is the task runner - see [`justfile`](justfile) for available tasks.

The project uses npm and TypeScript. The shell is [CastLabs Electron](https://github.com/castlabs/electron-releases) (`wvcus` variant) rather than standard Electron - this is non-negotiable for Widevine DRM support on Linux.

See [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) for full technical detail: architecture, IPC event flow, MPRIS property checklist, platform media control implementation, and the complete feature inventory.

---

## Licence

[Blue Oak Model License 1.0.0](LICENSE)

