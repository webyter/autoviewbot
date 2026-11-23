'use strict';

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const PORT = 39922;
const BASE = `http://127.0.0.1:${PORT}`;
const ROOT = path.join(__dirname, '..');

let passed = 0;
let failed = 0;
function check(name, cond, extra) {
    if (cond) { passed++; console.log(`  ok  ${name}`); }
    else { failed++; console.error(`FAIL  ${name}${extra ? ' — ' + extra : ''}`); }
}

function request(method, urlPath, { headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(urlPath, BASE);
        const req = http.request(u, { method, headers }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                let json = null;
                try { json = JSON.parse(data); } catch {}
                resolve({ status: res.statusCode, headers: res.headers, body: data, json });
            });
        });
        req.on('error', reject);
        if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
        req.end();
    });
}

function jar(res) {
    const raw = res.headers['set-cookie'] || [];
    const map = new Map();
    for (const c of raw) {
        const pair = c.split(';')[0];
        const idx = pair.indexOf('=');
        if (idx !== -1) {
            map.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
        }
    }
    return Array.from(map.entries()).map(([k, v]) => `${k}=${v}`).join('; ');
}

function csrf(res) {
    const raw = res.headers['set-cookie'] || [];
    let tok = '';
    for (const c of raw) {
        const m = c.match(/^av_csrf=([^;]*)/);
        if (m) tok = decodeURIComponent(m[1]);
    }
    return tok;
}

(async () => {
    console.log('\nv2 SPA compat API bridge (lib/compat-api.js)');

    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-compat-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'autoviewer.js')], {
        env: { ...process.env, PORT: String(PORT), SESSION_DIR: sessionDir, NODE_ENV: 'development', DOTENV_QUIET: 'true' },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    let up = false;
    for (let i = 0; i < 40; i++) {
        await wait(250);
        try {
            const r = await request('GET', '/health');
            if (r.status === 200) { up = true; break; }
        } catch {}
    }
    if (!up) {
        child.kill('SIGKILL');
        console.error('  FAIL server did not boot');
        process.exit(1);
    }

    try {
        // 1. GET /api/public-settings
        let r = await request('GET', '/api/public-settings');
        check('GET /api/public-settings returns ok', r.status === 200 && r.json && r.json.ok === true);

        // 2. Initial visit to / to get csrf + session cookies
        r = await request('GET', '/');
        let cookie = jar(r);
        let token = csrf(r);
        check('initial GET / provides csrf cookie', !!token);

        // 3. POST /api/register (first account -> admin)
        r = await request('POST', '/api/register', {
            headers: { 'Content-Type': 'application/json', 'Cookie': cookie, 'X-CSRF-Token': token },
            body: { username: 'testadmin', password: 'Passw0rd123' }
        });
        check('POST /api/register creates admin', r.status === 201 && r.json && r.json.ok === true && r.json.isAdmin === true);
        const adminCookie = jar(r) || cookie;
        token = csrf(r) || token;

        // 4. GET /api/session
        r = await request('GET', '/api/session', { headers: { 'Cookie': adminCookie } });
        check('GET /api/session returns user session', r.status === 200 && r.json && r.json.userId === 'testadmin' && r.json.isAdmin === true);
        check('GET /api/session contains settings', r.json && r.json.settings && typeof r.json.settings === 'object');

        // 5. PATCH /api/settings
        r = await request('PATCH', '/api/settings', {
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie, 'X-CSRF-Token': token },
            body: { autoStatusView: false, presence: 'online', statusReaction: ['🔥', '💙'], groupChatAI: true, commandPrefix: '!', voiceNotes: true }
        });
        check('PATCH /api/settings saves settings', r.status === 200 && r.json && r.json.ok === true && r.json.settings.autoStatusView === false && r.json.settings.groupChatAI === true && r.json.settings.commandPrefix === '!' && r.json.settings.presence === 'online');

        r = await request('PATCH', '/api/settings', {
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie, 'X-CSRF-Token': token },
            body: { presence: 'auto' }
        });
        check('PATCH /api/settings handles auto presence', r.status === 200 && r.json && r.json.settings.presence === 'auto' && r.json.settings.ghostMode === false);

        r = await request('PATCH', '/api/settings', {
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie, 'X-CSRF-Token': token },
            body: { presence: 'off' }
        });
        check('PATCH /api/settings handles ghost mode off', r.status === 200 && r.json && r.json.settings.presence === 'off' && r.json.settings.ghostMode === true);

        // 6. Notifications: GET, POST (admin), dismiss
        r = await request('POST', '/api/admin/notifications', {
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie, 'X-CSRF-Token': token },
            body: { title: 'Welcome', message: 'Hello from test', type: 'info' }
        });
        check('POST /api/admin/notifications creates notif', r.status === 201 && r.json && r.json.ok === true);
        const notifId = r.json.notification.id;

        r = await request('GET', '/api/notifications', { headers: { 'Cookie': adminCookie } });
        check('GET /api/notifications returns list', r.status === 200 && r.json && Array.isArray(r.json.notifications) && r.json.notifications.some(n => n.id === notifId));

        r = await request('POST', `/api/notifications/${notifId}/dismiss`, {
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie, 'X-CSRF-Token': token },
            body: {}
        });
        check('POST /api/notifications/:id/dismiss ok', r.status === 200 && r.json && r.json.ok === true);

        // 7. Admin settings: GET and POST
        r = await request('GET', '/api/admin/settings', { headers: { 'Cookie': adminCookie } });
        check('GET /api/admin/settings returns ok', r.status === 200 && r.json && r.json.ok === true);

        r = await request('POST', '/api/admin/settings', {
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie, 'X-CSRF-Token': token },
            body: { adminWhatsApp: '233550001122' }
        });
        check('POST /api/admin/settings saves admin WhatsApp', r.status === 200 && r.json && r.json.adminWhatsApp === '233550001122');

        // Check that public settings now reflects the new admin WhatsApp
        r = await request('GET', '/api/public-settings');
        check('GET /api/public-settings updated', r.json && r.json.adminWhatsApp === '233550001122');

        // 8. Admin user operations (PATCH rentalDays, enabled, DELETE)
        r = await request('PATCH', '/api/admin/users/testadmin', {
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie, 'X-CSRF-Token': token },
            body: { rentalDays: 14 }
        });
        check('PATCH /api/admin/users/:userId updates rental', r.status === 200 && r.json && r.json.ok === true);

        r = await request('GET', '/api/session', { headers: { 'Cookie': adminCookie } });
        check('GET /api/session reflects rental updates', r.status === 200 && r.json && r.json.rentalDays > 0 && r.json.rentalExpiresAt);

        r = await request('PATCH', '/api/admin/users/testadmin', {
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie, 'X-CSRF-Token': token },
            body: { enabled: false }
        });
        check('PATCH /api/admin/users/:userId toggles enabled', r.status === 200 && r.json && r.json.ok === true);

        // 9. POST /api/logout
        r = await request('POST', '/api/logout', {
            headers: { 'Content-Type': 'application/json', 'Cookie': adminCookie, 'X-CSRF-Token': token },
            body: {}
        });
        check('POST /api/logout returns ok', r.status === 200 && r.json && r.json.ok === true);

        // 10. POST /api/login with JSON
        r = await request('GET', '/');
        const preLoginCookie = jar(r);
        const preLoginToken = csrf(r);
        r = await request('POST', '/api/login', {
            headers: { 'Content-Type': 'application/json', 'Cookie': preLoginCookie, 'X-CSRF-Token': preLoginToken },
            body: { username: 'testadmin', password: 'Passw0rd123' }
        });
        check('POST /api/login succeeds with valid credentials', r.status === 200 && r.json && r.json.ok === true);
        const loggedInCookie = jar(r);
        const loggedInToken = csrf(r);

        // 11. Static frontend assets served directly by backend
        r = await request('GET', '/app.js');
        check('GET /app.js served directly', r.status === 200 && /javascript/.test(r.headers['content-type'] || '') && r.body.includes('settingsDirty'));

        r = await request('GET', '/styles.css');
        check('GET /styles.css served directly', r.status === 200 && /css/.test(r.headers['content-type'] || '') && r.body.includes(':root'));

        r = await request('GET', '/brand.svg');
        check('GET /brand.svg served directly', r.status === 200 && /svg/.test(r.headers['content-type'] || ''));

        r = await request('GET', '/index.html');
        check('GET /index.html served directly', r.status === 200 && /<!doctype html>/i.test(r.body));

        r = await request('GET', '/register.html');
        check('GET /register.html served directly', r.status === 200 && /<!doctype html>/i.test(r.body));

        // 12. Pairing code validation and connection
        r = await request('POST', '/api/session/connect', {
            headers: { 'Content-Type': 'application/json', 'Cookie': loggedInCookie, 'X-CSRF-Token': loggedInToken },
            body: { phoneNumber: '123' }
        });
        check('POST /api/session/connect rejects invalid phone', r.status === 400 && r.json && r.json.error);

        r = await request('POST', '/api/session/connect', {
            headers: { 'Content-Type': 'application/json', 'Cookie': loggedInCookie, 'X-CSRF-Token': loggedInToken },
            body: { phoneNumber: '233550001122' }
        });
        check('POST /api/session/connect accepts valid phone', r.status === 202 && r.json && r.json.mode === 'pairing');

    } finally {
        child.kill('SIGKILL');
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch {}
    }

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
