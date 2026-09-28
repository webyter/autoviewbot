'use strict';

// Plain-node e2e smoke test — no test runner, no extra deps (CI-friendly).
// Boots the manager on a throwaway port with a throwaway session dir and
// exercises the core flows: register-first-admin, login, CSRF, invite
// create/link/prefill, single-use consumption, logout POST, delete.
//
// Run: node test/smoke.js   (expects `npm install` to have been run)

const { spawn } = require('child_process');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const PORT = 3999;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ok  ${name}`); }
    else { failed++; console.error(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

function request(method, url, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request(url, { method, headers }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

function field(html, name) {
    const m = html.match(new RegExp(`name="${name}"[^>]*value="([^"]*)"`));
    return m ? m[1] : '';
}

// Cookie jar good enough for the test (single cookie: connect.sid)
function jar(res) {
    const raw = res.headers['set-cookie'] || [];
    return raw.map(c => c.split(';')[0]).join('; ');
}

function csrf(html) {
    const m = html.match(/name="_csrf" value="([^"]*)"/) || html.match(/CSRF_TOKEN='([^']*)'/);
    return m ? m[1] : '';
}

async function waitUp() {
    for (let i = 0; i < 40; i++) {
        try { await request('GET', `${BASE}/health`); return; }
        catch (_) { await new Promise(r => setTimeout(r, 500)); }
    }
    throw new Error('server did not come up');
}

async function main() {
    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-smoke-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'autoviewer.js')], {
        env: { ...process.env, PORT: String(PORT), SESSION_DIR: sessionDir, NODE_ENV: '' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', () => {}); // keep logs out of the way
    try {
        await waitUp();

        // ── first registration needs no invite and becomes admin ──
        let r = await request('GET', `${BASE}/register`);
        check('register page 200', r.status === 200);
        let c = jar(r), tok = csrf(r.body);
        r = await request('POST', `${BASE}/register`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': c },
            body: `username=smokeadmin&password=Passw0rd123&_csrf=${tok}`
        });
        check('register 302', r.status === 302);

        // ── login (register does NOT auto-login) ──
        r = await request('GET', `${BASE}/login`);
        c = jar(r); tok = csrf(r.body);
        r = await request('POST', `${BASE}/login`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': c },
            body: `username=smokeadmin&password=Passw0rd123&_csrf=${tok}`
        });
        check('login 302', r.status === 302);
        const adminCookie = jar(r);

        // ── dashboard + CSRF token ──
        r = await request('GET', `${BASE}/`, { headers: { 'Cookie': adminCookie } });
        check('dashboard 200', r.status === 200);
        const dashTok = csrf(r.body);
        check('dashboard embeds CSRF', !!dashTok);

        // ── create invite, verify short format + link ──
        r = await request('POST', `${BASE}/api/admin/invites/create`, {
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie, 'X-CSRF-Token': dashTok },
            body: JSON.stringify({ maxUses: 1 })
        });
        const inv = JSON.parse(r.body);
        check('invite created', inv.status === 'ok', r.body);
        check('invite code is short format', /^INV-[A-Z2-9]{6}$/.test(inv.code), inv.code);
        check('invite url shape', /\/register\?code=/.test(inv.url || ''), inv.url);

        // ── second registration MUST use the invite ──
        r = await request('GET', `${BASE}/register`);
        c = jar(r); tok = csrf(r.body);
        r = await request('POST', `${BASE}/register`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': c },
            body: `username=smokeuser1&password=Passw0rd123&_csrf=${tok}&invite=INV-NOPE01`
        });
        check('bad invite rejected', r.status === 403);

        r = await request('GET', `${BASE}/register?code=${encodeURIComponent(inv.code)}`);
        check('invite link prefills code', r.body.includes(`value="${inv.code}"`));
        c = jar(r); tok = csrf(r.body);
        r = await request('POST', `${BASE}/register`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': c },
            body: `username=smokeuser1&password=Passw0rd123&_csrf=${tok}&invite=${inv.code}`
        });
        check('invite consumed, user registered', r.status === 302);

        // single-use: the same code must now be dead
        r = await request('GET', `${BASE}/register`);
        c = jar(r); tok = csrf(r.body);
        r = await request('POST', `${BASE}/register`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': c },
            body: `username=smokeuser2&password=Passw0rd123&_csrf=${tok}&invite=${inv.code}`
        });
        check('single-use enforced', r.status === 403);

        // ── logout: GET is a no-op, POST (with CSRF) destroys the session ──
        r = await request('GET', `${BASE}/logout`, { headers: { 'Cookie': adminCookie } });
        check('GET logout does not destroy session', r.status === 302);
        r = await request('GET', `${BASE}/`, { headers: { 'Cookie': adminCookie } });
        check('session still valid after GET logout', r.status === 200);
        r = await request('POST', `${BASE}/logout`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': adminCookie },
            body: `_csrf=${dashTok}`
        });
        check('POST logout 302', r.status === 302);
        r = await request('GET', `${BASE}/`, { headers: { 'Cookie': adminCookie } });
        check('session destroyed after POST logout', r.status === 302);

        // ── login again and delete the second user ──
        r = await request('GET', `${BASE}/login`);
        c = jar(r); tok = csrf(r.body);
        r = await request('POST', `${BASE}/login`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': c },
            body: `username=smokeadmin&password=Passw0rd123&_csrf=${tok}`
        });
        const cookie2 = jar(r);
        r = await request('GET', `${BASE}/`, { headers: { 'Cookie': cookie2 } });
        const tok2 = csrf(r.body);
        r = await request('POST', `${BASE}/api/admin/user/delete`, {
            headers: { 'Content-Type': 'application/json', 'Cookie': cookie2, 'X-CSRF-Token': tok2 },
            body: JSON.stringify({ username: 'smokeuser1' })
        });
        check('delete user ok', JSON.parse(r.body).status === 'ok', r.body);
        check('session files removed', !fs.existsSync(path.join(sessionDir, 'smokeuser1')));

        // ── tampered CSRF must be rejected ──
        r = await request('POST', `${BASE}/settings/toggle`, {
            headers: { 'Content-Type': 'application/json', 'Cookie': cookie2, 'X-CSRF-Token': 'deadbeefdeadbeefdeadbeefdeadbeef' },
            body: JSON.stringify({ feature: 'autoreply' })
        });
        check('bad CSRF rejected', r.status === 403);
    } finally {
        child.kill('SIGKILL');
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
