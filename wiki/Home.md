This wiki covers configuration, controls, [Custom Themes](Custom-Themes), [Scrobbling](Scrobbling), and [Development](Development) for Sidra.

## Configuration and user data

Sidra stores configuration (`config.json`) and custom themes (`custom-theme.json`) in its user data directory:

| Platform | Directory |
|---|---|
| Linux | `~/.config/Sidra/` |
| macOS | `~/Library/Application Support/Sidra/` |
| Windows | `%APPDATA%\Sidra\` |

On Linux, a set `XDG_CONFIG_HOME` replaces `~/.config`.

Flatpak keeps settings, authentication, and downloaded Widevine components in app-private storage under `~/.var/app/world.wimpys.sidra/`.

## Controls and navigation

Open **Settings** with the gear button beside Back, Forward, and Reload. With the player focused, press <kbd>Ctrl</kbd>+<kbd>,</kbd> on Linux or Windows, or <kbd>Cmd</kbd>+<kbd>,</kbd> on macOS.

Point at the player bar volume control and scroll to change the volume by 5% per notch.

### Controller navigation

Sidra supports controllers that expose the browser's standard Gamepad mapping. The controls work in Apple Music and Apple Music Classical:

| Controller input | Action |
|---|---|
| D-pad | Move up, down, left, or right |
| A button | Select the focused item |
| B button | Go back when navigation history permits |

Hold a D-pad direction to repeat it. The A and B buttons act once per press. Controller input does not control media playback or settings.
