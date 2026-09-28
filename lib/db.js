// lib/db.js — user database (JSON file) + serialized write queue.
// Extracted from autoviewer.js as part of the modular split (behavior-identical).
const fs = require('fs');
const path = require('path');

// ── Database ────────────────────────────────────────────────────────────────
const SESSION_BASE = process.env.SESSION_DIR || path.join(__dirname, '..', 'session');
const DB_PATH = path.join(SESSION_BASE, 'users.json');

if (!fs.existsSync(SESSION_BASE)) fs.mkdirSync(SESSION_BASE, { recursive: true });

// Migration: if session/users.json doesn't exist, import from data/users.json
if (!fs.existsSync(DB_PATH)) {
    const legacyDB = path.join(__dirname, '..', 'data', 'users.json');
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
    let db;
    try { db = loadDB(); } catch (e) { return; } // fail closed: retry on next restart
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
        // FAIL CLOSED: a read/parse error (EMFILE, EACCES, truncated file) must
        // never look like "no users" — that would hand an uninvited admin
        // account to a stranger and let saveDB() wipe every real account.
        // Throwing is caught by express (-> 500) and by dbTransaction (-> no
        // save), both of which are safe outcomes.
        console.error('[Manager] DB Load Error (failing closed):', e.message);
        throw new Error('DB_UNAVAILABLE');
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
        return true;
    }).catch(e => {
        console.error('[Manager] DB Transaction Error:', e.message);
        return false; // (audit L7) callers can await and react to failure
    });
    return dbQueue;
}


// Queue primitive for other stores (invites) that must serialize on the SAME
// queue as user-DB writes — mutations must never interleave with a register
// handler's atomic consume.
function runExclusive(fn) {
    dbQueue = dbQueue.then(fn).catch(e => {
        console.error('[Manager] Queue Error:', e.message);
    });
    return dbQueue;
}

// Invite codes are only demanded once the first account exists — a fresh
// install has a chicken-and-egg problem otherwise. The first signup is the
// admin (via ADMIN_USERNAMES). On a DB error this fails closed (invite
// required) rather than open.
function inviteRequired() {
    try { return Object.keys(loadDB()).length > 0; }
    catch (e) { return true; }
}

module.exports = {
    SESSION_BASE,
    DB_PATH,
    adminUsernameList,
    syncAdminUsers,
    loadDB,
    saveDB,
    dbTransaction,
    runExclusive,
    inviteRequired,
};
