<h1 align="center">
  <img src="build/icon.png" width="256" height="256" alt="Sidra">
  <br />
  Sidra
</h1>

<p align="center"><b>An elegant Apple Music desktop client for Linux, macOS and Windows. No frippery, just quality. A better class of Cider 🍎</b></p>

<p align="center">Made with 💝 for 🐧🍏🪟</p>

Most Apple Music desktop clients break the audio, mangle the playback controls, or bury you under a custom UI that Apple never signed off on - the problem is worst on Linux.
Sidra takes the opposite approach: wrap `music.apple.com` directly, stay out of the way, and let the audio through untouched.
Runs on Linux, macOS, and Windows. Apple owns the interface and keeps it current - Sidra inherits every improvement automatically.

---

## Features

Sidra is under active development; several features in this list are not yet implemented.

- Apple Music desktop client
- Lossless audio on macOS and Windows via CastLabs EVS production VMP signing
- Persistent login with localised Apple Music storefront
- Localised interface in 31 languages
- **Linux**:
  - Standard Widevine DRM via CastLabs Electron
  - Wayland and X11 support
  - Full bi-directional MPRIS (`org.mpris.MediaPlayer2.sidra`) via D-Bus
- **macOS**:
  - Full Widevine DRM with EVS production VMP signing
  - Now Playing widget via Chromium's built-in mediaSession bridge
- **Windows**:
  - Full Widevine DRM with EVS production VMP signing
  - GSMTC media flyout via Chromium's built-in mediaSession bridge
- Desktop Notifications
- Discord Rich Presence
- Application Indicator (tray)
- Auto-update via GitHub Releases:
  - AppImage (Linux) and NSIS (Windows): silent OTA download with restart prompt; disable with `SIDRA_DISABLE_AUTO_UPDATE=1`
  - deb, rpm, Nix, macOS DMG: update notification with link to release page
- AirPlay casting

---

> [!IMPORTANT]
> Sidra's macOS and Windows releases are currently unsigned, requiring Gatekeeper and SmartScreen workarounds at install time. [Sponsoring the project](https://github.com/sponsors/flexiondotorg) 🩷 goes directly towards code-signing certificates to remove that friction for every user.

## Install

Download the latest release from [GitHub Releases](https://github.com/wimpysworld/sidra/releases).

### Linux

**AppImage** - portable, no installation required:

```bash
chmod +x Sidra-*.AppImage
./Sidra-*.AppImage
```

**Debian/Ubuntu** (`.deb`):

```bash
sudo apt install ./Sidra-*.deb
```

**Fedora** (`.rpm`):

```bash
sudo dnf install ./Sidra-*.rpm
```

**openSUSE** (`.rpm`):

```bash
sudo zypper install ./Sidra-*.rpm
```

**Nix**:

```bash
nix profile install github:wimpysworld/sidra
```

To use Sidra as a NixOS or Home Manager module, add `github:wimpysworld/sidra` as a flake input and reference `inputs.sidra.packages.<system>.default`.

### macOS

**DMG** - open the `.dmg` and drag Sidra to Applications.

Gatekeeper will block the first launch because the app is unsigned. Two ways to proceed:

1. Remove the quarantine attribute:

```bash
xattr -d com.apple.quarantine /Applications/Sidra.app
```

2. Open System Settings → Privacy & Security and click **Open Anyway** after the first blocked launch attempt.

**Nix**:

```bash
nix profile install github:wimpysworld/sidra
```

### Windows

**Installer** (`.exe`) - run the NSIS installer and follow the prompts.

SmartScreen will show "Windows protected your PC" because the installer is unsigned. Click **More info** then **Run anyway**.

---

## How It Works

Sidra loads `music.apple.com` directly inside CastLabs Electron (required for Widevine DRM on Linux - no other shell supports this).
A lightweight hook script is injected after page load that taps `MusicKit.getInstance()` events and forwards them over Electron IPC to the main process, which distributes them to platform integrations.

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

The codebase is tightly focused and as lean as possible.

---

## Why Sidra?

I used Cider for years, but as time passed and the weight of features grew the core experience degraded.

The audio was the first thing I noticed. Cider hardcodes a 96kHz `AudioContext`, so every track - delivered by Apple at 44.1 or 48kHz - is resampled up to 96kHz, then back down to whatever the hardware expects. Twice, unnecessarily. On top of that, all audio routes through a multi-stage DSP chain regardless of whether you have touched any Audio Lab settings. The "Cider Adrenaline Processor" markets itself as making lossy audio sound lossless; it is biquad EQ shaping and cannot recover discarded information.
The most common advice in community threads was simply to turn Audio Lab off.

Reliability followed the same pattern.
Authentication reported failure even after succeeding.
Tracks stopped for no reason. Volume reset mid-session.
On Linux, MPRIS volume never worked properly - Cider's audio engine sits between the system volume curve and the actual output, so changes via media controls were inconsistent or ignored entirely.
Playback state drifted from what Apple Music knew about.
These were not new bugs; they persisted across versions because the architecture that caused them was load-bearing.

None of this was Cider's fault in any personal sense.
It is an ambitious project and the ambition is the problem: a custom UI, custom auth, a plugin marketplace, and a custom audio engine all create surface area where things go wrong.
The settings UI kept accumulating features without ever resolving the underlying instability.

I got to the point where I wanted something that just worked.
That meant going back to the source.

**The immediate reason was Linux.**
Every existing Apple Music client for Linux either lacks MPRIS entirely, implements it badly, or wrecks the audio in the process.
Media keys should work.
Desktop notifications should fire.
Volume should track.
None of that is exotic, and none of it should require a custom audio engine to achieve.

**The second reason is corporate macOS.**
Devices enrolled in MDM can block authentication with personal Apple IDs, which means the native Apple Music app simply refuses to let you sign in.
Sidra authenticates at the application layer - little more than a glorified browser session - so MDM policy never sees it.
If you can reach music.apple.com in Chrome, you can use Sidra.

The third reason is a friend who wanted a decent Apple Music client for Windows that was not Cider.

The fourth reason became apparent once it was working: wrapping `music.apple.com` directly means none of those failure modes exist.
Apple's audio pipeline, Apple's auth, Apple's UI.
Sidra never creates an `AudioContext` - audio flows untouched from Apple Music through Chromium's media stack to the OS.
Authentication is Apple's web flow; it cannot get out of sync with Apple's servers.
The interface updates automatically whenever Apple ships a change.
Stripping away the abstraction layers improved the sound.
Less processing, less resampling, less interference between the music library and your ears.

Sidra is the Spanish word for the traditional dry cider of Asturias in northern Spain - poured from height, unfiltered, drunk before it goes flat.
The name came from a trip to the region for UbuCon Europe 2018.
No additives, no artifice, nothing between the apple and the glass.
That felt right.

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
