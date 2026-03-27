# Sidra vs Cider: Apple Music desktop client comparison

**Last updated:** 2026-03-27
**Confidence note:** Cider v1 (open-source, AGPL-3.0) analysis is based on source code inspection of `ciderapp/Cider` on GitHub. Cider 2+ (proprietary) analysis is based on public issue trackers, devlogs, changelogs, and community reports - no source code review was possible. Sidra analysis is based on full source code review.

---

## 1. Executive summary

**If you want audio fidelity and reliability:** Sidra. It passes audio through untouched, never creates an AudioContext, and inherits Apple's own playback pipeline. No double-resampling, no DSP artefacts, no AudioContext suspension stalls.

**If you want a custom UI with equaliser, visualisations, and themes:** Cider. It offers a full-featured replacement interface with audio processing tools, Last.fm scrobbling, immersive mode, and extensive theming.

**If you care about security and auditability:** Sidra. Cider v1's source code shows `contextIsolation: false`, `nodeIntegration: true`, `webSecurity: false`, and an embedded Express server. Cider 2+ is proprietary and cannot be audited. Sidra follows Electron security best practices with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and an IPC channel allowlist.

**If you use Linux and need working media controls:** Sidra. Cider's MPRIS implementation has documented ongoing issues including playerctl not recognising it as a client (issue #1291, November 2025, still open) and track length reporting `9223372036854775807` on song changes (issue #1301, December 2025, still open).

**If you want free, open-source software:** Sidra (Blue Oak 1.0.0 licence). Cider v1 was AGPL-3.0 but is archived; Cider 2+ costs $3.49 on itch.io or $3.99 on the Microsoft Store.

---

## 2. Architecture overview

### Sidra

Sidra loads `music.apple.com` directly inside CastLabs Electron (a Chromium fork with Widevine CDM support). A lightweight hook script (`musicKitHook.js`, injected after page load) taps MusicKit.js events and forwards them over Electron IPC to the main process. The main process distributes events to platform integrations (MPRIS, Discord, notifications, macOS Dock, Windows taskbar).

```
music.apple.com (Apple's UI, unmodified)
  -> MusicKit.js events
    -> musicKitHook.js (injected, read-only observer)
      -> IPC -> player.ts (EventEmitter)
        -> Platform integrations
```

Audio flows from MusicKit.js through the HTMLMediaElement into Chromium's native media stack. Sidra never intercepts, re-routes, or processes the audio stream. Controls flow in reverse via `webContents.send()` through the preload bridge to `window.__sidra` methods.

**Key architectural property:** Sidra is a thin shell around Apple's own web application. When Apple updates `music.apple.com`, Sidra inherits the changes automatically - no patch cycle required.

### Cider v1 (open source, archived)

Cider v1 built a complete custom interface in Vue.js, served via an embedded Express HTTP server on localhost. The renderer loaded this local web application rather than `music.apple.com` directly. MusicKit.js was used as a library for Apple Music API access, but the UI, audio pipeline, and playback management were all custom.

```
Express server (localhost:9000)
  -> Vue.js custom UI
    -> MusicKit.js (API/playback library)
      -> MediaElementAudioSourceNode
        -> AudioContext (96kHz)
          -> DSP chain (CAP, normalisation, spatial, EQ)
            -> AudioContext destination
```

The audio pipeline intercepted the HTMLMediaElement output via `MediaElementAudioSourceNode`, routed it through a chain of Web Audio API processing nodes, and output to an `AudioContext` destination. This architecture enabled Cider's audio processing features but introduced multiple failure modes (detailed in section 3).

**Runtime dependencies:** Cider v1 shipped approximately 30+ runtime npm dependencies including Express, music-metadata, node-fetch, chokidar, castv2-client, airtunes2, adm-zip, and youtube-search-without-api-key. Sidra ships 5 runtime dependencies: `@holusion/dbus-next`, `@xhayper/discord-rpc`, `electron-log`, `electron-store`, and `electron-updater`.

### Cider 2+ (proprietary)

Cider 2+ is closed-source. Based on public information:

- The project transitioned from Electron-only to a split architecture: a .NET/WPF client on Windows (`dotnet` client in issue metadata), and an Electron client on macOS/Linux (`genten` client).
- The Vue.js custom UI was retained and expanded with immersive mode, visualisations, and richer theming.
- The audio processing features (CAP, equaliser, spatial audio) were carried forward.
- A package manager called "Taproom" was introduced for distribution on Linux.
- Version numbering progressed from 2.x through 3.x, with the latest release being 3.1.10 (codename "Gala") as of early 2026.

**Caveat:** Without source code access, claims about Cider 2+'s internal architecture are inferred from public issue tracker metadata, devlogs, and user reports. The security analysis in section 5 cannot be performed for Cider 2+.

---

## 3. Audio quality

### The double-resampling problem (Cider v1, confirmed via source)

Cider v1's `audio.js` creates an `AudioContext` with a hardcoded sample rate of 96,000 Hz:

```javascript
CiderAudio.context = new window.AudioContext({
    sampleRate: 96000,
});
CiderAudio.source = CiderAudio.context.createMediaElementSource(mediaElem);
```

Apple Music delivers most tracks at 44.1 kHz (CD quality) or 48 kHz. When these reach Cider's AudioContext:

1. **First resample (up):** The browser resamples 44.1/48 kHz source material to 96 kHz to match the AudioContext.
2. **DSP processing:** Audio passes through the CAP, normalisation, spatial audio, and equaliser nodes at 96 kHz.
3. **Second resample (down):** The OS audio subsystem resamples 96 kHz to whatever the hardware DAC expects (typically 44.1 or 48 kHz).

Each resampling pass introduces quantisation noise and potential aliasing artefacts. For the majority of Apple Music's catalogue (44.1 kHz AAC or ALAC), the audio is resampled twice for no benefit.

**Confidence:** High. Directly verified in Cider v1 source code. Whether Cider 2+ changed this architecture is unknown - the audio processing features are still marketed, suggesting the AudioContext pipeline persists.

### Cider Adrenaline Processor (CAP)

CAP uses convolution reverb with impulse response files (`CAP_64.wav`, `CAP_256_FINAL_48k.wav`, `CAP_Maikiwi.wav`, `CAP_Natural.wav`) to shape lossy audio. The marketing claims it makes "lossy audio sound lossless." Technically, CAP applies frequency-domain shaping via convolution - it can alter the tonal character but cannot recover information discarded during lossy encoding. Common community advice is to disable it.

CAP adapts based on detected bitrate: different impulse responses for 64 kbps, 256 kbps, and lossless passthrough. When lossless audio is detected, CAP disables itself ("Non-Lossy Bitrate" passthrough). However, the audio still passes through the 96 kHz AudioContext and the rest of the DSP chain.

### Sidra's approach

Sidra never creates an `AudioContext`. Audio flows from MusicKit.js through the HTMLMediaElement directly into Chromium's native media pipeline, then to the OS audio subsystem. The audio stream is bit-identical to what Apple delivers, subject only to Chromium's own media decoding (which is the same path used by Chrome on `music.apple.com`).

### Lossless and Dolby Atmos

| Capability | Sidra | Cider |
|---|---|---|
| AAC 256 kbps | Yes (all platforms) | Yes (all platforms) |
| ALAC lossless (16/44.1, 16/48) | macOS and Windows (with EVS production VMP signing) | Claimed but unverifiable for Cider 2+ |
| ALAC hi-res lossless (24/96, 24/192) | Limited by Widevine L3 (Chromium) | Limited by Widevine L3 (Chromium) |
| Dolby Atmos / Spatial Audio | Not supported (web player limitation) | Not natively supported; Cider's spatial audio is its own DSP effect, not Dolby Atmos decode |

**Important context:** Neither Sidra nor Cider can deliver true Dolby Atmos from Apple Music. The `music.apple.com` web player and MusicKit.js do not expose Atmos streams. Cider's "spatial audio" feature is a custom convolution-based effect applied to stereo audio, not a decode of Apple's Dolby Atmos mix. Both clients are limited by the same Widevine L3 ceiling for hi-res lossless.

### Widevine DRM

Both clients require Widevine CDM for DRM-protected playback. Sidra uses CastLabs Electron (CastLabs ECS), which bundles Widevine and supports production VMP signing on macOS and Windows for higher DRM trust levels. On Linux, Widevine operates at L3 (software decryption) on both clients.

---

## 4. Platform integration

### Linux

| Feature | Sidra | Cider |
|---|---|---|
| MPRIS service | `org.mpris.MediaPlayer2.sidra` via dbus-next; bi-directional (play, pause, next, prev, seek, volume, open URI) | Present but unreliable (see below) |
| playerctl recognition | Works | Broken - issue #1291 (Nov 2025, open): "Playerctl cannot recognize as MPRIS client" |
| Track metadata accuracy | Correct; `mpris:length` set from MusicKit `durationInMillis` | Broken - issue #1301 (Dec 2025, open): length reports `9223372036854775807` (max int64) on track change |
| MPRIS Volume | Controls MusicKit software volume; feedback loop suppression; matches Rhythmbox/Spotify/VLC behaviour | Volume sync issues documented in Cider v1 due to AudioContext sitting between MPRIS and output |
| Wayland support | Native via `UseOzonePlatform` + `WaylandWindowDecorations` Chromium flags | Supported in Electron builds; .NET client (Windows only) not applicable |
| X11 support | Yes | Yes |
| PulseAudio/PipeWire identity | Corrected via `AudioServiceOutOfProcess` disable + `setDesktopName('sidra.desktop')` | Defaults to "Chromium" identity |
| Desktop notifications | Via Electron Notification API; works on NixOS with libnotify in LD_LIBRARY_PATH | Supported |
| Stability on Linux | Stable; no open Linux-specific issues | Issue #1373 (Feb 2026): "So unstable on Linux Mint"; issue #1280: "Not launching at all on Ubuntu 24.04"; issue #1367: "Quickly switching songs puts player into broken state" |

### macOS

| Feature | Sidra | Cider |
|---|---|---|
| Now Playing widget | Yes, via Chromium's native mediaSession bridge | Yes |
| Dock menu | Playback controls (play/pause, next, previous) | Custom UI controls |
| Dock progress bar | Yes | Unknown |
| Media keys | Yes, via mediaSession | Yes |
| MDM bypass | Yes - authenticates at application layer, MDM policy does not block | Unknown |
| App menu | Cmd+Q, About, native share sheet | Custom menu |

### Windows

| Feature | Sidra | Cider |
|---|---|---|
| GSMTC media flyout | Yes, via Chromium's native mediaSession bridge | Yes (Cider 2+ uses .NET for deeper integration) |
| Taskbar thumbnail toolbar | Play/pause, next, previous | Custom implementation |
| Taskbar progress bar | Yes, with playback position | Unknown |
| Taskbar overlay icon | Yes, shows playback state | Unknown |
| SMTC identity | Correct via `setAppUserModelId` before `app.whenReady()` | Supported |

---

## 5. Security and Electron practices

### Cider v1 (verified from source code)

The Cider v1 source code (`browserwindow.ts`) reveals several Electron security anti-patterns:

```javascript
webPreferences: {
    experimentalFeatures: true,
    nodeIntegration: true,          // Renderer has full Node.js access
    sandbox: true,                  // Contradicted by nodeIntegration: true
    allowRunningInsecureContent: true, // Mixed HTTP/HTTPS content allowed
    contextIsolation: false,        // No isolation between page and preload
    webviewTag: true,               // Deprecated, enables <webview> elements
    nodeIntegrationInWorker: true,  // Web Workers get Node.js access
    webSecurity: false,             // Same-origin policy disabled
    preload: "cider-preload.js",
};
```

**Key issues:**

- **`contextIsolation: false` + `nodeIntegration: true`:** The renderer process has unrestricted Node.js API access. Any XSS vulnerability in the renderer (or in any loaded web content) grants full system access - file system, network, child processes.
- **`webSecurity: false`:** Disables the same-origin policy. The renderer can make cross-origin requests without restriction.
- **`allowRunningInsecureContent: true`:** HTTP resources can load in HTTPS pages without warning.
- **Embedded Express server:** Cider runs an Express HTTP server on localhost (port 9000) to serve its renderer content, plus a second Express server for the web remote feature (port 6942). These are accessible to any local process.
- **`global.ipcRenderer = require("electron").ipcRenderer`:** The preload script exposes the full `ipcRenderer` API on the global object with no channel filtering. Any code running in the renderer can send arbitrary IPC messages to the main process.
- **Command injection (issue #1742):** A reported and fixed command injection vulnerability in the link handler, triggerable from the renderer via `location.href`.

**No known CVEs** have been assigned specifically to Cider. However, the security posture described above would fail any Electron security audit.

### Cider 2+ (proprietary, not auditable)

Without source code access, Cider 2+'s security practices cannot be verified. The transition to a .NET client on Windows may have addressed some Electron-specific issues on that platform. The Electron client on macOS/Linux cannot be assessed.

### Sidra (verified from source code and security audit)

Sidra's security posture, verified by a full security audit (Semgrep, Gitleaks, OSV-Scanner) with zero findings:

| Practice | Sidra | Electron best practice |
|---|---|---|
| `contextIsolation` | `true` (all windows) | `true` |
| `nodeIntegration` | `false` (all windows) | `false` |
| `sandbox` | `true` (all windows) | `true` |
| `webSecurity` | Default (`true`) | `true` |
| IPC | Allowlisted `SEND_CHANNELS` in preload; blocked channels log warning | Channel validation |
| Node APIs in renderer | None exposed | None |
| External URL validation | Protocol check (`http:`/`https:`) before `shell.openExternal()` | Protocol validation |
| CSP | Delegated to `music.apple.com` (Apple's CSP applies) | Application-level CSP preferred |
| Dependency count | 5 runtime deps | Minimise attack surface |
| Automated scanning | Semgrep (0 findings), Gitleaks (0 findings), OSV-Scanner (0 findings across 473 packages) | Regular scanning |

**One open security item:** `verifyUpdateCodeSignature: false` on Windows because the app is unsigned. This is documented and acknowledged; sponsorship funds are directed toward code-signing certificates.

---

## 6. Open source vs proprietary

### Licensing history

| Period | Project | Licence | Status |
|---|---|---|---|
| 2020-2021 | Apple-Music-Electron | GPL-3.0 | Archived, read-only |
| 2021-2024 | Cider v1 | AGPL-3.0 | Archived December 2024, read-only |
| 2023-present | Cider 2+ | Proprietary | Active, paid ($3.49 itch.io / $3.99 Microsoft Store) |
| 2025-present | Sidra | Blue Oak 1.0.0 | Active, free and open source |

### Implications

**Auditability:** Sidra's full source code is public and has undergone documented security audits. Cider 2+ is a black box - users trust the developer's claims without verification. Cider v1's source remains readable on GitHub but is no longer maintained.

**Forkability:** Sidra can be forked, modified, and redistributed under the Blue Oak licence. Cider v1 can theoretically be forked (AGPL-3.0), but the archived codebase carries the security issues documented above. Cider 2+ cannot be forked.

**Business model:** Cider 2+ operates as a paid product. This funds development but introduces a commercial dependency - users who paid for Cider have no recourse if the project is abandoned or the developer makes changes they disagree with. Sidra is community-funded via GitHub Sponsors.

**Community trust:** Cider's transition from open source to proprietary generated community friction. The original open-source project (7,100+ GitHub stars) was archived. Users who contributed to the open-source project saw their contributions incorporated into a paid product. This is legally permitted under AGPL-3.0 by the copyright holder but has affected community goodwill.

---

## 7. Feature comparison

| Feature | Sidra | Cider |
|---|---|---|
| **Audio** | | |
| Bit-perfect passthrough | Yes | No (AudioContext pipeline) |
| Equaliser | No | Yes (parametric EQ) |
| Audio normalisation | No (Apple's Sound Check via MusicKit) | Yes (MaikiwiSoundCheck) |
| CAP audio processor | No | Yes |
| Spatial audio effect | No | Yes (custom convolution, not Dolby Atmos) |
| Lossless (macOS/Windows) | Yes (EVS production VMP) | Claimed |
| **Interface** | | |
| UI | Apple's `music.apple.com` (maintained by Apple) | Custom Vue.js UI |
| Themes | Catppuccin; Apple Music default | Extensive theming system |
| Immersive/fullscreen mode | No | Yes (album art visualisation) |
| Mini player | No | Yes |
| Lyrics display | Via Apple's web UI | Custom lyrics view |
| **Integrations** | | |
| MPRIS (Linux) | Full bi-directional | Present but unreliable (open bugs) |
| Discord Rich Presence | Yes (opt-in) | Yes |
| Last.fm scrobbling | No | Yes (built-in) |
| ListenBrainz | No | Unknown |
| Desktop notifications | Yes | Yes |
| Chromecast / AirPlay | No | Yes (Cider v1 had Chromecast/AirPlay; status in 2+ unclear) |
| Web remote | No | Yes (Cider v1; status in 2+ unclear) |
| **Platform** | | |
| Linux packages | AppImage, deb, rpm, Nix flake | AppImage, Taproom |
| macOS | DMG, Nix | DMG |
| Windows | NSIS installer | NSIS installer, Microsoft Store |
| Android | No | Yes (Cider 2+) |
| Auto-update | AppImage and NSIS (silent OTA); deb/rpm/Nix (notification) | Via itch.io / Microsoft Store |
| **Other** | | |
| Localisation | 32 languages | Multiple languages (Crowdin-managed in v1) |
| Plugin system | No | Yes (Cider v1, limited in 2+) |
| Open source | Yes (Blue Oak 1.0.0) | No (v1 archived; 2+ proprietary) |
| Price | Free | $3.49 (itch.io) / $3.99 (Microsoft Store) |

---

## 8. Reliability and maintenance

### How each handles Apple Music updates

**Sidra:** Loads `music.apple.com` directly. When Apple updates the web player - new features, UI changes, bug fixes, API changes - Sidra inherits them automatically with zero developer intervention. The only maintenance surface is the MusicKit.js event API that the hook script observes, which has been stable.

**Cider:** Builds a complete custom UI on top of MusicKit.js as a library. When Apple changes the MusicKit API, deprecates endpoints, or modifies authentication flows, Cider must patch its own code to match. This creates a maintenance burden proportional to Cider's feature surface area.

### Documented reliability issues (Cider 2+, from public issue tracker)

These are all from the public `ciderapp/Cider-2` issue tracker on GitHub:

- **Playback stopping mid-track** (issue #631, May 2024): Songs stop at the 1-2 minute mark; pressing play restarts the song and replaces the queue with reversed history. Closed as `wontfix`.
- **Unable to play music at all** (issue #1030, April 2025): Complete playback failure on Windows.
- **Authentication failures** (itch.io community, January 2025, March 2025): Multiple reports of inability to sign in after updates, particularly after v2.6.0.
- **Linux instability** (issue #1373, February 2026): "So unstable on Linux Mint" - songs stop mid-playback, login issues.
- **MPRIS not recognised by playerctl** (issue #1291, November 2025): playerctl cannot find Cider as an MPRIS client. Open, 2 thumbs-up reactions.
- **MPRIS track length corruption** (issue #1301, December 2025): Reports `9223372036854775807` (max signed 64-bit integer) as track length. Open.
- **Memory leak** (issue #1370): "High Memory Usage/Leak when running cider" on Windows.
- **Broken state on fast track switching** (issue #1367): "Quickly switching songs occasionally puts the player into a broken state" on Linux.
- **Session logout mid-playback** (issue #1372): "Cider keeps logging me out mid session, reducing songs to shortened versions" on Windows.
- **Bug reports going unanswered** (Reddit, September 2025): User frustration with Cider 4.x bug reports not receiving responses.

### Documented reliability issues (Sidra)

Sidra's approach eliminates the architectural failure modes documented in Cider (AudioContext suspension, DSP chain stalls, MediaElementAudioSourceNode disconnection, custom queue corruption). A wedge detector exists as low-cost insurance against platform-level issues (Chromium MSE bugs, CDM failures) but has not fired in production use.

The primary residual risk is MusicKit.js bugs in Apple's own web player, which affect all browser-based clients equally.

---

## 9. Who should use which

### Choose Sidra if you:

- Prioritise audio fidelity and want bit-perfect passthrough
- Use Linux and need reliable MPRIS media controls
- Care about security and want an auditable open-source codebase
- Prefer stability over features
- Want automatic inheritance of Apple Music web player improvements
- Do not want to pay for a music client on top of your Apple Music subscription
- Need MDM bypass on macOS for Apple ID authentication

### Choose Cider if you:

- Want a custom UI that differs from Apple's web player
- Use the equaliser, spatial audio effect, or audio normalisation features
- Want Last.fm scrobbling built into the client
- Want immersive/fullscreen visualisation mode
- Want extensive theming beyond what Sidra offers
- Need Android support
- Are comfortable with proprietary software and the $3.49-3.99 price

### Neither is ideal if you:

- Need true Dolby Atmos decode (use Apple's native apps on supported hardware)
- Need hi-res lossless above Widevine L3 limits (use Apple's native apps)
- Want a fully native, non-Electron application

---

## Methodology and confidence

| Section | Sidra confidence | Cider confidence | Source |
|---|---|---|---|
| Architecture | High | High (v1), Medium (2+) | Sidra: full source. Cider v1: full source. Cider 2+: public metadata |
| Audio quality | High | High (v1), Medium (2+) | Sidra: source + ROBUST.md. Cider v1: `audio.js` source inspection |
| Platform integration | High | High | Sidra: source. Cider: public issue tracker |
| Security | High | High (v1), Not assessable (2+) | Sidra: audit report + source. Cider v1: `browserwindow.ts` source |
| Features | High | Medium-High | Sidra: source + README. Cider: marketing materials + devlogs |
| Reliability | High | High | Both: public issue trackers, community reports |

All Cider v1 source code references are from the `ciderapp/Cider` repository on GitHub, archived December 2024. Cider 2+ information is from the `ciderapp/Cider-2` public issue tracker, itch.io devlogs, and the `cider.sh` website, gathered March 2026.
