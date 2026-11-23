# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and
the project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0]

### Added
- **View-once / anti-delete media recovery** — `.vv` reveals view-once media,
  `.antivv on` auto-reveals incoming view-once to the owner, `.media` saves
  any photo/video/audio/document. Expired media is recovered by asking the
  sender's device to re-upload it.
- **Durable recovery cache** (`lib/store.js`) — the message/status cache is
  written to disk, so recovery survives a bot restart.
- **Group moderation**: join-request approval (`.requests/.approve/.reject`),
  disappearing messages (`.ephemeral`), join-approval and member-add modes
  (`.joinmode/.addmode`), group description (`.desc`), invite revocation
  (`.revoke`), group info (`.rules`).
- **Engagement**: native polls (`.poll`).
- **Admin panel**: live feature matrix per user, invite generator, announcement
  broadcast, Max Bots control, search.
- **Session manager** — an account can list its logins and revoke the others
  (`/api/sessions`, `/api/sessions/revoke-all`).
- **Audit log** (`lib/audit.js`) — append-only record of privileged actions,
  exposed at `/api/admin/audit`.
- **Health probes** — `/livez` (liveness), `/readyz` (readiness: DB + session
  dir), `/health` (full telemetry incl. keep-alive state).
- **Keep-alive** (`lib/keepalive.js`) — detects Render/Railway/Fly/Replit and
  pings the public URL every ~9 minutes so idle hosts never spin down.
- **Auto-generated Render blueprint** (`lib/render-config.js`,
  `npm run render:init`) — the deploy config is generated from the code, never
  writes secrets, and is refreshed at runtime on Render.
- **GitHub Actions keep-alive workflow** — the external pinger that can *wake*
  a sleeping service.
- **Production tooling**: hardened systemd unit (`deploy/autoviewer.service`),
  `scripts/preflight.sh`, `scripts/backup.sh`.
- **Tests**: 88 checks across 9 suites (smoke, media, media streaming,
  features, worker boot, rendered pages, keep-alive, render config, groq key).

### Fixed
- **Media download on Baileys rc14** — three upstream bugs made view-once
  recovery impossible: the re-upload path checked `error.status` while Boom
  keeps the code in `error.output.statusCode`; media without a `url` key (the
  normal shape for view-once) was rejected outright; and a base64 `mediaKey`
  produced a wrong retry key.
- **View-once detection** now uses Baileys' `key.isViewOnce` in addition to
  wrapper inspection.
- **Anti-delete recovery** reads through to the durable cache, so a delete
  that arrives after a restart is still recovered.
- **Dashboard** — a single broken character in the inline script killed every
  control on the page (toggles, save buttons, QR polling). The rendered pages
  are now parsed by a test so it cannot regress.
- **Admin panel** — number inputs stretched to full width (a `flex:1` rule
  overrode their width) and their native spinners rendered as white boxes in
  the dark UI; the "copy invite link" button used the destructive red style
  next to Delete.
- **A code crash no longer logs users out** — the manager distinguishes code
  crashes from session failures and never wipes a linked session.
- **Media is streamed to disk** instead of buffered, so a large video no
  longer has to fit in RAM (Render free instances have 512 MB).

### Security
- Strict `Content-Security-Policy`, HSTS (when TLS is used),
  `Cross-Origin-Opener-Policy`, `Cross-Origin-Resource-Policy`.
- Rate limits on every mutating endpoint.
- `COOKIE_SECURE` control so plain-HTTP deployments do not silently lose the
  session cookie.

### Changed
- Anti-Link is a **group-admin tool**: it requires "Group Admin Tools" to be
  enabled, and turning that off also switches anti-link off.
- The ChatAI prompt is tuned to reply like a real person, with no business scoping.

## [1.0.0]

- Initial multi-user platform: per-user WhatsApp linking, auto status
  viewing/reactions, anti-delete, ChatAI (Groq), group moderation, invite-only
  registration, admin panel.
