'use strict';

// Static check: every inline <script> block the server renders must parse.
//
// A dashboard whose script has a syntax error silently loses ALL interactivity
// (toggles, save buttons, QR polling) while still rendering fine — this test
// renders the pages and parses the extracted scripts, so that class of bug
// cannot ship again.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const PORT = 39917;

let passed = 0;
let failed = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; }
}

function extractScripts(html) {
    const out = [];
    const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi;
    let m;
    while ((m = re.exec(html))) {
        const code = m[1].trim();
        if (code) out.push(code);
    }
    return out;
}

(async () => {
    console.log('\nrendered page scripts (dashboard / admin / login / register)');

    const sessionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-page-'));
    const child = spawn(process.execPath, [path.join(ROOT, 'autoviewer.js')], {
        cwd: ROOT,
        env: { ...process.env, PORT: String(PORT), SESSION_DIR: sessionDir, NODE_ENV: 'development' },
        stdio: ['ignore', 'pipe', 'pipe']
    });

    const wait = (ms) => new Promise(r => setTimeout(r, ms));
    let base = null;
    for (let i = 0; i < 60; i++) {
        await wait(250);
        try {
            const r = await fetch(`http://127.0.0.1:${PORT}/health`);
            if (r.ok) { base = `http://127.0.0.1:${PORT}`; break; }
        } catch {}
    }
    if (!base) {
        child.kill('SIGKILL');
        console.error('  FAIL server did not start');
        process.exit(1);
    }

    const fetchPage = async (path) => {
        const r = await fetch(base + path, { redirect: 'manual' });
        return { status: r.status, headers: r.headers, html: await r.text() };
    };

    // Every Set-Cookie header, as name=value pairs. The old pages embedded the
    // CSRF token in HTML; it now arrives as an `av_csrf` cookie, and the
    // session cookie has to travel with it or the token won't match.
    const setCookies = (res) => (typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : String(res.headers.get('set-cookie') || '').split(/,\s*(?=[^;,\s]+=)/));
    const jar = (res) => setCookies(res).map((c) => c.split(';')[0]).join('; ');
    const csrfOf = (res) => {
        for (const c of setCookies(res)) {
            const m = c.match(/^av_csrf=([^;]*)/);
            if (m) return decodeURIComponent(m[1]);
        }
        return '';
    };

    // The static frontend folds /login into the shared sign-in screen on /.
    const loginHead = await fetchPage('/login');
    t('/login redirects to /', () => {
        assert.ok([301, 302, 303, 307, 308].includes(loginHead.status), `expected a redirect (got ${loginHead.status})`);
        assert.strictEqual(loginHead.headers.get('location'), '/');
    });

    for (const p of ['/register', '/']) {
        const { status, html } = await fetchPage(p);
        t(`${p} renders`, () => {
            assert.strictEqual(status, 200, `page must render (got ${status})`);
            assert.ok(html.length > 100, 'page must render');
        });
        t(`${p} inline scripts parse`, () => {
            // A static page may carry no inline script at all (app.js and
            // register.js load by src) — but any inline script that exists
            // must parse, or the page silently loses interactivity.
            for (const code of extractScripts(html)) {
                new vm.Script(code, { filename: `${p}-inline.js` });
            }
        });
    }

    // Register (first account becomes admin), then log in.
    const regPage = await fetchPage('/register');
    let cookie = jar(regPage);
    let csrf = csrfOf(regPage);
    await fetch(base + '/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams({ username: 'pageadmin', password: 'Passw0rd123', _csrf: csrf }),
        redirect: 'manual'
    });

    const loginPage = await fetchPage('/login');
    cookie = jar(loginPage);
    csrf = csrfOf(loginPage);
    const loginRes = await fetch(base + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', cookie },
        body: new URLSearchParams({ username: 'pageadmin', password: 'Passw0rd123', _csrf: csrf }),
        redirect: 'manual'
    });
    assert.ok([302, 303].includes(loginRes.status), `login must redirect (got ${loginRes.status})`);
    const authCookie = jar(loginRes);
    assert.ok(authCookie, 'login must set a session cookie');

    for (const p of ['/', '/admin']) {
        const r = await fetch(base + p, { headers: { cookie: authCookie }, redirect: 'manual' });
        const html = await r.text();
        t(`${p} renders and inline scripts parse`, () => {
            assert.ok(r.status === 200, `page must render (got ${r.status})`);
            for (const code of extractScripts(html)) {
                new vm.Script(code, { filename: `${p}-inline.js` });
            }
        });
        t(`${p} has no dangling function calls`, () => {
            // Helpers that were removed in earlier rounds must not be called
            // from the page any more (a dangling call is a ReferenceError that
            // kills the whole inline script).
            const scripts = extractScripts(html).join('\n');
            const removed = ['loadKeys', 'loadWebhooks', 'buildLocalTools', 'runLocalTool', 'fireWebhook'];
            for (const name of removed) {
                assert.ok(!new RegExp(`\\b${name}\\s*\\(`).test(scripts), `page still calls removed helper "${name}()"`);
            }
        });
    }

    child.kill('SIGTERM');
    await wait(500);
    try { child.kill('SIGKILL'); } catch {}
    fs.rmSync(sessionDir, { recursive: true, force: true });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
})();

// Never leave a server behind, whatever happens (an orphaned manager keeps
// port 3000 and fights the real service).
process.on('exit', () => { try { process.kill(child.pid, 'SIGKILL'); } catch {} });
