/**
 * AutoViewer — Master Manager
 * Production-ready multi-user WhatsApp automation platform.
 */

// Session files hold WhatsApp credentials and users.json holds bcrypt hashes —
// anything this process creates must stay private to the service user.
process.umask(0o077);

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
process.env.DOTENV_QUIET = 'true';
require('dotenv/config');
const config = require('./config.js');
const { SESSION_BASE, loadDB, dbTransaction, inviteRequired, adminUsernameList } = require('./lib/db');
const { loadInvites, findLiveInvite, hasActiveInvites, inviteStatus, inviteTransaction } = require('./lib/invites');
const { testGroq, getGroqStatus } = require('./lib/groqAI');
const { startKeepAlive } = require('./lib/keepalive');
const { AuditLog } = require('./lib/audit');
const backup = require('./lib/backup');


// Prevent duplicate manager processes (causes port conflicts and worker churn).
const INSTANCE_LOCK_FILE = path.join(SESSION_BASE, 'autoviewer.lock');
function releaseInstanceLock() {
    try {
        if (!fs.existsSync(INSTANCE_LOCK_FILE)) return;
        const pid = fs.readFileSync(INSTANCE_LOCK_FILE, 'utf8').trim();
        if (pid === String(process.pid)) fs.unlinkSync(INSTANCE_LOCK_FILE);
    } catch {}
}
function acquireInstanceLock() {
    try {
        fs.mkdirSync(SESSION_BASE, { recursive: true });
        if (fs.existsSync(INSTANCE_LOCK_FILE)) {
            const raw = fs.readFileSync(INSTANCE_LOCK_FILE, 'utf8').trim();
            const pid = parseInt(raw, 10);
            if (pid && pid !== process.pid) {
                try {
                    process.kill(pid, 0);
                    console.error(`[Manager] Another autoviewer instance is already running (pid ${pid}). Exiting to avoid conflicts.`);
                    process.exit(1);
                } catch {
                    // stale lock
                }
            }
        }
        fs.writeFileSync(INSTANCE_LOCK_FILE, String(process.pid));
    } catch (e) {
        console.warn('[Manager] Could not acquire instance lock:', e.message);
    }
}
acquireInstanceLock();
process.on('exit', releaseInstanceLock);

// Official WhatsApp glyph (Simple Icons path) — used for the QR overlay and
// the favicon. The previous hand-drawn path rendered as a distorted blob.
const WHATSAPP_ICON_PATH = 'M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z';

const app = express();
app.disable('x-powered-by');
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    // The dashboard renders only its own inline <style>/<script>; everything
    // else (icons, QR data URLs) is same-origin. A strict CSP keeps injected
    // markup from executing.
    res.setHeader('Content-Security-Policy', [
        "default-src 'self'",
        "img-src 'self' data: blob: https://*.whatsapp.net https://*.fbcdn.net https://pps.whatsapp.net",
        "style-src 'self' 'unsafe-inline'",
        "script-src 'self' 'unsafe-inline'",
        "connect-src 'self'",
        "font-src 'self' data:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
        "object-src 'none'"
    ].join('; '));
    // HSTS only makes sense (and only works) over TLS.
    if (secureCookiesEnabled()) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
});
// Directly-exposed VPS deployments must not trust X-Forwarded-For (a client
// could spoof it to dodge the per-IP rate limits). PaaS/reverse-proxy setups
// keep the previous behavior unless TRUST_PROXY=0 is set.
app.set('trust proxy', process.env.TRUST_PROXY === '0' ? false : 1);
const loginLimiter = rateLimit({ windowMs: 15*60*1000, max: 20, message: 'Too many login attempts, try later', standardHeaders: true, legacyHeaders: false });
const registerLimiter = rateLimit({ windowMs: 60*60*1000, max: 10, message: 'Too many registrations, try later', standardHeaders: true, legacyHeaders: false });
// The dashboard and the admin panel poll status every 4s (15/min per open tab),
// so the 60/min limiter silently 429'd real users with a couple of tabs open
// (or two users behind one NAT) and froze the dashboard. Polling gets its own,
// higher ceiling.
const statusLimiter = rateLimit({ windowMs: 60*1000, max: 300, standardHeaders: true, legacyHeaders: false });
// Write endpoints mutate state (settings, invites, bot lifecycle). They are
// session-authenticated, but a runaway client or a hijacked session could
// still hammer them — cap the write rate per IP.
const writeLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { status: 'error', message: 'Too many changes — slow down a little.' }
});
const port = process.env.PORT || 3000;

// Never cache protected pages/APIs — browsers heuristically cache HTML and
// GET responses, which broke the dynamic dashboard/status pages.
app.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    next();
});

// Live under SESSION_BASE so the setting persists on a mounted volume. On
// Docker the app directory itself is read-only for the `node` user, so the
// old __dirname location silently discarded every admin change on restart.
const MAX_INSTANCES_FILE = path.join(SESSION_BASE, 'server-config.json');
const LEGACY_MAX_INSTANCES_FILE = path.join(__dirname, 'server-config.json');

// Settings keys a worker may change via dot commands (strict whitelist).
// Includes both schema dialects: 'chatai'/'antidelete' arrive from the
// command engine and are mapped in UPDATE_SETTINGS below.
const WORKER_EDITABLE_KEYS = ['autoreply', 'chatai', 'antideleteMsg', 'antidelete', 'antideleteStatus', 'antiTagStatus', 'autostatus', 'statusReact', 'groupAdmin', 'groupChatAI', 'reactEmojis', 'antilink', 'antivv', 'anticall', 'allow', 'block', 'persona', 'admins', 'mode', 'commandPrefix', 'voiceNotes', 'groupai', 'groupchatai', 'voicenotes', 'vn', 'prefix', 'commandprefix', 'presence', 'ghost'];

// Settings keys pushed TO a worker (manager -> worker SETTINGS messages).
// A strict whitelist, not the raw row: the user record also holds the bcrypt
// password hash and bookkeeping fields the worker never reads — the worker's
// own SETTINGS_KEYS list is the consumer side of this list.
const WORKER_SETTINGS_KEYS = ['autoreply', 'autostatus', 'statusReact', 'reactEmojis', 'antideleteMsg', 'antideleteStatus', 'antiTagStatus', 'presence', 'mode', 'anticall', 'botName', 'botInstructions', 'antilink', 'groupAdmin', 'groupChatAI', 'antivv', 'allow', 'block', 'persona', 'admins', 'commandPrefix', 'voiceNotes'];
function workerSettingsPayload(row) {
    const out = {};
    if (!row) return out;
    for (const k of WORKER_SETTINGS_KEYS) {
        if (row[k] !== undefined) out[k] = row[k];
    }
    // .persona and botInstructions are the same concept (KEYMAP maps persona
    // → botInstructions when persisting). Keep the worker's persona field in
    // sync so .settings display shows the right value after a settings
    // round-trip or worker restart.
    if (out.persona === undefined || !out.persona) out.persona = out.botInstructions || '';
    return out;
}
function loadMaxInstances() {
    // Clamp the env value too: a negative/zero MAX_INSTANCES used to make the
    // capacity check reject every start, leaving the platform unable to run
    // any bot at all.
    const env = Math.min(Math.max(1, parseInt(process.env.MAX_INSTANCES || '5', 10) || 5), 50);
    for (const file of [MAX_INSTANCES_FILE, LEGACY_MAX_INSTANCES_FILE]) {
        try {
            const c = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (Number.isFinite(c.maxInstances)) return Math.min(Math.max(1, c.maxInstances | 0), 50);
        } catch (e) {}
    }
    return env;
}
let MAX_INSTANCES = loadMaxInstances();
function saveMaxInstances(n) {
    n = Math.min(Math.max(1, n | 0), 50);
    try {
        fs.writeFileSync(MAX_INSTANCES_FILE, JSON.stringify({ maxInstances: n }));
        MAX_INSTANCES = n; // only apply after the write succeeds
        return true;
    } catch (e) {
        console.warn('[Manager] saveMaxInstances failed:', e.message);
        return false;
    }
}
const instances = new Map(); // username -> { child, status, qr, ppUrl }
let keepAliveTimer = null;
let keepAliveState = null;   // keep-alive telemetry (surfaced on /health)
// Append-only audit trail for privileged actions (admin panel, user account).
const auditLog = new AuditLog({ file: path.join(SESSION_BASE, 'audit.log') });
const lastQrCache = new Map(); // username -> { qr, qrDataUrl } — survives restarts
const lastPairingCodeCache = new Map(); // username -> { code, phone, ts } — survives restarts
const startingLock = new Set(); // prevent duplicate spawns
const pendingRestarts = new Map(); // username -> timeout handle
const startupWatchdogs = new Map(); // username -> timeout handle
const crashCounts = new Map(); // username -> consecutive crash count
const wipeCounts = new Map();  // username -> consecutive session-wipe count
const crashKinds = new Map();   // username -> 'code' | 'startup' | 'session' | 'unknown'
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

function startUserBot(username, clearSession = false, force = false, phoneNumber = null) {
    // `force` is used by the restart routes. The lock is held for the whole
    // lifetime of a live worker (see the exit handler), so without it a
    // restart of a RUNNING bot answered 409 "already starting" and the
    // dashboard's Restart button never did anything.
    if (!force && startingLock.has(username)) {
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
    // Match both the installation/session directory and the exact username.
    if (isValidUsername(username)) require('./lib/worker-cleanup')({
        script: path.join(__dirname, 'bot_worker.js'), sessionBase: SESSION_BASE, username
    });

    startingLock.add(username);

    try {
        if (clearSession) {
            lastQrCache.delete(username);
            lastPairingCodeCache.delete(username);
            const sessionDir = path.join(SESSION_BASE, username);
            if (fs.existsSync(sessionDir)) {
                const files = fs.readdirSync(sessionDir);
                for (const f of files) fs.rmSync(path.join(sessionDir, f), { recursive: true, force: true });
            }
        }

        // No per-worker heap cap: let each bot use Node's default heap. Set
        // WORKER_MEM_MB explicitly to impose a limit on constrained hosts.
        const memMb = parseInt(process.env.WORKER_MEM_MB || '', 10);
        const forkOpts = { silent: true };
        if (Number.isFinite(memMb) && memMb > 0) forkOpts.execArgv = [`--max-old-space-size=${memMb}`];
        const forkArgs = phoneNumber ? [username, String(phoneNumber).replace(/\D/g, '')] : [username];
        const child = fork(path.join(__dirname, 'bot_worker.js'), forkArgs, forkOpts);
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
                        inst.pairingCode = null;
                        inst.errorMsg = null;
                        lastQrCache.delete(username);
                        lastPairingCodeCache.delete(username);
                        wipeCounts.delete(username);
                        clearStartupWatchdog(username);
                    }
                    break;
                case 'PAIRING_CODE':
                    inst.status = 'pairing';
                    inst.pairingCode = msg.code;
                    lastPairingCodeCache.set(username, { code: msg.code, phone: msg.phone, ts: Date.now() });
                    console.log(`[Manager] Pairing code received for ${username}: ${msg.code}`);
                    break;
                case 'QR':
                    inst.status = 'connecting';
                    inst.qr = msg.qr;
                    lastQrCache.set(username, { qr: msg.qr, qrDataUrl: null });
                    // High error correction + a real quiet zone: the centre logo
                    // and rounded container must not stop scanners reading it.
                    QRCode.toDataURL(msg.qr, { width: 560, margin: 4, errorCorrectionLevel: 'H' }).then(url => {
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
                    try {
                        const avatarFile = path.join(SESSION_BASE, username, 'avatar.url');
                        fs.writeFileSync(avatarFile, msg.url, 'utf8');
                    } catch (e) {}
                    break;
                case 'ACCOUNT_INFO':
                    inst.phone = msg.phone;
                    inst.accountName = msg.name;
                    break;
                case 'NOTIFICATION_DELIVERED': {
                    const notifId = msg.notificationId;
                    if (notifId) {
                        try {
                            const file = path.join(SESSION_BASE, 'notifications.json');
                            if (fs.existsSync(file)) {
                                const list = JSON.parse(fs.readFileSync(file, 'utf8'));
                                if (Array.isArray(list)) {
                                    const item = list.find(n => n.id === notifId);
                                    if (item) {
                                        item.delivered_count = (item.delivered_count || 0) + 1;
                                        const tmp = file + '.tmp.' + process.pid + '.' + Date.now();
                                        fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
                                        fs.renameSync(tmp, file);
                                    }
                                }
                            }
                        } catch (e) {
                            console.error('[Manager] Failed to record delivered notification:', e.message);
                        }
                    }
                    break;
                }
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
                case 'CRASH': {
                    // The worker died because of a BUG (not a broken session).
                    // Remember it: the exit handler must never wipe a linked
                    // session because of a code crash.
                    crashKinds.set(username, msg.kind || 'code');
                    console.error(`[Manager] ${username} crashed (${msg.kind || 'code'}): ${msg.message || 'unknown'}`);
                    break;
                }
                case 'UPDATE_SETTINGS': {
                    // Worker applied a dot command (.autoreply off, .persona, .allow...).
                    // Persist it — strict whitelist, only keys a worker may ever change.
                    // Key dialect map: command engine speaks GitHub schema.
                    const changes = msg.changes || {};
                    const KEYMAP = {
                        chatai: 'autoreply',
                        antidelete: 'antideleteMsg',
                        persona: 'botInstructions',
                        groupai: 'groupChatAI',
                        groupchatai: 'groupChatAI',
                        voicenotes: 'voiceNotes',
                        vn: 'voiceNotes',
                        prefix: 'commandPrefix',
                        commandprefix: 'commandPrefix',
                        ghost: 'presence'
                    };
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
                // (audit L9) the starting lock spans the worker's lifetime —
                // only the CURRENT worker's exit may release it. A forced
                // restart kills the old child and forks a new one, and the
                // stale exit used to clear the new worker's lock, letting a
                // second spawn double-link the account (428 / MessageCounter).
                startingLock.delete(username);
                instances.delete(username);
                clearStartupWatchdog(username);
                let db;
                try { db = loadDB(); } catch (e) {
                    // A transient DB read error must never throw out of this
                    // listener: uncaughtException tears down every user's bot.
                    console.error(`[Manager] DB unreadable when ${username}'s worker exited:`, e.message);
                    return;
                }
                if (db[username]?.running) {
                    clearPendingRestart(username);
                    // Track consecutive crashes: only clear the session if the worker
                    // keeps dying within a short window (likely corrupt session state).
                    let clearSession = false;
                    const crashKind = crashKinds.get(username) || 'unknown';
                    if (code !== 0) {
                        const startedAt = startedAtMap.get(username) || 0;
                        const crashedFast = Date.now() - startedAt < CRASH_WINDOW_MS;
                        const count = crashedFast ? (crashCounts.get(username) || 0) + 1 : 0;
                        if (count >= CRASH_LIMIT) {
                            // A CODE crash (bug) must NEVER log the user out.
                            // Only a session-level failure may wipe the session.
                            if (crashKind === 'session') {
                                clearSession = true;
                            } else {
                                console.error(`[Manager] ${username} crashed ${count}x (${crashKind}) — NOT clearing the session (code crash). Fix the bug; the account stays linked.`);
                            }
                            crashCounts.delete(username);
                        } else {
                            crashCounts.set(username, count);
                        }
                    } else {
                        crashCounts.delete(username);
                        startedAtMap.delete(username);
                    }
                    crashKinds.delete(username);
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
                        let db2;
                        try { db2 = loadDB(); } catch (e) {
                            console.error(`[Manager] DB unreadable during restart of ${username}:`, e.message);
                            return;
                        }
                        if (db2[username]?.running) {
                            let started;
                            try { started = startUserBot(username, clearSession); }
                            catch (err) {
                                // fork() can throw (EMFILE/EAGAIN); a throw in a
                                // timer callback would take down the manager and
                                // every other bot with it. Clear the flag too so a
                                // ghost "running" account isn't stranded in admin.
                                console.error(`[Manager] Restart of ${username} failed:`, err.message);
                                dbTransaction((db) => { if (db[username]) db[username].running = false; });
                                return;
                            }
                            if (started === 'capacity') {
                                // Slots filled while we waited — don't strand a
                                // ghost "running" state the dashboard can't start
                                console.log(`[Manager] ${username} restart aborted: capacity full. Marking stopped.`);
                                dbTransaction((db) => { if (db[username]) db[username].running = false; });
                            }
                        } else {
                            console.log(`[Manager] ${username} was stopped during restart delay. Skipping.`);
                        }
                    }, 3000);
                    pendingRestarts.set(username, tid);
                }
            } else if (!instances.has(username)) {
                // No restart coming — a cached QR for a dead worker is stale,
                // and with no replacement worker the lock must go too (a stop
                // can remove the instance before its exit event fires).
                startingLock.delete(username);
                lastQrCache.delete(username);
                lastPairingCodeCache.delete(username);
            }
        });

        child.on('error', (err) => {
            console.error(`[Manager] Worker error for ${username}:`, err.message);
        });

        child.stderr.pipe(process.stderr);
        child.stdout.resume();

        let cachedPpUrl = null;
        try {
            const avatarFile = path.join(SESSION_BASE, username, 'avatar.url');
            if (fs.existsSync(avatarFile)) cachedPpUrl = fs.readFileSync(avatarFile, 'utf8').trim();
        } catch (e) {}

        instances.set(username, {
            child,
            status: phoneNumber ? "pairing" : "starting",
            qr: null,
            qrDataUrl: null,
            pairingCode: null,
            phoneNumber: phoneNumber || null,
            ppUrl: cachedPpUrl,
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
                // (audit L9) the lock now spans the worker lifetime; the killed
                // child's exit event releases it asynchronously, so clear it
                // here before the immediate restart
                startingLock.delete(username);
                let db;
                try { db = loadDB(); } catch (e) {
                    // Same fail-soft rule as the exit handler: a disk hiccup
                    // here must not escalate into a process-wide crash.
                    console.error(`[Manager] DB unreadable during watchdog restart of ${username}:`, e.message);
                    return;
                }
                if (db[username]?.running) {
                    // Do NOT clear the session — the worker may just be slow to
                    // connect (network/WA version fetch). Session is only cleared
                    // by the crash-loop logic in the exit handler.
                    let started;
                    try { started = startUserBot(username, false); }
                    catch (err) {
                        console.error(`[Manager] Watchdog restart of ${username} failed:`, err.message);
                        dbTransaction((db) => { if (db[username]) db[username].running = false; });
                        return;
                    }
                    if (started === 'capacity') {
                        // Slots filled while the watchdog was waiting — don't
                        // strand a ghost "running" state the dashboard can't start.
                        console.log(`[Manager] ${username} restart aborted: capacity full. Marking stopped.`);
                        dbTransaction((db) => { if (db[username]) db[username].running = false; });
                    }
                }
            }
        }, 45000);
        startupWatchdogs.set(username, wd);
    } catch (e) {
        // (audit L9) the lock now spans the worker's LIFETIME, not just this
        // synchronous function — a sync finally made it a no-op. Released in
        // the child 'exit' handler (and on stop/delete); released here if the
        // fork itself threw so the account isn't locked out forever.
        startingLock.delete(username);
        throw e;
    }
    return 'started';
}

app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(express.json({ limit: '1mb' }));
const sessionSecret = process.env.SESSION_SECRET;
let effectiveSecret = sessionSecret;
if (!effectiveSecret) {
    // Honor SESSION_DIR like the DB and session store do: a hard-coded
    // __dirname/session secret is not on the mounted volume, so every restart
    // minted a new secret and logged everyone out.
    const secretFile = path.join(SESSION_BASE, '.session_secret');
    try {
        if (fs.existsSync(secretFile)) effectiveSecret = fs.readFileSync(secretFile, 'utf8').trim();
        if (!effectiveSecret) {
            effectiveSecret = crypto.randomBytes(32).toString('hex');
            // Generate-and-persist works in EVERY environment (including
            // production on Fly/Render with a mounted disk) — a crash-loop
            // here is worse than a generated secret. Only a truly unwritable
            // home falls back to a per-boot secret (with a warning).
            try { fs.writeFileSync(secretFile, effectiveSecret); }
            catch (writeErr) { effectiveSecret = crypto.randomBytes(32).toString('hex'); }
        }
    } catch (e) { effectiveSecret = crypto.randomBytes(32).toString('hex'); }
    if (process.env.NODE_ENV === 'production') {
        console.warn('[Manager] ⚠️ SESSION_SECRET not set in production — using generated secret persisted to SESSION_DIR/.session_secret (survives restarts on a persistent disk). Set SESSION_SECRET explicitly for multi-instance deployments.');
    } else {
        console.warn('[Manager] ⚠️ WARNING: Using generated session secret. Set SESSION_SECRET for production persistence.');
    }
}
// File-backed store instead of the leaky MemoryStore: sessions survive
// restarts on a persistent disk and expired ones get swept.
const { FileSessionStore } = require('./lib/session-store');
const sessionStore = new FileSessionStore({
    // Honor SESSION_DIR like lib/db.js and bot_worker.js do — a hard-coded
    // __dirname/session put web sessions outside a mounted volume and outside
    // the directory the smoke test isolates.
    dir: require('path').join(SESSION_BASE, 'sessions'),
    ttl: 24 * 60 * 60 * 1000
});
// Whether the session cookie may only travel over TLS.
//   COOKIE_SECURE=true  -> always secure (production behind TLS)
//   COOKIE_SECURE=false -> never secure (plain-HTTP LAN / reverse-proxy setups
//                          that terminate TLS elsewhere but forward plain HTTP)
//   unset               -> secure when NODE_ENV=production
function secureCookiesEnabled() {
    const v = (process.env.COOKIE_SECURE || '').trim().toLowerCase();
    if (v === 'true') return true;
    if (v === 'false') return false;
    return process.env.NODE_ENV === 'production';
}
app.use(session({
    store: sessionStore,
    secret: effectiveSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: secureCookiesEnabled(),
        httpOnly: true,
        sameSite: 'lax',
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Session-bound token. Server-rendered pages embed it: native forms (login,
// register) submit it as a _csrf field, the dashboard/admin fetch wrappers
// send it as an X-CSRF-Token header. SameSite=Lax cookies back this up.
// The server-rendered pages used to embed this token in their HTML. The
// static frontend has no server-side template, so the token is handed over as
// a readable cookie instead (httpOnly:false — the SPA echoes it back as
// X-CSRF-Token). Only routes that can actually need it mint one: health
// probes and asset requests must not create a session file per hit.
function handsOutCsrf(req) {
    return req.path === '/' || req.path === '/index.html' ||
        req.path === '/login' ||
        req.path === '/register' || req.path === '/register.html' ||
        req.path === '/admin' || req.path === '/admin.html' ||
        req.path.startsWith('/api/');
}
app.use((req, res, next) => {
    if (handsOutCsrf(req) && !req.session.csrf) {
        req.session.csrf = crypto.randomBytes(24).toString('hex');
    }
    if (req.session.csrf) {
        res.cookie('av_csrf', req.session.csrf, {
            secure: secureCookiesEnabled(),
            httpOnly: false,
            sameSite: 'lax',
            path: '/',
            maxAge: 24 * 60 * 60 * 1000
        });
    }
    if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS') return next();
    const token = req.get('X-CSRF-Token') || (req.body && req.body._csrf) || '';
    const expected = req.session.csrf || '';
    // Compare BUFFER lengths, not string lengths: a multibyte token can have
    // the same .length but a different byte length, and timingSafeEqual throws
    // a RangeError (-> 500) on a mismatch instead of rejecting the request.
    const tokenBuf = Buffer.from(typeof token === 'string' ? token : '');
    const expectedBuf = Buffer.from(typeof expected === 'string' ? expected : '');
    const ok = expectedBuf.length > 0 && tokenBuf.length === expectedBuf.length &&
        crypto.timingSafeEqual(tokenBuf, expectedBuf);
    if (!ok) {
        if (req.path.startsWith('/api')) return res.status(403).json({ status: 'error', message: 'Bad CSRF token. Refresh the page and try again.' });
        return res.status(403).json({ error: 'Session expired — please try again.' });
    }
    next();
});

function requireUser(req, res, next) {
    if (!req.session.user) {
        // API endpoints must return JSON, not a redirect — otherwise the
        // dashboard's fetch follows the redirect and silently freezes
        if (req.path.startsWith('/api')) return res.status(401).json({ status: 'error', message: 'Not authenticated.' });
        return res.redirect('/login');
    }
    let db;
    try { db = loadDB(); }
    catch (e) { // fail closed: don't log the user out on a transient disk error
        console.error('[Manager] requireUser DB error:', e.message);
        if (req.path.startsWith('/api')) return res.status(503).json({ status: 'error', message: 'Service temporarily unavailable.' });
        return res.status(503).send('Service temporarily unavailable.');
    }
    if (!db[req.session.user.username]) {
        req.session.destroy();
        if (req.path.startsWith('/api')) return res.status(401).json({ status: 'error', message: 'Not authenticated.' });
        return res.redirect('/login');
    }
    // (audit L8) stale-cookie invalidation: when a username re-registers, the
    // account row is new. A session cookie issued to the PREVIOUS account
    // holder carries the old createdAt epoch — reject it.
    if ((db[req.session.user.username].createdAt || 0) !== (req.session.user.createdAt || 0)) {
        req.session.destroy();
        if (req.path.startsWith('/api')) return res.status(401).json({ status: 'error', message: 'Session expired. Please sign in again.' });
        return res.redirect('/login');
    }
    next();
}

function requireAdmin(req, res, next) {
    if (!req.session.user) {
        if (req.path.startsWith('/api')) return res.status(401).json({ status: 'error', message: 'Not authenticated.' });
        return res.redirect('/login');
    }
    let db;
    try { db = loadDB(); }
    catch (e) { // fail closed
        console.error('[Manager] requireAdmin DB error:', e.message);
        if (req.path.startsWith('/api')) return res.status(503).json({ status: 'error', message: 'Service temporarily unavailable.' });
        return res.status(503).send('Service temporarily unavailable.');
    }
    if (!db[req.session.user.username]?.isAdmin) {
        if (req.path.startsWith('/api')) return res.status(403).json({ status: 'error', message: 'Forbidden.' });
        return res.status(403).send('Forbidden');
    }
    next();
}

// Wrap async route handlers — Express doesn't catch async rejections and a
// hung request freezes the client's fetch forever
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Silent no-op assets the browser requests automatically — avoids harmless 404
// noise in both the server log and the browser console.
app.get('/favicon.ico', (req, res) => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
    res.type('image/png').set('Cache-Control', 'public, max-age=86400').send(png);
});
app.get('/favicon.svg', (req, res) => {
    res.type('image/svg+xml').set('Cache-Control', 'public, max-age=86400').send(
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><rect width="24" height="24" rx="5" fill="#25D366"/><path d="${WHATSAPP_ICON_PATH}" fill="#fff"/></svg>`
    );
});
app.get('/robots.txt', (req, res) => res.type('text/plain').send('User-agent: *\nDisallow:'));

// Admin panel routes must require auth before static file serving can see admin.html
app.get(['/admin', '/admin.html'], requireUser, requireAdmin, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve static frontend assets (CSS, JS, SVG, etc.) from ./public
app.use(express.static(path.join(__dirname, 'public'), {
    index: false,
    maxAge: '1h',
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-cache');
        } else {
            res.setHeader('Cache-Control', 'public, max-age=3600');
        }
    }
}));

app.get(['/', '/index.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/login', (req, res) => {
    res.redirect('/');
});

// Pre-computed hash so the login handler always runs one bcrypt compare —
// unknown usernames must be indistinguishable from wrong passwords by timing.
const DUMMY_HASH = bcrypt.hashSync('nova-timing-dummy-pw', 10);
app.post(['/login', '/api/login'], loginLimiter, ah(async (req, res) => {
    const { username, password } = req.body || {};
    // Repeated form fields arrive as arrays — .trim() on an array used to
    // throw a TypeError (500) instead of rejecting the login.
    if (typeof username !== 'string' || typeof password !== 'string') return res.status(401).json({ error: 'Invalid username or password.' });
    const cleanUser = username.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!cleanUser || !isValidUsername(cleanUser) || !password || password.length < 6 || password.length > 100) return res.status(401).json({ error: 'Invalid username or password.' });
    
    const db = loadDB();
    // Always run one bcrypt compare — unknown users must be indistinguishable
    // from wrong-password users by response timing (user enumeration).
    // Short-circuiting on `!!db[cleanUser]` first skipped the compare entirely
    // for unknown usernames (~0ms vs ~100ms for a real one), so the DUMMY_HASH
    // path below never even executed. Compute the hash target first, compare
    // always.
    const pwHash = db[cleanUser]?.password || DUMMY_HASH;
    // Always run the compare — short-circuiting on !!db[cleanUser] first
    // would skip the ~100ms bcrypt work for unknown usernames, leaking
    // whether an account exists via response timing.
    const pwMatch = await bcrypt.compare(password, pwHash);
    const ok = !!db[cleanUser] && pwMatch;
    if (ok) {
        req.session.regenerate((regenErr) => {
            if (regenErr) {
                console.error('[Manager] login session regenerate failed:', regenErr.message);
                return res.status(503).json({ error: 'Session error. Please try again.' });
            }
            // (audit L8) bind the session to this account INSTANCE — a
            // re-registered username gets a fresh createdAt, which invalidates
            // cookies issued to the previous holder
            req.session.user = {
                username: cleanUser,
                createdAt: db[cleanUser].createdAt || 0,
                // Session manager metadata (returned by /api/sessions).
                ip: req.ip || req.socket?.remoteAddress || null,
                ua: String(req.headers['user-agent'] || '').slice(0, 200),
                loginAt: Date.now()
            };
            req.session.csrf = crypto.randomBytes(24).toString('hex');
            const prevCookies = [].concat(res.getHeader('set-cookie') || []);
            res.setHeader('set-cookie', prevCookies.filter(c => !String(c).startsWith('av_csrf=')));
            res.cookie('av_csrf', req.session.csrf, {
                secure: secureCookiesEnabled(),
                httpOnly: false,
                sameSite: 'lax',
                path: '/',
                maxAge: 24 * 60 * 60 * 1000
            });
            // Persist BEFORE redirecting. express-session flushes the 302
            // headers while the store write is still queued, and browsers
            // follow the redirect immediately — the dashboard request then
            // read a not-yet-written session and bounced back to /login.
            req.session.save((saveErr) => {
                if (saveErr) {
                    console.error('[Manager] login session save failed:', saveErr.message);
                    return res.status(503).json({ error: 'Session error. Please try again.' });
                }
                if (req.is('application/json')) return res.json({ ok: true });
                res.redirect('/');
            });
        });
        return;
    }
    res.status(401).json({ error: 'Invalid username or password.' });
}));

app.get(['/register', '/register.html'], (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'register.html'));
});

function isValidUsername(u) {
    return /^[a-z0-9]{2,20}$/.test(u);
}

app.post(['/register', '/api/register'], registerLimiter, ah(async (req, res) => {
    const { username, password } = req.body || {};
    // Repeated form fields arrive as arrays — reject them instead of letting
    // .trim() throw a TypeError (500).
    if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) return res.status(400).json({ error: 'Username and password are required.' });
    if (password.length < 6 || password.length > 100) return res.status(400).json({ error: 'Password must be 6-100 characters.' });

    // Invite-only registration: valid codes are INVITE_CODE env entries plus
    // admin-managed codes stored in the invite store (single-use/expiry aware).
    // This pre-check is UX only — the AUTHORITATIVE gate re-verifies and
    // consumes the code inside the serialized transaction below, so concurrent
    // registrations can't share a single-use code.
    if (inviteRequired()) {
        const envCodes = (process.env.INVITE_CODE || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
        if (!envCodes.length && !hasActiveInvites()) {
            return res.status(403).json({ error: 'Registration is currently closed. Contact the admin to get an invite code.' });
        }
        const invite = String(req.body.invite || '').trim().toUpperCase().slice(0, 64);
        const a = Buffer.from(invite);
        const envOk = envCodes.some((code) => {
            const b = Buffer.from(code);
            return a.length === b.length && crypto.timingSafeEqual(a, b);
        });
        if (!envOk && !findLiveInvite(invite)) {
            return res.status(403).json({ error: 'Invalid invite code. Contact the admin to get one.' });
        }
    }

    const cleanUser = username.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!isValidUsername(cleanUser)) return res.status(400).json({ error: 'Username must be 2-20 alphanumeric characters.' });

    const hashed = await bcrypt.hash(password, 10);
    let taken = false;
    let inviteRejected = false;
    let consumedInviteCode = null; // DB invite to persist only after the user DB commit
    const saved = await dbTransaction((db) => {
        if (db[cleanUser]) { taken = true; return; }
        const firstUser = Object.keys(db).length === 0;
        // Atomic invite gate: authoritative check in this serialized
        // transaction. Env codes bypass the store; admin-managed codes are
        // re-verified live here so N parallel registrations against a
        // maxUses:1 code yield one account. Consumption of a DB code is
        // recorded but deferred until after the user DB is committed — a
        // failed user save must never burn an invite code.
        // The first account never needs an invite; it becomes the admin.
        if (!firstUser) {
            const invite = String(req.body.invite || '').trim().toUpperCase().slice(0, 64);
            const envCodes = (process.env.INVITE_CODE || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean);
            const a = Buffer.from(invite);
            const envOk = envCodes.some((code) => {
                const b = Buffer.from(code);
                return a.length === b.length && crypto.timingSafeEqual(a, b);
            });
            let matchedDbCode = null;
            if (!envOk) matchedDbCode = findLiveInvite(invite);
            if (!envOk && !matchedDbCode) { inviteRejected = true; return; }
            if (matchedDbCode) {
                consumedInviteCode = matchedDbCode;
            }
        }
        const activeInvites = loadInvites();
        const inviteEntry = consumedInviteCode ? activeInvites[consumedInviteCode] : null;
        const rentalDays = (inviteEntry && Number.isInteger(inviteEntry.rentalDays) && inviteEntry.rentalDays > 0) ? inviteEntry.rentalDays : null;
        const rentalExpiresAt = rentalDays ? Date.now() + rentalDays * 24 * 60 * 60 * 1000 : null;

        db[cleanUser] = { 
            password: hashed,
            createdAt: Date.now(), // (audit L8) instance epoch for stale-session invalidation
            autoreply: false,
            antideleteMsg: true,
            antideleteStatus: true,
            autostatus: true,
            statusReact: true,
            antiTagStatus: false,
            antivv: true,
            presence: 'auto',
            mode: 'self',
            anticall: false,
            antilink: false,
            groupAdmin: false,
            groupChatAI: false,
            voiceNotes: false,
            commandPrefix: '.',
            isAdmin: adminUsernameList().includes(cleanUser) || firstUser,
            rentalDays,
            rentalExpiresAt,
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
    // A failed transaction is an I/O problem, not a bad invite — check it
    // before the flags so a disk error isn't reported as an invalid code.
    if (!saved) return res.status(500).json({ error: 'Registration failed due to a server error. Please try again.' });
    if (inviteRejected) return res.status(403).json({ error: 'Invalid invite code. Contact the admin to get one.' });
    if (taken) return res.status(409).json({ error: 'Registration failed.' });
    // Fail-closed guard: if the transaction itself errored (disk trouble), no
    // account was created — don't send the user to login as if it worked.
    try { if (!loadDB()[cleanUser]) return res.status(500).json({ error: 'Registration failed due to a server error. Please try again.' }); }
    catch (e) { return res.status(503).json({ error: 'Service temporarily unavailable. Please try again.' }); }
    // User DB committed successfully — now persist the invite consumption.
    if (consumedInviteCode) {
        try {
            await inviteTransaction((invites) => {
                if (invites[consumedInviteCode]) {
                    invites[consumedInviteCode].uses = (invites[consumedInviteCode].uses || 0) + 1;
                }
            });
        } catch (e) {
            // The account exists; a failed invite-write is the lesser failure.
            console.error('[Manager] Failed to persist invite consumption:', e.message);
        }
    }

    // JSON/API clients (v2 frontend) expect a JSON response and an
    // authenticated session immediately; form clients expect the legacy
    // redirect to /login.
    if (req.is('application/json')) {
        const db2 = loadDB();
        const createdUser = db2[cleanUser] || {};
        const isFirstUser = Object.keys(db2).length === 1;
        return req.session.regenerate((regenErr) => {
            if (regenErr) {
                return res.status(503).json({ error: 'Session error. Please try again.' });
            }
            req.session.user = {
                username: cleanUser,
                createdAt: createdUser.createdAt || Date.now(),
                ip: req.ip || req.socket?.remoteAddress || null,
                ua: String(req.headers['user-agent'] || '').slice(0, 200),
                loginAt: Date.now()
            };
            req.session.csrf = crypto.randomBytes(24).toString('hex');
            const prevCookies = [].concat(res.getHeader('set-cookie') || []);
            res.setHeader('set-cookie', prevCookies.filter(c => !String(c).startsWith('av_csrf=')));
            res.cookie('av_csrf', req.session.csrf, {
                secure: secureCookiesEnabled(),
                httpOnly: false,
                sameSite: 'lax',
                path: '/',
                maxAge: 24 * 60 * 60 * 1000
            });
            req.session.save((saveErr) => {
                if (saveErr) {
                    return res.status(503).json({ error: 'Session error. Please try again.' });
                }
                res.status(201).json({ ok: true, isAdmin: !!createdUser.isAdmin, isFirstUser });
            });
        });
    }

    res.redirect('/login');
}));

const ALLOWED_FEATURES = new Set(['autoreply', 'antideleteMsg', 'antideleteStatus', 'autostatus', 'statusReact', 'anticall', 'antilink', 'groupAdmin', 'antiTagStatus', 'antivv', 'mode']);
const ALLOWED_PRESENCE = new Set(['auto', 'none', 'off', 'online', 'typing', 'recording']);
app.post('/settings/toggle', writeLimiter, requireUser, ah(async (req, res) => {
    const { feature } = req.body || {};
    auditLog.record('user.setting.toggle', req.session.user.username, { ip: req.ip, feature });
    if (!feature || !ALLOWED_FEATURES.has(feature)) return res.status(400).json({ status: 'error', message: 'Invalid feature.' });
    const username = req.session.user.username;
    let enabled;
    const saved = await dbTransaction((db) => {
        if (!db[username]) return;
        if (feature === 'mode') {
            // mode is 'self'|'public', not boolean
            enabled = db[username].mode !== 'public';
            db[username].mode = enabled ? 'public' : 'self';
        } else {
            if (feature === 'antilink' && !db[username].groupAdmin) {
                // Anti-Link is a group-admin tool — it can only be switched on
                // while "Group Admin Tools" is enabled.
                enabled = false;
                db[username].antilink = false;
            } else {
                db[username][feature] = !db[username][feature];
                enabled = db[username][feature];
            }
        }
        // Turning the group-admin tools off also disables anti-link: it is one
        // of those tools, so it must not stay active on its own.
        if (feature === 'groupAdmin' && !enabled && db[username].antilink) {
            db[username].antilink = false;
        }
        const inst = instances.get(username);
        if (inst && inst.child) {
            // A dead/reconnecting child must not abort the DB save
            try { inst.child.send({ type: 'SETTINGS', settings: workerSettingsPayload(db[username]) }); }
            catch (e) { console.warn(`[Manager] Worker unreachable for ${username} (will pick up settings on next load): ${e.message}`); }
        }
    });
    if (!saved) return res.status(500).json({ status: 'error', message: 'Could not save the setting. Try again.' });
    res.json({ status: 'ok', enabled });
}));

app.post('/settings/update-emojis', writeLimiter, requireUser, ah(async (req, res) => {
    const { emojis } = req.body || {};
    if (!emojis || typeof emojis !== 'string' || emojis.length > 500) {
        return res.status(400).json({ status: 'error', message: 'Invalid emoji input.' });
    }
    const cleaned = emojis.split(',').map(s => s.replace(/[^\p{So}\p{Sk}\uFE0F\u200D]/gu, '').trim()).filter(Boolean).join(',');
    if (!cleaned) return res.status(400).json({ status: 'error', message: 'No valid emojis found.' });
    const username = req.session.user.username;
    const saved = await dbTransaction((db) => {
        if (!db[username]) return;
        db[username].reactEmojis = cleaned;
        const inst = instances.get(username);
        if (inst && inst.child) {
            try { inst.child.send({ type: 'SETTINGS', settings: workerSettingsPayload(db[username]) }); }
            catch (e) { console.warn(`[Manager] Worker unreachable for ${username}: ${e.message}`); }
        }
    });
    if (!saved) return res.status(500).json({ status: 'error', message: 'Could not save the emojis. Try again.' });
    res.json({ status: 'ok' });
}));

app.post('/settings/bot-profile', writeLimiter, requireUser, ah(async (req, res) => {
    const { botName, botInstructions } = req.body || {};
    // Only update fields the request actually provided: a botName-only save
    // used to wipe the stored instructions with ''.
    const hasInstr = botInstructions !== undefined;
    const instr = hasInstr ? String(botInstructions ?? '').slice(0, 1000) : null;
    const username = req.session.user.username;
    const saved = await dbTransaction((db) => {
        if (!db[username]) return;
        // botName is only touched when explicitly provided — saving
        // instructions must not wipe an existing name
        if (botName !== undefined) db[username].botName = String(botName).trim().slice(0, 30);
        if (hasInstr) db[username].botInstructions = instr;
        const inst = instances.get(username);
        if (inst && inst.child) {
            try { inst.child.send({ type: 'SETTINGS', settings: workerSettingsPayload(db[username]) }); }
            catch (e) { console.warn(`[Manager] Worker unreachable for ${username}: ${e.message}`); }
        }
    });
    if (!saved) return res.status(500).json({ status: 'error', message: 'Could not save the instructions. Try again.' });
    res.json({ status: 'ok' });
}));

const EDITABLE_LISTS = new Set(['allow', 'block', 'admins']);
app.post('/settings/update-lists', writeLimiter, requireUser, ah(async (req, res) => {
    const { key, value } = req.body || {};
    auditLog.record('user.setting.list', req.session.user.username, { ip: req.ip, key });
    if (!key || !EDITABLE_LISTS.has(key) || typeof value !== 'string') return res.status(400).json({ status: 'error', message: 'Invalid input.' });
    const username = req.session.user.username;
    let cleaned;
    // 'persona' is NOT in EDITABLE_LISTS (only 'allow','block','admins'),
    // so this branch was unreachable dead code. Removed.
    {
        cleaned = value.split(/[\n,;\s.]+/).map(s => s.replace(/[^0-9]/g, '')).filter(v => v.length >= 8 && v.length <= 15);
        if (cleaned.length > 200) return res.status(400).json({ status: 'error', message: 'List too long (max 200 numbers).' });
    }
    const saved = await dbTransaction((db) => {
        if (!db[username]) return;
        db[username][key] = cleaned;
        const inst = instances.get(username);
        if (inst && inst.child) {
            try { inst.child.send({ type: 'SETTINGS', settings: workerSettingsPayload(db[username]) }); }
            catch (e) { console.warn(`[Manager] Worker unreachable for ${username}: ${e.message}`); }
        }
    });
    if (!saved) return res.status(500).json({ status: 'error', message: 'Could not save the list. Try again.' });
    res.json({ status: 'ok' });
}));


// NOTE: the settings EXPORT was removed — there is no backup download
// endpoint anymore. Import stays so a settings file exported earlier can
// still be restored.
app.post('/api/backup/import', writeLimiter, requireUser, ah(async (req, res) => {
    const username = req.session.user.username;
    let result;
    try {
        result = backup.importUser(loadDB(), username, req.body || {});
    } catch (e) {
        return res.status(400).json({ status: 'error', message: e.message });
    }
    const saved = await dbTransaction((db) => {
        if (!db[username]) return;
        backup.importUser(db, username, req.body || {});
        const inst = instances.get(username);
        if (inst && inst.child) {
            try { inst.child.send({ type: 'SETTINGS', settings: workerSettingsPayload(db[username]) }); }
            catch (e) { console.warn(`[Manager] Worker unreachable for ${username}: ${e.message}`); }
        }
    });
    if (!saved) return res.status(500).json({ status: 'error', message: 'Could not import the backup.' });
    res.json({ status: 'ok', applied: result.applied });
}));


app.post('/settings/presence', writeLimiter, requireUser, ah(async (req, res) => {
    const { presence } = req.body || {};
    if (!ALLOWED_PRESENCE.has(presence)) {
        return res.status(400).json({ status: 'error', message: 'Invalid presence value.' });
    }
    const username = req.session.user.username;
    const saved = await dbTransaction((db) => {
        if (!db[username]) return;
        db[username].presence = presence;
        const inst = instances.get(username);
        if (inst && inst.child) {
            try { inst.child.send({ type: 'SETTINGS', settings: workerSettingsPayload(db[username]) }); }
            catch (e) { console.warn(`[Manager] Worker unreachable for ${username}: ${e.message}`); }
        }
    });
    if (!saved) return res.status(500).json({ status: 'error', message: 'Could not save the presence. Try again.' });
    res.json({ status: 'ok' });
}));

app.post('/bot/start', writeLimiter, requireUser, ah(async (req, res) => {
    const username = req.session.user.username;
    if (instances.size >= MAX_INSTANCES && !instances.has(username)) {
        return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    }
    clearPendingRestart(username);
    const started = startUserBot(username, false);
    if (started === 'busy') return res.status(409).json({ status: 'error', message: 'Bot is already starting.' });
    if (started === 'capacity') return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    const saved = await dbTransaction((db) => {
        if (instances.has(username) && db[username]) db[username].running = true;
    });
    if (!saved) return res.status(500).json({ status: 'error', message: 'Bot started, but the account state could not be saved. It may not auto-restart after a server reboot.' });
    res.json({ status: 'ok' });
}));

app.post('/bot/stop', writeLimiter, requireUser, ah(async (req, res) => {
    const username = req.session.user.username;
    clearPendingRestart(username);
    clearStartupWatchdog(username);
    const saved = await dbTransaction((db) => { if (!db[username]) return; db[username].running = false; });
    // Don't kill the worker if the state could not be persisted — otherwise a
    // reboot would auto-start the bot the user just stopped.
    if (!saved) return res.status(500).json({ status: 'error', message: 'Could not save the account state. Try again.' });
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
    lastPairingCodeCache.delete(username);
    res.json({ status: 'ok' });
}));

app.post('/bot/restart', writeLimiter, requireUser, ah(async (req, res) => {
    auditLog.record('user.bot.restart', req.session.user.username, { ip: req.ip });
    const username = req.session.user.username;
    if (instances.size >= MAX_INSTANCES && !instances.has(username)) {
        return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    }
    const started = startUserBot(username, false, true);
    if (started === 'busy') return res.status(409).json({ status: 'error', message: 'Bot is already starting.' });
    if (started === 'capacity') return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    const saved = await dbTransaction((db) => {
        if (!db[username]) return;
        db[username].running = true;
    });
    if (!saved) return res.status(500).json({ status: 'error', message: 'Could not update the account. Try again.' });
    res.json({ status: 'ok' });
}));

app.post('/api/refresh-qr', writeLimiter, requireUser, ah(async (req, res) => {
    const username = req.session.user.username;
    if (instances.size >= MAX_INSTANCES && !instances.has(username)) {
        return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    }
    clearPendingRestart(username);
    const started = startUserBot(username, true, true);
    if (started === 'busy') return res.status(409).json({ status: 'error', message: 'Bot is already starting.' });
    if (started === 'capacity') return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    const saved = await dbTransaction((db) => {
        if (!db[username]) return;
        db[username].running = true;
    });
    if (!saved) return res.status(500).json({ status: 'error', message: 'Could not update the account. Try again.' });
    res.json({ status: 'ok' });
}));

// (audit L4) logout is now POST + CSRF (the global CSRF middleware covers it) —
// a cross-site GET can no longer force a sign-out. GET /logout is a no-op
// redirect so stale bookmarks don't 404.
app.get('/logout', (req, res) => {
    res.redirect('/login');
});
app.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/login'));
});

app.post('/api/logout', (req, res) => {
    req.session.destroy(() => res.json({ ok: true }));
});

function adminTarget(req) {
    const { username } = req.body || {};
    const clean = String(username || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!clean) return null;
    let db;
    try { db = loadDB(); } catch (e) { return null; } // fail closed
    return db[clean] ? clean : null;
}

app.get('/api/admin/users', requireUser, requireAdmin, (req, res) => {
    const db = loadDB();
    const users = Object.keys(db).map(u => {
        const inst = instances.get(u) || null;
        const data = db[u];
        const rawStatus = inst ? inst.status : 'stopped';
        let v2Status = rawStatus;
        if (rawStatus === 'online') v2Status = 'connected';
        else if (rawStatus === 'stopped' || rawStatus === 'offline' || rawStatus === 'error') v2Status = 'disconnected';
        else if ((rawStatus === 'starting' || rawStatus === 'connecting') && inst && (inst.qr || inst.qrDataUrl)) v2Status = 'qr';
        else if (rawStatus === 'starting') v2Status = 'connecting';
        return {
            // v1 fields (legacy)
            username: u,
            isAdmin: !!data.isAdmin,
            running: !!data.running,
            errorMsg: inst?.errorMsg || null,
            presence: data.presence || 'auto',
            features: {
                autoreply: !!data.autoreply,
                antideleteMsg: (('antideleteMsg' in data) ? data.antideleteMsg : data.antidelete) !== false,
                antideleteStatus: (('antideleteStatus' in data) ? data.antideleteStatus : data.antidelete) !== false,
                autostatus: data.autostatus !== false,
                statusReact: data.statusReact !== false,
                anticall: !!data.anticall,
                antilink: !!data.antilink,
                groupAdmin: !!data.groupAdmin,
                antiTagStatus: !!data.antiTagStatus,
                antivv: !!data.antivv,
                publicCommands: data.mode === 'public'
            },
            // v2-compat fields (new frontend)
            user_id: u,
            email: null,
            is_admin: !!data.isAdmin,
            created_at: data.createdAt ? new Date(data.createdAt).toISOString() : null,
            enabled: !!data.running,
            status: v2Status,
            updated_at: data.updatedAt ? new Date(data.updatedAt).toISOString() : null,
            rental_days: data.rentalDays || null,
            rental_expires_at: data.rentalExpiresAt ? new Date(data.rentalExpiresAt).toISOString() : null,
            rentalExpired: !data.isAdmin && !!data.rentalExpiresAt && (Date.now() >= data.rentalExpiresAt),
        };
    });
    console.log(`[Admin] users listed by ${req.session.user.username}: ${users.length}`);
    res.json({ users, activeCount: instances.size, maxCount: MAX_INSTANCES });
});

app.post('/api/admin/bot/start', writeLimiter, requireUser, requireAdmin, ah(async (req, res) => {
    auditLog.record('admin.bot.start', req.session.user.username, { ip: req.ip, target: adminTarget(req) });
    const username = adminTarget(req);
    if (!username) return res.status(400).json({ status: 'error', message: 'Invalid user.' });
    if (instances.size >= MAX_INSTANCES && !instances.has(username)) {
        return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    }
    clearPendingRestart(username);
    const started = startUserBot(username, false);
    if (started === 'busy') return res.status(409).json({ status: 'error', message: 'Bot is already starting.' });
    if (started === 'capacity') return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    const saved = await dbTransaction((db) => { if (instances.has(username) && db[username]) db[username].running = true; });
    if (!saved) return res.status(500).json({ status: 'error', message: 'Bot started, but the account state could not be saved. It may not auto-restart after a server reboot.' });
    res.json({ status: 'ok' });
}));

app.post('/api/admin/bot/stop', writeLimiter, requireUser, requireAdmin, ah(async (req, res) => {
    auditLog.record('admin.bot.stop', req.session.user.username, { ip: req.ip, target: adminTarget(req) });
    const username = adminTarget(req);
    if (!username) return res.status(400).json({ status: 'error', message: 'Invalid user.' });
    clearPendingRestart(username);
    clearStartupWatchdog(username);
    const saved = await dbTransaction((db) => { if (!db[username]) return; db[username].running = false; });
    if (!saved) return res.status(500).json({ status: 'error', message: 'Could not save the account state. Try again.' });
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
    lastPairingCodeCache.delete(username);
    res.json({ status: 'ok' });
}));

app.post('/api/admin/bot/restart', writeLimiter, requireUser, requireAdmin, ah(async (req, res) => {
    auditLog.record('admin.bot.restart', req.session.user.username, { ip: req.ip, target: adminTarget(req) });
    const username = adminTarget(req);
    if (!username) return res.status(400).json({ status: 'error', message: 'Invalid user.' });
    if (instances.size >= MAX_INSTANCES && !instances.has(username)) {
        return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    }
    const started = startUserBot(username, false, true);
    if (started === 'busy') return res.status(409).json({ status: 'error', message: 'Bot is already starting.' });
    if (started === 'capacity') return res.status(503).json({ status: 'error', message: `Max capacity (${MAX_INSTANCES} bots) reached.` });
    const saved = await dbTransaction((db) => {
        if (!db[username]) return;
        db[username].running = true;
    });
    if (!saved) return res.status(500).json({ status: 'error', message: 'Could not update the account. Try again.' });
    res.json({ status: 'ok' });
}));
app.post('/api/admin/user/delete', writeLimiter, requireUser, requireAdmin, ah(async (req, res) => {
    auditLog.record('admin.user.delete', req.session.user.username, { ip: req.ip, target: adminTarget(req) });
    const username = adminTarget(req);
    if (!username) return res.status(400).json({ status: 'error', message: 'Invalid user.' });
    if (username === req.session.user.username) {
        return res.status(400).json({ status: 'error', message: 'You cannot delete your own account.' });
    }
    const db = loadDB();
    let deleted = false;
    const isLastAdmin = db[username]?.isAdmin && Object.values(db).filter(u => u.isAdmin).length <= 1;
    if (isLastAdmin) return res.status(400).json({ status: 'error', message: 'Cannot delete the last admin account.' });

    clearPendingRestart(username);
    clearStartupWatchdog(username);

    // Persist the deletion FIRST. The old order killed the worker and wiped
    // its session before this transaction; if the in-transaction last-admin
    // recount then refused to delete (a concurrent admin delete), the account
    // survived with a dead bot and no WhatsApp session.
    const txOk = await dbTransaction((db) => {
        if (!db[username]) return;
        // Recount admins INSIDE the serialized transaction — the pre-transaction
        // snapshot could race a concurrent delete of the other admin.
        const isLastAdmin = db[username].isAdmin && Object.values(db).filter(u => u.isAdmin).length <= 1;
        if (isLastAdmin) return;
        delete db[username];
        deleted = true;
    });
    if (!txOk) {
        // (audit L7) the transaction errored — nothing was deleted and the
        // worker was not touched. Do NOT report success.
        return res.status(500).json({ status: 'error', message: 'Delete failed due to a server error. Try again.' });
    }
    if (!deleted) {
        return res.status(400).json({ status: 'error', message: 'Account no longer exists or is the last admin.' });
    }

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
    lastPairingCodeCache.delete(username);

    const sessionDir = path.join(SESSION_BASE, username);
    let dirRemoved = true;
    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {
        dirRemoved = false;
        console.error(`[Manager] Failed to remove session dir for ${username}:`, e.message);
    }
    console.log(`[Manager] Deleted user ${username}`);
    // (audit L7) leftover WhatsApp creds are a real (if secondary) failure —
    // surface it instead of a clean "ok"
    res.json(dirRemoved ? { status: 'ok' } : { status: 'ok', warning: 'Account deleted, but its session files could not be removed from disk.' });
}));

app.get('/api/admin/announcement', requireUser, requireAdmin, (req, res) => {
    res.json({ announcement: getAnnouncement() });
});

app.post('/api/admin/announcement', writeLimiter, requireUser, requireAdmin, (req, res) => {
    const { text } = req.body || {};
    auditLog.record('admin.announcement', req.session.user.username, { ip: req.ip, length: String(text || '').length });
    res.json({ status: 'ok', announcement: setAnnouncement(text) });
});

// An account can see where it is signed in and revoke every other session.
app.get('/api/sessions', requireUser, ah(async (req, res) => {
    const username = req.session.user.username;
    const list = [];
    for (const id of (sessionStore.ids ? sessionStore.ids() : [])) {
        const sess = sessionStore.read ? sessionStore.read(id) : null;
        const u = sess && sess.user;
        if (!u || u.username !== username) continue;
        list.push({
            id: id.slice(0, 8) + '…',
            current: id === req.sessionID,
            ip: u.ip || null,
            ua: u.ua || null,
            loginAt: u.loginAt || null,
            createdAt: u.createdAt || null
        });
    }
    list.sort((a, b) => (b.loginAt || 0) - (a.loginAt || 0));
    res.json({ status: 'ok', sessions: list });
}));

app.post('/api/sessions/revoke-all', requireUser, ah(async (req, res) => {
    const username = req.session.user.username;
    const targets = [];
    for (const id of (sessionStore.ids ? sessionStore.ids() : [])) {
        if (id === req.sessionID) continue; // keep the current session
        const sess = sessionStore.read ? sessionStore.read(id) : null;
        const u = sess && sess.user;
        if (!u || u.username !== username) continue;
        targets.push(id);
    }
    await new Promise((resolve) => {
        if (!sessionStore.destroyMany) return resolve();
        sessionStore.destroyMany(targets, () => resolve());
    });
    auditLog.record('user.sessions.revoke-all', username, { ip: req.ip, revoked: targets.length });
    res.json({ status: 'ok', revoked: targets.length });
}));

app.get('/api/admin/audit', requireUser, requireAdmin, ah(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    res.json({ status: 'ok', entries: await auditLog.tail(limit) });
}));

app.get('/api/admin/config', requireUser, requireAdmin, (req, res) => {
    res.json({ maxInstances: MAX_INSTANCES, groq: getGroqStatus() });
});

app.get('/api/admin/groq-test', requireUser, requireAdmin, ah(async (req, res) => {
    const result = await testGroq();
    res.json({ status: result.ok ? 'success' : 'error', ...result, groq: getGroqStatus() });
}));

app.get('/api/groq-test', requireUser, ah(async (req, res) => {
    const result = await testGroq();
    res.json({ status: result.ok ? 'success' : 'error', ...result, groq: getGroqStatus() });
}));
app.post('/api/admin/config', writeLimiter, requireUser, requireAdmin, ah(async (req, res) => {
    auditLog.record('admin.config', req.session.user.username, { ip: req.ip, maxInstances: (req.body && req.body.maxInstances) });
    const n = parseInt((req.body && req.body.maxInstances), 10);
    if (!Number.isFinite(n) || n < 1 || n > 50) return res.status(400).json({ status: 'error', message: 'Max bots must be between 1 and 50.' });
    if (!saveMaxInstances(n)) return res.status(500).json({ status: 'error', message: 'Could not save the setting. Check the session directory permissions.' });
    console.log(`[Manager] Max instances changed to ${n} by ${req.session.user.username}`);
    res.json({ status: 'ok', maxInstances: MAX_INSTANCES });
}));

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

function buildInviteLink(req, code) {
    let base = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || (req.protocol + '://' + req.get('host'))).trim();
    if (base && !/^https?:\/\//i.test(base)) base = 'https://' + base;
    return base.replace(/\/+$/, '') + '/register?code=' + encodeURIComponent(code);
}

app.get('/api/admin/invites', requireUser, requireAdmin, (req, res) => {
    const invites = loadInvites();
    const list = Object.entries(invites).map(([code, e]) => {
        const st = inviteStatus(e);
        const active = st === 'active';
        const usedUp = Number.isFinite(e.maxUses) && e.maxUses > 0 && (e.uses || 0) >= e.maxUses;
        return {
            code, createdBy: e.createdBy || null, createdAt: e.createdAt || null,
            uses: e.uses || 0, maxUses: e.maxUses || null,
            expiresAt: e.expiresAt || null, revoked: !!e.revoked,
            status: st,
            // v2-compat fields
            id: code,
            rental_days: e.rentalDays || 30,
            rentalDays: e.rentalDays || 30,
            expires_at: e.expiresAt ? new Date(e.expiresAt).toISOString() : null,
            claimed_at: usedUp ? new Date(e.createdAt || Date.now()).toISOString() : null,
            created_at: e.createdAt ? new Date(e.createdAt).toISOString() : null,
            active,
            inviteLink: buildInviteLink(req, code),
        };
    }).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    res.json({ invites: list });
});
// inviteTransaction() now rejects when the store can't be read/written (the
// old queue swallowed the error). Without these handlers the request would
// hang forever instead of returning a 5xx.
function inviteTxFailed(res, err) {
    console.error('[Invites] Transaction failed:', err.message);
    if (!res.headersSent) res.status(503).json({ status: 'error', message: 'Invite store temporarily unavailable.' });
}

// v2 frontend POSTs to /api/admin/invites (not /create) — share create logic.
function handleInviteCreate(req, res) {
    auditLog.record('admin.invite.create', req.session.user.username, { ip: req.ip, maxUses: (req.body || {}).maxUses, expiresInDays: (req.body || {}).expiresInDays, expiresInHours: (req.body || {}).expiresInHours });
    const body = req.body || {};
    const maxUses = parseInt(body.maxUses, 10);
    const rentalDaysInput = parseInt(body.rentalDays, 10);
    const rentalDays = (Number.isFinite(rentalDaysInput) && rentalDaysInput > 0) ? Math.min(rentalDaysInput, 365) : 30;
    let days = parseInt(body.expiresInDays, 10);
    const hours = parseInt(body.expiresInHours, 10);
    if (!Number.isFinite(days) && Number.isFinite(hours) && hours > 0) days = Math.max(1, Math.ceil(hours / 24));
    if (Number.isFinite(maxUses) && maxUses < 1) {
        return res.status(400).json({ status: 'error', message: 'Max uses must be at least 1 (or empty for unlimited).', error: 'Max uses must be at least 1 (or empty for unlimited).' });
    }
    let created = null;
    let createdEntry = null;
    let error = null;
    const createTx = inviteTransaction((invites) => {
        if (Object.keys(invites).length >= 200) { error = 'Too many invite codes. Delete some first.'; return; }
        const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
        const part = (n) => Array.from(crypto.randomBytes(n)).map(b => alphabet[b % alphabet.length]).join('');
        let code;
        do { code = 'INV-' + part(6); } while (invites[code]);
        invites[code] = {
            createdAt: Date.now(),
            createdBy: req.session.user.username,
            uses: 0,
            maxUses: (Number.isFinite(maxUses) && maxUses > 0) ? Math.min(maxUses, 999) : null,
            expiresAt: (Number.isFinite(days) && days > 0) ? Date.now() + days * 24 * 60 * 60 * 1000 : null,
            rentalDays,
            revoked: false
        };
        created = code;
        createdEntry = invites[code];
    });
    createTx.then(() => {
        if (error) return res.status(400).json({ status: 'error', message: error, error });
        if (!created) return res.status(503).json({ status: 'error', message: 'Invite store temporarily unavailable.', error: 'Invite store temporarily unavailable.' });
        console.log(`[Invites] Created ${created} by ${req.session.user.username}`);
        const url = buildInviteLink(req, created);
        res.json({ status: 'ok', ok: true, code: created, invite: createdEntry, url, inviteLink: url, expiresInHours: Number.isFinite(hours) ? hours : null, rentalDays: createdEntry.rentalDays || 30 });
    }).catch((err) => inviteTxFailed(res, err));
}
app.post('/api/admin/invites/create', writeLimiter, requireUser, requireAdmin, handleInviteCreate);
app.post('/api/admin/invites', writeLimiter, requireUser, requireAdmin, handleInviteCreate);
app.post('/api/admin/invites/revoke', writeLimiter, requireUser, requireAdmin, (req, res) => {
    const code = String((req.body || {}).id || (req.body || {}).code || '').trim().toUpperCase();
    auditLog.record('admin.invite.revoke', req.session.user.username, { ip: req.ip, code });
    let found = false;
    const revokeTx = inviteTransaction((invites) => {
        if (!invites[code]) return;
        invites[code].revoked = true;
        found = true;
    });
    revokeTx.then(() => {
        if (!found) return res.status(404).json({ status: 'error', message: 'Unknown invite code.', error: 'Invite not found.' });
        console.log(`[Invites] Revoked ${code} by ${req.session.user.username}`);
        res.json({ status: 'ok', ok: true, id: code });
    }).catch((err) => inviteTxFailed(res, err));
});
app.post('/api/admin/invites/delete', writeLimiter, requireUser, requireAdmin, (req, res) => {
    const code = String((req.body || {}).code || (req.body || {}).id || '').trim().toUpperCase();
    auditLog.record('admin.invite.delete', req.session.user.username, { ip: req.ip, code });
    let found = false;
    const deleteTx = inviteTransaction((invites) => {
        if (!invites[code]) return;
        delete invites[code];
        found = true;
    });
    deleteTx.then(() => {
        if (!found) return res.status(404).json({ status: 'error', message: 'Unknown invite code.' });
        console.log(`[Invites] Deleted ${code} by ${req.session.user.username}`);
        res.json({ status: 'ok' });
    }).catch((err) => inviteTxFailed(res, err));
});

app.get('/api/status', statusLimiter, requireUser, (req, res) => {
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

const registerCompatApi = require('./lib/compat-api');
registerCompatApi(app, {
    SESSION_BASE,
    loadDB,
    dbTransaction,
    instances,
    lastQrCache,
    lastPairingCodeCache,
    MAX_INSTANCES,
    clearPendingRestart,
    clearStartupWatchdog,
    startUserBot,
    writeLimiter,
    requireUser,
    requireAdmin,
    ah,
    auditLog,
    adminTarget,
    startingLock,
    crashCounts,
    wipeCounts,
    startedAtMap,
    workerSettingsPayload,
    getAnnouncement,
    setAnnouncement,
    inviteTransaction,
    inviteTxFailed,
    buildInviteLink,
    loadInvites,
    inviteStatus,
    isValidUsername,
    config,
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

function checkRentalExpirations() {
    try {
        const db = loadDB();
        const now = Date.now();
        let changed = false;
        for (const [username, u] of Object.entries(db)) {
            if (!u.isAdmin && u.rentalExpiresAt && now >= u.rentalExpiresAt) {
                if (u.running || instances.has(username)) {
                    console.log(`[Rental] Account ${username} rental has expired. Stopping bot and wiping session.`);
                    clearPendingRestart(username);
                    clearStartupWatchdog(username);
                    u.running = false;
                    u.updatedAt = now;
                    changed = true;
                    const inst = instances.get(username);
                    if (inst && inst.child) {
                        try { inst.child.kill('SIGKILL'); } catch (e) {}
                        instances.delete(username);
                    }
                    startingLock.delete(username);
                    crashCounts.delete(username);
                    wipeCounts.delete(username);
                    startedAtMap.delete(username);
                    lastQrCache.delete(username);
                    lastPairingCodeCache.delete(username);
                    const sessionDir = path.join(SESSION_BASE, username);
                    try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {}
                }
            }
        }
        if (changed) {
            dbTransaction((tdb) => {
                for (const [username, u] of Object.entries(tdb)) {
                    if (!u.isAdmin && u.rentalExpiresAt && now >= u.rentalExpiresAt && u.running) {
                        u.running = false;
                        u.updatedAt = now;
                    }
                }
            });
        }
    } catch (e) {}
}

// Liveness: the process is up. Never touches the DB — a liveness probe that
// fails on a slow disk restarts a healthy process.
app.get('/livez', (req, res) => {
    res.json({ status: 'ok', uptime: process.uptime() });
});

// Readiness: the service can actually serve traffic (DB readable/writable,
// session dir writable). The generated blueprint still points its
// healthCheckPath at /health.
app.get('/readyz', (req, res) => {
    const checks = {};
    let ok = true;
    try {
        fs.accessSync(path.join(SESSION_BASE, 'users.json'), fs.constants.R_OK);
        checks.db = 'ok';
    } catch {
        // The file may not exist on a fresh install — the dir must still work.
        try {
            fs.accessSync(SESSION_BASE, fs.constants.W_OK);
            checks.db = 'ok (new)';
        } catch {
            checks.db = 'unavailable';
            ok = false;
        }
    }
    try {
        fs.accessSync(SESSION_BASE, fs.constants.W_OK);
        checks.sessionDir = 'ok';
    } catch {
        checks.sessionDir = 'unavailable';
        ok = false;
    }
    checks.workers = instances.size;
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'unavailable', checks });
});

app.get('/health', (req, res) => {
    checkMemoryWarn();
    const authed = req.session?.user;
    res.json({
        status: 'ok',
        uptime: process.uptime(),
        activeBots: instances.size,
        maxBots: MAX_INSTANCES,
        memory: memUsage(),
        groq: getGroqStatus(),
        // Keep-alive telemetry: a background job with no visible signal is
        // indistinguishable from one that silently died.
        keepAlive: keepAliveState ? {
            enabled: keepAliveState.enabled,
            platform: keepAliveState.platform,
            target: keepAliveState.target,
            intervalMin: keepAliveState.intervalMin,
            pings: keepAliveState.pings,
            failures: keepAliveState.failures,
            lastPingAt: keepAliveState.lastPingAt,
            lastStatus: keepAliveState.lastStatus,
            lastError: keepAliveState.lastError
        } : { enabled: false },
        bots: authed ? Array.from(instances.entries()).filter(([name]) => name === authed.username).map(([name, inst]) => ({
            username: name,
            status: inst.status,
            pid: inst.child?.pid
        })) : undefined
    });
});

// SPA & API 404 fallback
app.use((req, res, next) => {
    if (req.path.startsWith('/api')) {
        return res.status(404).json({ status: 'error', message: 'Endpoint not found.' });
    }
    if (req.method === 'GET' || req.method === 'HEAD') {
        return res.redirect('/');
    }
    res.status(404).send('Not found');
});

app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    console.error('[Manager] Express Error:', err);
    // Honor body-parser/Express client errors (malformed JSON = 400, payload
    // too large = 413) instead of masking every one as a 500.
    const status = Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    res.status(status).json({
        status: 'error',
        message: status === 500 ? 'Internal server error.' : status === 413 ? 'Request too large.' : 'Bad request.'
    });
});

process.on('unhandledRejection', (reason) => {
    console.error('[Manager] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[Manager] Uncaught Exception:', err);
    cleanup();
    process.exit(1);
});

function cleanup() {
    console.log('[Manager] Shutting down...');
    releaseInstanceLock();
    if (keepAliveTimer) clearInterval(keepAliveTimer);
    pendingRestarts.forEach(tid => clearTimeout(tid));
    pendingRestarts.clear();
    startupWatchdogs.forEach(tid => clearTimeout(tid));
    startupWatchdogs.clear();
    // Graceful first: the worker flushes its recovery cache on SIGTERM, so a
    // restart does not lose the media metadata `.vv`/anti-delete rely on.
    // Only workers that ignore SIGTERM get SIGKILLed afterwards.
    const children = Array.from(instances.values()).map(i => i.child).filter(Boolean);
    for (const child of children) {
        try { child.kill('SIGTERM'); } catch (e) {}
    }
    const killTimer = setTimeout(() => {
        for (const child of children) {
            try {
                if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
            } catch (e) {}
        }
    }, 8000);
    if (killTimer.unref) killTimer.unref();
}
function shutdown() {
    cleanup();
    process.exit(0);
}
process.on('SIGINT', () => { shutdown(); });
process.on('SIGTERM', () => { shutdown(); });

app.listen(port, () => {
    console.log(`[Manager] Multi-user dashboard running at http://localhost:${port}`);

    // Backward compatibility: redirect any legacy requests on port 3001 to main port
    const legacyPort = 3001;
    if (Number(port) !== legacyPort && !process.env.SESSION_DIR) {
        try {
            const http = require('http');
            const legacyServer = http.createServer((req, res) => {
                const hostHeader = req.headers.host || '';
                const hostWithoutPort = hostHeader.split(':')[0] || 'localhost';
                res.writeHead(301, {
                    Location: `http://${hostWithoutPort}:${port}${req.url}`
                });
                res.end();
            });
            legacyServer.on('error', () => {});
            legacyServer.listen(legacyPort, () => {
                console.log(`[Manager] Redirecting legacy port ${legacyPort} -> ${port}`);
            });
        } catch {}
    }

    if (!getGroqStatus().configured) {
        console.warn('[Manager] Groq API key is not configured. Set it in the admin panel or service environment to enable AI features.');
    }

    // Keep-alive: self-ping the PUBLIC url so hosts that sleep on idle
    // (Render Free spins down after 15 min without inbound traffic) never
    // reach their idle window. The platform is detected automatically
    // (RENDER / RAILWAY / FLY / REPL_ID) and the platform-provided public
    // url is used when PUBLIC_URL is not set — see lib/keepalive.js.
    const keepAlive = startKeepAlive({ log: (m) => console.log(m) });
    keepAliveState = keepAlive.state;
    keepAliveTimer = setInterval(() => {
        checkMemoryWarn();
    }, 10 * 60 * 1000);

    checkRentalExpirations();
    const rentalTimer = setInterval(checkRentalExpirations, 60 * 1000);
    if (rentalTimer.unref) rentalTimer.unref();

    // Auto-write the Render blueprint so the deployed config never drifts from
    // what the app actually needs (public URL, keep-alive settings, health
    // path). On Render Free the filesystem is ephemeral, so this is a
    // convenience — the file must be committed locally (npm run render:init).
    try {
        const { writeRenderConfig } = require('./lib/render-config');
        const renderUrl = (process.env.RENDER_EXTERNAL_URL || '').trim();
        const res = writeRenderConfig({
            appDir: __dirname,
            overrides: renderUrl ? { publicUrl: renderUrl } : {}
        });
        if (res.changed) {
            console.log(`[Manager] Render blueprint refreshed: ${res.path}`);
            if (process.env.RENDER) {
                console.log('[Manager] NOTE: that file is ephemeral on Render Free — run `npm run render:init` locally and commit it to keep the blueprint in sync.');
            }
        }
    } catch (e) {
        console.warn('[Manager] Could not refresh the Render blueprint:', e.message);
    }

    // Reap orphaned worker processes left by a force-killed previous manager.
    // A fresh boot has an empty instances map, so without this it would fork a
    // SECOND worker for an account whose orphan is still connected, causing
    // MessageCounterError ("Key used already") and 428 disconnects. Reap only
    // this installation's session-directory workers, preserving test workers
    // and other installations.
    require('./lib/worker-cleanup')({ script: path.join(__dirname, 'bot_worker.js'), sessionBase: SESSION_BASE });

    let db;
    try { db = loadDB(); }
    catch (err) {
        // Fail soft: a corrupt/locked DB must not throw out of the listen
        // callback (uncaughtException tears the process down and the service
        // crash-loops instead of serving its error page / /health).
        console.error('[Manager] DB unreadable at boot — skipping auto-start:', err.message);
        return;
    }
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
            try { startUserBot(username, false); }
            catch (err) {
                console.error(`[Manager] Auto-start of ${username} failed:`, err.message);
                dbTransaction((db) => { if (db[username]) db[username].running = false; });
            }
        }, i * 5000); // stagger 5s apart to avoid network contention
    });
});




