Copy [custom-theme.json](https://github.com/wimpysworld/sidra/blob/main/docs/custom-theme.json) to Sidra's user data directory, then edit its colours.

## File location

| Platform | File |
|---|---|
| Linux | `~/.config/Sidra/custom-theme.json` |
| macOS | `~/Library/Application Support/Sidra/custom-theme.json` |
| Windows | `%APPDATA%\Sidra\custom-theme.json` |

On Linux, a set `XDG_CONFIG_HOME` replaces `~/.config`.

A valid file adds one **Custom Theme** choice under **Style** in Settings.
Select it once. Saved edits apply without a restart, including in an open Settings window.

Enable Noctalia's [Sidra community template](https://github.com/noctalia-dev/community-templates/tree/main/sidra) and select **Settings → Style → Custom Theme** once.
Sidra then follows Noctalia's active colour palette automatically.

## Colour format

The example contains all 12 required colours in `dark`:

```json
{
  "dark": {
    "base": "#1e1e2e",
    "mantle": "#181825",
    "crust": "#11111b",
    "surface0": "#313244",
    "surface1": "#45475a",
    "surface2": "#585b70",
    "overlay": "#6c7086",
    "text": "#cdd6f4",
    "subtext1": "#bac2de",
    "subtext0": "#a6adc8",
    "accent": "#f38ba8",
    "accentHover": "#eba0ac"
  }
}
```

Use six-digit hex colours, such as `#1e1e2e`. JSON requires double quotes and accepts no comments or trailing commas.
For a separate light scheme, add a `light` object with the same 12 keys. Without it, Sidra uses `dark` in both modes.

| Keys | Colour role |
|---|---|
| `base`, `mantle`, `crust` | Page, player and footer backgrounds |
| `surface0`, `surface1`, `surface2` | Controls, scrollbars and borders |
| `text`, `subtext1`, `subtext0`, `overlay` | Primary, secondary, emphasised secondary and tertiary text |
| `accent`, `accentHover` | Highlight colour and its hover or pressed state |

Sidra accepts low-contrast palettes without adjustment. Choose colours that you can read comfortably.
Custom themes change colours only, not fonts or layout.

If the file is missing, unreadable or invalid, **Custom Theme** disappears and an active custom theme falls back to **Apple Music**.
Fix or restore the file to recover the theme automatically, unless you selected another style.

## Migrating from custom CSS

Sidra ignores existing `custom.css` files but leaves them untouched.
Copy your colours into the JSON example. Sidra cannot automatically convert arbitrary CSS, and CSS rules no longer apply.
