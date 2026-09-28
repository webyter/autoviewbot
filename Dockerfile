FROM node:20-slim

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

COPY package*.json ./
RUN npm install --production

COPY . .

# Session dir (WhatsApp creds) and data dir (JSON DB) must be writable by the
# unprivileged runtime user.
RUN mkdir -p /app/session /app/data && chown -R node:node /app/session /app/data

USER node

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "autoviewer.js"]
