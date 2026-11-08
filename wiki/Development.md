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
                    ├── Last.fm scrobbling
                    ├── Desktop notifications
                    ├── navigator.mediaSession (macOS/Windows)
                    ├── Dock menu + progress bar (macOS)
                    └── Taskbar toolbar + overlay + progress bar (Windows)
```

Controls flow in reverse: MPRIS sends typed IPC commands through the isolated preload to `window.__sidra`, which calls MusicKit.

The codebase is tightly focused and as lean as possible.

## Development

Requires [Nix](https://nixos.org/) with flakes enabled. [direnv](https://direnv.net/) is recommended. The project uses npm and TypeScript with [CastLabs Electron](https://github.com/castlabs/electron-releases) (`wvcus` variant) - standard Electron cannot be substituted as it lacks Widevine DRM support on Linux.

```bash
direnv allow          # or: nix develop
just install          # install npm dependencies
just run              # build and launch
```

Sign in on first launch. Your session persists across relaunches. Run `just` with no arguments to list all available recipes for building, testing, debugging, and diagnostics.

Run `just generate-assets` to regenerate application icons, the logo, DMG backgrounds, tray icons and menu icons from SVG sources.
The command also composes the README image from screenshots.

### NixOS

The dev shell puts the libraries CastLabs Electron needs on `LD_LIBRARY_PATH`, but the host must supply the ELF interpreter. The npm-installed Electron is a prebuilt binary that requests `/lib64/ld-linux-x86-64.so.2`, a path plain NixOS does not provide. Enable [nix-ld](https://github.com/nix-community/nix-ld) (`programs.nix-ld.enable = true;`) or an equivalent compatibility loader before running `just run`. Do not patch the Electron binary with `patchelf`: it is EVS-signed, and patching invalidates the signature.

### Widevine VMP signing

Widevine enforces VMP (Verified Media Path) production signing on macOS and Windows - without it, Apple Music returns "Something went wrong" after login. CastLabs ECS ships with development keys. Production signing requires a free [CastLabs EVS](https://github.com/castlabs/electron-releases/wiki/EVS) account.

**One-time setup:**

```bash
uvx --from castlabs-evs evs-account signup
```

Credentials are stored at `~/.config/evs/config.json`. The account is portable - use `evs-account reauth` on any new machine.

| Context | Credentials |
|---------|-------------|
| Local machine | `~/.config/evs/config.json`, or set `EVS_ACCOUNT_NAME` + `EVS_PASSWD` env vars (for example, via sops-nix) |

`just install` and `just build` sign the local Electron binary automatically once credentials are in place. Release builds are signed via the `afterPack` hook in `build/afterPack.cjs`.

### Last.fm API credentials

Official releases ship Last.fm API credentials. A build from this repository does not. Without credentials, Settings and the tray hide the Last.fm controls unless a valid custom endpoint is configured.

Register an API account at [last.fm/api/account/create](https://www.last.fm/api/account/create), then export the key and secret before building:

```bash
export SIDRA_LASTFM_API_KEY=your-api-key
export SIDRA_LASTFM_API_SECRET=your-shared-secret
just run
```

| Context | Credentials |
|---------|-------------|
| Local machine | `SIDRA_LASTFM_API_KEY` + `SIDRA_LASTFM_API_SECRET` env vars (for example, via direnv or sops-nix) |
| Packaged build | `assets/lastfm-credentials.json`, written from those env vars by `just build` and `npm run build` |
| CI | The same two names as repository secrets |

Environment variables win at runtime. The JSON file is the fallback that packaged builds use. That file is gitignored - the shared secret must never be committed. With neither variable set the build writes it empty, unless it already holds credentials, in which case it is left alone.

See [`docs/SPECIFICATION.md`](https://github.com/wimpysworld/sidra/blob/main/docs/SPECIFICATION.md) for full technical detail: architecture, IPC event flow, MPRIS property checklist, platform media control implementation, and the complete feature inventory.
