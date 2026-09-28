// lib/invites.js — admin-managed invite codes.
// Extracted from autoviewer.js as part of the modular split (behavior-identical).
// Serialized on the same queue as user-DB writes, so invite mutations can
// never interleave with the register handler's atomic consume.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { SESSION_BASE, runExclusive } = require('./db');

// ── Admin-managed invite codes ──────────────────────────────────────────────
// Stored in session/invites.json, independent of the user DB. Shape:
//   { "INV-XXXXX-XXXXX": { createdAt, createdBy, uses, maxUses, expiresAt, revoked } }
// maxUses/expiresAt may be null (= unlimited / never expires). INVITE_CODE env
// entries remain valid alongside these.
const INVITES_PATH = path.join(SESSION_BASE, 'invites.json');
function loadInvites() {
    try { return JSON.parse(fs.readFileSync(INVITES_PATH, 'utf8')); }
    catch (e) { return {}; }
}
function saveInvites(data) {
    const tmp = INVITES_PATH + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, INVITES_PATH);
}
function isInviteLive(entry) {
    if (!entry || entry.revoked) return false;
    if (Number.isFinite(entry.maxUses) && entry.maxUses > 0 && (entry.uses || 0) >= entry.maxUses) return false;
    if (Number.isFinite(entry.expiresAt) && entry.expiresAt > 0 && Date.now() > entry.expiresAt) return false;
    return true;
}
function hasActiveInvites() {
    return Object.values(loadInvites()).some(isInviteLive);
}
// Timing-safe scan for a live admin-managed code matching `invite`.
function findLiveInvite(invite, invites = loadInvites()) {
    const a = Buffer.from(String(invite || ''));
    for (const [code, entry] of Object.entries(invites)) {
        if (!isInviteLive(entry)) continue;
        const b = Buffer.from(code);
        if (a.length === b.length && crypto.timingSafeEqual(a, b)) return code;
    }
    return null;
}
function inviteStatus(entry) {
    if (entry.revoked) return 'revoked';
    if (Number.isFinite(entry.expiresAt) && entry.expiresAt > 0 && Date.now() > entry.expiresAt) return 'expired';
    if (Number.isFinite(entry.maxUses) && entry.maxUses > 0 && (entry.uses || 0) >= entry.maxUses) return 'exhausted';
    return 'active';
}

// Serialized on the same queue as user-DB writes, so invite mutations can
// never interleave with the register handler's atomic consume.
function inviteTransaction(fn) {
    return runExclusive(async () => {
        const invites = loadInvites();
        await fn(invites);
        saveInvites(invites);
    });
}


module.exports = {
    INVITES_PATH,
    loadInvites,
    saveInvites,
    isInviteLive,
    hasActiveInvites,
    findLiveInvite,
    inviteStatus,
    inviteTransaction,
};
