/**
 * AutoViewer — Master Manager
 * Production-ready multi-user WhatsApp automation platform.
 */

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');
require('dotenv/config');
const config = require('./config.js');

const app = express();
app.set('trust proxy', 1);
const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: 'Too many login attempts, try later', standardHeaders: true, legacyHeaders: false });
const registerLimiter = rateLimit({ windowMs: 60*60*1000, max: 10, message: 'Too many registrations, try later', standardHeaders: true, legacyHeaders: false });
const apiLimiter = rateLimit({ windowMs: 60*1000, max: 60, standardHeaders: true, legacyHeaders: false });
const port = process.env.PORT || 3000;

// Never cache protected pages/APIs — browsers heuristically cache HTML and
// GET responses, which broke the dynamic dashboard/status pages.
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

// ── Database ────────────────────────────────────────────────────────────────
const SESSION_BASE = process.env.SESSION_DIR || path.join(__dirname, 'session');
const DB_PATH = path.join(SESSION_BASE, 'users.json');

if (!fs.existsSync(SESSION_BASE)) fs.mkdirSync(SESSION_BASE, { recursive: true });

// Migration: if session/users.json doesn't exist, import from data/users.json
if (!fs.existsSync(DB_PATH)) {
    const legacyDB = path.join(__dirname, 'data', 'users.json');
    if (fs.existsSync(legacyDB)) {
        console.log('[Manager] Migrating data/users.json → session/users.json');
        fs.copyFileSync(legacyDB, DB_PATH);
        try { fs.unlinkSync(legacyDB); } catch (e) {}
    } else {
        fs.writeFileSync(DB_PATH, '{}');
    }
}

// Admin bootstrap: grant admin to usernames listed in ADMIN_USERNAMES (comma separated).
// Applied on every startup and at registration, so existing accounts get promoted on restart.
function adminUsernameList() {
    return (process.env.ADMIN_USERNAMES || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
}

function syncAdminUsers() {
    const list = adminUsernameList();
    if (!list.length) return;
    const db = loadDB();
    let changed = false;
    for (const u of list) {
        if (db[u] && !db[u].isAdmin) {
            db[u].isAdmin = true;
            changed = true;
            console.log(`[Admin] Granted admin to '${u}' via ADMIN_USERNAMES`);
        }
    }
    if (changed) saveDB(db);
}
syncAdminUsers();

function loadDB() {
    try {
        const raw = fs.readFileSync(DB_PATH, 'utf8');
        return JSON.parse(raw);
    } catch (e) {
        console.error('[Manager] DB Load Error:', e.message);
        return {};
    }
}

let dbQueue = Promise.resolve();
let saveQueue = Promise.resolve();
function saveDB(data) {
    saveQueue = saveQueue.then(() => {
        try {
            const tmp = DB_PATH + '.tmp.' + process.pid;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
            fs.renameSync(tmp, DB_PATH);
        } catch (e) {
            console.error('[Manager] DB Save Error:', e.message);
        }
    }).catch(e => {
        console.error('[Manager] DB Save Error (queue):', e.message);
    });
    return saveQueue;
}

function dbTransaction(fn) {
    dbQueue = dbQueue.then(async () => {
        const data = loadDB();
        await fn(data);
        await saveDB(data);
    }).catch(e => {
        console.error('[Manager] DB Transaction Error:', e.message);
    });
    return dbQueue;
}

// ── Process Management ──────────────────────────────────────────────────────
const MAX_INSTANCES_FILE = path.join(__dirname, 'server-config.json');

// Settings keys a worker may change via dot commands (strict whitelist).
// Includes both schema dialects: 'chatai'/'antidelete' arrive from the
// command engine and are mapped in UPDATE_SETTINGS below.
const WORKER_EDITABLE_KEYS = ['autoreply', 'chatai', 'antideleteMsg', 'antidelete', 'antideleteStatus', 'antiTagStatus', 'autostatus', 'statusReact', 'groupAdmin', 'reactEmojis', 'antilink', 'allow', 'block', 'persona', 'admins', 'mode'];
function loadMaxInstances() {
    const env = Math.min(parseInt(process.env.MAX_INSTANCES || '5') || 5, 20);
    try {
        const c = JSON.parse(fs.readFileSync(MAX_INSTANCES_FILE, 'utf8'));
        if (Number.isFinite(c.maxInstances)) return Math.min(Math.max(1, c.maxInstances | 0), 50);
    } catch (e) {}
    return env;
}
let MAX_INSTANCES = loadMaxInstances();
function saveMaxInstances(n) {
    n = Math.min(Math.max(1, n | 0), 50);
    MAX_INSTANCES = n;
    try { fs.writeFileSync(MAX_INSTANCES_FILE, JSON.stringify({ maxInstances: n })); }
    catch (e) { console.warn('[Manager] saveMaxInstances failed:', e.message); }
}
const instances = new Map(); // username -> { child, status, qr, ppUrl }
let keepAliveTimer = null;
const lastQrCache = new Map(); // username -> { qr, qrDataUrl } — survives restarts
const startingLock = new Set(); // prevent duplicate spawns
const pendingRestarts = new Map(); // username -> timeout handle
const startupWatchdogs = new Map(); // username -> timeout handle
const crashCounts = new Map(); // username -> consecutive crash count
const wipeCounts = new Map();  // username -> consecutive session-wipe count
const startedAtMap = new Map(); // username -> timestamp of last spawn
const CRASH_WINDOW_MS = 60000;
const CRASH_LIMIT = 3;

function clearPendingRestart(username) {
    if (pendingRestarts.has(username)) {
        clearTimeout(pendingRestarts.get(username));
        pendingRestarts.delete(username);
    }
}

function clearStartupWatchdog(username) {
    if (startupWatchdogs.has(username)) {
        clearTimeout(startupWatchdogs.get(username));
        startupWatchdogs.delete(username);
    }
}

function startUserBot(username, clearSession = false) {
    if (startingLock.has(username)) {
        console.log(`[Manager] Bot already starting for ${username}`);
        return 'busy';
    }

    if (instances.size >= MAX_INSTANCES && !instances.has(username)) {
        console.log(`[Manager] Instance limit (${MAX_INSTANCES}) reached. Cannot start bot for ${username}.`);
        return 'capacity';
    }

    clearPendingRestart(username);
    clearStartupWatchdog(username);

    // Properly clean up any stale instance before starting
    if (instances.has(username)) {
        const existing = instances.get(username);
        if (existing.child) {
            try { existing.child.kill('SIGKILL'); } catch (e) {}
        }
        instances.delete(username);
    }
    // Reap any orphaned worker for this account not tracked in `instances`
    // (e.g. left behind by a manager crash where cleanup() never ran). A second
    // live connection to the same WA account causes MessageCounterError -> 428.
    try { // safe: kill by pid from instances map, not shell pkill
        const inst = instances.get(username);
        if (inst?.child?.pid) try{ process.kill(inst.child.pid, 'SIGKILL'); }catch(e){}
        // fallback: pkill with sanitized username only alphanumeric
        if (isValidUsername(username)) require('child_process').execSync(`pkill -f "bot_worker.js ${username.replace(/[^a-zA-Z0-9_]/g,'')}"`, { stdio: 'ignore' });
    } catch (e) {}

    startingLock.add(username);

    try {
        if (clearSession) {
            lastQrCache.delete(username);
            const sessionDir = path.join(SESSION_BASE, username);
            if (fs.existsSync(sessionDir)) {
                const files = fs.readdirSync(sessionDir);
                for (const f of files) fs.rmSync(path.join(sessionDir, f), { recursive: true, force: true });
            }
        }

        const memMb = parseInt(process.env.WORKER_MEM_MB || '200') || 200;
        const child = fork(path.join(__dirname, 'bot_worker.js'), [username], {
            execArgv: [`--max-old-space-size=${memMb}`],
            silent: true
        });
        startedAtMap.set(username, Date.now());

        child.on('message', (msg) => {
            const inst = instances.get(username);
            // A late message from a KILLED child must not mutate the replacement
            // instance (stale STATUS/QR/LOGGED_OUT would corrupt the new worker)
            if (!inst || inst.child !== child) return;

            switch (msg.type) {
                case 'STATUS':
                    inst.status = msg.status;
                    if (msg.status === 'online') {
                        inst.qr = null;
                        inst.qrDataUrl = null;
                        inst.errorMsg = null;
                        lastQrCache.delete(username);
                        clearStartupWatchdog(username);
                    }
                    break;
                case 'QR':
                    inst.status = 'connecting';
                    inst.qr = msg.qr;
                    lastQrCache.set(username, { qr: msg.qr, qrDataUrl: null });
                    QRCode.toDataURL(msg.qr, { width: 400, margin: 1 }).then(url => {
                        // Only commit if this QR is still the current one —
                        // a stale callback must not overwrite a newer QR
                        const current = instances.get(username);
                        if (current && current.qr === msg.qr) current.qrDataUrl = url;
                        const cached = lastQrCache.get(username);
                        if (cached && cached.qr === msg.qr) cached.qrDataUrl = url;
                    }).catch(e => console.error('[Manager] QR generation error:', e.message));
                    break;
                case 'PP_URL':
                    inst.ppUrl = msg.url;
                    break;
                case 'LOG':
                    console.log(`[Worker:${username}] ${msg.data}`);
                    break;
                case 'LOGGED_OUT':
                    console.log(`[Manager] ${username} reported logged out. Clearing running flag.`);
                    dbTransaction((db) => { if (db[username]) db[username].running = false; });
                    break;
                case 'ERROR':
                    inst.status = 'error';
                    inst.errorMsg = msg.message || `Error (code ${msg.code})`;
                    console.log(`[Manager] ${username} reported error: ${inst.errorMsg}`);
                    break;
                case 'UPDATE_SETTINGS': {
                    // Worker applied a dot command (.autoreply off, .persona, .allow...).
                    // Persist it — strict whitelist, only keys a worker may ever change.
                    // Key dialect map: command engine speaks GitHub schema.
                    const changes = msg.changes || {};
                    const KEYMAP = { chatai: 'autoreply', antidelete: 'antideleteMsg', persona: 'botInstructions' };
                    dbTransaction((db) => {
                        const u = db[username];
                        if (!u) return;
                        for (const k of WORKER_EDITABLE_KEYS) {
                            if (k in changes) u[KEYMAP[k] || k] = changes[k];
                        }
                    });
                    break;
                }
            }
        });

        child.on('exit', (code, signal) => {
            console.log(`[Manager] Worker for ${username} exited (pid ${child.pid}, code ${code}, signal ${signal}). Active: ${instances.size - (instances.get(username)?.child === child ? 1 : 0)}/${MAX_INSTANCES}`);
            const isCurrent = instances.get(username)?.child === child;
            if (isCurrent) {
                instances.delete(username);
                clearStartupWatchdog(username);
                const db = loadDB();
                if (db[username]?.running) {
                    clearPendingRestart(username);
                    // Track consecutive crashes: only clear the session if the worker
                    // keeps dying within a short window (likely corrupt session state).
                    let clearSession = false;
                    if (code !== 0) {
                        const startedAt = startedAtMap.get(username) || 0;
                        const crashedFast = Date.now() - startedAt < CRASH_WINDOW_MS;
                        const count = crashedFast ? (crashCounts.get(username) || 0) + 1 : 0;
                        if (count >= CRASH_LIMIT) {
                            clearSession = true;
                            crashCounts.delete(username);
                        } else {
                            crashCounts.set(username, count);
                        }
                    } else {
                        crashCounts.delete(username);
                        startedAtMap.delete(username);
                    }
                    if (clearSession) {
                        // A wiped session still crash-looping means the account is
                        // in a bad state (ban, invalid creds). After 2 wipes, stop
                        // hammering — mark the bot stopped and require manual action.
                        const wipes = (wipeCounts.get(username) || 0) + 1;
                        wipeCounts.set(username, wipes);
                        if (wipes >= 2) {
                            console.log(`[Manager] ${username} keeps crashing after session wipes. Marking stopped — manual restart required.`);
                            wipeCounts.delete(username);
                            crashCounts.delete(username);
                            dbTransaction((db) => { if (db[username]) db[username].running = false; });
                            return;
                        }
                    }
                    console.log(`[Manager] Restarting ${username} in 3s${clearSession ? ' (clearing session)' : ''}...`);
                    const tid = setTimeout(() => {
                        pendingRestarts.delete(username);
                        const db2 = loadDB();
                        if (db2[username]?.running) {
                            startUserBot(username, clearSession);
                        } else {
                            console.log(`[Manager] ${username} was stopped during restart delay. Skipping.`);
                        }
                    }, 3000);
                    pendingRestarts.set(username, tid);
                }
            }
        });

        child.on('error', (err) => {
            console.error(`[Manager] Worker error for ${username}:`, err.message);
        });

        child.stderr.pipe(process.stderr);
        child.stdout.resume();

        instances.set(username, { 
            child, 
            status: 'starting', 
            qr: null, 
            qrDataUrl: null,
            ppUrl: null,
            errorMsg: null 
        });

        console.log(`[Manager] Forked worker for ${username} (pid ${child.pid}). Active: ${instances.size}/${MAX_INSTANCES}`);

        // Watchdog: kill + restart if stuck in 'starting' for 45s
        const wd = setTimeout(() => {
            startupWatchdogs.delete(username);
            const inst = instances.get(username);
            if (inst && inst.status === 'starting') {
                console.log(`[Manager] ${username} stuck in starting state. Restarting...`);
                if (inst.child) {
                    try { inst.child.kill(); } catch (e) {}
                }
                instances.delete(username);
                const db = loadDB();
                if (db[username]?.running) {
                    // Do NOT clear the session — the worker may just be slow to
                    // connect (network/WA version fetch). Session is only cleared
                    // by the crash-loop logic in the exit handler.
                    startUserBot(username, false);
                }
            }
        }, 45000);
        startupWatchdogs.set(username, wd);
    } finally {
        startingLock.delete(username);
    }
    return 'started';
}

// ── Middleware ──────────────────────────────────────────────────────────────
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
const sessionSecret = process.env.SESSION_SECRET;
let effectiveSecret = sessionSecret;
if (!effectiveSecret) {
    const crypto = require('crypto');
    const secretFile = require('path').join(__dirname, 'session', '.session_secret');
    try {
        if (require('fs').existsSync(secretFile)) effectiveSecret = require('fs').readFileSync(secretFile, 'utf8').trim();
        else { effectiveSecret = crypto.randomBytes(32).toString('hex'); require('fs').writeFileSync(secretFile, effectiveSecret); }
    } catch(e){ effectiveSecret = crypto.randomBytes(32).toString('hex'); }
    if (process.env.NODE_ENV === 'production') {
        console.error('[Manager] FATAL: SESSION_SECRET environment variable is required in production.');
        process.exit(1);
    }
    console.warn('[Manager] ⚠️ WARNING: Using generated session secret. Set SESSION_SECRET for production persistence.');
}
app.use(session({
    secret: effectiveSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: process.env.NODE_ENV === 'production',
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// ── CSRF Protection ──────────────────────────────────────────────────────────
// Session-bound token. Server-rendered pages embed it: native forms (login,
// register) submit it as a _csrf field, the dashboard/admin fetch wrappers
// send it as an X-CSRF-Token header. SameSite=Lax cookies back this up.
function csrfToken(req) {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    return req.session.csrf;
}
app.use((req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const token = req.get('X-CSRF-Token') || (req.body && req.body._csrf) || '';
    const expected = req.session.csrf || '';
    const ok = expected && typeof token === 'string' && token.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!ok) {
        if (req.path.startsWith('/api')) return res.status(403).json({ status: 'error', message: 'Bad CSRF token. Refresh the page and try again.' });
        return res.status(403).send(loginPage('Session expired — please try again.', req));
    }
    next();
});

// ── Auth Middleware ──────────────────────────────────────────────────────────
function requireUser(req, res, next) {
    if (!req.session.user) {
        // API endpoints must return JSON, not a redirect — otherwise the
        // dashboard's fetch follows the redirect and silently freezes
        if (req.path.startsWith('/api')) return res.status(401).json({ status: 'error', message: 'Not authenticated.' });
        return res.redirect('/login');
    }
    const db = loadDB();
    if (!db[req.session.user.username]) {
        req.session.destroy();
        if (req.path.startsWith('/api')) return res.status(401).json({ status: 'error', message: 'Not authenticated.' });
        return res.redirect('/login');
    }
    next();
}

function requireAdmin(req, res, next) {
    const db = loadDB();
    if (!db[req.session.user.username]?.isAdmin) {
        if (req.path.startsWith('/api')) return res.status(403).json({ status: 'error', message: 'Forbidden.' });
        return res.status(403).send('Forbidden');
    }
    next();
}

// Wrap async route handlers — Express doesn't catch async rejections and a
// hung request-freezes the client's fetch forever
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ── Templates ───────────────────────────────────────────────────────────────
function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function sPage(title, subtitle, icon, accent, fields, footer, error) {
    return `<!DOCTYPE html><html lang="en"><head>
        <meta charset="UTF-8">
        <title>AutoViewer • ${title}</title>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>
            @keyframes bgMove{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
            @keyframes floatIn{0%{opacity:0;transform:translateY(20px) scale(0.96)}100%{opacity:1;transform:translateY(0) scale(1)}}
            :root{--accent:${accent}}
            *{box-sizing:border-box;-webkit-font-smoothing:antialiased;margin:0}
            body{
                margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",sans-serif;
                background:linear-gradient(135deg,#0a0a0f 0%,#0d0d1a 30%,#0a0f14 60%,#0f0f0f 100%);
                background-size:200% 200%;animation:bgMove 20s ease infinite;
                min-height:100vh;display:flex;align-items:center;justify-content:center;
                color:#f0f0f5;padding:16px;
            }
            .card{
                background:rgba(255,255,255,0.04);backdrop-filter:blur(40px) saturate(1.4);
                -webkit-backdrop-filter:blur(40px) saturate(1.4);
                border-radius:32px;border:1px solid rgba(255,255,255,0.06);
                box-shadow:0 32px 64px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.06);
                padding:40px 28px;width:100%;max-width:420px;text-align:center;
                animation:floatIn 0.7s cubic-bezier(0.16,1,0.3,1);
            }
            .icon{
                width:64px;height:64px;
                background:linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03));
                border-radius:20px;margin:0 auto 24px;
                display:flex;align-items:center;justify-content:center;
                border:1px solid rgba(255,255,255,0.04);
            }
            .icon svg{width:26px;height:26px}
            h1{font-size:26px;font-weight:800;color:#fff;letter-spacing:-0.6px;line-height:1.15}
            .sub{font-size:13px;color:rgba(255,255,255,0.35);margin:6px 0 28px;font-weight:500;letter-spacing:0.2px}
            .err{
                background:rgba(255,69,58,0.08);color:#ff6b6b;
                border:1px solid rgba(255,69,58,0.1);border-radius:14px;
                padding:12px 16px;font-size:12px;font-weight:600;margin-bottom:20px;
                text-align:left;backdrop-filter:blur(8px);
            }
            input{
                width:100%;padding:15px 16px;border-radius:14px;
                border:1px solid rgba(255,255,255,0.06);
                background:rgba(0,0,0,0.3);color:#fff;font-size:15px;margin-bottom:10px;
                outline:none;transition:all 0.3s cubic-bezier(0.16,1,0.3,1);
            }
            input:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(255,255,255,0.03),0 4px 12px rgba(0,0,0,0.2);background:rgba(0,0,0,0.4)}
            input::placeholder{color:rgba(255,255,255,0.2)}
            button{
                background:linear-gradient(135deg,var(--accent),#0056cc);color:#fff;border:none;width:100%;padding:15px;
                border-radius:14px;font-weight:700;font-size:15px;cursor:pointer;
                margin-top:8px;transition:all 0.3s cubic-bezier(0.16,1,0.3,1);
                box-shadow:0 4px 16px rgba(0,122,255,0.25);
            }
            button:hover{filter:brightness(1.1);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,122,255,0.35)}
            button:active{transform:scale(0.97)}
            .pw-wrap{position:relative}
            .pw-wrap input{padding-right:46px}
            .pw-toggle{
                position:absolute;right:8px;top:50%;transform:translateY(-50%);
                width:32px;height:32px;padding:0;margin:0;background:transparent;
                border:none;border-radius:8px;font-size:15px;cursor:pointer;
                display:flex;align-items:center;justify-content:center;opacity:0.55;
                box-shadow:none;transition:all 0.2s;
            }
            .pw-toggle:hover{opacity:1;filter:none;background:rgba(255,255,255,0.06);transform:translateY(-50%)}
            .pw-toggle:active{transform:translateY(-50%) scale(0.88)}
            .footer{margin-top:24px;font-size:13px;color:rgba(255,255,255,0.3)}
            a{color:var(--accent);text-decoration:none;font-weight:600;letter-spacing:0.2px}
            a:hover{opacity:0.8}
            @media(max-width:420px){.card{padding:28px 18px}h1{font-size:22px}}
        </style>
    </head><body>
        <div class="card">
            <div class="icon">${icon}</div>
            <h1>${title}</h1>
            <p class="sub">${subtitle}</p>
            ${error ? `<div class="err">${escapeHTML(error)}</div>` : ''}
            <form method="POST">${fields}</form>
            <div class="footer">${footer}</div>
        </div>
        <script>
            function togglePw(btn){
                const input = btn.previousElementSibling;
                const show = input.type === 'password';
                input.type = show ? 'text' : 'password';
                btn.textContent = show ? '🙈' : '👁';
            }
        </script>
    </body></html>`;
}

function loginPage(error = '', req = null) {
    const csrf = req ? csrfToken(req) : '';
    return sPage('Sign In', 'Sign in to your account',
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" fill="#007aff"/></svg>',
        '#007aff',
        `<input type="hidden" name="_csrf" value="${csrf}">
         <input name="username" placeholder="Username" required autofocus>
         <div class="pw-wrap">
             <input name="password" type="password" placeholder="Password" required>
             <button type="button" class="pw-toggle" onclick="togglePw(this)" aria-label="Show password">👁</button>
         </div>
         <button type="submit">Sign In</button>`,
        `Having problems? Contact the admin on <a href="https://wa.me/${ADMIN_CONTACT}" target="_blank" rel="noopener" style="color:var(--accent)">WhatsApp</a>.<br>New here? <a href="/register">Create account</a>`,
        error
    );
}

// Invite codes are only demanded once the first account exists — a fresh
// install has a chicken-and-egg problem otherwise. The first signup is the
// admin (via ADMIN_USERNAMES).
function inviteRequired() { return Object.keys(loadDB()).length > 0; }

// Registration is invite-only. Admin sets INVITE_CODE (comma separated for
// multiple codes); with none set, registration is closed. Users with problems
// are pointed at the admin's WhatsApp.
const ADMIN_CONTACT = process.env.ADMIN_CONTACT || '233531556024';
const contactFooter = `Having problems or want an account? Contact the admin on <a href="https://wa.me/${ADMIN_CONTACT}" target="_blank" rel="noopener" style="color:var(--accent)">WhatsApp</a>.`;

function registerPage(error = '', req = null) {
    const csrf = req ? csrfToken(req) : '';
    return sPage('Create Account', 'Join the AutoViewer platform',
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="#007aff"/></svg>',
        '#007aff',
        `<input type="hidden" name="_csrf" value="${csrf}">
         <input name="username" placeholder="Choose Username" required autofocus>
         <div class="pw-wrap">
             <input name="password" type="password" placeholder="Choose Password" required>
             <button type="button" class="pw-toggle" onclick="togglePw(this)" aria-label="Show password">👁</button>
         </div>
         ${inviteRequired() ? '<input name="invite" placeholder="Invite Code" required>' : ''}
         <button type="submit">Sign Up</button>`,
        `${inviteRequired() ? `Registration is invite-only. ${contactFooter}<br>` : `<strong>First account</strong> — no invite needed; it becomes the admin.${contactFooter ? '<br>' + contactFooter : ''}<br>`}Already registered? <a href="/login">Sign In</a>`,
        error
    );
}

// ── Routes ──────────────────────────────────────────────────────────────────
// Silent no-op assets the browser requests automatically — avoids harmless 404
// noise in both the server log and the browser console.
app.get('/favicon.ico', (req, res) => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    res.type('image/png').set('Cache-Control', 'public, max-age=86400').send(png);
});
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow:'));

app.get('/', requireUser, (req, res) => {
    const user = req.session.user;
    const inst = instances.get(user.username) || { status: 'stopped', qr: null, ppUrl: null };
    const db = loadDB();
    const userData = db[user.username] || {};

    res.send(`<!DOCTYPE html><html lang="en"><head>
        <title>AutoViewer • Dashboard</title>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>
            @keyframes bgMove{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
            @keyframes floatIn{0%{opacity:0;transform:translateY(20px) scale(0.96)}100%{opacity:1;transform:translateY(0) scale(1)}}
            @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.5}}
            @keyframes spin{0%{transform:rotate(0deg)}100%{transform:rotate(360deg)}}
            :root{--accent:#007aff;--danger:#ff453a;--success:#30d158}
            *{box-sizing:border-box;-webkit-font-smoothing:antialiased;margin:0}
            body{
                margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",sans-serif;
                background:linear-gradient(135deg,#0a0a0f 0%,#0d0d1a 30%,#0a0f14 60%,#0f0f0f 100%);
                background-size:200% 200%;animation:bgMove 20s ease infinite;
                min-height:100vh;display:flex;align-items:center;justify-content:center;
                color:#f0f0f5;padding:16px;
            }
            .card{
                background:rgba(255,255,255,0.04);backdrop-filter:blur(40px) saturate(1.4);
                -webkit-backdrop-filter:blur(40px) saturate(1.4);
                border-radius:32px;border:1px solid rgba(255,255,255,0.06);
                box-shadow:0 32px 64px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.06);
                padding:32px 28px;width:100%;max-width:520px;text-align:center;
                animation:floatIn 0.7s cubic-bezier(0.16,1,0.3,1);
            }
            h1{font-size:24px;font-weight:800;color:#fff;letter-spacing:-0.6px;line-height:1.15}
            .sub{font-size:12px;color:rgba(255,255,255,0.3);margin:3px 0 22px;font-weight:500;letter-spacing:0.2px}
            .badge{
                display:inline-flex;align-items:center;gap:6px;
                padding:4px 14px;border-radius:20px;font-size:10px;font-weight:700;
                margin-bottom:10px;text-transform:uppercase;letter-spacing:0.7px;
                backdrop-filter:blur(10px);
            }
            .badge.online{background:rgba(48,209,88,0.12);color:#30d158}
            .badge.connecting{background:rgba(255,159,10,0.12);color:#ff9f0a}
            .badge.offline{background:rgba(142,142,147,0.12);color:#8e8e93}
            .badge.stopped{background:rgba(255,255,255,0.05);color:rgba(255,255,255,0.35)}
            .badge.error{background:rgba(255,69,58,0.12);color:#ff453a}
            .badge::before{content:'';width:6px;height:6px;border-radius:50%}
            .badge.online::before{background:#30d158;box-shadow:0 0 6px rgba(48,209,88,0.5)}
            .badge.connecting::before{background:#ff9f0a;box-shadow:0 0 6px rgba(255,159,10,0.5)}
            .badge.offline::before{background:#8e8e93}
            .badge.stopped::before{background:rgba(255,255,255,0.25)}
            .badge.error::before{background:#ff453a;box-shadow:0 0 6px rgba(255,69,58,0.5)}
            .slots{font-size:11px;color:rgba(255,255,255,0.2);font-weight:600;margin-bottom:22px;letter-spacing:0.3px}
            .hidden{display:none!important}

            .qr-wrap{
                background:rgba(0,0,0,0.4);padding:12px;border-radius:20px;
                display:inline-flex;align-items:center;justify-content:center;
                margin:0 auto 14px;position:relative;width:fit-content;
                border:1px solid rgba(255,255,255,0.04);
            }
            .qr-wrap img{width:180px;max-width:100%;height:auto;aspect-ratio:1;border-radius:12px;display:block}
            .qr-logo{
                position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);
                width:40px;height:40px;background:#fff;border-radius:10px;padding:6px;
                box-shadow:0 4px 12px rgba(0,0,0,0.3);
            }
            .hint{font-size:11px;color:rgba(255,255,255,0.25);margin-bottom:16px;letter-spacing:0.2px;line-height:1.4}

            .pp-wrap{
                width:96px;height:96px;margin:0 auto 12px;
                border-radius:50%;overflow:hidden;
                border:2px solid rgba(255,255,255,0.08);
                box-shadow:0 0 0 4px rgba(255,255,255,0.03),0 8px 24px rgba(0,0,0,0.3);
            }
            .pp-wrap img,.pp-wrap svg{width:100%;height:100%;object-fit:cover}
            .pp-wrap svg{display:block}
            .active-label{font-weight:700;font-size:16px;color:#fff;margin-bottom:1px;letter-spacing:-0.3px}
            .active-subtle{font-size:12px;color:rgba(255,255,255,0.25);letter-spacing:0.2px}

            .section{padding:0 0 8px}
            .actions{display:flex;gap:8px;margin-top:16px}
            .actions .btn{flex:1;margin:0;padding:11px 16px;font-size:13px;border-radius:12px}

            .settings{text-align:left;margin-top:24px;border-top:1px solid rgba(255,255,255,0.04);padding-top:16px}
            .row{display:flex;align-items:center;justify-content:space-between;padding:10px 0;gap:8px}
            .row span{font-size:13px;font-weight:600;color:rgba(255,255,255,0.75);letter-spacing:0.1px}

            .presence-select{
                background:rgba(0,0,0,0.3);color:#fff;border:1px solid rgba(255,255,255,0.06);
                border-radius:10px;padding:8px 10px;font-size:12px;font-weight:600;outline:none;flex-shrink:0;
            }
            .presence-select:focus{border-color:var(--accent)}
            .presence-select option{background:#111;color:#fff}

            .switch{position:relative;display:inline-block;width:44px;height:26px;flex-shrink:0}
            .switch input{opacity:0;width:0;height:0}
            .slider{
                position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;
                background:rgba(255,255,255,0.08);transition:0.3s cubic-bezier(0.16,1,0.3,1);border-radius:26px;
            }
            .slider:before{
                content:"";position:absolute;height:20px;width:20px;
                left:3px;bottom:3px;background:#fff;transition:0.3s cubic-bezier(0.16,1,0.3,1);
                border-radius:50%;box-shadow:0 2px 4px rgba(0,0,0,0.2);
            }
            input:checked+.slider{background:var(--success)}
            input:checked+.slider:before{transform:translateX(18px);box-shadow:0 2px 8px rgba(48,209,88,0.3)}

            .emoji-card{
                margin-top:16px;background:rgba(0,0,0,0.25);padding:14px 16px;
                border-radius:16px;border:1px solid rgba(255,255,255,0.03);
            }
            .emoji-card label{font-size:10px;color:rgba(255,255,255,0.25);display:block;margin-bottom:8px;font-weight:700;text-transform:uppercase;letter-spacing:0.7px}
            .emoji-row{display:flex;gap:6px}
            .emoji-row input{
                flex:1;padding:11px 12px;font-size:13px;border-radius:10px;
                border:1px solid rgba(255,255,255,0.04);
                background:rgba(0,0,0,0.3);color:#fff;outline:none;
                transition:0.3s cubic-bezier(0.16,1,0.3,1);
            }
            .emoji-row input:focus{border-color:var(--accent);background:rgba(0,0,0,0.4)}
            .emoji-row textarea{
                width:100%;min-height:70px;resize:vertical;padding:11px 12px;font-size:13px;border-radius:10px;
                border:1px solid rgba(255,255,255,0.04);
                background:rgba(0,0,0,0.3);color:#fff;outline:none;font-family:inherit;line-height:1.5;
                transition:0.3s cubic-bezier(0.16,1,0.3,1);
            }
            .emoji-row textarea:focus{border-color:var(--accent);background:rgba(0,0,0,0.4)}
            .emoji-row textarea::placeholder{color:rgba(255,255,255,0.15)}
            .announce{
                display:none;border-radius:14px;padding:10px 14px;font-size:12px;font-weight:600;
                margin-bottom:14px;text-align:left;line-height:1.5;
                background:rgba(255,159,10,0.10);color:#ff9f0a;border:1px solid rgba(255,159,10,0.16);
                backdrop-filter:blur(8px);
            }
            .announce.show{display:block}

            .btn{
                display:inline-flex;align-items:center;justify-content:center;gap:5px;
                border:none;border-radius:12px;font-weight:700;font-size:13px;
                cursor:pointer;padding:11px 20px;transition:all 0.3s cubic-bezier(0.16,1,0.3,1);
            }
            .btn:hover{filter:brightness(1.1);transform:translateY(-2px)}
            .btn:active{transform:scale(0.97)}
            .btn:disabled{opacity:0.35;pointer-events:none}
            .btn-primary{background:linear-gradient(135deg,var(--accent),#0056cc);color:#fff;width:100%;margin-top:8px;box-shadow:0 4px 16px rgba(0,122,255,0.25)}
            .btn-primary:hover{box-shadow:0 8px 24px rgba(0,122,255,0.35)}
            .btn-secondary{background:rgba(255,255,255,0.04);color:rgba(255,255,255,0.6);border:1px solid rgba(255,255,255,0.04)}
            .btn-secondary:hover{background:rgba(255,255,255,0.08)}
            .btn-restart{color:var(--accent);background:rgba(0,122,255,0.08);border:1px solid rgba(0,122,255,0.06)}
            .btn-restart:hover{background:rgba(0,122,255,0.15)}
            .btn-stop{color:var(--danger);background:rgba(255,69,58,0.08);border:1px solid rgba(255,69,58,0.06)}
            .btn-stop:hover{background:rgba(255,69,58,0.15)}
            .btn-emojis{width:auto;margin:0;padding:0 16px;font-size:12px;border-radius:10px}

            .err-msg{
                background:rgba(255,69,58,0.08);color:#ff6b6b;
                border:1px solid rgba(255,69,58,0.1);border-radius:14px;
                padding:12px 16px;font-size:12px;font-weight:600;margin-bottom:16px;
                backdrop-filter:blur(8px);
            }
            .err-msg-title{font-weight:700;margin:0 0 4px;font-size:13px}
            .err-msg-desc{font-size:12px;margin:0 0 14px;line-height:1.4}

            .signout{
                display:inline-block;margin-top:24px;
                color:rgba(255,255,255,0.15);text-decoration:none;
                font-size:12px;font-weight:600;transition:all 0.3s;letter-spacing:0.5px;
            }
            .signout:hover{color:rgba(255,255,255,0.3)}
            .admin-link{
                display:inline-block;margin-top:24px;margin-right:16px;
                color:#0a84ff;text-decoration:none;
                font-size:12px;font-weight:700;transition:all 0.3s;letter-spacing:0.5px;
            }
            .admin-link:hover{opacity:0.8}

            .status-box{
                width:180px;max-width:100%;height:180px;margin:0 auto 14px;
                display:flex;align-items:center;justify-content:center;
                background:rgba(0,0,0,0.3);border-radius:20px;
                border:1px solid rgba(255,255,255,0.03);
            }
            .status-box div{font-size:12px;color:rgba(255,255,255,0.25);font-weight:600;text-align:center}
            .status-box .spinner{
                width:22px;height:22px;border:2px solid rgba(255,255,255,0.05);
                border-top-color:rgba(255,255,255,0.3);border-radius:50%;
                animation:spin 0.8s linear infinite;margin:0 auto 8px;
            }

            @media(max-width:480px){
                .card{padding:20px 14px}
                h1{font-size:20px}
                .row span{font-size:12px}
                .actions .btn{font-size:12px;padding:10px 12px}
                .qr-wrap img{width:160px}
                .emoji-card{padding:12px 12px}
            }
        </style>
    </head><body>
        <div class="card">
            <h1>AutoViewer</h1>
            <p class="sub">${escapeHTML(user.username)}</p>

            <div class="badge ${inst.status === 'online' ? 'online' : inst.status === 'connecting' ? 'connecting' : inst.status === 'error' ? 'error' : 'offline'}" id="status-badge">
                ${escapeHTML(inst.status.toUpperCase())}
            </div>
            <div class="slots" id="slots-display">${instances.size}/${MAX_INSTANCES} slots</div>

            <div class="announce" id="announce"></div>

            <div id="setup-section" class="${inst.status === 'online' ? 'hidden' : ''} section">
                <div id="qr-content">
                    ${inst.qrDataUrl ? `
                        <div class="qr-wrap">
                            <img src="${inst.qrDataUrl}" alt="QR Code">
                            <svg class="qr-logo" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12C2 14.4 2.8 16.6 4.2 18.4L3.3 21.5L6.5 20.6C8.3 21.8 10.4 22.5 12.5 22.5C18 22.5 22.5 18 22.5 12.5C22.5 9.6 21.3 7 19.2 4.9C17.1 2.8 14.5 2 12 2Z" fill="#25D366"/><path d="M17.2 14.8C17 15 16.5 15.3 15.8 15.1C15.3 14.9 14.5 14.5 14 14.3C13.5 14.1 13.2 14 12.8 14.3C12.5 14.5 11.8 15.1 11.6 15.3C11.4 15.5 11.1 15.6 10.8 15.4C10.3 15.2 9.5 14.9 8.7 14.2C7.9 13.5 7.4 12.6 7.2 12.3C7 12 7.2 11.8 7.3 11.6C7.5 11.4 7.6 11.3 7.8 11.1C7.9 10.9 8 10.8 8.1 10.6C8.2 10.4 8.2 10.2 8.1 10C8 9.8 7.6 8.9 7.4 8.5C7.2 8.1 7 8.1 6.8 8.1C6.6 8.1 6.4 8.1 6.1 8.1C5.9 8.1 5.5 8.2 5.2 8.5C4.9 8.9 4 9.8 4 11.6C4 13.4 5.3 15 5.5 15.3C5.7 15.6 7.5 18.5 10.2 19.7C12.9 20.9 12.9 20.4 13.7 20.3C14.5 20.2 16.6 19.3 17 18.3C17.4 17.3 17.4 16.5 17.2 14.8Z" fill="white"/></svg>
                        </div>
                        <p class="hint">WhatsApp > Linked Devices > Link a Device</p>
                        <button class="btn btn-secondary" id="qr-refresh-btn">Refresh QR Code</button>
                    ` : inst.status === 'starting' ? `
                        <div class="status-box"><div><div class="spinner"></div>Initializing...</div></div>
                    ` : `
                        <button class="btn btn-primary" id="start-btn">Start Link Process</button>
                    `}
                </div>
            </div>

            <div id="online-section" class="${inst.status === 'online' ? '' : 'hidden'} section">
                <div class="pp-wrap">
                    ${inst.ppUrl
                        ? `<img id="profile-pic" src="${escapeHTML(inst.ppUrl)}">`
                        : `<svg id="profile-pic" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" fill="rgba(255,255,255,0.15)"/><path d="M4 22c0-4.4 3.6-8 8-8s8 3.6 8 8" fill="rgba(255,255,255,0.15)"/></svg>`
                    }
                </div>
                <p class="active-label">Connected</p>
                <p class="active-subtle">Bot is active</p>
                <div class="actions">
                    <button class="btn btn-restart" id="restart-btn">Restart</button>
                    <button class="btn btn-stop" id="stop-btn">Disconnect</button>
                </div>
            </div>

            <div class="settings">
                <div class="row">
                    <span>🛡️ Anti-Delete (Messages)</span>
                    <label class="switch"><input type="checkbox" data-feature="antideleteMsg" ${userData.antideleteMsg !== false ? 'checked' : ''}><span class="slider"></span></label>
                </div>
                <div class="row">
                    <span>🛡️ Anti-Delete (Status)</span>
                    <label class="switch"><input type="checkbox" data-feature="antideleteStatus" ${userData.antideleteStatus !== false ? 'checked' : ''}><span class="slider"></span></label>
                </div>
                <div class="row">
                    <span>🤖 Auto-Reply</span>
                    <label class="switch"><input type="checkbox" data-feature="autoreply" ${userData.autoreply ? 'checked' : ''}><span class="slider"></span></label>
                </div>
                <div class="row">
                    <span>👁️ Auto View Status</span>
                    <label class="switch"><input type="checkbox" data-feature="autostatus" ${userData.autostatus !== false ? 'checked' : ''}><span class="slider"></span></label>
                </div>
                <div class="row">
                    <span>🎭 Status React</span>
                    <label class="switch"><input type="checkbox" data-feature="statusReact" ${userData.statusReact !== false ? 'checked' : ''}><span class="slider"></span></label>
                </div>
                <div class="row">
                    <span>🟢 Presence</span>
                    <select class="presence-select" id="presence-select">
                        <option value="none" ${(userData.presence || 'none') === 'none' ? 'selected' : ''}>None (default)</option>
                        <option value="online" ${(userData.presence || 'none') === 'online' ? 'selected' : ''}>Online</option>
                        <option value="typing" ${(userData.presence || 'none') === 'typing' ? 'selected' : ''}>Typing</option>
                        <option value="recording" ${(userData.presence || 'none') === 'recording' ? 'selected' : ''}>Recording</option>
                    </select>
                </div>
                <div class="row">
                    <span>📵 Anti-Call</span>
                    <label class="switch"><input type="checkbox" data-feature="anticall" ${userData.anticall ? 'checked' : ''}><span class="slider"></span></label>
                </div>
                <div class="row">
                    <span>🔗 Anti-Link</span>
                    <label class="switch"><input type="checkbox" data-feature="antilink" ${userData.antilink ? 'checked' : ''}><span class="slider"></span></label>
                </div>
                <div class="row">
                    <span>👑 Group Admin Tools</span>
                    <label class="switch"><input type="checkbox" data-feature="groupAdmin" ${userData.groupAdmin ? 'checked' : ''}><span class="slider"></span></label>
                </div>
                <div class="row">
                    <span>🏷️ Anti-Tag Status</span>
                    <label class="switch"><input type="checkbox" data-feature="antiTagStatus" ${userData.antiTagStatus ? 'checked' : ''}><span class="slider"></span></label>
                </div>
                <div class="row">
                    <span>🌐 Public Commands</span>
                    <label class="switch"><input type="checkbox" data-feature="mode" ${userData.mode === 'public' ? 'checked' : ''}><span class="slider"></span></label>
                </div>

                <div class="emoji-card">
                    <label>Allow List <span style="text-transform:none;letter-spacing:0">(ChatAI replies — numbers, comma separated. Empty = everyone)</span></label>
                    <div class="emoji-row">
                        <textarea id="list-input-allow" inputmode="decimal" autocomplete="off" placeholder="233555123456, 233555654321">${escapeHTML((userData.allow || []).join(', '))}</textarea>
                    </div>
                    <div class="emoji-row" style="margin-top:8px">
                        <button class="btn btn-primary btn-emojis list-save-btn" data-listkey="allow">Save</button>
                    </div>
                </div>

                <div class="emoji-card">
                    <label>Block List <span style="text-transform:none;letter-spacing:0">(ChatAI never replies — numbers, comma separated)</span></label>
                    <div class="emoji-row">
                        <textarea id="list-input-block" inputmode="decimal" autocomplete="off" placeholder="233555000000">${escapeHTML((userData.block || []).join(', '))}</textarea>
                    </div>
                    <div class="emoji-row" style="margin-top:8px">
                        <button class="btn btn-primary btn-emojis list-save-btn" data-listkey="block">Save</button>
                    </div>
                </div>

                <div class="emoji-card">
                    <label>Admin Users <span style="text-transform:none;letter-spacing:0">(can use admin dot-commands — numbers, comma separated)</span></label>
                    <div class="emoji-row">
                        <textarea id="list-input-admins" inputmode="decimal" autocomplete="off" placeholder="233555123456">${escapeHTML((userData.admins || []).join(', '))}</textarea>
                    </div>
                    <div class="emoji-row" style="margin-top:8px">
                        <button class="btn btn-primary btn-emojis list-save-btn" data-listkey="admins">Save</button>
                    </div>
                </div>

                <div class="emoji-card">
                    <label>Persona <span style="text-transform:none;letter-spacing:0">(alternate bot identity for .persona — overrides nothing if empty)</span></label>
                    <div class="emoji-row">
                        <textarea id="list-input-persona" maxlength="2000" placeholder="e.g. Kwame, friendly phone shop attendant">${escapeHTML(userData.persona || '')}</textarea>
                    </div>
                    <div class="emoji-row" style="margin-top:8px">
                        <button class="btn btn-primary btn-emojis list-save-btn" data-listkey="persona">Save</button>
                    </div>
                </div>

                <div class="emoji-card">
                    <label>Reaction Emojis</label>
                    <div class="emoji-row" id="emoji-form">
                        <input type="text" id="emoji-input" value="${escapeHTML(userData.reactEmojis || '❤️,🖤,💚,🤍,💙,🩷,🩵')}">
                        <button class="btn btn-primary btn-emojis" id="emoji-save-btn">Save</button>
                    </div>
                </div>

                <div class="emoji-card">
                    <label>Bot Instructions <span style="text-transform:none;letter-spacing:0">(only with Auto-Reply)</span></label>
                    <div class="emoji-row">
                        <textarea id="botinstr-input" maxlength="1000" placeholder="e.g. We sell phones in Accra. Prices in GHS. Hours: 9am-6pm Mon-Sat.">${escapeHTML(userData.botInstructions || '')}</textarea>
                    </div>
                    <div class="emoji-row" style="margin-top:8px">
                        <button class="btn btn-primary btn-emojis" id="botinstr-save-btn">Save</button>
                    </div>
                </div>
            </div>

            ${userData.isAdmin ? '<a href="/admin?r=1" class="admin-link">Admin Panel</a>' : ''}
            <a href="/logout" class="signout">Sign Out</a>
        </div>

        <script>
            function esc(s){if(!s)return '';return String(s).replace(/[&<>"']/g,c=>{return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c];})}
            function $(id){return document.getElementById(id)}
            let pollTimer=null,lastQrKey='',prevIsOnline=null;

            const CSRF_TOKEN='${csrfToken(req)}';
            async function apiPost(url,body){
                const resp=await fetch(url,{method:'POST',headers:body?{'Content-Type':'application/json','X-CSRF-Token':CSRF_TOKEN}:{'X-CSRF-Token':CSRF_TOKEN},body:body?JSON.stringify(body):undefined});
                if(!resp.ok){const txt=await resp.text();let msg;try{const j=JSON.parse(txt);msg=j.message||j.error||txt;}catch(e){msg=txt||resp.statusText;}throw new Error(msg);}
                return resp;
            }

            function showError(msg){
                let div=document.querySelector('.card>.err-msg');
                if(!div){
                    div=document.createElement('div');div.className='err-msg';
                    document.querySelector('.card h1').insertAdjacentElement('afterend',div);
                }
                div.textContent=msg;
            }

            function doAction(btn,label,url,body){
                btn.disabled=true;const orig=btn.textContent;btn.textContent=label;
                apiPost(url,body).then(()=>{btn.disabled=false;btn.textContent=orig;}).catch(e=>{showError('Action failed: '+e.message);btn.disabled=false;btn.textContent=orig;});
            }

            document.addEventListener('DOMContentLoaded',()=>{
                const err=new URLSearchParams(window.location.search).get('error');
                if(err){showError(decodeURIComponent(err));history.replaceState(null,'','/');}
                bindActions();startPolling();
            });

            window.addEventListener('beforeunload',()=>{if(pollTimer)clearInterval(pollTimer);});

            function bindActions(){
                $('emoji-form')?.addEventListener('submit',e=>e.preventDefault());
                $('emoji-save-btn')?.addEventListener('click',async function(){
                    const input=$('emoji-input');if(!input.value.trim())return;
                    this.disabled=true;this.textContent='Saving...';
                    try{await apiPost('/settings/update-emojis',{emojis:input.value});this.textContent='Saved!';setTimeout(()=>{this.textContent='Save';this.disabled=false;},1500);}
                    catch(e){showError('Failed to save emojis: '+e.message);this.disabled=false;this.textContent='Save';}
                });

                $('botinstr-save-btn')?.addEventListener('click',async function(){
                    const input=$('botinstr-input');
                    this.disabled=true;this.textContent='Saving...';
                    try{
                        const v=(input.value||'').slice(0,1000);
                        await apiPost('/settings/bot-profile',{botInstructions:v});
                        this.textContent='Saved!';setTimeout(()=>{this.textContent='Save';this.disabled=false;},1500);
                    }
                    catch(e){showError('Failed to save instructions: '+e.message);this.disabled=false;this.textContent='Save';}
                });

                document.querySelectorAll('.list-save-btn').forEach(btn=>{
                    btn.addEventListener('click',async function(){
                        const key=this.dataset.listkey;
                        const input=document.getElementById('list-input-'+key);
                        if(!input)return;
                        this.disabled=true;this.textContent='Saving...';
                        try{
                            await apiPost('/settings/update-lists',{key,value:input.value});
                            this.textContent='Saved!';setTimeout(()=>{this.textContent='Save';this.disabled=false;},1500);
                        }
                        catch(e){showError('Failed to save list: '+e.message);this.disabled=false;this.textContent='Save';}
                    });
                });

                // Disable antilink toggle when groupAdmin off
                const syncAntilink = () => {
                    const ga = document.querySelector('input[data-feature="groupAdmin"]');
                    const al = document.querySelector('input[data-feature="antilink"]');
                    if (ga && al) { al.disabled = !ga.checked; al.closest('.row').style.opacity = ga.checked ? '1' : '0.5'; }
                };
                syncAntilink();
                document.querySelector('input[data-feature="groupAdmin"]')?.addEventListener('change', syncAntilink);
                document.querySelectorAll('input[data-feature]').forEach(cb=>{
                    cb.addEventListener('change',async function(){
                        const feature=this.dataset.feature;
                        try{const resp=await apiPost('/settings/toggle',{feature});const data=await resp.json();this.checked=data.enabled;}
                        catch(e){this.checked=!this.checked;showError('Failed to update setting: '+e.message);}
                    });
                });

                $('presence-select')?.addEventListener('change',async function(){
                    const prev=this.value;
                    this.disabled=true;
                    try{
                        const resp=await apiPost('/settings/presence',{presence:this.value});
                        if(!resp.ok)throw new Error('request failed');
                    }catch(e){
                        this.value=prev;
                        showError('Failed to update presence: '+e.message);
                    }finally{
                        this.disabled=false;
                    }
                });

                document.addEventListener('click',e=>{
                    const btn=e.target.closest('#qr-refresh-btn,#start-btn,#restart-btn,#stop-btn,#retry-btn');
                    if(!btn)return;
                    const id=btn.id;
                    if(id==='qr-refresh-btn')doAction(btn,'Refreshing...','/api/refresh-qr');
                    else if(id==='start-btn')doAction(btn,'Starting...','/bot/start');
                    else if(id==='restart-btn')doAction(btn,'Restarting...','/bot/restart');
                    else if(id==='retry-btn')doAction(btn,'Retrying...','/bot/restart');
                    else if(id==='stop-btn')doAction(btn,'Disconnecting...','/bot/stop');
                });
            }

            function startPolling(){pollTimer=setInterval(pollStatus,4000);}

            async function pollStatus(){
                try{
                    const resp=await fetch('/api/status');if(!resp.ok)return;
                    const data=await resp.json();
                    const badge=$('status-badge');
                    if(badge){
                        badge.className='badge '+(data.status==='online'?'online':data.status==='connecting'||data.status==='starting'?'connecting':data.status==='error'?'error':data.status==='stopped'?'stopped':'offline');
                        badge.textContent=data.status.toUpperCase();
                    }
                    const slots=$('slots-display');if(slots)slots.textContent=data.activeCount+'/'+data.maxCount+' slots';
                    const ann=$('announce');
                    if(ann){
                        if(data.announcement){ann.textContent=data.announcement;ann.classList.add('show');}
                        else{ann.classList.remove('show');ann.textContent='';}
                    }
                    updateView(data);
                }catch(e){}
            }

            function setProfilePic(el,url){
                if(!url)return;
                if(el.tagName==='IMG'){el.src=url;return;}
                const img=document.createElement('img');img.id='profile-pic';img.style.cssText='width:100%;height:100%;object-fit:cover;';img.src=url;
                el.parentNode.replaceChild(img,el);
            }

            function qrKey(data){if(data.qrDataUrl)return data.qrDataUrl;if(data.status==='error')return 'error:'+(data.errorMsg||'');return data.status;}

            function updateView(data){
                const setup=$('setup-section'),online=$('online-section'),qr=$('qr-content'),pp=$('profile-pic');
                const isOnline=data.status==='online';
                if(prevIsOnline!==isOnline){setup?.classList.toggle('hidden',isOnline);online?.classList.toggle('hidden',!isOnline);prevIsOnline=isOnline;}
                if(isOnline){if(pp)setProfilePic(pp,data.ppUrl);return;}
                if(!qr)return;
                const key=qrKey(data);if(key===lastQrKey)return;lastQrKey=key;
                if(data.status==='error'){
                    qr.innerHTML='<div class="err-msg"><p class="err-msg-title">⚠️ Connection Error</p><p class="err-msg-desc">'+esc(data.errorMsg||'Connection failed.')+'</p><button class="btn btn-primary" id="retry-btn">Try Again</button></div>';
                }else if(data.qrDataUrl){
                    qr.innerHTML='<div class="qr-wrap"><img src="'+esc(data.qrDataUrl)+'" alt="QR Code"><svg class="qr-logo" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12C2 14.4 2.8 16.6 4.2 18.4L3.3 21.5L6.5 20.6C8.3 21.8 10.4 22.5 12.5 22.5C18 22.5 22.5 18 22.5 12.5C22.5 9.6 21.3 7 19.2 4.9C17.1 2.8 14.5 2 12 2Z" fill="#25D366"/><path d="M17.2 14.8C17 15 16.5 15.3 15.8 15.1C15.3 14.9 14.5 14.5 14 14.3C13.5 14.1 13.2 14 12.8 14.3C12.5 14.5 11.8 15.1 11.6 15.3C11.4 15.5 11.1 15.6 10.8 15.4C10.3 15.2 9.5 14.9 8.7 14.2C7.9 13.5 7.4 12.6 7.2 12.3C7 12 7.2 11.8 7.3 11.6C7.5 11.4 7.6 11.3 7.8 11.1C7.9 10.9 8 10.8 8.1 10.6C8.2 10.4 8.2 10.2 8.1 10C8 9.8 7.6 8.9 7.4 8.5C7.2 8.1 7 8.1 6.8 8.1C6.6 8.1 6.4 8.1 6.1 8.1C5.9 8.1 5.5 8.2 5.2 8.5C4.9 8.9 4 9.8 4 11.6C4 13.4 5.3 15 5.5 15.3C5.7 15.6 7.5 18.5 10.2 19.7C12.9 20.9 12.9 20.4 13.7 20.3C14.5 20.2 16.6 19.3 17 18.3C17.4 17.3 17.4 16.5 17.2 14.8Z" fill="white"/></svg></div><p class="hint">WhatsApp &gt; Linked Devices &gt; Link a Device</p><button class="btn btn-secondary" id="qr-refresh-btn">Refresh QR Code</button>';
                }else if(data.status==='starting'){
                    qr.innerHTML='<div class="status-box"><div><div class="spinner"></div>Waiting for QR code...</div></div>';
                }else if(data.status==='connecting'){
                    qr.innerHTML='<div class="status-box"><div><div class="spinner"></div>Generating QR code...</div></div>';
                }else if(data.status==='offline'){
                    qr.innerHTML='<div class="status-box"><div><div class="spinner"></div>Reconnecting...</div></div>';
                }else if(data.status==='stopped'){
                    qr.innerHTML='<button class="btn btn-primary" id="start-btn">Start Link Process</button>';
                }
            }
        </script>
    </body></html>
    `);
});

app.get('/login', (req, res) => {
    res.send(loginPage('', req));
});

app.post('/login', loginLimiter, ah(async (req, res) => {
    const { username, password } = req.body || {};
    const cleanUser = (username || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!cleanUser || !isValidUsername(cleanUser) || typeof password !== 'string' || !password || password.length < 6 || password.length > 100) return res.status(401).send(loginPage('Invalid username or password.', req));
    
    const db = loadDB();
    if (db[cleanUser] && await bcrypt.compare(password, db[cleanUser].password)) {
        req.session.regenerate(() => {
            req.session.user = { username: cleanUser };
            res.redirect('/');
        });
        return;
    }
    res.status(401).send(loginPage('Invalid username or password.', req));
}));

app.get('/register', (req, res) => {
    res.send(registerPage('', req));
});

function isValidUsername(u) {
    return /^[a-z0-9]{2,20}$/.test(u);
}

app.post('/register', registerLimiter, ah(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).send(registerPage('Username and password are required.', req));
    if (password.length < 6) return res.status(400).send(registerPage('Password must be at least 6 characters.', req));

    // Invite-only registration: INVITE_CODE may hold comma-separated codes.
    // With no codes configured, registration is closed entirely. The very
    // first account (empty DB) bypasses the gate — someone has to bootstrap.
    if (inviteRequired()) {
        const validCodes = (process.env.INVITE_CODE || '').split(',').map(s => s.trim()).filter(Boolean);
        if (!validCodes.length) {
            return res.status(403).send(registerPage('Registration is currently closed. Contact the admin to get an invite code.', req));
        }
        const a = Buffer.from(String(req.body.invite || ''));
        const codeOk = validCodes.some((code) => {
            const b = Buffer.from(code);
            return a.length === b.length && crypto.timingSafeEqual(a, b);
        });
        if (!codeOk) return res.status(403).send(registerPage('Invalid invite code. Contact the admin to get one.', req));
    }

    const cleanUser = (username || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!isValidUsername(cleanUser)) return res.status(400).send(registerPage('Username must be 2-20 alphanumeric characters.', req));

    const hashed = await bcrypt.hash(password, 10);
    let taken = false;
    await dbTransaction((db) => {
        if (db[cleanUser]) { taken = true; return; }
        db[cleanUser] = { 
            password: hashed,
            autoreply: false,
            antideleteMsg: true,
            antideleteStatus: true,
            autostatus: true,
            statusReact: true,
            antiTagStatus: false,
            presence: 'none',
            mode: 'self',
            anticall: false,
            antilink: false,
            groupAdmin: false,
            isAdmin: adminUsernameList().includes(cleanUser),
            // Command-managed settings (dot commands, ported from GitHub version)
            allow: [],
            block: [],
            persona: '',
            admins: [],
            reactEmojis: '❤️,🖤,💚,🤍,💙,🩷,🩵',
            botName: '',
            botInstructions: '',
            running: false
        };
    });
    if (taken) return res.status(409).send(registerPage('Registration failed.', req));
    res.redirect('/login');
}));

const ALLOWED_FEATURES = new Set(['autoreply', 'antideleteMsg', 'antideleteStatus', 'autostatus', 'statusReact', 'anticall', 'antilink', 'groupAdmin', 'antiTagStatus', 'mode']);
const ALLOWED_PRESENCE = new Set(['none', 'online', 'typing', 'recording']);
app.post('/settings/toggle', requireUser, ah(async (req, res) => {
    const { feature } = req.body || {};
    if (!feature || !ALLOWED_FEATURES.has(feature)) return res.status(400).json({ status: 'error', message: 'Invalid feature.' });
    const username = req.session.user.username;
    // antilink requires groupAdmin enabled
    if (feature === 'antilink') {
        const dbCheck = loadDB();
        if (!dbCheck[username]?.groupAdmin) return res.status(400).json({ status: 'error', message: 'Enable Group Admin Tools first' });
    }
    let enabled;
    await dbTransaction((db) => {
        if (!db[username]) return;
        if (feature === 'mode') {
            // mode is 'self'|'public', not boolean
            enabled = db[username].mode !== 'public';
            db[username].mode = enabled ? 'public' : 'self';
        } else {
            db[username][feature] = !db[username][feature];
            enabled = db[username][feature];
        }
        // if disabling groupAdmin, also disable antilink for consistency
        if (feature === 'groupAdmin' && !enabled && db[username].antilink) {
            db[username].antilink = false;
        }
        const inst = instances.get(username);
        if (inst && inst.child) {
            // A dead/reconnecting child must not abort the DB save
            try { inst.child.send({ type: 'SETTINGS', settings: db[username] }); }
            catch (e) { console.warn(`[Manager] Worker unreachable for ${username} (will pick up settings on next load): ${e.message}`); }
        }
    });
    res.json({ status: 'ok', enabled });
}));

app.post('/settings/update-emojis', requireUser, ah(async (req, res) => {
    const { emojis } = req.body || {};
    if (!emojis || typeof emojis !== 'string' || emojis.length > 500) {
        return res.status(400).json({ status: 'error', message: 'Invalid emoji input.' });
    }
    const cleaned = emojis.split(',').map(s => s.replace(/[^\p{So}\p{Sk}\uFE0F\u200D]/gu, '').trim()).filter(Boolean).join(',');
    if (!cleaned) return res.status(400).json({ status: 'error', message: 'No valid emojis found.' });
    const username = req.session.user.username;
    await dbTransaction((db) => {
        if (!db[username]) return;
        db[username].reactEmojis = cleaned;
        const inst = instances.get(username);
        if (inst && inst.child) {
            try { inst.child.send({ type: 'SETTINGS', settings: db[username] }); }
            catch (e) { console.warn(`[Manager] Worker unreachable for ${username}: ${e.message}`); }
        }
    });
    res.json({ status: 'ok' });
}));

app.post('/settings/bot-profile', requireUser, ah(async (req, res) => {
    const { botName, botInstructions } = req.body || {};
    const instr = String(botInstructions ?? '').slice(0, 1000);
    const username = req.session.user.username;
    await dbTransaction((db) => {
        if (!db[username]) return;
        // botName is only touched when explicitly provided — saving
        // instructions must not wipe an existing name
        if (botName !== undefined) db[username].botName = String(botName).trim().slice(0, 30);
        db[username].botInstructions = instr;
        const inst = instances.get(username);
        if (inst && inst.child) {
            try { inst.child.send({ type: 'SETTINGS', settings: db[username] }); }
            catch (e) { console.warn(`[Manager] Worker unreachable for ${username}: ${e.message}`); }
        }
    });
    res.json({ status: 'ok' });
}));

const EDITABLE_LISTS = new Set(['allow', 'block', 'admins', 'persona']);
app.post('/settings/update-lists', requireUser, ah(async (req, res) => {
    const { key, value } = req.body || {};
    if (!key || !EDITABLE_LISTS.has(key) || typeof value !== 'string') return res.status(400).json({ status: 'error', message: 'Invalid input.' });
    const username = req.session.user.username;
    let cleaned;
    if (key === 'persona') {
        cleaned = value.trim().slice(0, 2000);
    } else {
        cleaned = value.split(/[\n,;\s.]+/).map(s => s.replace(/[^0-9]/g, '')).filter(v => v.length >= 8 && v.length <= 15);
        if (cleaned.length > 200) return res.status(400).json({ status: 'error', message: 'List too long (max 200 numbers).' });
    }
    await dbTransaction((db) => {
        if (!db[username]) return;
        db[username][key] = cleaned;
        const inst = instances.get(username);
        if (inst && inst.child) {
            try { inst.child.send({ type: 'SETTINGS', settings: db[username] }); }
            catch (e) { console.warn(`[Manager] Worker unreachable for ${username}: ${e.message}`); }
        }
    });
    res.json({ status: 'ok' });
}));
app.post('/settings/presence', requireUser, ah(async (req, res) => {
    const { presence } = req.body || {};
    if (!ALLOWED_PRESENCE.has(presence)) {
        return res.status(400).json({ status: 'error', message: 'Invalid presence value.' });
    }
    const username = req.session.user.username;
    await dbTransaction((db) => {
        if (!db[username]) return;
        db[username].presence = presence;
        const inst = instances.get(username);
        if (inst && inst.child) {
            try { inst.child.send({ type: 'SETTINGS', settings: db[username] }); }
            catch (e) { console.warn(`[Manager] Worker unreachable for ${username}: ${e.message}`); }
        }
    });
    res.json({ status: 'ok' });
}));

app.post('/bot/start', requireUser, ah(async (req, res) => {
    const username = req.session.user.username;
    if (instances.size >= MAX_INSTANCES && !instances.has(username)) {
        return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    }
    clearPendingRestart(username);
    const started = startUserBot(username, false);
    if (started === 'busy') return res.status(409).json({ status: 'error', message: 'Bot is already starting.' });
    if (started === 'capacity') return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    await dbTransaction((db) => {
        if (instances.has(username)) db[username].running = true;
    });
    res.json({ status: 'ok' });
}));

app.post('/bot/stop', requireUser, ah(async (req, res) => {
    const username = req.session.user.username;
    clearPendingRestart(username);
    clearStartupWatchdog(username);
    await dbTransaction((db) => { db[username].running = false; });
    const inst = instances.get(username);
    if (inst && inst.child) {
        inst.child.kill();
        await new Promise(r => setTimeout(r, 1000));
        // Graceful SIGTERM can be stuck on a busy event loop — make sure the
        // worker actually dies so a re-start can't double-session the account
        if (inst.child.exitCode === null && inst.child.signalCode === null) {
            try { inst.child.kill('SIGKILL'); } catch (e) {}
        }
        // Only remove if it's still the SAME instance — a restart clicked
        // during the 1s window replaced it and must not be orphaned
        if (instances.get(username) === inst) instances.delete(username);
    }
    // Purge crash/wipe/QR bookkeeping for a manual stop
    crashCounts.delete(username);
    wipeCounts.delete(username);
    startedAtMap.delete(username);
    lastQrCache.delete(username);
    res.json({ status: 'ok' });
}));

app.post('/bot/restart', requireUser, ah(async (req, res) => {
    const username = req.session.user.username;
    if (instances.size >= MAX_INSTANCES && !instances.has(username)) {
        return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    }
    const started = startUserBot(username, false);
    if (started === 'busy') return res.status(409).json({ status: 'error', message: 'Bot is already starting.' });
    if (started === 'capacity') return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    await dbTransaction((db) => { db[username].running = true; });
    res.json({ status: 'ok' });
}));

app.post('/api/refresh-qr', requireUser, ah(async (req, res) => {
    const username = req.session.user.username;
    if (instances.size >= MAX_INSTANCES && !instances.has(username)) {
        return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    }
    clearPendingRestart(username);
    const started = startUserBot(username, true);
    if (started === 'busy') return res.status(409).json({ status: 'error', message: 'Bot is already starting.' });
    if (started === 'capacity') return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    await dbTransaction((db) => { db[username].running = true; });
    res.json({ status: 'ok' });
}));

app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/login');
});

// ── Admin ────────────────────────────────────────────────────────────────────
function adminTarget(req) {
    const { username } = req.body || {};
    const clean = String(username || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!clean) return null;
    const db = loadDB();
    return db[clean] ? clean : null;
}

app.get('/api/admin/users', requireUser, requireAdmin, (req, res) => {
    const db = loadDB();
    const users = Object.keys(db).map(u => {
        const inst = instances.get(u) || null;
        const data = db[u];
        return {
            username: u,
            isAdmin: !!data.isAdmin,
            running: !!data.running,
            status: inst ? inst.status : 'stopped',
            errorMsg: inst?.errorMsg || null,
            presence: data.presence || 'none',
            features: {
                autoreply: !!data.autoreply,
                antideleteMsg: (('antideleteMsg' in data) ? data.antideleteMsg : data.antidelete) !== false,
                antideleteStatus: (('antideleteStatus' in data) ? data.antideleteStatus : data.antidelete) !== false,
                autostatus: data.autostatus !== false,
                statusReact: data.statusReact !== false,
                anticall: !!data.anticall
            }
        };
    });
    console.log(`[Admin] users listed by ${req.session.user.username}: ${users.length}`);
    res.json({ users, activeCount: instances.size, maxCount: MAX_INSTANCES });
});

app.post('/api/admin/bot/start', requireUser, requireAdmin, ah(async (req, res) => {
    const username = adminTarget(req);
    if (!username) return res.status(400).json({ status: 'error', message: 'Invalid user.' });
    if (instances.size >= MAX_INSTANCES && !instances.has(username)) {
        return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    }
    clearPendingRestart(username);
    const started = startUserBot(username, false);
    if (started === 'busy') return res.status(409).json({ status: 'error', message: 'Bot is already starting.' });
    if (started === 'capacity') return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    await dbTransaction((db) => { if (instances.has(username)) db[username].running = true; });
    res.json({ status: 'ok' });
}));

app.post('/api/admin/bot/stop', requireUser, requireAdmin, ah(async (req, res) => {
    const username = adminTarget(req);
    if (!username) return res.status(400).json({ status: 'error', message: 'Invalid user.' });
    clearPendingRestart(username);
    clearStartupWatchdog(username);
    await dbTransaction((db) => { db[username].running = false; });
    const inst = instances.get(username);
    if (inst && inst.child) {
        inst.child.kill();
        await new Promise(r => setTimeout(r, 1000));
        if (inst.child.exitCode === null && inst.child.signalCode === null) {
            try { inst.child.kill('SIGKILL'); } catch (e) {}
        }
        if (instances.get(username) === inst) instances.delete(username);
    }
    crashCounts.delete(username);
    wipeCounts.delete(username);
    startedAtMap.delete(username);
    lastQrCache.delete(username);
    res.json({ status: 'ok' });
}));

app.post('/api/admin/bot/restart', requireUser, requireAdmin, ah(async (req, res) => {
    const username = adminTarget(req);
    if (!username) return res.status(400).json({ status: 'error', message: 'Invalid user.' });
    if (instances.size >= MAX_INSTANCES && !instances.has(username)) {
        return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    }
    const started = startUserBot(username, false);
    if (started === 'busy') return res.status(409).json({ status: 'error', message: 'Bot is already starting.' });
    if (started === 'capacity') return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    await dbTransaction((db) => { db[username].running = true; });
    res.json({ status: 'ok' });
}));
app.post('/api/admin/user/delete', requireUser, requireAdmin, ah(async (req, res) => {
    const username = adminTarget(req);
    if (!username) return res.status(400).json({ status: 'error', message: 'Invalid user.' });
    if (username === req.session.user.username) {
        return res.status(400).json({ status: 'error', message: 'You cannot delete your own account.' });
    }
    const db = loadDB();
    const isLastAdmin = db[username]?.isAdmin && Object.values(db).filter(u => u.isAdmin).length <= 1;
    if (isLastAdmin) return res.status(400).json({ status: 'error', message: 'Cannot delete the last admin account.' });

    clearPendingRestart(username);
    clearStartupWatchdog(username);
    const inst = instances.get(username);
    if (inst && inst.child) {
        inst.child.kill();
        await new Promise(r => setTimeout(r, 1000));
        if (inst.child.exitCode === null && inst.child.signalCode === null) {
            try { inst.child.kill('SIGKILL'); } catch (e) {}
        }
        if (instances.get(username) === inst) instances.delete(username);
    }
    startingLock.delete(username);
    crashCounts.delete(username);
    wipeCounts.delete(username);
    startedAtMap.delete(username);
    lastQrCache.delete(username);

    await dbTransaction((db) => { delete db[username]; });

    const sessionDir = path.join(SESSION_BASE, username);
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {
        console.error(`[Manager] Failed to remove session dir for ${username}:`, e.message);
    }
    console.log(`[Manager] Deleted user ${username}`);
    res.json({ status: 'ok' });
}));

app.get('/api/admin/announcement', requireUser, requireAdmin, (req, res) => {
    res.json({ announcement: getAnnouncement() });
});

app.post('/api/admin/announcement', requireUser, requireAdmin, (req, res) => {
    const { text } = req.body || {};
    res.json({ status: 'ok', announcement: setAnnouncement(text) });
});

app.get('/api/admin/config', requireUser, requireAdmin, (req, res) => {
    res.json({ maxInstances: MAX_INSTANCES });
});
app.post('/api/admin/config', requireUser, requireAdmin, ah(async (req, res) => {
    const n = parseInt((req.body && req.body.maxInstances));
    if (!Number.isFinite(n) || n < 1 || n > 50) return res.status(400).json({ status: 'error', message: 'Max bots must be between 1 and 50.' });
    saveMaxInstances(n);
    console.log(`[Manager] Max instances changed to ${n} by ${req.session.user.username}`);
    res.json({ status: 'ok', maxInstances: MAX_INSTANCES });
}));
app.get('/admin', requireUser, requireAdmin, (req, res) => {
    res.send(`<!DOCTYPE html><html lang="en"><head>
        <meta charset="UTF-8">
        <title>AutoViewer • Admin</title>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>
            @keyframes bgMove{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
            @keyframes floatIn{0%{opacity:0;transform:translateY(18px)}100%{opacity:1;transform:translateY(0)}}
            @keyframes toastIn{0%{opacity:0;transform:translateY(10px)}100%{opacity:1;transform:translateY(0)}}
            *{box-sizing:border-box;margin:0}
            body{
                font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",sans-serif;
                background:linear-gradient(135deg,#0a0a0f,#0d0d1a 30%,#0a0f14 60%,#0f0f0f);
                background-size:200% 200%;animation:bgMove 26s ease infinite;
                min-height:100vh;color:#f0f0f5;padding:28px 16px;
            }
            .wrap{max-width:1020px;margin:0 auto}
            header{display:flex;align-items:center;justify-content:space-between;margin-bottom:22px;flex-wrap:wrap;gap:14px;animation:floatIn .5s cubic-bezier(.16,1,.3,1)}
            .brand{display:flex;align-items:center;gap:12px}
            .logo{width:44px;height:44px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:21px;background:linear-gradient(135deg,rgba(10,132,255,.3),rgba(10,132,255,.07));border:1px solid rgba(255,255,255,.09)}
            h1{font-size:20px;font-weight:800;letter-spacing:-.4px}
            .sub{font-size:12px;color:rgba(255,255,255,.35);margin-top:3px}
            .links{display:flex;align-items:center;gap:14px;flex-wrap:wrap}
            a{color:#0a84ff;text-decoration:none;font-weight:600;font-size:13px}
            a.ghost{color:rgba(255,255,255,.45)}
            a:hover{opacity:.85}
            .chips{display:flex;gap:8px;flex-wrap:wrap;animation:floatIn .5s .06s cubic-bezier(.16,1,.3,1) both}
            .chip{font-size:11px;font-weight:700;color:rgba(255,255,255,.6);background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);padding:7px 13px;border-radius:20px}
            .chip b{color:#fff}
            .ann{background:rgba(255,255,255,.04);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.07);border-radius:18px;padding:14px 16px;margin-bottom:16px;animation:floatIn .5s .12s cubic-bezier(.16,1,.3,1) both}
            .ann-t{font-size:13px;font-weight:700}
            .ann-s{font-size:11px;color:rgba(255,255,255,.35);margin:3px 0 10px}
            .ann-row{display:flex;gap:8px;flex-wrap:wrap}
            .ann-row input{flex:1;min-width:220px;padding:10px 13px;border-radius:11px;border:1px solid rgba(255,255,255,.07);background:rgba(0,0,0,.35);color:#fff;font-size:13px;outline:none}
            .ann-row input:focus{border-color:#0a84ff;box-shadow:0 0 0 3px rgba(10,132,255,.12)}
            .bar{display:flex;align-items:center;gap:12px;margin-bottom:16px;flex-wrap:wrap;animation:floatIn .5s .18s cubic-bezier(.16,1,.3,1) both}
            .search{flex:1;min-width:200px;padding:9px 13px;border-radius:11px;border:1px solid rgba(255,255,255,.07);background:rgba(0,0,0,.3);color:#fff;font-size:13px;outline:none}
            .search:focus{border-color:#0a84ff;box-shadow:0 0 0 3px rgba(10,132,255,.12)}
            .err{font-size:12px;color:#ff6b6b;font-weight:600}
            .cards{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
            .card{background:rgba(255,255,255,.04);backdrop-filter:blur(20px);border:1px solid rgba(255,255,255,.07);border-radius:18px;padding:16px;animation:floatIn .45s cubic-bezier(.16,1,.3,1)}
            .ct{display:flex;align-items:center;gap:12px}
            .av{width:44px;height:44px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:17px;font-weight:800;color:#fff;background:linear-gradient(135deg,#2c2c38,#1b1b24);border:2px solid rgba(255,255,255,.12)}
            .av.online{border-color:#30d158;box-shadow:0 0 12px rgba(48,209,88,.3)}
            .av.connecting{border-color:#ff9f0a;box-shadow:0 0 12px rgba(255,159,10,.3)}
            .av.offline{border-color:#8e8e93}
            .av.error{border-color:#ff453a;box-shadow:0 0 12px rgba(255,69,58,.3)}
            .av.starting{border-color:#ff9f0a;box-shadow:0 0 12px rgba(255,159,10,.3)}
            .id{flex:1;min-width:0}
            .nm{font-weight:700;font-size:14px;display:flex;align-items:center;gap:6px;flex-wrap:wrap}
            .adm{font-size:9px;background:rgba(10,132,255,.15);color:#0a84ff;border-radius:6px;padding:2px 6px;font-weight:700}
            .pill{display:inline-flex;align-items:center;gap:6px;padding:3px 10px;border-radius:20px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;margin-top:5px}
            .pill::before{content:'';width:6px;height:6px;border-radius:50%}
            .pill.online{background:rgba(48,209,88,.12);color:#30d158}.pill.online::before{background:#30d158}
            .pill.connecting{background:rgba(255,159,10,.12);color:#ff9f0a}.pill.connecting::before{background:#ff9f0a}
            .pill.error{background:rgba(255,69,58,.12);color:#ff453a}.pill.error::before{background:#ff453a}
            .pill.offline{background:rgba(142,142,147,.12);color:#8e8e93}.pill.offline::before{background:#8e8e93}
            .pill.stopped{background:rgba(255,255,255,.05);color:rgba(255,255,255,.35)}.pill.stopped::before{background:rgba(255,255,255,.25)}
            .pill.starting{background:rgba(255,159,10,.12);color:#ff9f0a}.pill.starting::before{background:#ff9f0a}
            .meta{display:flex;gap:6px;flex-wrap:wrap;margin:12px 0 9px}
            .tag{display:inline-block;font-size:10px;font-weight:600;padding:3px 9px;border-radius:8px;background:rgba(255,255,255,.05);color:rgba(255,255,255,.4)}
            .tag.on{background:rgba(48,209,88,.1);color:#30d158}
            .tag2{display:inline-block;font-size:10px;font-weight:600;padding:3px 9px;border-radius:8px;background:rgba(255,255,255,.05);color:rgba(255,255,255,.5)}
            .feats{display:flex;gap:6px;flex-wrap:wrap}
            .feat{width:31px;height:31px;border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:14px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.05);opacity:.28;filter:grayscale(1);transition:all .25s}
            .feat.on{opacity:1;filter:none;background:rgba(48,209,88,.08);border-color:rgba(48,209,88,.25);box-shadow:0 0 8px rgba(48,209,88,.12)}
            .el{font-size:11px;color:#ff6b6b;margin:9px 0 4px;font-weight:600;word-break:break-word}
            .acts{display:flex;gap:8px;margin-top:12px}
            .btn{border:none;border-radius:10px;padding:8px 14px;font-size:11px;font-weight:700;cursor:pointer;color:#fff;transition:all .2s;flex:1}
            .btn:hover{filter:brightness(1.2);transform:translateY(-1px)}
            .btn:active{transform:scale(.96)}
            .btn:disabled{opacity:.35;pointer-events:none}
            .bg{background:rgba(48,209,88,.18);color:#30d158;box-shadow:0 4px 14px rgba(48,209,88,.12)}
            .br{background:rgba(255,69,58,.18);color:#ff453a;box-shadow:0 4px 14px rgba(255,69,58,.12)}
            .bb{background:rgba(10,132,255,.18);color:#0a84ff;box-shadow:0 4px 14px rgba(10,132,255,.12)}
            .bd{background:rgba(255,69,58,.18);color:#ff453a;box-shadow:0 4px 14px rgba(255,69,58,.12)}
            .empty{text-align:center;color:rgba(255,255,255,.3);padding:40px;font-size:13px}
            .hidden{display:none!important}
            .toasts{position:fixed;bottom:20px;right:20px;display:flex;flex-direction:column;gap:8px;z-index:99;max-width:320px}
            .toast{background:rgba(20,20,26,.94);backdrop-filter:blur(16px);border:1px solid rgba(255,255,255,.09);border-radius:12px;padding:11px 15px;font-size:12px;font-weight:600;color:#fff;box-shadow:0 12px 32px rgba(0,0,0,.5);animation:toastIn .3s cubic-bezier(.16,1,.3,1)}
            .toast.ok{border-color:rgba(48,209,88,.3)}
            .toast.bad{border-color:rgba(255,69,58,.35);color:#ff6b6b}
            @media(max-width:560px){body{padding:18px 12px}}
        </style>
    </head><body>
        <div class="wrap">
            <header>
                <div class="brand">
                    <div class="logo">🛡️</div>
                    <div><h1>Admin Panel</h1><div class="sub2" style="font-size:12px;color:rgba(255,255,255,.35);margin-top:3px">Manage users &amp; their bots</div></div>
                </div>
                <div style="display:flex;flex-direction:column;align-items:flex-end;gap:12px">
                    <div class="chips">
                        <span class="chip" id="ch-slots">– slots</span>
                        <span class="chip" id="ch-online">– online</span>
                    </div>
                    <div class="maxbox">
                        <label for="max-in" style="font-size:11px;color:rgba(255,255,255,.5);font-weight:700">Max Bots</label>
                        <div style="display:flex;gap:6px;margin-top:5px">
                            <input type="number" id="max-in" min="1" max="50" value="${MAX_INSTANCES}" style="width:72px;padding:7px 10px;border-radius:10px;border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.35);color:#fff;font-size:13px;outline:none">
                            <button class="btn bg" id="max-save" style="flex:0 0 auto;font-size:12px;padding:7px 12px">Save</button>
                        </div>
                    </div>
                    <div class="links"><a href="/">Dashboard</a><a href="/logout" class="ghost">Sign Out</a></div>
                </div>
            </header>

            <div class="ann">
                <div class="ann-t">📢 Announcement</div>
                <div class="ann-s">Shown on every user's dashboard</div>
                <div class="ann-row">
                    <input type="text" id="ann-in" maxlength="500" placeholder="Type an announcement…">
                    <button class="btn bg annb" id="ann-set" style="flex:0 0 auto">Set</button>
                    <button class="btn br annb" id="ann-clr" style="flex:0 0 auto">Clear</button>
                </div>
            </div>

            <div class="bar">
                <input type="text" id="q" class="search" placeholder="🔍  Search users…">
                <div class="err" id="err"></div>
            </div>

            <main id="cards" class="cards"></main>
            <div id="empty" class="empty hidden">No users yet</div>
        </div>

        <div id="toasts" class="toasts"></div>

        <script>
            function $(id){return document.getElementById(id)}
            function esc(s){if(s==null)return'';return String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]))}
            function toast(msg,ok){
                const t=document.createElement('div');t.className='toast '+(ok===false?'bad':'ok');t.textContent=msg;
                $('toasts').appendChild(t);
                setTimeout(()=>{t.style.opacity='0';t.style.transition='opacity .4s';setTimeout(()=>t.remove(),400)},3600);
            }
            const CSRF_TOKEN='${csrfToken(req)}';
            async function api(url,body){
                const r=await fetch(url,{method:'POST',headers:body?{'Content-Type':'application/json','X-CSRF-Token':CSRF_TOKEN}:{'X-CSRF-Token':CSRF_TOKEN},body:body?JSON.stringify(body):undefined});
                if(!r.ok){
                    const t=await r.text();let msg;
                    try{const j=JSON.parse(t);msg=j.message||j.error||t}catch(e){msg=t||r.statusText}
                    throw new Error(msg);
                }
                return r;
            }
            async function getJSON(url){
                const r=await fetch(url,{cache:'no-store'});
                if(!r.ok)throw new Error('HTTP '+r.status);
                const ct=r.headers.get('content-type')||'';
                if(!ct.includes('json'))throw new Error('Not JSON ('+ct+') — session expired?');
                return r.json();
            }
            const FEATS=[['autoreply','🤖'],['antideleteMsg','🛡️'],['antideleteStatus','🛡️'],['autostatus','👁️'],['statusReact','🎭'],['anticall','📵']];
            const FTITLE={autoreply:'Auto-Reply',antideleteMsg:'Anti-Delete (Messages)',antideleteStatus:'Anti-Delete (Status)',autostatus:'Auto-Status',statusReact:'Status Reactions',anticall:'Anti-Call'};
            const RUN=['online','connecting','offline','starting'];

            function mk(name){
                const d=document.createElement('article');d.className='card';d.dataset.user=name;
                d.innerHTML='<div class="ct">'+
                    '<div class="av"></div>'+
                    '<div class="id"><div class="nm"></div><span class="pill"></span></div></div>'+
                    '<div class="meta"><span class="tag" data-r="run"></span><span class="tag2" data-r="pre"></span></div>'+
                    '<div class="feats" data-r="feats"></div>'+
                    '<div class="el" data-r="err" hidden></div>'+
                    '<div class="acts">'+
                    '<button class="btn bg" data-act="start">Start</button>'+
                    '<button class="btn br" data-act="stop">Stop</button>'+
                    '<button class="btn bb" data-act="restart">Restart</button>'+
                    '<button class="btn bd" data-act="delete" title="Delete user">🗑 Delete</button></div>';
                return d;
            }
            function set(card,u){
                const st=u.status||'stopped';
                card.querySelector('.av').textContent=(u.username||'?')[0].toUpperCase();
                card.querySelector('.av').className='av '+st;
                card.querySelector('.nm').innerHTML=esc(u.username)+(u.isAdmin?'<span class="adm">ADMIN</span>':'');
                const p=card.querySelector('.pill');p.className='pill '+st;p.textContent=st;
                const r=card.querySelector('[data-r="run"]');r.textContent=u.running?'● running':'○ stopped';r.className='tag '+(u.running?'on':'');
                card.querySelector('[data-r="pre"]').textContent='presence: '+esc(u.presence);
                const ft=u.features||{};
                card.querySelector('[data-r="feats"]').innerHTML=FEATS.map(f=>'<span class="feat '+(ft[f[0]]?'on':'')+'" title="'+FTITLE[f[0]]+'">'+f[1]+'</span>').join('');
                const e=card.querySelector('[data-r="err"]');e.textContent=u.errorMsg||'';e.hidden=!u.errorMsg;
                const on=RUN.indexOf(st)>=0;
                card.querySelector('[data-act="start"]').hidden=on;
                card.querySelector('[data-act="stop"]').hidden=!on;
                card.querySelector('[data-act="restart"]').hidden=!on;
                card.querySelectorAll('button').forEach(b=>b.disabled=false);
                card.style.display=(($('q').value||'').toLowerCase()?card.dataset.user.indexOf(($('q').value||'').toLowerCase())>=0?'':'none':'');
            }
            function apply(d){
                $('ch-slots').innerHTML='<b>'+d.activeCount+'</b>/'+d.maxCount+' slots';
                $('ch-online').innerHTML='<b>'+(d.users||[]).filter(u=>u.status==='online').length+'</b> online';
                const g=$('cards'),seen={};
                (d.users||[]).forEach(u=>{seen[u.username]=1;let c=g.querySelector('.card[data-user="'+u.username+'"]');if(!c){c=mk(u.username);g.appendChild(c)}set(c,u)});
                g.querySelectorAll('.card').forEach(c=>{if(!seen[c.dataset.user])c.remove()});
                $('empty').classList.toggle('hidden',(d.users||[]).length>0);
            }
            async function poll(){
                try{const d=await getJSON('/api/admin/users');$('err').textContent='';apply(d)}
                catch(e){$('err').textContent='Users failed to load: '+e.message}
            }
            $('q').addEventListener('input',()=>document.querySelectorAll('.card').forEach(c=>set(c,{username:c.dataset.user})));
            $('cards').addEventListener('click',async ev=>{
                const b=ev.target.closest('button[data-act]');if(!b)return;
                const act=b.dataset.act,u=b.closest('.card').dataset.user;
                if(act==='delete'){
                    if(!confirm('Delete "'+u+'" forever?\\nThis stops their bot and removes their account and WhatsApp session.'))return;
                    b.disabled=true;
                    try{await api('/api/admin/user/delete',{username:u});toast('User "'+u+'" deleted')}
                    catch(e){toast('Delete failed: '+e.message,false);b.disabled=false}
                    setTimeout(poll,1200);return;
                }
                b.disabled=true;
                try{await api('/api/admin/bot/'+act,{username:u});toast(act[0].toUpperCase()+act.slice(1)+' "'+u+'"')}
                catch(e){toast('Action failed: '+e.message,false);b.disabled=false}
                setTimeout(poll,1200);
            });
            async function initAnn(){
                try{const d=await getJSON('/api/admin/announcement');if(d.announcement)$('ann-in').value=d.announcement}catch(e){}
                $('ann-set').onclick=async function(){this.disabled=true;try{await api('/api/admin/announcement',{text:$('ann-in').value});toast('Announcement updated')}catch(e){toast('Set failed: '+e.message,false)}this.disabled=false};
                $('ann-clr').onclick=async function(){this.disabled=true;try{await api('/api/admin/announcement',{text:''});$('ann-in').value='';toast('Announcement cleared')}catch(e){toast('Clear failed: '+e.message,false)}this.disabled=false};
            }
            $('max-save').onclick = async function () {
                const v = parseInt($('max-in').value, 10);
                if (!Number.isFinite(v) || v < 1 || v > 50) { toast('Max bots must be 1-50', false); return; }
                this.disabled = true;
                try { await api('/api/admin/config', { maxInstances: v }); toast('Max bots set to ' + v); $('max-in').value = v; await poll(); }
                catch (e) { toast('Save failed: ' + e.message, false); }
                this.disabled = false;
            };
            initAnn();poll();setInterval(poll,4000);
        </script>
    </body></html>`);
});

const ANNOUNCE_PATH = path.join(SESSION_BASE, 'announcement.json');
function getAnnouncement() {
    try {
        const j = JSON.parse(fs.readFileSync(ANNOUNCE_PATH, 'utf8'));
        return (typeof j.text === 'string' && j.text.trim()) ? j.text.slice(0, 500) : null;
    } catch (e) { return null; }
}
function setAnnouncement(text) {
    const clean = String(text ?? '').trim().slice(0, 500);
    if (!clean) { fs.rmSync(ANNOUNCE_PATH, { force: true }); return null; }
    fs.writeFileSync(ANNOUNCE_PATH, JSON.stringify({ text: clean, ts: Date.now() }));
    return clean;
}

app.get('/api/status', apiLimiter, requireUser, (req, res) => {
    const username = req.session.user.username;
    const cached = lastQrCache.get(username);
    const inst = instances.get(username) || { status: 'stopped', qr: null, qrDataUrl: null, ppUrl: null, errorMsg: null };
    res.json({
        status: inst.status,
        qr: inst.status !== 'stopped' ? (inst.qr || (cached?.qr || null)) : null,
        qrDataUrl: inst.status !== 'stopped' ? (inst.qrDataUrl || (cached?.qrDataUrl || null)) : null,
        ppUrl: inst.ppUrl,
        errorMsg: inst.errorMsg,
        activeCount: instances.size,
        maxCount: MAX_INSTANCES,
        announcement: getAnnouncement()
    });
});

const memUsage = () => ({
    rss: Math.round(process.memoryUsage().rss / 1024 / 1024),
    heapTotal: Math.round(process.memoryUsage().heapTotal / 1024 / 1024),
    heapUsed: Math.round(process.memoryUsage().heapUsed / 1024 / 1024)
});

function checkMemoryWarn() {
    const mem = process.memoryUsage();
    const totalMb = Math.round(mem.rss / 1024 / 1024);
    if (totalMb > 400) {
        console.warn(`[Manager] High memory: ${totalMb}MB RSS — consider reducing MAX_INSTANCES or worker memory limit`);
    }
}

app.get('/health', (req, res) => {
    checkMemoryWarn();
    const authed = req.session?.user;
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        activeBots: instances.size,
        maxBots: MAX_INSTANCES,
        memory: memUsage(),
        bots: authed ? Array.from(instances.entries()).filter(([name]) => name === authed.username).map(([name, inst]) => ({
            username: name,
            status: inst.status,
            pid: inst.child?.pid
        })) : undefined
    });
});

// ── Express Error Handler ────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('[Manager] Express Error:', err);
    res.status(500).json({ status: 'error', message: 'Internal server error.' });
});

// ── Global Error Handlers ───────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
    console.error('[Manager] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[Manager] Uncaught Exception:', err);
    cleanup();
    process.exit(1);
});

// ── Cleanup on Exit ─────────────────────────────────────────────────────────
function cleanup() {
    console.log('[Manager] Shutting down...');
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    pendingRestarts.forEach(tid => clearTimeout(tid));
    pendingRestarts.clear();
    startupWatchdogs.forEach(tid => clearTimeout(tid));
    startupWatchdogs.clear();
    instances.forEach(inst => {
        if (inst.child) {
            // SIGKILL: a busy WA event loop can delay a worker's SIGTERM
            // shutdown; if pm2 then SIGKILLs the manager, SIGTERM-only children
            // orphan and later double-link the account -> MessageCounterError -> 428
            try { inst.child.kill('SIGKILL'); } catch (e) {}
        }
    });
}
function shutdown() {
    cleanup();
    process.exit(0);
}
process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });

app.listen(port, () => {
    console.log(`[Manager] Multi-user dashboard running at http://localhost:${port}`);

    if (!process.env.GROQ_API_KEY && !config.GROQ_API_KEY) {
        console.warn('[Manager] ⚠️ Warning: GROQ_API_KEY is not set. Auto-Reply will not function.');
    }

    // Keep-alive: prevents Render free tier from sleeping (free tier sleeps
    // after 15 min without inbound traffic; we self-ping /health every 10).
const publicUrl = process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '';
    if (publicUrl) {
        console.log(`[Manager] Keep-alive enabled, pinging ${publicUrl} every 10 min`);
        const pingSelf = () => {
            try {
                const url = publicUrl.replace(/\/+$/, '') + '/health';
                const req = (url.startsWith('http://') ? require('http') : https).get(url, { family: 4, timeout: 8000 }, (res) => {
                    if (res.statusCode !== 200) console.warn('[KeepAlive] Ping returned', res.statusCode);
                    else console.log(`[KeepAlive] Ping ok (${res.statusCode})`);
                    res.resume();
                });
                req.on('timeout', () => req.destroy(new Error('timeout')));
                req.on('error', (e) => console.warn('[KeepAlive] Ping failed:', e.message));
            } catch (e) {
                console.warn('[KeepAlive] Ping failed:', e.message);
            }
        };
        pingSelf(); // cover the sleep window right after boot
        keepAliveTimer = setInterval(() => { checkMemoryWarn(); pingSelf(); }, 10 * 60 * 1000);
    } else {
        console.log('[Manager] No PUBLIC_URL set — keep-alive disabled. Set PUBLIC_URL in env to prevent Render sleep.');
    }

    // Reap orphaned worker processes left by a force-killed previous manager.
    // A fresh boot has an empty instances map, so without this it would fork a
    // SECOND worker for an account whose orphan is still connected, causing
    // MessageCounterError ("Key used already") and 428 disconnects.
    try { for(const [u,inst] of instances) try{ if(inst.child?.pid) process.kill(inst.child.pid,'SIGKILL'); }catch(e){} }
    catch (e) { /* no workers / pkill unavailable */ }

    const db = loadDB();
    const runningUsers = Object.keys(db).filter(u => db[u].running);
    runningUsers.forEach((username, i) => {
        setTimeout(() => {
            // More users marked running than MAX_INSTANCES — clear the flag for
            // the ones we can't start instead of stranding them as "running"
            // forever (they'd never restart on crash and only recover on reboot)
            if (instances.size >= MAX_INSTANCES) {
                console.log(`[Manager] Instance limit (${MAX_INSTANCES}) reached at boot — marking ${username} stopped. Start manually when slots free up.`);
                dbTransaction((db) => { if (db[username]) db[username].running = false; });
                return;
            }
            console.log(`[Manager] Auto-starting bot for: ${username}`);
            startUserBot(username, false);
        }, i * 5000); // stagger 5s apart to avoid network contention
    });
});




