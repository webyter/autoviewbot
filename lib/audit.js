'use strict';

// lib/audit.js — append-only audit log for privileged actions.
//
// Who did what, to whom, and when. Without it, "an admin deleted the wrong
// account" is unanswerable — the app logs to stdout and the DB has no history.
//
// Format: JSONL (one JSON object per line) under SESSION_DIR/audit.log.
// Append-only, size-capped (rotated), owner-readable, never contains secrets.

const fs = require('fs');
const path = require('path');

const MAX_BYTES = 2 * 1024 * 1024; // rotate at 2 MB
const REDACT_KEYS = new Set(['password', 'groqKey', 'sessionSecret', 'token', 'key']);

function sanitize(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (depth > 4) return '[deep]';
    if (typeof value === 'string') return value.length > 300 ? value.slice(0, 300) + '…' : value;
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return value.slice(0, 20).map(v => sanitize(v, depth + 1));
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = REDACT_KEYS.has(k) ? '[redacted]' : sanitize(v, depth + 1);
        }
        return out;
    }
    return String(value);
}

class AuditLog {
    /**
     * @param {object} opts
     *   dir      – directory for audit.log
     *   maxBytes – rotate threshold
     */
    constructor(opts = {}) {
        this.file = opts.file || path.join(opts.dir || '.', 'audit.log');
        this.maxBytes = opts.maxBytes ?? MAX_BYTES;
        this._pending = null;
    }

    /**
     * Record an action. Never throws — auditing must not break the action.
     */
    record(action, actor, details = {}) {
        try {
            const entry = {
                ts: new Date().toISOString(),
                action: String(action),
                actor: actor ? String(actor).slice(0, 64) : 'system',
                ip: details.ip || undefined,
                details: sanitize(details)
            };
            const line = JSON.stringify(entry) + '\n';
            // Serialise writes so concurrent actions cannot interleave.
            this._pending = (this._pending || Promise.resolve()).then(() => this._append(line)).catch(() => {});
            return entry;
        } catch {
            return null;
        }
    }

    async _append(line) {
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            try {
                const st = fs.statSync(this.file);
                if (st.size + Buffer.byteLength(line) > this.maxBytes) {
                    // Rotate: keep the newest half.
                    const old = fs.readFileSync(this.file, 'utf8').split('\n');
                    fs.writeFileSync(this.file, old.slice(Math.floor(old.length / 2)).join('\n'));
                }
            } catch { /* file does not exist yet */ }
            fs.appendFileSync(this.file, line, { mode: 0o600 });
        } catch { /* never throw */ }
    }

    /** Read the most recent entries (newest last). */
    async tail(limit = 100) {
        try {
            const raw = fs.readFileSync(this.file, 'utf8');
            const lines = raw.split('\n').filter(Boolean);
            return lines.slice(-limit).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } });
        } catch {
            return [];
        }
    }

    /** Flush any queued writes (used on shutdown). */
    async flush() {
        if (this._pending) { try { await this._pending; } catch {} }
    }
}

module.exports = { AuditLog, sanitize, MAX_BYTES };
