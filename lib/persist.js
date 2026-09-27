/**
 * persist.js — Session persistence for ephemeral hosts (Render free tier).
 *
 * Render's free plan has no persistent disk: every spin-down, restart, or
 * deploy wipes the filesystem, taking the WhatsApp sessions and users.json
 * with it. This module keeps an encrypted snapshot of the session directory
 * in Supabase Storage and restores it on boot when the local copy is gone.
 *
 * Env:
 *   BACKUP_SUPABASE_URL   e.g. https://abcdef.supabase.co        (required)
 *   BACKUP_SUPABASE_KEY   service_role key (server-side only!)   (required)
 *   BACKUP_BUCKET         bucket name, default 'autoviewbot-backup'
 *   BACKUP_PATH           object path,  default 'session-backup.enc'
 *
 * The snapshot is encrypted with AES-256-GCM using a key derived from
 * SESSION_SECRET, so WhatsApp credentials never sit in plaintext at the
 * storage provider. If SESSION_SECRET is not set, the manager's fallback
 * (session/.session_secret) is used — set SESSION_SECRET explicitly in
 * production or the snapshot becomes unrestorable after a wipe.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const axios = require('axios');

const BACKUP_URL = (process.env.BACKUP_SUPABASE_URL || '').replace(/\/+$/, '');
const BACKUP_KEY = process.env.BACKUP_SUPABASE_KEY || '';
const BACKUP_BUCKET = process.env.BACKUP_BUCKET || 'autoviewbot-backup';
const BACKUP_PATH = process.env.BACKUP_PATH || 'session-backup.enc';
const MAGIC = Buffer.from('AVB1');           // format version tag
const MAX_FILE_BYTES = 5 * 1024 * 1024;      // skip anything absurd
const SCAN_INTERVAL_MS = 3 * 60 * 1000;      // change-detection cadence

const enabled = !!(BACKUP_URL && BACKUP_KEY);
if (!enabled && (process.env.BACKUP_SUPABASE_URL || process.env.BACKUP_SUPABASE_KEY)) {
    console.warn('[Persist] ⚠️ Backup half-configured — set BOTH BACKUP_SUPABASE_URL and BACKUP_SUPABASE_KEY.');
}
if (!enabled) console.log('[Persist] External backup disabled (no BACKUP_SUPABASE_URL/BACKUP_SUPABASE_KEY).');

// ── Crypto ──────────────────────────────────────────────────────────────────
function deriveKey(secret) {
    return crypto.scryptSync(secret || 'autoviewbot-fallback', 'autoviewbot-backup-v1', 32);
}

function encryptBuffer(plain, secret) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(secret), iv);
    const data = Buffer.concat([cipher.update(plain), cipher.final()]);
    return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), data]);
}

function decryptBuffer(blob, secret) {
    if (blob.length < 4 + 12 + 16 || !blob.subarray(0, 4).equals(MAGIC)) {
        throw new Error('bad snapshot format');
    }
    const iv = blob.subarray(4, 16);
    const tag = blob.subarray(16, 32);
    const data = blob.subarray(32);
    const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(secret), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]);
}

// ── Snapshot pack/unpack ────────────────────────────────────────────────────
function collectFiles(base) {
    const out = [];
    const walk = (dir) => {
        let entries;
        try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
        for (const ent of entries) {
            const full = path.join(dir, ent.name);
            if (ent.isDirectory()) { walk(full); continue; }
            if (!ent.isFile()) continue;
            let st;
            try { st = fs.statSync(full); } catch (e) { continue; }
            if (st.size > MAX_FILE_BYTES) {
                console.warn(`[Persist] Skipping oversized file ${ent.name} (${st.size} bytes)`);
                continue;
            }
            out.push({ full, rel: path.relative(base, full) });
        }
    };
    walk(base);
    return out;
}

function packSnapshot(base) {
    const files = collectFiles(base).map(({ full, rel }) => ({
        p: rel.split(path.sep).join('/'),
        b: fs.readFileSync(full).toString('base64'),
    }));
    return Buffer.from(JSON.stringify({ v: 1, ts: Date.now(), files }), 'utf8');
}

function unpackSnapshot(blob, base) {
    const parsed = JSON.parse(blob.toString('utf8'));
    if (!parsed || parsed.v !== 1 || !Array.isArray(parsed.files)) throw new Error('bad snapshot payload');
    for (const f of parsed.files) {
        const dest = path.join(base, ...f.p.split('/'));
        if (!dest.startsWith(path.resolve(base) + path.sep) && dest !== path.resolve(base)) {
            throw new Error(`unsafe path in snapshot: ${f.p}`);
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, Buffer.from(f.b, 'base64'));
    }
    return parsed.files.length;
}

// Cheap change detector: fingerprint of rel path + size + mtimeMs.
function fingerprint(base) {
    const parts = collectFiles(base)
        .map(({ full, rel }) => {
            try { const st = fs.statSync(full); return `${rel}:${st.size}:${st.mtimeMs}`; }
            catch (e) { return null; }
        })
        .filter(Boolean)
        .sort();
    return crypto.createHash('sha256').update(parts.join('|')).digest('hex');
}

// ── Supabase Storage I/O ────────────────────────────────────────────────────
function objectUrl() {
    return `${BACKUP_URL}/storage/v1/object/${BACKUP_BUCKET}/${BACKUP_PATH}`;
}

async function uploadSnapshot(base, secret) {
    const plain = packSnapshot(base);
    const blob = encryptBuffer(plain, secret);
    const res = await axios.post(objectUrl(), blob, {
        headers: {
            'Authorization': `Bearer ${BACKUP_KEY}`,
            'Content-Type': 'application/octet-stream',
            'x-upsert': 'true',
        },
        maxBodyLength: Infinity,
        timeout: 30000,
    });
    console.log(`[Persist] Backup uploaded (${(blob.length / 1024).toFixed(1)} KB, ${new Date().toISOString()})`);
    return res.status;
}

async function downloadSnapshot(secret) {
    try {
        const res = await axios.get(objectUrl(), {
            headers: { 'Authorization': `Bearer ${BACKUP_KEY}` },
            responseType: 'arraybuffer',
            timeout: 30000,
        });
        return decryptBuffer(Buffer.from(res.data), secret);
    } catch (e) {
        if (e.response && e.response.status === 404) return null; // first boot — nothing stored yet
        throw e;
    }
}

function snapshotSecret() {
    let secret = process.env.SESSION_SECRET;
    if (!secret) {
        try {
            secret = fs.readFileSync(path.join(__dirname, '..', 'session', '.session_secret'), 'utf8').trim();
        } catch (e) { /* fall through */ }
    }
    return secret;
}

// ── Public API ──────────────────────────────────────────────────────────────

/** Restore the session dir from backup if it came up empty (ephemeral disk). */
async function restoreIfEmpty(sessionBase, dbPath) {
    if (fs.existsSync(dbPath)) return false; // local data intact — nothing to do
    if (!enabled) {
        console.warn('[Persist] Session dir is empty and no backup is configured — users will need to re-register/re-link.');
        return false;
    }
    const secret = snapshotSecret();
    const plain = await downloadSnapshot(secret);
    if (!plain) {
        console.log('[Persist] No stored backup yet — starting fresh.');
        return false;
    }
    const n = unpackSnapshot(plain, sessionBase);
    console.log(`[Persist] Restored ${n} files from backup (${new Date().toISOString()})`);
    return true;
}

/** Force an immediate upload (used on shutdown). Resolves when done or skipped. */
async function saveNow(sessionBase) {
    if (!enabled) return false;
    const files = collectFiles(sessionBase);
    if (!files.length) return false;
    await uploadSnapshot(sessionBase, snapshotSecret());
    return true;
}

/** Periodic change-detection loop. Call once at startup. Never throws. */
function watchAndBackup(sessionBase) {
    if (!enabled) return;
    let last = null;
    const tick = async () => {
        let fp;
        try { fp = fingerprint(sessionBase); } catch (e) { return; }
        if (!fp || fp === last) return;
        last = fp;
        try { await uploadSnapshot(sessionBase, snapshotSecret()); }
        catch (e) {
            console.warn('[Persist] Backup upload failed:', e.response ? `${e.response.status} ${e.response.statusText}` : e.message);
        }
    };
    setTimeout(tick, SCAN_INTERVAL_MS);          // give boot (restore) time to settle
    setInterval(() => { tick().catch(() => {}); }, SCAN_INTERVAL_MS);
    console.log(`[Persist] Change monitoring active — snapshotting every ${SCAN_INTERVAL_MS / 60000} min when dirty.`);
}

module.exports = {
    enabled,
    restoreIfEmpty,
    saveNow,
    watchAndBackup,
    // exported for tests
    encryptBuffer, decryptBuffer, packSnapshot, unpackSnapshot, fingerprint,
};
