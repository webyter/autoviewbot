'use strict';

// Static frontend + reverse proxy for the AutoViewer dashboard.
//
// The v1 backend (autoviewer.js) is left untouched. It listens on
// BACKEND_PORT (default 3001) and this server listens on PORT (default 3000),
// serves the static frontend from ./public, and proxies every other request
// (including /api/*) to the backend.

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const BACKEND_PORT = Number(process.env.BACKEND_PORT || 3001);
const BACKEND_HOST = process.env.BACKEND_HOST || '127.0.0.1';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, headers);
  res.end(body);
}

function proxy(req, res) {
  const headers = { ...req.headers };

  // Preserve the original client for the backend's logging / rate limits.
  const clientIp = req.socket.remoteAddress || '';
  if (headers['x-forwarded-for']) {
    headers['x-forwarded-for'] = `${headers['x-forwarded-for']}, ${clientIp}`;
  } else {
    headers['x-forwarded-for'] = clientIp;
  }
  if (!headers['x-forwarded-proto']) headers['x-forwarded-proto'] = 'http';
  if (!headers['x-forwarded-host']) headers['x-forwarded-host'] = headers.host || '';

  const proxyReq = http.request(
    {
      host: BACKEND_HOST,
      port: BACKEND_PORT,
      method: req.method,
      path: req.url,
      headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );

  proxyReq.on('error', (error) => {
    if (!res.headersSent) {
      send(res, 502, JSON.stringify({ error: 'Backend unavailable' }), {
        'content-type': 'application/json; charset=utf-8',
      });
    } else {
      res.destroy();
    }
  });

  req.pipe(proxyReq);
}

function serveStatic(req, res, pathname) {
  // SPA entry routes are proxied to the backend (see server handler) so the
  // backend can attach session/CSRF cookies. Everything else here is a real
  // static asset path.
  let file = pathname.slice(1);

  const normalized = path.normalize(file);
  if (normalized.startsWith('..') || path.isAbsolute(normalized)) {
    return send(res, 403, 'Forbidden', { 'content-type': 'text/plain; charset=utf-8' });
  }

  const full = path.join(PUBLIC_DIR, normalized);
  if (!full.startsWith(PUBLIC_DIR + path.sep) && full !== PUBLIC_DIR) {
    return send(res, 403, 'Forbidden', { 'content-type': 'text/plain; charset=utf-8' });
  }

  fs.stat(full, (error, stat) => {
    if (error || !stat.isFile()) return proxy(req, res);
    const type = MIME[path.extname(full).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, {
      'content-type': type,
      'content-length': stat.size,
      'cache-control': path.extname(full).toLowerCase() === '.html'
        ? 'no-cache'
        : 'public, max-age=3600',
    });
    fs.createReadStream(full).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  let pathname;
  try {
    pathname = new URL(req.url, `http://${req.headers.host || 'localhost'}`).pathname;
  } catch {
    return send(res, 400, 'Bad request', { 'content-type': 'text/plain; charset=utf-8' });
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') return proxy(req, res);
  // Always proxy the SPA entry pages to the backend so it can mint the
  // session + av_csrf cookies the frontend needs for authenticated API calls.
  // Static assets (js/css/svg/...) are still served from disk below.
  if (pathname === '/' || pathname === '/login' || pathname === '/register' || pathname === '/admin') {
    return proxy(req, res);
  }
  serveStatic(req, res, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`[Frontend] serving ${PUBLIC_DIR} on http://${HOST}:${PORT}, proxying to ${BACKEND_HOST}:${BACKEND_PORT}`);
});
