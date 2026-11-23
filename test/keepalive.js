'use strict';

// Tests for lib/keepalive.js — platform detection, URL resolution and the
// ping loop (against a local HTTP server).

const assert = require('assert');
const http = require('http');
const { resolveConfig, detectPlatform, normalizeUrl, startKeepAlive } = require('../lib/keepalive');

let passed = 0;
let failed = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; }
}

(async () => {
    console.log('\nkeep-alive (idle-sleep prevention)');

    await t('detects Render from the RENDER env var', () => {
        assert.strictEqual(detectPlatform({ RENDER: 'true' }), 'render');
        assert.strictEqual(detectPlatform({ RAILWAY_ENVIRONMENT: 'production' }), 'railway');
        assert.strictEqual(detectPlatform({ FLY_APP_NAME: 'x' }), 'fly');
        assert.strictEqual(detectPlatform({}), 'generic');
    });

    await t('normalises URLs (adds scheme, strips trailing slash)', () => {
        assert.strictEqual(normalizeUrl('example.com'), 'https://example.com');
        assert.strictEqual(normalizeUrl('https://example.com/'), 'https://example.com');
        assert.strictEqual(normalizeUrl('http://example.com/'), 'http://example.com');
        assert.strictEqual(normalizeUrl(''), '');
    });

    await t('uses the Render external URL when PUBLIC_URL is unset', () => {
        const cfg = resolveConfig({ RENDER: 'true', RENDER_EXTERNAL_URL: 'https://svc.onrender.com' });
        assert.strictEqual(cfg.enabled, true);
        assert.strictEqual(cfg.target, 'https://svc.onrender.com');
        assert.strictEqual(cfg.platform, 'render');
    });

    await t('PUBLIC_URL wins over the platform URL', () => {
        const cfg = resolveConfig({ RENDER: 'true', RENDER_EXTERNAL_URL: 'https://a.onrender.com', PUBLIC_URL: 'https://b.example.com' });
        assert.strictEqual(cfg.target, 'https://b.example.com');
    });

    await t('KEEPALIVE_URL overrides everything', () => {
        const cfg = resolveConfig({ PUBLIC_URL: 'https://b.example.com', KEEPALIVE_URL: 'https://c.example.com' });
        assert.strictEqual(cfg.target, 'https://c.example.com');
        assert.strictEqual(cfg.explicit, true);
    });

    await t('stays OFF without a public URL (localhost pings are pointless)', () => {
        const cfg = resolveConfig({});
        assert.strictEqual(cfg.enabled, false);
        assert.strictEqual(cfg.target, '');
    });

    await t('ping interval is clamped to a safe window', () => {
        assert.strictEqual(resolveConfig({ PUBLIC_URL: 'x' }).intervalMin, 9);
        assert.strictEqual(resolveConfig({ PUBLIC_URL: 'x', KEEPALIVE_INTERVAL_MIN: '1' }).intervalMin, 2);
        assert.strictEqual(resolveConfig({ PUBLIC_URL: 'x', KEEPALIVE_INTERVAL_MIN: '99' }).intervalMin, 14);
        assert.strictEqual(resolveConfig({ PUBLIC_URL: 'x', KEEPALIVE_INTERVAL_MIN: 'abc' }).intervalMin, 9);
    });

    await t('the pinger actually requests the target and records the result', async () => {
        let hits = 0;
        const server = http.createServer((req, res) => { hits++; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"status":"ok"}'); });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const port = server.address().port;
        const logs = [];
        const ka = startKeepAlive({
            env: { KEEPALIVE_URL: `http://127.0.0.1:${port}` },
            pingPath: '/health',
            log: m => logs.push(m)
        });
        // The first ping fires ~2s after start.
        await new Promise(r => setTimeout(r, 3500));
        ka.stop();
        server.close();
        assert.strictEqual(hits, 1, 'the ping must reach the target');
        assert.strictEqual(ka.state.pings, 1, 'ping count must be recorded');
        assert.strictEqual(ka.state.failures, 0, 'no failures expected');
        assert.strictEqual(ka.state.lastStatus, 200);
        assert.ok(ka.state.lastPingAt > 0, 'lastPingAt must be set');
    });

    await t('a failing ping is recorded, not thrown', async () => {
        const server = http.createServer((req, res) => { res.writeHead(500); res.end('nope'); });
        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const port = server.address().port;
        const ka = startKeepAlive({
            env: { KEEPALIVE_URL: `http://127.0.0.1:${port}` },
            pingPath: '/health',
            log: () => {}
        });
        await new Promise(r => setTimeout(r, 3500));
        ka.stop();
        server.close();
        assert.strictEqual(ka.state.pings, 1);
        assert.strictEqual(ka.state.failures, 1, 'failure must be counted');
        assert.ok(ka.state.lastError, 'the error must be visible');
    });

    await t('a disabled keep-alive reports itself as off', () => {
        const ka = startKeepAlive({ env: {}, log: () => {} });
        assert.strictEqual(ka.state.enabled, false);
        ka.stop();
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
})();
