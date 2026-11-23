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

// The token used to be embedded in the server-rendered pages; those pages are
// gone, so it now arrives as a readable `av_csrf` cookie on the same response.
function csrf(res) {
    const raw = res.headers['set-cookie'] || [];
    for (const c of raw) {
        const m = c.match(/^av_csrf=([^;]*)/);
        if (m) return decodeURIComponent(m[1]);
    }
    return '';
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
        env: { ...process.env, PORT: String(PORT), SESSION_DIR: sessionDir, NODE_ENV: '', INVITE_CODE: '' },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    child.stderr.on('data', () => {}); // keep logs out of the way
    try {
        await waitUp();

        let r = await request('GET', `${BASE}/register`);
        check('register page 200', r.status === 200);
        let c = jar(r), tok = csrf(r);
        r = await request('POST', `${BASE}/register`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': c },
            body: `username=smokeadmin&password=Passw0rd123&_csrf=${tok}`
        });
        check('register 302', r.status === 302);

        r = await request('GET', `${BASE}/login`);
        c = jar(r); tok = csrf(r);
        r = await request('POST', `${BASE}/login`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': c },
            body: `username=smokeadmin&password=Passw0rd123&_csrf=${tok}`
        });
        check('login 302', r.status === 302);
        const adminCookie = jar(r);

        r = await request('GET', `${BASE}/`, { headers: { 'Cookie': adminCookie } });
        check('dashboard 200', r.status === 200);
        const dashTok = csrf(r);
        check('dashboard embeds CSRF', !!dashTok);

        r = await request('POST', `${BASE}/api/admin/invites/create`, {
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie, 'X-CSRF-Token': dashTok },
            body: JSON.stringify({ maxUses: 1 })
        });
        const inv = JSON.parse(r.body);
        check('invite created', inv.status === 'ok', r.body);
        check('invite code is short format', /^INV-[A-Z2-9]{6}$/.test(inv.code), inv.code);
        check('invite url shape', /\/register\?code=/.test(inv.url || ''), inv.url);

        r = await request('GET', `${BASE}/register`);
        c = jar(r); tok = csrf(r);
        r = await request('POST', `${BASE}/register`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': c },
            body: `username=smokeuser1&password=Passw0rd123&_csrf=${tok}&invite=INV-NOPE01`
        });
        check('bad invite rejected', r.status === 403);

        r = await request('GET', `${BASE}/register?code=${encodeURIComponent(inv.code)}`);
        // The register page is a static SPA now; the invite field is filled by
        // register.js on the client, so the raw HTML won't contain the value.
        check('invite link serves register page', r.status === 200 && r.body.includes('id="register-invite"'));
        c = jar(r); tok = csrf(r);
        r = await request('POST', `${BASE}/register`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': c },
            body: `username=smokeuser1&password=Passw0rd123&_csrf=${tok}&invite=${inv.code}`
        });
        check('invite consumed, user registered', r.status === 302);

        // single-use: the same code must now be dead
        r = await request('GET', `${BASE}/register`);
        c = jar(r); tok = csrf(r);
        r = await request('POST', `${BASE}/register`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': c },
            body: `username=smokeuser2&password=Passw0rd123&_csrf=${tok}&invite=${inv.code}`
        });
        check('single-use enforced', r.status === 403);

        r = await request('GET', `${BASE}/logout`, { headers: { 'Cookie': adminCookie } });
        check('GET logout does not destroy session', r.status === 302);
        // `/` is a public static page now, so session state is probed through
        // an endpoint that still requires a signed-in user.
        r = await request('GET', `${BASE}/api/status`, { headers: { 'Cookie': adminCookie } });
        check('session still valid after GET logout', r.status === 200, `status=${r.status}`);
        r = await request('POST', `${BASE}/logout`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': adminCookie },
            body: `_csrf=${dashTok}`
        });
        check('POST logout 302', r.status === 302);
        r = await request('GET', `${BASE}/api/status`, { headers: { 'Cookie': adminCookie } });
        check('session destroyed after POST logout', r.status === 401, `status=${r.status}`);

        r = await request('GET', `${BASE}/login`);
        c = jar(r); tok = csrf(r);
        r = await request('POST', `${BASE}/login`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': c },
            body: `username=smokeadmin&password=Passw0rd123&_csrf=${tok}`
        });
        const cookie2 = jar(r);
        r = await request('GET', `${BASE}/`, { headers: { 'Cookie': cookie2 } });
        const tok2 = csrf(r);
        r = await request('POST', `${BASE}/api/admin/user/delete`, {
            headers: { 'Content-Type': 'application/json', 'Cookie': cookie2, 'X-CSRF-Token': tok2 },
            body: JSON.stringify({ username: 'smokeuser1' })
        });
        check('delete user ok', JSON.parse(r.body).status === 'ok', r.body);
        check('session files removed', !fs.existsSync(path.join(sessionDir, 'smokeuser1')));

        r = await request('POST', `${BASE}/settings/toggle`, {
            headers: { 'Content-Type': 'application/json', 'Cookie': cookie2, 'X-CSRF-Token': 'deadbeefdeadbeefdeadbeefdeadbeef' },
            body: JSON.stringify({ feature: 'autoreply' })
        });
        check('bad CSRF rejected', r.status === 403);

        r = await request('GET', `${BASE}/login`);
        const freshC = jar(r), freshTok = csrf(r);
        r = await request('POST', `${BASE}/login`, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Cookie': freshC },
            body: `username=nonexistentuser&password=Passw0rd123&_csrf=${freshTok}`
        });
        check('unknown user login 401', r.status === 401, `status=${r.status}`);

        r = await request('POST', `${BASE}/settings/bot-profile`, {
            headers: { 'Content-Type': 'application/json', 'Cookie': cookie2, 'X-CSRF-Token': tok2 },
            body: JSON.stringify({ botName: 'AlexBot', botInstructions: 'Test instructions' })
        });
        check('bot-profile update ok', r.status === 200 && JSON.parse(r.body).status === 'ok');

        r = await request('POST', `${BASE}/settings/update-lists`, {
            headers: { 'Content-Type': 'application/json', 'Cookie': cookie2, 'X-CSRF-Token': tok2 },
            body: JSON.stringify({ key: 'allow', value: '233201234567, 233501234567' })
        });
        check('update-lists allow ok', r.status === 200 && JSON.parse(r.body).status === 'ok');

        r = await request('GET', `${BASE}/health`);
        check('health endpoint returns ok', r.status === 200 && JSON.parse(r.body).status === 'ok');
    } finally {
        child.kill('SIGKILL');
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (_) {}
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
