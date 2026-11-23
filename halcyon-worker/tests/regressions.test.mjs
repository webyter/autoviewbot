import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openDatabase } from '../database.mjs'

const source = await readFile(new URL('../worker-dist/index.js', import.meta.url), 'utf8')
const internals = '\nexport { validateCart, computeTotals, readCookie, verifySessionToken, createSessionToken, verifyStripeSignature, hmac, retrieveStripeSession };'
const module = await import('data:text/javascript;base64,' + Buffer.from(source + internals).toString('base64'))
const worker = module.default
const dbDirectory = await mkdtemp(join(tmpdir(), 'halcyon-test-'))
const db = openDatabase(dbDirectory)
const env = { DB: db, ADMIN_PASSWORD: 'regression-password', ASSETS: { fetch: () => new Response('missing', { status: 404 }) } }
const request = (path, options = {}) => worker.fetch(new Request('http://localhost' + path, options), env)
let product

test('catalogue and SQLite changes survive opening another database connection', async () => {
  const response = await request('/api/products')
  assert.equal(response.status, 200)
  const data = await response.json()
  assert.equal(data.products.length, 16)
  product = data.products[0]
  await db.prepare("INSERT INTO settings (key, value) VALUES ('test', 'saved')").run()
  assert.equal((await openDatabase(dbDirectory).prepare("SELECT value FROM settings WHERE key = 'test'").first()).value, 'saved')
})
test('checkout validates quantities and aggregate stock across variants', () => {
  const p = { ...product, stock: 2 }
  const line = { productId: p.id, size: p.sizes[0], colour: p.colours[0].name, qty: 1 }
  assert.ok(module.validateCart([{ ...line, qty: 1.5 }], [p]).error)
  assert.ok(module.validateCart([{ ...line, qty: 2 }, line], [p]).error)
  assert.ok(module.validateCart([line], [{ ...p, stock: 0 }]).error)
  assert.equal(module.validateCart([line], [p]).lines[0].qty, 1)
})
test('free delivery progress uses the subtotal after discounts', () => {
  const totals = module.computeTotals(15000, 'standard', 'WELCOME10')
  assert.equal(totals.freeShippingRemaining, 1500)
  assert.equal(totals.delivery, 495)
})
test('malformed cookies and trailing token segments are rejected', async () => {
  assert.equal(module.readCookie(new Request('http://localhost', { headers: { cookie: 'halcyon_admin=%' } })), undefined)
  const token = await module.createSessionToken('secret')
  assert.equal(await module.verifySessionToken(token, 'secret'), true)
  assert.equal(await module.verifySessionToken(token + '.extra', 'secret'), false)
})
test('admin login rejects cross-origin requests and malformed cookies yield 401', async () => {
  const response = await request('/api/admin/login', { method: 'POST', headers: { origin: 'https://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ password: env.ADMIN_PASSWORD }) })
  assert.equal(response.status, 403)
  assert.equal((await request('/api/admin/session', { headers: { cookie: 'halcyon_admin=%' } })).status, 401)
  const login = await request('/api/admin/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: env.ADMIN_PASSWORD }) })
  assert.equal(login.status, 200)
  const cookie = login.headers.get('set-cookie').split(';')[0]
  assert.equal((await request('/api/admin/session', { headers: { cookie } })).status, 200)
})
test('Stripe signing key rotation accepts any valid v1 signature', async () => {
  const timestamp = Math.floor(Date.now() / 1000)
  const payload = '{}'
  const signature = await module.hmac('secret', timestamp + '.' + payload)
  assert.equal(await module.verifyStripeSignature(payload, 't=' + timestamp + ',v1=' + signature + ',v1=invalid', 'secret'), true)
  assert.equal(await module.verifyStripeSignature(payload, 't=' + timestamp + ',v1=invalid', 'secret'), false)
})
test('Stripe session amounts use line item subtotals', async () => {
  const original = globalThis.fetch
  globalThis.fetch = async () => Response.json({ id: 'cs_test', line_items: { data: [{ description: 'Coat', quantity: 2, amount_subtotal: 20000, amount_total: 18000 }] } })
  try { assert.equal((await module.retrieveStripeSession('test', 'cs_test')).lines[0].amount, 20000) }
  finally { globalThis.fetch = original }
})
test('deleting the entire catalogue does not reseed it', async () => {
  await db.prepare('DELETE FROM products').run()
  const freshEnv = { ...env, DB: openDatabase(dbDirectory) }
  const response = await worker.fetch(new Request('http://localhost/api/products'), freshEnv)
  assert.deepEqual((await response.json()).products, [])
  await rm(dbDirectory, { force: true, recursive: true })
})
