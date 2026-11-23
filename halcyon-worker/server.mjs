import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import worker from './worker-dist/index.js'
import { openDatabase } from './database.mjs'

const assets = new Map(await Promise.all([
  ['/', 'index.html', 'text/html; charset=utf-8'],
  ['/app.js', 'app.js', 'text/javascript; charset=utf-8'],
  ['/style.css', 'style.css', 'text/css; charset=utf-8'],
].map(async ([path, file, type]) => [path, {
  body: await readFile(new URL(file, import.meta.url)), type,
}])));
assets.set('/index.html', assets.get('/'));
const host = process.env.HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 8787)
const env = {
  DB: openDatabase(process.env.DATA_DIR ?? new URL('./.data', import.meta.url).pathname),
  ADMIN_PASSWORD: process.env.ADMIN_PASSWORD,
  ADMIN_SESSION_SECRET: process.env.ADMIN_SESSION_SECRET,
  STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
  STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
  SITE_URL: process.env.SITE_URL,
  ASSETS: {
    fetch(request) {
      const { pathname } = new URL(request.url)
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        return new Response(null, { status: 405, headers: { allow: 'GET, HEAD' } })
      }
      const asset = assets.get(pathname)
      if (!asset) {
        return new Response('Not found', { status: 404 })
      }
      return new Response(request.method === 'HEAD' ? null : asset.body, {
        headers: { 'content-type': asset.type },
      })
    },
  },
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(env.SITE_URL || ('http://' + (incoming.headers.host ?? host + ':' + server.address().port)))
    const target = incoming.url ?? '/'
    if (!target.startsWith('/')) {
      outgoing.writeHead(400).end()
      return
    }
    const request = new Request(url.origin + target, {
      method: incoming.method,
      headers: incoming.headers,
      ...(incoming.method !== 'GET' && incoming.method !== 'HEAD'
        ? { body: Readable.toWeb(incoming), duplex: 'half' }
        : {}),
    })
    const response = await worker.fetch(request, env)
    const headers = Object.fromEntries(response.headers)
    const cookies = response.headers.getSetCookie()
    if (cookies.length) headers['set-cookie'] = cookies
    outgoing.writeHead(response.status, headers)
    if (response.body && incoming.method !== 'HEAD') {
      await pipeline(Readable.fromWeb(response.body), outgoing)
    } else {
      outgoing.end()
    }
  } catch (error) {
    console.error(error)
    if (!outgoing.headersSent) outgoing.writeHead(500)
    outgoing.end()
  }
})

server.listen(port, host, () => {
  console.log('Halcyon Worker listening on http://' + host + ':' + server.address().port)
})

server.on('error', (error) => { console.error('Server could not start:', error.message); process.exitCode = 1 })
