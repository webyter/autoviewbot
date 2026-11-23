# AutoViewer

A lightweight multi-user WhatsApp automation platform with a web dashboard, QR linking, auto-status viewing, anti-delete recovery, and AI chat integration.

> **Disclaimer:** AutoViewer uses the unofficial WhatsApp Web API via Baileys. Use responsibly and at your own risk.

---

## Features

- **Auto Status & Reactions:** Automatically view statuses and react with emojis.
- **Message Recovery:** Anti-delete and view-once media retrieval.
- **AI Integration (Groq):** Smart auto-reply, persona customization, and voice note transcription.
- **Group Management:** Anti-link protection, admin tools, kick/promote, announcements, and polls.
- **Multi-User Dashboard:** Web panel with QR code pairing for managing individual bot instances.

---

## Quick Start

### Requirements
- Node.js >= 20
- npm

### Installation

```bash
git clone https://github.com/webyter/autoviewbot.git
cd autoviewbot
npm install
cp .env.example .env
npm start
```

Open `http://localhost:3000` in your browser. The first registered account automatically becomes the administrator.

---

## Key Environment Variables

Configure these in `.env`:

| Variable | Description | Default |
| :--- | :--- | :--- |
| `PORT` | Web dashboard port | `3000` |
| `SESSION_SECRET` | Session cookie encryption secret | Auto-generated |
| `GROQ_API_KEY` | Groq API key for ChatAI & audio transcription | *(Optional)* |
| `INVITE_CODE` | Registration codes (comma-separated) | *(Optional)* |
| `PUBLIC_URL` | Public base URL for invite links & webhooks | *(Optional)* |

See [`.env.example`](.env.example) for all available options.

---

## Common WhatsApp Commands

Send `.menu` in any WhatsApp chat to view all available commands:

- **Automation:** `.autostatus`, `.statusreact`, `.antidelete`, `.antivv`
- **AI Chat:** `.chatai on/off`, `.persona <text>`
- **Tools:** `.vv`, `.media`, `.save`, `.poll`
- **Group Admin:** `.antilink on/off`, `.tagall`, `.mute`, `.kick`

---

## Documentation

- [Production Guide](docs/PRODUCTION.md) — VPS, Docker, and Render deployment guides.
- [Operations Guide](docs/OPERATIONS.md) — Backups, updates, and maintenance.

---

## License

Apache-2.0
