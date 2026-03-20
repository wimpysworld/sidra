# Sidra 🍎

An elegant Apple Music desktop client. No frippery, just quality. A better class of Cider 🍎

An elegant Apple Music desktop app for Linux, macOS and Windows. Sidra wraps `music.apple.com` in a [CastLabs Electron](https://github.com/castlabs/electron-releases) shell and bridges MusicKit.js events to native platform media controls. Apple maintains the UI, lossless audio just works, and authentication is a non-issue - it is identical to signing in at music.apple.com in Chrome.

**Linux**: full MPRIS (`org.mpris.MediaPlayer2.sidra`) via D-Bus, Wayland native.
**macOS**: Now Playing widget via Chromium's built-in mediaSession bridge.
**Windows**: GSMTC media flyout via Chromium's built-in mediaSession bridge.

---

## Requirements

- An Apple Music subscription (all platforms)
- Linux, macOS or Windows

---

## Features

- Apple Music desktop client with Widevine DRM
- Persistent login
- Linux:
  - Wayland and X11 support
  - Bi-directional MPRIS support (*planned*)
- macOS:
  - Now Playing (Control Centre, Lock Screen, media keys) (*planned*)
- Windows
  - GSMTC (media flyout, taskbar controls, media keys) (*planned*)
- Discord Rich Presence (*planned*)
- Desktop Notifications (*planned*)
- System tray (*planned*)
  - Media controls
  - Settings
- Last.fm scrobbling (*planned*)
- AirPlay casting (*planned*)

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

[Cider](https://github.com/ciderapp/Cider) builds a full custom UI on top of MusicKit.js - thousands of components, custom authentication, a plugin marketplace, and its own audio engine. That scope creates real problems.

**Audio quality.** Cider hardcodes a 96kHz `AudioContext` ([`audio.js` lines 54-57](https://github.com/ciderapp/Cider/blob/953bb5a9e26080bba2bb20438f0ddf38b0a8b260/src/renderer/audio/audio.js#L54-L57), comment: *"Don't ever remove the sample rate arg. Ask Maikiwi."*). Apple Music delivers AAC at 44.1/48kHz. Every sample is resampled up to 96kHz, then back down to the hardware rate - twice, unnecessarily. All audio then routes through a DSP chain of up to seven processing stages (EQ, convolvers, bass enhancement, spatial effects) regardless of whether Audio Lab features are enabled. The "Cider Adrenaline Processor" is marketed as making lossy audio "sound lossless"; it is biquad EQ shaping and cannot reconstruct discarded information. The [top answer on this Reddit thread](https://www.reddit.com/r/AppleMusic/comments/w6asti/poor_sound_quality_on_cider/) is "turn off Audio Lab." Sidra never creates an `AudioContext`; audio flows untouched from Apple's CDN through Chromium's media stack to the OS.

**Reliability.** Authentication perpetually reports failure even after succeeding, forcing repeated re-authentication. Tracks stop unexpectedly. Volume resets mid-session. MPRIS volume on Linux has never worked reliably - Cider's non-linear audio engine means the system volume curve feels broken, and changes via MPRIS are not reflected in the app. [Volume normalisation causes freezes](https://github.com/ciderapp/Cider-2/issues/1172). Playback state in Cider regularly diverges from what Apple Music knows about.

**Complexity.** The settings UI accumulates features without coherent design. Frippery over reliability.

Sidra has no UI to maintain, no audio engine to go wrong. Apple ships updates silently.

---

## Why Sidra?

The immediate reason was Linux. Every existing Apple Music client for Linux either lacks MPRIS entirely, implements it badly, or wrecks the audio in the process. Media keys should work. Desktop notifications should fire. Volume should track. None of that is exotic, and none of it should require a custom audio engine to achieve.

The second reason is corporate macOS. Devices enrolled in MDM can block authentication with personal Apple IDs, which means the native Apple Music app simply refuses to let you sign in. Sidra authenticates at the application layer - it is a browser session, nothing more - so MDM policy never sees it. If you can reach music.apple.com in Chrome, you can use Sidra.

The third reason is a friend who wanted a decent Apple Music client for Windows that was not Cider.

The fourth reason became apparent once it was working: stripping away the abstraction layers improved the sound. Less processing, less resampling, less interference between Apple's CDN and your ears. The tagline is not ironic.

Sidra is the Spanish word for cider, specifically the traditional dry cider from Asturias in northern Spain. The name came from a trip to the region for UbuCon Europe 2018, where the local sidra made a lasting impression. It seemed a fitting name for a leaner, more honest alternative to the other one.

---

## Development

### Prerequisites

- [Nix](https://nixos.org/) with flakes enabled
- [direnv](https://direnv.net/) (optional, but recommended)

The project uses npm and TypeScript. The shell is [CastLabs Electron](https://github.com/castlabs/electron-releases) (`wvcus` variant) rather than standard Electron - this is non-negotiable for Widevine DRM support on Linux.

### Quick start

```bash
direnv allow          # or: nix develop
just install          # install npm dependencies
just run              # build and launch
```

Sign in with your Apple Music account on first launch. Your session persists across relaunches.

### Available recipes

| Recipe | Description |
|--------|-------------|
| `just install` | Install npm dependencies |
| `just build` | Compile TypeScript to `dist/` |
| `just run` | Build and launch the app |
| `just run-fast` | Launch without rebuilding (pair with `just watch`) |
| `just watch` | Rebuild on file changes |
| `just lint` | Run actionlint and TypeScript type-check |
| `just clean` | Remove `dist/` build artefacts |
| `just logs` | Show log file location and tail recent entries |

### Debug and diagnostics

| Recipe | Description |
|--------|-------------|
| `just run-debug` | Launch with `ELECTRON_LOG_LEVEL=debug` (verbose file logging) |
| `just run-devtools` | Launch with DevTools open for inspecting CSS and DOM |
| `just run-inspect` | Launch with both debug logging and DevTools |
| `just logs` | Tail `~/.config/sidra/logs/main.log` |

### Typical dev loop

1. `just watch` in one terminal to auto-rebuild on changes
2. `just run-fast` in another to launch without rebuilding
3. `just run-devtools` to inspect CSS injection or DOM state
4. `just logs` to review structured log output

See [`docs/SPECIFICATION.md`](docs/SPECIFICATION.md) for full technical detail: architecture, IPC event flow, MPRIS property checklist, platform media control implementation, and the complete feature inventory.
