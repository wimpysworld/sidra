# Sidra vs Cider: Apple Music desktop client comparison

**Last updated:** 2026-09-06
**Confidence note:** Cider v1 (open-source, AGPL-3.0) source analysis is historical. It does not describe Cider 4. Current Cider claims use official documentation and selected issue updates, without independent playback tests or access to proprietary source. Sidra claims use repository documentation and source. This update is not a fresh security audit or broad issue survey.

---

## 1. Executive summary

**If you want Apple's web playback without client-added DSP:** Sidra. It adds no audio processing or rerouting. Chromium and the OS can still process audio. This is not a measured fidelity or reliability ranking against Cider 4.

**If you want a custom UI with equaliser, visualisations, and themes:** Cider. It has a full-featured replacement interface with audio processing tools, immersive mode, and extensive theming.

**If you care about public source auditability:** Sidra. It uses `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, and an IPC channel allowlist. Cider 2+ source is proprietary and not publicly auditable. The Cider v1 security findings below do not establish Cider 4's security practices.

**If you use Linux:** Both clients support MPRIS and Linux ARM64. Sidra has direct, bi-directional media controls. Historical Cider MPRIS reports do not establish current behaviour: #1291 closed with a maintainer-reported 4.x fix, while #1301 closed without a confirmed fix.

**If you want Apple Account sign-in to stay on supported desktop paths:** Sidra. It uses Apple's own web authentication, but hides passkey and "Sign in with iPhone" options that cannot complete in Electron because Chromium's QR-code UI lives outside the `//content` layer Electron ships.

**If you want free, open-source software:** Sidra (Blue Oak 1.0.0 licence). Cider v1 was AGPL-3.0 but is archived. The official [itch.io purchase page](https://cidercollective.itch.io/cider/purchase) lists Cider at US$8.49 or more. Other storefront prices are unverified.

---

## 2. Architecture overview

### Sidra

Sidra loads `music.apple.com` and `classical.music.apple.com` directly inside CastLabs Electron (a Chromium fork with Widevine CDM support). A lightweight hook script (`musicKitHook.js`, injected after page load) taps MusicKit.js events and forwards them over Electron IPC to the main process. The main process distributes events to platform integrations (MPRIS, Discord, notifications, macOS Dock, Windows taskbar).

```
music.apple.com / classical.music.apple.com (Apple's UI, with Sidra additions)
  -> MusicKit.js events
    -> musicKitHook.js (injected event bridge and playback controls)
      -> IPC -> player.ts (EventEmitter)
        -> Platform integrations
```

Audio flows from MusicKit.js through the HTMLMediaElement into Chromium's native media stack. Sidra never intercepts, re-routes, or processes the audio stream. Controls flow in reverse via `webContents.send()` through the preload bridge to `window.__sidra` methods.

**Key architectural property:** Sidra loads Apple's current web applications. Its injected navigation, themes, authentication adjustments and MusicKit bridge still need maintenance when Apple changes relevant behaviour.

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

**Runtime dependencies:** Cider v1 shipped approximately 30+ runtime npm dependencies including Express, music-metadata, node-fetch, chokidar, castv2-client, airtunes2, adm-zip, and youtube-search-without-api-key. Sidra ships 5 runtime dependencies: `@holusion/dbus-next`, `@xhayper/discord-rpc`, `electron-conf`, `electron-log`, and `electron-updater`.

### Cider 2+ (proprietary)

Cider 4 is the current generation. Its [4.0.0 changelog](https://github.com/ciderapp/Cider-2/blob/main/changelogs/4.0.0.md), dated [16 June 2026](https://cider.sh/changelogs), documents:

- Removal of MusicKit.js in favour of the custom MKLite playback system.
- WebAssembly audio work, LUFS normalisation, Automix and spectral crossfade.
- Dolby Atmos and spatial audio assets.
- A custom interface with audio processing and visualisation tools.

Earlier issue metadata identified .NET/WPF Windows (`dotnet`) and Electron macOS/Linux (`genten`) clients. That runtime map is historical, not verified for Cider 4. Linux distribution includes Taproom.

The [official downloads page](https://cider.sh/downloads/client) lists Cider 4, but says that the Microsoft Store remains on 3.1 because of storefront issues.

**Caveat:** These are vendor-documented changes, not independently tested capabilities. The current platform matrix for audio and runtimes is unverified. Proprietary source prevents the public source review used for v1.

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
3. **Possible second resample:** If the output uses a different rate, the audio subsystem converts the 96 kHz signal again.

This creates an extra resampling stage. A second conversion depends on the output configuration. Source inspection alone does not establish audible degradation.

**Confidence:** High for the v1 source configuration, not for measured output quality. Cider 4 documents a different playback system, so this finding does not establish its audio path.

### Cider Adrenaline Processor (CAP, historical v1 analysis)

In v1, CAP uses convolution reverb with impulse response files (`CAP_64.wav`, `CAP_256_FINAL_48k.wav`, `CAP_Maikiwi.wav`, `CAP_Natural.wav`) to alter lossy audio. The marketing claimed that it makes "lossy audio sound lossless." Convolution can alter the tonal character but cannot recover information discarded during lossy encoding.

CAP adapts based on detected bitrate: different impulse responses for 64 kbps, 256 kbps, and lossless passthrough. When lossless audio is detected, CAP disables itself ("Non-Lossy Bitrate" passthrough). However, the audio still passes through the 96 kHz AudioContext and the rest of the DSP chain.

### Sidra's approach

Sidra adds no `AudioContext`, DSP or audio rerouting. Audio uses Apple's web player, Chromium's media pipeline and the OS audio subsystem. Decoding, resampling, mixing and system effects can occur downstream, so this is not a bit-perfect guarantee.

### Lossless and Dolby Atmos

| Capability | Sidra | Cider |
|---|---|---|
| AAC 256 kbps | Yes (all platforms) | Yes (all platforms) |
| ALAC lossless (16/44.1, 16/48) | macOS and Windows (with EVS production VMP signing) | Vendor claims, current platform coverage not independently verified |
| ALAC hi-res lossless (24/96, 24/192) | Limited by the web player and Chromium DRM path | Current formats, rates and platform coverage unverified |
| Dolby Atmos / Spatial Audio | Not supported by Sidra's web playback path | Cider 4 documents Atmos/spatial audio assets, playback and platform coverage not independently verified |

**Important context:** Cider v1's stereo spatial effect does not describe Cider 4's documented Atmos work. Cider 4 replaced MusicKit.js, so Sidra's web playback limits cannot establish Cider 4's format or DRM limits. Confirm the required format on your platform before purchase.

### Widevine DRM

Sidra uses CastLabs Electron (CastLabs ECS), which bundles Widevine and supports production VMP signing on macOS and Windows. Sidra uses software decryption on Linux. Cider 4's current DRM implementation and platform limits are unverified here.

---

## 4. Platform integration

### Linux

| Feature | Sidra | Cider |
|---|---|---|
| MPRIS service | `org.mpris.MediaPlayer2.sidra` via dbus-next, bi-directional (play, pause, next, prev, seek, volume, open URI) | Supported, historical reports below are not a current reliability test |
| playerctl recognition | Supported | #1291 closed 25 April 2026, maintainer reports a 4.x fix |
| Track metadata accuracy | `mpris:length` set from MusicKit `durationInMillis` | #1301 reported max-int64 lengths, closed 13 June 2026 as stale/not planned without a confirmed fix |
| MPRIS Volume | Controls MusicKit software volume; feedback loop suppression; matches Rhythmbox/Spotify/VLC behaviour | Volume sync issues documented in Cider v1 due to AudioContext sitting between MPRIS and output |
| Wayland support | Native via Chromium | Supported in earlier Electron builds, current runtime map unverified |
| X11 support | Yes | Yes |
| PulseAudio/PipeWire identity | Corrected via `AudioServiceOutOfProcess` disable + `setDesktopName('sidra.desktop')` | Current identity unverified |
| Desktop notifications | Track notifications use D-Bus, with Previous/Next controls when the daemon supports actions. Other notifications use Electron and require libnotify on NixOS | Supported |
| Stability on Linux | No current comparative stability test | Historical reports include #1373, #1280 and #1367, not evidence of universal Cider 4 behaviour |

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
| GSMTC media flyout | Yes, via Chromium's native mediaSession bridge | Documented in earlier clients, current runtime map unverified |
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

These historical settings conflict with Electron security guidance. This update includes no current CVE survey.

### Cider 2+ (proprietary, source not publicly auditable)

Cider 2+ source is not publicly available for the review used above. Binary and runtime audits remain possible, but this comparison includes neither. Earlier .NET/Electron client metadata does not establish Cider 4's security practices.

### Sidra (source practices and historical audit results)

The previous comparison reported zero findings from Semgrep, Gitleaks and OSV-Scanner. Those historical results are not a current audit. The source-level practices are:

| Practice | Sidra | Electron best practice |
|---|---|---|
| `contextIsolation` | `true` (all windows) | `true` |
| `nodeIntegration` | `false` (all windows) | `false` |
| `sandbox` | `true` (all windows) | `true` |
| `webSecurity` | Default (`true`) | `true` |
| IPC | Allowlisted `SEND_CHANNELS` in preload; blocked channels log warning | Channel validation |
| Node APIs in renderer | None exposed | None |
| External URL validation | Protocol check (`http:`/`https:`) before `shell.openExternal()` | Protocol validation |
| CSP | Apple's CSP on its web pages, explicit CSP on Sidra's local windows | Application-level CSP |
| Dependency count | 5 runtime deps | Minimise attack surface |
| Automated scanning | Historical scan results only, not rerun for this update | Regular scanning |

**Windows update limitation:** Sidra is unsigned. Its `verifyUpdateCodeSignature` callback accepts updates without signature verification. This is not a claim that no other security issues exist.

---

## 6. Open source vs proprietary

### Licensing history

| Period | Project | Licence | Status |
|---|---|---|---|
| 2020-2021 | Apple-Music-Electron | GPL-3.0 | Archived, read-only |
| 2021-2024 | Cider v1 | AGPL-3.0 | Archived December 2024, read-only |
| 2023-present | Cider 2+ | Proprietary | Active, paid (itch.io: US$8.49 or more) |
| 2025-present | Sidra | Blue Oak 1.0.0 | Active, free and open source |

### Implications

**Auditability:** Sidra's full source code is public. Cider 2+ source is not publicly auditable, although binary and runtime testing remain possible. Cider v1's source remains readable on GitHub but is no longer maintained.

**Forkability:** Sidra can be forked, modified, and redistributed under the Blue Oak licence. Cider v1 can theoretically be forked (AGPL-3.0), but the archived codebase carries the security issues documented above. Cider 2+ cannot be forked.

**Business model:** Cider 2+ operates as a paid product. This funds development but introduces a commercial dependency - users who paid for Cider have no recourse if the project is abandoned or the developer makes changes they disagree with. Sidra is community-funded via GitHub Sponsors.

**Community trust:** Cider's transition from open source to proprietary generated community friction. The original open-source project (7,100+ GitHub stars) was archived. Users who contributed to the open-source project saw their contributions incorporated into a paid product. This is legally permitted under AGPL-3.0 by the copyright holder but has affected community goodwill.

---

## 7. Feature comparison

| Feature | Sidra | Cider |
|---|---|---|
| **Audio** | | |
| Client-added audio processing | No Sidra-added DSP or rerouting, not a bit-perfect guarantee | Cider 4 documents a custom audio system and DSP |
| Equaliser | No | Yes (parametric EQ) |
| Audio normalisation | No Sidra-added normalisation | Cider 4 documents LUFS normalisation |
| CAP audio processor | No | Historical CAP analysis above, current implementation unverified |
| Spatial audio / Atmos | No | Cider 4 documents Atmos/spatial assets, see audio caveat above |
| Lossless (macOS/Windows) | Yes (EVS production VMP) | Vendor claims, platform coverage not independently verified |
| **Interface** | | |
| UI | Apple's `music.apple.com` and `classical.music.apple.com`, with Sidra additions | Custom UI, Vue.js documented in earlier versions |
| Themes | Apple Music default, eight bundled themes and one JSON-based Custom Theme. Colours apply to both services and Settings | Extensive theming system |
| Immersive/fullscreen mode | No | Yes (album art visualisation) |
| Mini player | None bundled, external MPRIS MiniPlayer on Linux | Built-in mini-player and microplayer |
| Settings | Dedicated resizable, themed window with gear and keyboard access, direct tray preferences remain | In-app settings, current layout not compared |
| Controller navigation | Standard Gamepad: D-pad moves, A selects, B goes back in both services. No media or settings controls | Not verified in current official documentation |
| Lyrics display | Via Apple's web UI | Custom lyrics view |
| **Integrations** | | |
| MPRIS (Linux) | Full bi-directional | Supported, see dated issue outcomes in section 8 |
| Discord Rich Presence | Yes (opt-in) | Yes |
| Last.fm scrobbling | Yes (opt-in), including individual songs from live radio and archived shows | Yes (built-in), radio behaviour not verified |
| ListenBrainz | No | Unknown |
| Desktop notifications | Yes | Yes |
| Chromecast / AirPlay | No | Yes (Cider v1 had Chromecast/AirPlay; status in 2+ unclear) |
| Web remote | No | Yes (Cider v1; status in 2+ unclear) |
| **Platform** | | |
| Linux packages | AppImage, deb, rpm, Snap, Nix flake | AppImage, Taproom, Cider Collective Repository for select distributions |
| Linux CPU architectures | x86_64 and ARM64 across the listed packages | x86_64 and ARM64, ARM64 availability depends on distribution channel |
| macOS | DMG, Nix | DMG |
| Windows | NSIS installer | NSIS installer, Microsoft Store |
| Android | No | Cider Remote companion, standalone playback not confirmed |
| Auto-update | AppImage and NSIS (silent OTA), deb/rpm/Nix/macOS DMG (release notification) | Distribution-dependent, Microsoft Store remains on 3.1 |
| **Other** | | |
| Apple Account sign-in | Apple's own web auth, unsupported passkey and "Sign in with iPhone" desktop flows hidden | Custom client authentication, earlier failure reports do not establish Cider 4 behaviour |
| Localisation | 32 languages | Multiple languages (Crowdin-managed in v1) |
| Plugin system | No | Yes (Cider v1, limited in 2+) |
| Open source | Yes (Blue Oak 1.0.0) | No (v1 archived; 2+ proprietary) |
| Price | Free | US$8.49 or more on itch.io, other storefront prices unverified |

Christian Lauinger built [MPRIS MiniPlayer](https://github.com/ChrisLauinger77/mpris-miniplayer) after requesting a mini player in [Sidra #125](https://github.com/wimpysworld/sidra/issues/125). It controls any MPRIS player on Linux, not only Sidra. Cider documents its built-in alternatives in the [2.3.0](https://cidercollective.itch.io/cider/devlog/674855/cider-v230) and [3.0](https://cidercollective.itch.io/cider/devlog/944519/cider-30-dreaming-even-bigger) devlogs.

Sidra Settings opens from the gear button, <kbd>Ctrl</kbd>+<kbd>,</kbd> on Linux/Windows, or <kbd>Cmd</kbd>+<kbd>,</kbd> on macOS. The player must have focus for the shortcut.

The [Cider ARM64 maintainer reply](https://github.com/ciderapp/Cider-2/issues/1825#issuecomment-5228949176), dated 9 August 2026, names Taproom and the Cider Collective Repository for select distributions. This is not a guarantee for every Asahi Linux setup.

[Cider Remote](https://github.com/ciderapp/Cider-Remote-RN) is an Android companion, not verified as a standalone music player.

Cider's GameMode reduces CPU use. It does not establish controller navigation support.

---

## 8. Reliability and maintenance

### How each handles Apple Music updates

**Sidra:** Loads `music.apple.com` and `classical.music.apple.com` directly, so Apple's web player updates arrive without a replacement UI release. Sidra's MusicKit bridge, injected navigation, themes and authentication adjustments still need compatibility work when Apple changes relevant behaviour.

Sidra also keeps Apple's authentication UI, but filters impossible desktop choices. Apple's passkey and "Sign in with iPhone" buttons rely on WebAuthn cross-device transport and Chromium's `//chrome` product UI for the QR-code modal. Electron only ships `//content`, so Sidra hides those options in the auth iframe and leaves the password flow visible.

**Cider:** Builds a custom UI and, in Cider 4, uses MKLite instead of MusicKit.js. Its developers maintain those components against Apple's service changes. This comparison does not measure either project's maintenance burden or response time.

### Historical reliability reports (Cider 2+, from public issue tracker)

The earlier comparison collected these issue tracker and community reports. They describe particular versions and systems, not universal Cider 4 behaviour. Only the two MPRIS outcomes below were refreshed for this update.

- **Playback stopping mid-track** (issue #631, May 2024): Songs stop at the 1-2 minute mark; pressing play restarts the song and replaces the queue with reversed history. Closed as `wontfix`.
- **Unable to play music at all** (issue #1030, April 2025): Complete playback failure on Windows.
- **Authentication failures** (itch.io community, January 2025, March 2025): Multiple reports of inability to sign in after updates, particularly after v2.6.0.
- **Linux instability** (issue #1373, February 2026): "So unstable on Linux Mint" - songs stop mid-playback, login issues.
- **MPRIS not recognised by playerctl** ([#1291](https://github.com/ciderapp/Cider-2/issues/1291#issuecomment-4318397472), November 2025): Closed 25 April 2026. The maintainer says that 4.x fixes the issue. Not independently retested here.
- **MPRIS track length corruption** ([#1301](https://github.com/ciderapp/Cider-2/issues/1301), December 2025): Reported `9223372036854775807` as track length. Closed 13 June 2026 as stale/not planned, without a confirmed fix.
- **Memory leak** (issue #1370): "High Memory Usage/Leak when running cider" on Windows.
- **Broken state on fast track switching** (issue #1367): "Quickly switching songs occasionally puts the player into a broken state" on Linux.
- **Session logout mid-playback** (issue #1372): "Cider keeps logging me out mid session, reducing songs to shortened versions" on Windows.

### Documented reliability issues (Sidra)

Sidra adds no AudioContext or DSP chain, so it does not introduce the v1 processing failures described above. Its wedge detector handles playback stalls, but this update includes no production activation data or comparative reliability test.

Sidra still depends on Apple's web player, Chromium, the CDM and its own integrations. The effects of faults differ by client and platform.

---

## 9. Who should use which

### Choose Sidra if you:

- Want Apple's web playback without Sidra-added DSP or audio rerouting
- Use Linux and want bi-directional MPRIS media controls
- Care about security and want an auditable open-source codebase
- Prefer Apple's web interface to a replacement UI
- Want Apple Music web player improvements as Apple ships them, with some Sidra compatibility maintenance
- Want Apple Account sign-in without unsupported Electron passkey/iPhone dead ends
- Do not want to pay for a music client on top of your Apple Music subscription
- Need MDM bypass on macOS for Apple ID authentication

### Choose Cider if you:

- Want a custom UI that differs from Apple's web player
- Want audio tools such as equalisation, LUFS normalisation, Automix or spectral crossfade
- Want immersive/fullscreen visualisation mode
- Want extensive theming beyond what Sidra offers
- Want a built-in mini-player or the Android remote companion
- Are comfortable with proprietary software and the itch.io price of US$8.49 or more

### Check before choosing if you:

- Need verified Dolby Atmos playback. Sidra does not support it, and Cider 4's documented support lacks independent platform verification here
- Need verified hi-res lossless. Use Apple's native apps on supported hardware, or confirm Cider's formats and rates on your platform
- Want a fully native, non-Electron application. Sidra uses Electron, and Cider 4's runtime map is unverified here

---

## Methodology and confidence

| Section | Sidra confidence | Cider confidence | Source |
|---|---|---|---|
| Architecture | Source-supported | Source-supported (v1), vendor-documented (4) | Sidra: source. Cider v1: source. Cider 4: official changelog, current runtime map unverified |
| Audio quality | No client-added DSP, output not measured | v1 configuration verified, Cider 4 output not tested | Source and vendor documentation do not establish measured fidelity |
| Platform integration | Source and README | Selected official documentation and issue outcomes | No current cross-platform runtime comparison |
| Security | Source practices, historical scans only | v1 source findings only | No fresh audit, Cider 2+ source not publicly available |
| Features | Source and README | Official pages and devlogs | Current Cider audio platform matrix unverified |
| Reliability | Not ranked | Not ranked | Historical reports, two refreshed MPRIS outcomes, no comparative test |

Cider v1 source references use the archived [`ciderapp/Cider`](https://github.com/ciderapp/Cider) repository. Historical reports come from the earlier comparison, which recorded research in March 2026. The 6 September 2026 update uses the official sources linked above for Cider 4, pricing, distribution, mini-player, remote companion and selected issue outcomes. It updates affected claims without repeating the broad issue survey or source audit.
