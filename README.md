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
3. **Persistence**: ⚠️ **IMPORTANT**: Because this is a multi-user platform, you **must** add a **Persistent Disk** to your Render service (Mount Path: `/home/graile/autoviewbot/session`). Otherwise, your users will be logged out every time the bot restarts.

## Local Run
```bash
npm install
npm start
```
Go to `http://localhost:3000`
