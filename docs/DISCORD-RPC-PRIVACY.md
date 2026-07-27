# Privacy Policy - Discord Rich Presence

This policy covers Sidra's Discord Rich Presence feature only.

## What the feature does

Sidra reads track metadata from Apple Music on your device and sends it to the Discord desktop client via a local socket (IPC) on your computer.

## What is shared with Discord

When the feature is active, Sidra passes the following to your local Discord client:

- Song title
- Artist name
- Album name
- Album artwork URL

## What Sidra does not collect or store

This feature collects and stores nothing, and needs no account. Track metadata reaches Discord over a local socket, so nothing leaves your machine through it. Sidra has no server, no analytics, and no telemetry.

Other Sidra features can send data off your machine once you switch them on. Last.fm scrobbling is opt-in and sends your listening to Last.fm; see [`LASTFM-PRIVACY.md`](LASTFM-PRIVACY.md).

## Discord's privacy policy

Once Discord receives presence data, Discord's own practices apply. See [Discord's Privacy Policy](https://discord.com/privacy) for details.

## Changes to this policy

This policy may be updated. All changes will appear in the [Sidra repository](https://github.com/wimpysworld/sidra).

## Contact

Report concerns or questions at [github.com/wimpysworld/sidra/issues](https://github.com/wimpysworld/sidra/issues).
