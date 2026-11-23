'use strict';

// lib/store.js — durable, bounded recovery cache.
//
// The worker's message/status caches were pure in-memory Maps, so every
// restart wiped them: `.vv` (view-once reveal) and anti-delete recovery only
// worked for messages received in the CURRENT session. WhatsApp's own CDN
// keeps expired media recoverable through the sender's device (see
// lib/media.js), so keeping the metadata around is what makes that
// recoverable.
//
// Design:
// - One JSON file per user: session/<user>/recovery-cache.json
// - Bounded (maxMessages / maxStatuses) and TTL'd — never grows unbounded.
// - Writes are debounced (coalesced) and atomic (tmp file + rename).
// - A failed write NEVER throws into the message path: recovery is best
//   effort and must not break message handling.
// - Media payloads are stored as-is (mediaKey/directPath/url) so the reupload
//   handshake can still work; the file inherits the process umask (0077).

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_MESSAGES = 300;
const DEFAULT_MAX_STATUSES = 150;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const SAVE_DEBOUNCE_MS = 10000; // coalesce writes; the cache can be ~1 MB

// Buffers (mediaKey, etc.) must survive JSON round-tripping. JSON.stringify
// turns a Buffer into {"type":"Buffer","data":[...]}, which Baileys can NOT
// use — getMediaKeys() would derive the wrong keys and the download (and the
// re-upload handshake) would fail after a restart. Encode them explicitly.
const B64_MARKER = '__av_b64__';

function encodeBuffers(value) {
    if (value === null || value === undefined) return value;
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
        return { [B64_MARKER]: Buffer.from(value).toString('base64') };
    }
    if (Array.isArray(value)) return value.map(encodeBuffers);
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = encodeBuffers(v);
        return out;
    }
    return value;
}

function decodeBuffers(value) {
    if (value === null || value === undefined) return value;
    // A Buffer/Uint8Array is already binary — never walk it (that would turn
    // it into a plain object and destroy the media key).
    if (Buffer.isBuffer(value) || value instanceof Uint8Array) return value;
    if (typeof value === 'object' && !Array.isArray(value) && typeof value[B64_MARKER] === 'string') {
        return Buffer.from(value[B64_MARKER], 'base64');
    }
    if (Array.isArray(value)) return value.map(decodeBuffers);
    if (typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) out[k] = decodeBuffers(v);
        return out;
    }
    return value;
}

class RecoveryCache {
    /**
     * @param {object} opts
     * @param {string} opts.file            path of the cache file
     * @param {number} [opts.maxMessages]
     * @param {number} [opts.maxStatuses]
     * @param {number} [opts.ttlMs]
     */
    constructor(opts) {
        this.file = opts.file;
        this.maxMessages = opts.maxMessages ?? DEFAULT_MAX_MESSAGES;
        this.maxStatuses = opts.maxStatuses ?? DEFAULT_MAX_STATUSES;
        this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
        this.messages = new Map(); // id -> { key, message, ts }
        this.statuses = new Map(); // id -> { key, message, ts }
        this._timer = null;
        this._dirty = false;
        this._log = opts.log || (() => {});
    }

    load() {
        try {
            if (!this.file || !fs.existsSync(this.file)) return false;
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (raw && Array.isArray(raw.messages)) {
                for (const e of raw.messages) {
                    if (e && e.id && e.message) this.messages.set(e.id, e);
                }
            }
            if (raw && Array.isArray(raw.statuses)) {
                for (const e of raw.statuses) {
                    if (e && e.id && e.message) this.statuses.set(e.id, e);
                }
            }
            this._evictExpired();
            this._trim();
            this._log(`loaded ${this.messages.size} messages / ${this.statuses.size} statuses from cache`);
            return true;
        } catch (e) {
            this._log('cache load failed: ' + e.message);
            return false;
        }
    }

    scheduleSave() {
        this._dirty = true;
        if (this._timer) return;
        this._timer = setTimeout(() => {
            this._timer = null;
            this.save();
        }, SAVE_DEBOUNCE_MS);
        if (this._timer.unref) this._timer.unref();
    }

    save() {
        if (!this.file || !this._dirty) return false;
        this._dirty = false;
        try {
            fs.mkdirSync(path.dirname(this.file), { recursive: true });
            const tmp = this.file + '.tmp.' + process.pid;
            const payload = JSON.stringify({
                v: 1,
                savedAt: Date.now(),
                messages: Array.from(this.messages.values()),
                statuses: Array.from(this.statuses.values())
            });
            fs.writeFileSync(tmp, payload);
            fs.renameSync(tmp, this.file);
            return true;
        } catch (e) {
            this._log('cache save failed: ' + e.message);
            return false;
        }
    }

    flush() {
        if (this._timer) { clearTimeout(this._timer); this._timer = null; }
        if (this._dirty) this.save();
    }

    clear() {
        this.messages.clear();
        this.statuses.clear();
        this._dirty = true;
        this.scheduleSave();
    }

    putMessage(id, message, key) {
        if (!id || !message) return;
        this.messages.set(id, { id, key: key || message.key || null, message: encodeBuffers(message), ts: Date.now() });
        this._trim();
        this.scheduleSave();
    }

    getMessage(id) {
        if (!id) return null;
        const e = this.messages.get(id);
        if (!e) return null;
        if (Date.now() - e.ts > this.ttlMs) { this.messages.delete(id); this.scheduleSave(); return null; }
        return { ...e, message: decodeBuffers(e.message) };
    }

    putStatus(id, message, key) {
        if (!id || !message) return;
        this.statuses.set(id, { id, key: key || message.key || null, message: encodeBuffers(message), ts: Date.now() });
        this._trim();
        this.scheduleSave();
    }

    getStatus(id) {
        if (!id) return null;
        const e = this.statuses.get(id);
        if (!e) return null;
        if (Date.now() - e.ts > this.ttlMs) { this.statuses.delete(id); this.scheduleSave(); return null; }
        return { ...e, message: decodeBuffers(e.message) };
    }

    listStatuses() {
        return Array.from(this.statuses.values()).map(e => ({ ...e, message: decodeBuffers(e.message) }));
    }

    stats() {
        return {
            messages: this.messages.size,
            statuses: this.statuses.size,
            file: this.file,
            ttlDays: Math.round(this.ttlMs / 86400000)
        };
    }

    _evictExpired() {
        const now = Date.now();
        for (const [k, e] of this.messages) if (now - e.ts > this.ttlMs) this.messages.delete(k);
        for (const [k, e] of this.statuses) if (now - e.ts > this.ttlMs) this.statuses.delete(k);
    }

    _trim() {
        // Map preserves insertion order — the oldest entries come first.
        while (this.messages.size > this.maxMessages) {
            const oldest = this.messages.keys().next().value;
            if (oldest === undefined) break;
            this.messages.delete(oldest);
        }
        while (this.statuses.size > this.maxStatuses) {
            const oldest = this.statuses.keys().next().value;
            if (oldest === undefined) break;
            this.statuses.delete(oldest);
        }
    }

    purgeExpired() {
        const before = this.messages.size + this.statuses.size;
        this._evictExpired();
        if (before !== this.messages.size + this.statuses.size) this.scheduleSave();
    }
}

module.exports = { RecoveryCache, DEFAULT_TTL_MS, DEFAULT_MAX_MESSAGES, DEFAULT_MAX_STATUSES };
