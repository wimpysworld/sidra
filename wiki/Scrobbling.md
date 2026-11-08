## Last.fm scrobbling

Nothing is sent to Last.fm until you connect an account. In Settings, choose **Connect to Last.fm…**, then approve Sidra in your browser. Settings and the tray show your username after approval. Sidra also sends a notification if notifications are on.

Use Settings or the tray **Last.fm** submenu to turn scrobbling on or off, or disconnect. You can also connect through that submenu. Sidra sends the now-playing track when playback starts or resumes, and scrobbles it once it has played for half its length or four minutes, whichever comes first. Tracks of 30 seconds or less never scrobble - that is Last.fm's rule, not Sidra's. When a scrobble cannot reach Last.fm, Sidra holds the play and sends it with the next one that gets through, so a dropped connection does not cost you it.

Sidra also scrobbles individual songs from live radio and archived shows. Radio songs have no reported duration, so they scrobble after four minutes of active playback. A song can scrobble at the next confirmed song change if Sidra observed its start and more than 30 seconds of playback. The first song joined part-way through uses the four-minute fallback.

Connecting stores a Last.fm session key and your username in Sidra's configuration file, in plain text:

- Linux: `~/.config/Sidra/config.json`
- macOS: `~/Library/Application Support/Sidra/config.json`
- Windows: `%APPDATA%\Sidra\config.json`

> [!IMPORTANT]
> Last.fm session keys never expire, and the Last.fm API has no call to revoke one. **Disconnect** deletes Sidra's copy of the key, which stops this installation scrobbling, but only Last.fm can invalidate the key itself. Remove Sidra under [Applications in your Last.fm settings](https://www.last.fm/settings/applications) to do that. Sidra notices the revoked session on its next request, disconnects, and tells you.

What Sidra sends is listed in [`docs/LASTFM-PRIVACY.md`](https://github.com/wimpysworld/sidra/blob/main/docs/LASTFM-PRIVACY.md).

## Custom scrobble endpoint

Sidra can send to [multi-scrobbler's Last.fm Endpoint](https://docs.multi-scrobbler.app/configuration/sources/lastfm-endpoint/) instead of Last.fm. Multi-scrobbler then forwards plays to its configured clients.

Quit Sidra before you edit `config.json` at the path above. Add `apiUrl` inside the existing `lastfm` object and set `enabled` to `true`:

```json
{
  "lastfm": {
    "apiUrl": "http://localhost:9078/2.0/",
    "enabled": true
  }
}
```

Keep your other configuration fields. Restart Sidra to select the endpoint. Settings and the tray show **Custom scrobbler**, with an on/off control and no browser authentication.

Use the complete endpoint URL. Sidra appends no path. For a multi-scrobbler source with `slug: "sidra"`, use `http://localhost:9078/api/lastfm/sidra` instead. Configure one default Last.fm Endpoint source without credentials, or use a slug to select a source. Sidra sends the dummy values `sidra` for `api_key` and `sk`, and signs with the dummy secret `sidra`. It never sends your saved Last.fm account or Sidra's real application credentials to this endpoint.

HTTP and HTTPS are supported. HTTP sends listening data without encryption. URLs with embedded credentials, query parameters or fragments are rejected. Redirects are not followed. An invalid URL disables scrobbling and never falls back to Last.fm.

The usual playback thresholds, radio handling and queue limit still apply. A destination change discards held plays on the next launch, so they cannot reach another destination. **Off** keeps held plays and any saved Last.fm account. Remove `apiUrl` or set it to `null`, then restart, to return to Last.fm. The shared `enabled` setting still applies.

Only one destination is active per launch. This option does not add native ListenBrainz support or configure multi-scrobbler's downstream clients. A successful request confirms endpoint receipt, not downstream delivery.
