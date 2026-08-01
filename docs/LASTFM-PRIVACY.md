# Privacy Policy - Last.fm scrobbling

This policy covers Sidra's Last.fm scrobbling feature only.

## What the feature does

Scrobbling is off until you connect a Last.fm account from Sidra's tray menu. Once connected, Sidra sends what you are playing to Last.fm's servers over HTTPS.

## What is shared with Last.fm

For each track, Sidra sends:

- Track title
- Artist name
- Album name (when the player reports one)
- Track length (when the player reports one)
- The time playback started (with a scrobble only)

A now-playing update goes out when a track starts or resumes, and a scrobble once the track has played far enough to qualify. Nothing else about your listening is sent. Nothing at all is sent while the feature is off or no account is connected.

## What is stored on your machine

Connecting stores a Last.fm session key and your Last.fm username in Sidra's configuration file (`config.json` in Sidra's user data directory), in plain text. The session key authorises scrobbling to your account. It goes nowhere except Last.fm.

When a scrobble cannot reach Last.fm, because the connection dropped for example, the same file holds that play until the next request carries it out. Each held play is a track title, artist name and the time playback started, plus the album name and track length when the player reported them. At most 50 are held, and the oldest goes once that is full.

## Turning it off and revoking access

- **Off** in the tray Last.fm submenu stops scrobbling and keeps the account linked.
- **Disconnect** deletes the session key, the username and any held plays from your machine.

Last.fm session keys never expire and the Last.fm API has no call to revoke one, so Disconnect cannot invalidate the key at Last.fm's end. Remove Sidra under [Applications in your Last.fm settings](https://www.last.fm/settings/applications) to do that.

## What Sidra does not collect

Sidra has no server, no analytics, and no telemetry. Your listening data goes to Last.fm and nowhere else. Sidra's developers never see it.

## Last.fm's privacy policy

Once Last.fm receives your scrobbles, Last.fm's own practices apply, including how your listening history appears on your Last.fm profile. See [Last.fm's Privacy Policy](https://www.last.fm/legal/privacy).

## Changes to this policy

This policy may be updated. All changes will appear in the [Sidra repository](https://github.com/wimpysworld/sidra).

## Contact

Report concerns or questions at [github.com/wimpysworld/sidra/issues](https://github.com/wimpysworld/sidra/issues).
