# AutoViewer Multi-User Platform

Production-ready WhatsApp automation with iOS Glass UI.

## Features
- 👁️ **Auto Status**: View & React (Custom Emojis)
- 🛡️ **Anti-Delete**: Real-time recovery
- 🤖 **ChatAI**: DM automation via Groq
- 📱 **Link Method**: QR Code or Pairing Code
- 👥 **Multi-User**: Independent instances for everyone
- 👑 **Admin**: Set `ADMIN_USERNAMES` (comma separated) in your environment — matching accounts are granted platform admin at registration, and existing accounts are promoted on restart

## Hosting on Render
To host this platform on Render, follow these steps:

1. **GitHub**: Push this code to your GitHub repository.
2. **Deploy**: Click the "Deploy to Render" button or create a new "Web Service".
3. **Persistence**: On the **free plan** Render has no persistent disk — every restart or deploy wipes the filesystem. This repo ships two countermeasures:
   - **Keep-alive**: the manager self-pings `/health` every 10 min (uses `PUBLIC_URL`, or `RENDER_EXTERNAL_URL` automatically on Render) so the free service never sleeps after 15 idle minutes.
   - **Session backup**: set `BACKUP_SUPABASE_URL`, `BACKUP_SUPABASE_KEY` (service_role key) and create a **private** Supabase Storage bucket named in `BACKUP_BUCKET`. The `session/` directory is AES-256-GCM encrypted (key derived from `SESSION_SECRET`) and synced to the bucket every 3 minutes when dirty, restored automatically on boot, and uploaded once more on shutdown. Without this, users are logged out on every restart.
   - On paid plans with a Persistent Disk (Mount Path: `/home/graile/autoviewbot/session`), the backup is a harmless redundancy.

## Local Run
```bash
npm install
npm start
```
Go to `http://localhost:3000`
