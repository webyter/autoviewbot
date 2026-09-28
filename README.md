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

## Hosting on a VPS
```bash
git clone https://github.com/webyter/autoviewbot && cd autoviewbot
npm install
cp .env.example .env   # then edit: SESSION_SECRET, GROQ_API_KEY, INVITE_CODE, ADMIN_USERNAMES
npm i -g pm2 && pm2 start autoviewer.js --name autoviewer && pm2 save && pm2 startup
```
Sessions persist in `./session/` on the VPS disk. Put nginx + certbot in front for HTTPS.

## Local Run
```bash
npm install
npm start
```
Go to `http://localhost:3000`
