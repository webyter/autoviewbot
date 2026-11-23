# Operations Guide

## The service is managed by systemd

`autoviewer.service` runs the manager. **Do not start the manager manually** —
a second instance would fight the service for port 3000 and kill the workers.

```bash
sudo systemctl status autoviewer.service   # status + recent logs
sudo systemctl restart autoviewer.service  # restart (picks up new code)
sudo systemctl stop autoviewer.service
sudo systemctl start autoviewer.service
journalctl -u autoviewer.service -f        # live logs
journalctl -u autoviewer.service --since "-10m"
```

The manager forks one worker per linked account (`bot_worker.js <username>`).
Workers are restarted automatically by the manager; a crash loop is visible in
`journalctl` and the dashboard shows the account as `error`.

### Single-instance guard

The manager writes its PID to `session/autoviewer.lock`. A second instance
exits immediately with:
`[Manager] Another autoviewer instance is already running (pid N). Exiting…`
This is intentional — it prevents duplicate workers and account conflicts
(the "MessageCounterError / 428" symptom).

## Keep-alive (idle hosts)

Hosts that sleep on idle (Render Free spins down after 15 min) are detected
automatically (`RENDER`, `RAILWAY_ENVIRONMENT`, `FLY_APP_NAME`, `REPL_ID`).
When a public URL is known the app requests `<public url>/health` every
~9 minutes so it never reaches the idle window.

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | The app's public address (used for invite links AND keep-alive) |
| `KEEPALIVE_URL` | Override the URL that gets pinged |
| `KEEPALIVE_INTERVAL_MIN` | Ping interval in minutes (2-14, default 9) |

`GET /health` reports the keep-alive telemetry (`keepAlive.pings`,
`failures`, `lastPingAt`, `lastStatus`) — a background job with no visible
signal is indistinguishable from one that silently died.

Self-ping **prevents** sleep; it cannot **wake** a sleeping service. Use the
shipped `.github/workflows/keep-alive.yml` (set the `SELF_URL` repo secret) or
an external monitor (UptimeRobot / cron-job.org) to wake it after a spin-down.

## Layout

```
autoviewer.js         manager: HTTP dashboard, API, per-user bot lifecycle
bot_worker.js         per-user WhatsApp worker (Baileys socket)
commands.js           dot-command engine (.menu .ping .vv .media .poll …)
lib/
  db.js               user database (session/users.json) + write queue
  invites.js          invite codes
  session-store.js    file-backed express-session store
  groqAI.js           Groq chat + Whisper transcription, model fallback
  media.js            resilient media download + re-upload (view-once, anti-delete)
  store.js            durable recovery cache (survives restarts)
  backup.js           settings import (export was removed)
  audit.js            append-only admin audit log
  forward.js          shared message forward/copy helper
  render-config.js    auto-generated Render blueprint
  keepalive.js        idle-sleep keep-alive (Render & friends)
session/
  users.json          user database
  <user>/             WhatsApp credentials + recovery-cache.json
```

## Feature map

| Area | Commands / API |
| --- | --- |
| Status & media | `.save`, `.media`, `.vv`, `.antivv on/off` |
| ChatAI | `.chatai`, `.persona`, `.allow`, `.block` |
| Group moderation | `.kick .promote .demote .mute .unmute .tagall`, `.antilink`, `.requests .approve .reject`, `.ephemeral`, `.joinmode`, `.addmode`, `.desc`, `.revoke`, `.leave`, `.rules` |
| Engagement | `.poll`, `.flip .roll .pick .8ball .love .joke .quote` |
| Dashboard API | `/api/backup/import` |

### View-once / expired media

`lib/media.js` implements a download path that works around three upstream
Baileys rc14 bugs (see `test/media.js`):

1. Baileys checks `error.status`, but Boom keeps the status in
   `error.output.statusCode` → its built-in re-upload never fired.
2. Baileys rejects media that has no `url` key (current WhatsApp delivers
   view-once media with only `directPath` + `mediaKey`).
3. `getMediaRetryKey()` does not decode a base64 `mediaKey` → wrong retry key.

If the media is gone from the CDN, the bot requests re-upload through the
primary phone. Recovery requires the original encryption key and an available
copy. Some view-once quotes omit the key and download location; `.vv` requests
the original from the primary phone, but cannot decrypt it if that metadata
is not returned. A successful mock test does not establish recoverability of
such a message.

## Environment

| Variable | Purpose |
| --- | --- |
| `SESSION_DIR` | where sessions + the DB live (default `./session`) |
| `SESSION_SECRET` | signs the dashboard session cookies |
| `GROQ_API_KEY` | ChatAI + transcription |
| `GROQ_MODEL` | chat model (default `openai/gpt-oss-120b`; must exist for the key) |
| `MAX_INSTANCES` | max concurrent bots (also settable in the admin panel) |
| `PUBLIC_URL` | public base URL for invite links + keep-alive ping |
| `ADMIN_USERNAMES` | comma-separated usernames promoted to platform admin |
| `INVITE_CODE` | extra registration codes (also managed in the admin panel) |

## Pre-flight check

```bash
scripts/preflight.sh
```
Validates the runtime, dependencies, session dir + permissions, secrets,
proxy/TLS cookie settings, port availability, the service state and whether
more than one manager is running. Run it before a deploy and after a reboot.

## Backups

### Creating a backup
```bash
scripts/backup.sh /var/backups/autoviewer
```
Writes a `0600` tarball containing the complete configured `SESSION_DIR`,
including encryption keys, user DB, invite store, session secret, administrator
settings and login sessions. It loads the same configuration files as the app
and follows a symlink used as the session-directory path. Store the archive
privately and choose a destination outside `SESSION_DIR`.

For a consistent snapshot, stop the service before backup. To restore, stop
the service, extract the archive to a staging directory, copy the extracted
`session/` contents into the configured `SESSION_DIR`, then start the service.
The live manager lock is excluded from the archive.

Settings **export** was removed — there is no backup download endpoint.
`POST /api/backup/import` remains so a settings file exported earlier can
still be restored. Import accepts only validated user-editable settings;
account roles, rental expiry, lifecycle state and secrets cannot be imported.
This API does not restore WhatsApp credentials; the full archive does.
