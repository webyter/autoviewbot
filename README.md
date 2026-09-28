# AutoViewer Multi-User Platform

Production-ready WhatsApp automation with iOS Glass UI.

## Features
- 👁️ **Auto Status**: View & React (Custom Emojis)
- 🛡️ **Anti-Delete**: Real-time recovery
- 🤖 **ChatAI**: DM automation via Groq
- 📱 **Link Method**: QR Code or Pairing Code
- 👥 **Multi-User**: Independent instances for everyone
- 🎟 **Invite Codes**: Generate, revoke, and track registration codes from the admin panel (single-use caps and expiry supported); `INVITE_CODE` env entries stay valid alongside them
- 🔐 **Invite-Only**: Registration requires an invite code (set `INVITE_CODE`; comma separated for multiple). Without it, registration is closed. Users are pointed to the admin's WhatsApp (`ADMIN_CONTACT`, default 233531556024) for accounts and problems.
- 👑 **Admin**: Set `ADMIN_USERNAMES` (comma separated) in your environment — matching accounts are granted platform admin at registration, and existing accounts are promoted on restart

## Hosting on Render
To host this platform on Render, follow these steps:

1. **GitHub**: Push this code to your GitHub repository.
2. **Deploy**: Click the "Deploy to Render" button or create a new "Web Service".
3. **Persistence**: On the **free plan** Render has no persistent disk — every restart or deploy wipes the filesystem, logging users out. For real use, host on a VPS (see below) or a paid plan with a Persistent Disk (Mount Path: `/opt/render/project/src/session`). The built-in keep-alive (self-pings `/health` via `PUBLIC_URL` or `RENDER_EXTERNAL_URL`) prevents the free tier's 15-min idle sleep.
4. **Environment** (dashboard → Environment). Only `GROQ_API_KEY` and `INVITE_CODE` are genuinely required; the rest have safe defaults on Render:

   | Variable | Required | What it does |
   | --- | --- | --- |
   | `GROQ_API_KEY` | yes | ChatAI (transcription + replies). Set it in the dashboard — never in the repo. |
   | `INVITE_CODE` | no | Comma-separated registration codes. Unset = registration closed, unless you generate codes in the Admin Panel. |
   | `SESSION_SECRET` | no | Signs session cookies. Render generates one if unset, but a generated secret changes on restart, so set your own for anything real. |
   | `PUBLIC_URL` | recommended | The app's public HTTPS URL. Used for **copyable invite links** and the keep-alive self-ping. Without it, invite links fall back to `RENDER_EXTERNAL_URL` and then to the request's host header — which is whatever the browser sent, so a misconfigured proxy can hand out links that point at the wrong place. Set it. |
   | `ADMIN_USERNAMES` | no | Comma-separated usernames promoted to platform admin at registration and on restart. |
   | `ADMIN_CONTACT` | no | WhatsApp number shown on the login/register pages. |

   `render.yaml` mirrors these (`SESSION_SECRET` via `generateValue`, the rest via `sync: false`, so you fill them in the dashboard).

## Hosting on a VPS
```bash
git clone https://github.com/webyter/autoviewbot && cd autoviewbot
npm install
cp .env.example .env   # then edit: SESSION_SECRET, GROQ_API_KEY, INVITE_CODE, PUBLIC_URL, ADMIN_USERNAMES
npm i -g pm2 && pm2 start autoviewer.js --name autoviewer && pm2 save && pm2 startup
```
Sessions persist in `./session/` on the VPS disk. Put nginx + certbot in front for HTTPS.

## Local Run
```bash
npm install
npm start
```
Go to `http://localhost:3000`
