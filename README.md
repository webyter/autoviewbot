# AutoViewer

AutoViewer is a multi-user WhatsApp automation platform built on Node.js and [Baileys](https://github.com/WhiskeySockets/Baileys). It runs a web dashboard (manager) that lets each user link their own WhatsApp account, configure automation, and manage the bot — with per-user workers, durable recovery, and production-oriented operational tooling.

> **Unofficial API notice:** AutoViewer uses the unofficial WhatsApp Web API via Baileys. Using unofficial clients can violate WhatsApp’s terms and may result in account restrictions or bans. Use at your own risk.

## Features

### Automation & recovery
- **Auto status** — view statuses automatically and optionally react with custom emojis.
- **Anti-delete** — recover deleted messages and statuses in real time.
- **View-once & media tools**
  - `.vv` retrieves media from a quoted original when the bot has its encryption metadata. Some view-once quotes omit the key and download location; if the primary phone cannot supply the original, recovery is unavailable.
  - `.antivv on/off` auto-reveals incoming view-once media to your chat.
  - `.media` / `.save` saves media/status content.
  - Expired media recovery asks the **sender’s device** to re-upload when possible (see `lib/media.js`), working around Baileys rc14 media/reupload edge cases.
- **Durable recovery cache** — message/status data is persisted to disk (`lib/store.js`) so recovery can survive restarts.

### ChatAI (Groq)
- DM auto-reply with model fallback, voice-note transcription, per-chat memory, allow/block lists, and configurable persona.
- **No API key is shipped.** Set your own `GROQ_API_KEY` (env or `.env`) to enable ChatAI and transcription; without it, AI features stay off.

### Group & engagement tools
- **Moderation/admin:** kick, promote/demote, mute/unmute, tagall, join-request handling (`.requests/.approve/.reject`), disappearing messages, join/add modes, group description, invite revoke, group info/rules.
- **Anti-link:** deletes links in groups (a **group-admin tool** — requires Group Admin Tools to be enabled).
- **Engagement:** native polls and fun commands (`.flip`, `.roll`, `.pick`, `.8ball`, `.love`, `.joke`, `.quote`).

### Platform, safety & operations
- **Multi-user dashboard** with QR linking per account.
- **Invite-only registration:** the first account becomes the platform admin; after that registration requires an invite code (`INVITE_CODE` or codes managed in the admin panel). Registration is closed when no codes are configured.
- **Admin panel:** user/bot overview, feature matrix, invite-code management, announcements, and bot limits.
- **Safety controls:** single-instance lock, session-preserving crash handling, session manager (list/revoke logins), and an admin audit log.
- **Health & keep-alive:** `/health`, `/livez`, `/readyz` endpoints and idle-host keep-alive support (Render/Railway/Fly/Replit detection + optional external pinger workflow).

## Requirements

- **Node.js >= 20** (tested on 20/22)
- **npm**
- A **persistent disk** for `SESSION_DIR` (WhatsApp credentials + user DB). Ephemeral filesystems will log users out on restart/redeploy.
- Linux with **systemd** recommended for production (Docker and Render are also supported)

## Quick start (local)

```bash
git clone https://github.com/webyter/autoviewbot.git
cd autoviewbot
npm install
cp .env.example .env
# edit .env — set SESSION_SECRET and (optionally) GROQ_API_KEY, INVITE_CODE, etc.
npm start
```

Open `http://localhost:3000`.

- The **first registered account becomes the platform admin**.
- Link WhatsApp from the dashboard by scanning the QR code.
- Run tests: `npm test` (88 checks across 9 suites).

## Configuration

Configuration is loaded from environment variables (and by default from `config.env` / `.env`, or files listed in `CONFIG_ENV_FILES`). See [`.env.example`](.env.example) for the full, documented list.

| Variable | Purpose | Notes |
| --- | --- | --- |
| `GROQ_API_KEY` | ChatAI + voice-note transcription | **Not shipped.** Required for AI features. |
| `GROQ_MODEL` | Chat model | Default `openai/gpt-oss-120b` (with fallbacks). |
| `SESSION_SECRET` | Signs dashboard session cookies | Recommended to set explicitly; if unset, a secret is generated/persisted in `SESSION_DIR`. |
| `PORT` | HTTP port | Default `3000`. |
| `PUBLIC_URL` | Public HTTPS base URL | Recommended for correct invite links and keep-alive pings. |
| `SESSION_DIR` | Sessions + user DB path | Default `./session` — must be persistent. |
| `INVITE_CODE` | Registration codes | Comma-separated; admin-panel codes also work. If none exist after the first account, registration is closed. |
| `ADMIN_USERNAMES` | Platform admins | Comma-separated usernames promoted at registration/restart. |
| `ADMIN_CONTACT` | Contact shown on auth pages | Default `233531556024`. |
| `MAX_INSTANCES` | Max concurrent bots | Also adjustable in the admin panel. |
| `COOKIE_SECURE` | Secure session cookie | `true` behind TLS, `false` for plain HTTP (unset ⇒ secure in production). |
| `TRUST_PROXY` | Proxy hop count | Set correctly when behind nginx/Caddy/Render. |
| `KEEPALIVE_URL` / `KEEPALIVE_INTERVAL_MIN` | Keep-alive tuning | Platform auto-detected; interval clamped (default ~9 min). |

For the complete production reference, see [`docs/PRODUCTION.md`](docs/PRODUCTION.md).

## Deployment

### VPS with systemd (recommended)

```bash
git clone https://github.com/webyter/autoviewbot.git
cd autoviewbot
npm ci --omit=dev
cp .env.example .env   # configure SESSION_SECRET, GROQ_API_KEY, PUBLIC_URL, INVITE_CODE, ADMIN_USERNAMES, etc.

sudo cp deploy/autoviewer.service /etc/systemd/system/autoviewer.service
# adjust User/Group/WorkingDirectory/ReadWritePaths in the unit to match your install
sudo systemctl daemon-reload
sudo systemctl enable --now autoviewer
```

- Put **nginx/Caddy + TLS** in front and set `COOKIE_SECURE=true` (and the correct `TRUST_PROXY`).
- **Do not run `node autoviewer.js` manually** while the service is running — the app enforces a single-instance lock (`session/autoviewer.lock`) to prevent port/worker conflicts.
- Day-to-day ops, backups, and monitoring: [`docs/OPERATIONS.md`](docs/OPERATIONS.md).

### Docker

```bash
docker build -t autoviewer .
docker run -d --name autoviewer \
  -p 3000:8080 \
  -v autoviewer-data:/app/session \
  -e PUBLIC_URL=https://bot.example.com \
  -e SESSION_SECRET="$(openssl rand -hex 32)" \
  -e GROQ_API_KEY="your_key_here" \
  --restart unless-stopped \
  autoviewer
```

Terminate TLS at a reverse proxy and forward `X-Forwarded-Proto` / `X-Forwarded-For`. The container serves HTTP on `8080` by default.

### Render

`render.yaml` is included (and can be regenerated with `npm run render:init`).

1. Push the repo to GitHub and create a Render Web Service from it.
2. Set secrets/values in the Render dashboard (`GROQ_API_KEY`, `PUBLIC_URL`, `ADMIN_USERNAMES`, `INVITE_CODE` as needed). `SESSION_SECRET` can be generated by the blueprint.
3. **Persistence:** Render Free uses an **ephemeral filesystem** — sessions and the user DB are lost on spin-down/restart/redeploy. For durable use, attach a persistent disk (and point `SESSION_DIR` to it), use a paid plan, or host on a VPS.
4. **Keep-alive:** the app can self-ping to reduce idle spin-downs, but a sleeping service must be woken externally. Set the GitHub Actions secret `SELF_URL=https://<your-service>.onrender.com` to enable `.github/workflows/keep-alive.yml` (cron ping), and/or use an external monitor (e.g. UptimeRobot, cron-job.org).

## WhatsApp commands

Use `.menu` in chat for the live command list. Highlights:

| Area | Commands |
| --- | --- |
| General | `.menu`, `.ping`, `.alive`, `.settings`, `.clear` |
| ChatAI | `.chatai on/off`, `.persona <text>\|clear`, `.allow add/del/list <number>`, `.block add/del/list <number>` |
| Access | `.mode public/self` (owner-only controls remain locked) |
| Automation | `.autostatus`, `.statusreact`, `.antidelete`, `.antideletestatus`, `.antitagstatus`, `.antivv` |
| Group admin/moderation | `.groupadmin`, `.antilink`, `.admin add/del/list`, `.kick/.promote/.demote`, `.mute/.unmute`, `.tagall`, `.requests/.approve/.reject`, `.ephemeral`, `.joinmode`, `.addmode`, `.desc`, `.revoke`, `.rules`, `.leave` |
| Status & media | `.save`, `.media`, `.vv` |
| Engagement | `.poll`, `.flip`, `.roll`, `.pick`, `.8ball`, `.love`, `.joke`, `.quote` |

Notes: `.vv`/`.antivv` and anti-delete recovery depend on message availability and (for expired media) the sender’s device being online to re-upload. Anti-link requires Group Admin Tools to be enabled.

## Health, scripts & maintenance

- **Health endpoints:** `GET /health` (telemetry), `GET /livez` (liveness), `GET /readyz` (readiness: DB/session dir/workers)
- **Preflight:** `scripts/preflight.sh`
- **Backups:** `scripts/backup.sh /path/to/backup-dir` archives the complete configured session directory, including encryption keys and administrator settings. Stop the service for a consistent snapshot and store the archive securely. The settings-import API restores only validated user-editable settings.
- **Render blueprint:** `npm run render:init` (regenerates `render.yaml` without writing secrets)

## Project layout

```text
autoviewer.js         Manager (HTTP dashboard/API, lifecycle, single-instance guard)
bot_worker.js         Per-user WhatsApp worker (Baileys)
commands.js           WhatsApp dot-command engine
lib/                  Core modules (db, media, store, groqAI, invites, audit, keepalive, etc.)
views/                Dashboard/auth UI assets
scripts/              Ops & tooling (preflight, backup, render config, helpers)
deploy/               systemd unit
docs/                 Production and operations guides
test/                 Test suites (run via npm test)
```

## Documentation

- [`docs/PRODUCTION.md`](docs/PRODUCTION.md) — production runbook, configuration, Docker/Render, hardening, troubleshooting
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — day-to-day operations, service management, feature map
- [`CHANGELOG.md`](CHANGELOG.md) — notable changes

## License

Apache-2.0 (see `package.json`). This project depends on third-party packages under their respective licenses.
