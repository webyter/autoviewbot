# syntax=docker/dockerfile:1
FROM node:20-slim

# procps for basic diagnostics, tini for correct PID-1 signal handling
# (the manager must receive SIGTERM so it can stop its workers cleanly).
RUN apt-get update && apt-get install -y --no-install-recommends procps tini \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080
# The dashboard is served over plain HTTP inside the container; terminate TLS
# at the reverse proxy and keep the cookie usable (set COOKIE_SECURE=true when
# the proxy forwards HTTPS and you want the secure cookie).
ENV COOKIE_SECURE=false
ENV TRUST_PROXY=1

# Reproducible installs from the lockfile.
COPY package*.json ./
RUN npm ci --omit=dev --no-audit --no-fund || npm install --omit=dev --no-audit --no-fund

COPY . .

# Session dir (WhatsApp creds) and data dir (JSON DB) must be writable by the
# unprivileged runtime user.
RUN mkdir -p /app/session /app/data && chown -R node:node /app/session /app/data

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tini reaps zombies and forwards SIGTERM to node
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "autoviewer.js"]
