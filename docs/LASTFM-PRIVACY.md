# Privacy Policy - Last.fm scrobbling

This policy covers Sidra's scrobbling feature, including its optional custom endpoint.

## What the feature does

Scrobbling is off by default. Connect a Last.fm account through Settings or the tray to send listening data to Last.fm over HTTPS. Alternatively, configure a custom endpoint and enable scrobbling as described in the [README](../README.md#custom-scrobble-endpoint).

## What is shared with Last.fm

For each track, Sidra sends:

- Track title
- Artist name
- Album name (when the player reports one)
- Track length (when the player reports one)
- The time playback started (with a scrobble only)

A now-playing update goes out when a track starts or resumes, and a scrobble once the track has played far enough to qualify. A radio scrobble also carries a flag that says the station chose the track. Nothing is sent while scrobbling is off. Official Last.fm also requires a connected account.

## Custom endpoint

When selected, a custom endpoint receives the same listening fields instead of Last.fm. Sidra sends dummy authentication values, never your saved Last.fm session, username or Sidra's real application credentials. HTTP endpoints receive data without encryption. Sidra does not follow redirects.

Your endpoint can forward plays to other services, according to its configuration and privacy practices. Sidra sends to one destination per launch. A successful response confirms receipt at the endpoint, not delivery to its downstream services.

## What is stored on your machine

Connecting stores a Last.fm session key and your Last.fm username in Sidra's configuration file (`config.json` in Sidra's user data directory), in plain text. The session key authorises scrobbling to your account. It goes nowhere except Last.fm.

When a scrobble cannot reach Last.fm, because the connection dropped for example, the same file holds that play until the next request carries it out. Each held play is a track title, artist name and the time playback started, plus the album name and track length when the player reported them. A play from a radio station also keeps the flag saying the station chose it. At most 50 are held, and the oldest goes once that is full.

Custom endpoints use the same queue. The configuration file stores the full endpoint URL and a hash that identifies its queue destination. On the next launch after a destination change, Sidra discards held plays. Endpoint values and custom server error messages are not logged.

## Turning it off and revoking access

- **Off** in the tray Last.fm submenu stops scrobbling and keeps the account linked.
- **Disconnect** deletes the session key, the username and any held plays from your machine.
- **Off** under **Custom scrobbler** stops custom requests but keeps held plays and your saved Last.fm account. Remove `lastfm.apiUrl` and restart to return to Last.fm. The shared on/off preference still applies.

Last.fm session keys never expire and the Last.fm API has no call to revoke one, so Disconnect cannot invalidate the key at Last.fm's end. Remove Sidra under [Applications in your Last.fm settings](https://www.last.fm/settings/applications) to do that.

## What Sidra does not collect

Sidra has no server, no analytics, and no telemetry. Listening data goes to Last.fm or your selected custom endpoint. Sidra's developers do not receive it.

## Last.fm's privacy policy

Once Last.fm receives your scrobbles, Last.fm's own practices apply, including how your listening history appears on your Last.fm profile. See [Last.fm's Privacy Policy](https://www.last.fm/legal/privacy).

## Changes to this policy

This policy may be updated. All changes will appear in the [Sidra repository](https://github.com/wimpysworld/sidra).

## Contact

Report concerns or questions at [github.com/wimpysworld/sidra/issues](https://github.com/wimpysworld/sidra/issues).
