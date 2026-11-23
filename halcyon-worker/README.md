# Halcyon Worker

Requires Node.js >=22.13. No external npm dependencies are required.

Setup is configured in `.env` (private, excluded from git). The generated admin password is stored there. Run `npm start` to start manually, or `pm2 start ecosystem.config.cjs` for supervised operation. The configured port is 8787. Do not run both at once.

Run `npm test` for the included regression suite. SQLite data persists in `.data/halcyon.sqlite`; back up the data directory while stopped.

The server binds to all interfaces for access through the host. For local access only, set HOST=127.0.0.1. Use HTTPS via a reverse proxy for public deployment and set SITE_URL to that HTTPS origin.

Without Stripe credentials, checkout runs in sandbox mode and does not charge money. To enable payments, configure STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET in `.env`, configure the Stripe webhook endpoint `/api/webhook`, and restart with `pm2 restart halcyon-worker`.

Useful commands: `pm2 logs halcyon-worker`, `pm2 restart halcyon-worker`, `pm2 stop halcyon-worker`.
