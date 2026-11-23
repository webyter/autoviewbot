'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// lib/media.js — resilient media download with a WORKING reupload path.
//
// Why this exists (two real bugs in Baileys rc14 that broke `.vv`/view-once):
//
// 1) Baileys' built-in reupload is dead code in this environment.
//    `downloadMediaMessage()` retries through `ctx.reuploadRequest` only when
//    `typeof error?.status === 'number'`. The error thrown by the media CDN
//    fetch (`getHttpStream`) is a Boom error, and Boom exposes the HTTP status
//    as `error.output.statusCode` — `error.status` is `undefined`. So a
//    404/410 from the media CDN (exactly what expired / already-viewed
//    view-once media returns) NEVER triggers the reupload and the download
//    just fails.
//
// 2) `downloadMediaMessage()` refuses media that has no `url` key at all:
//    `(!('url' in media) && !('thumbnailDirectPath' in media))` -> "message is
//    not a media message". Recent WhatsApp builds deliver media with only
//    `directPath` + `mediaKey` (no `url`), which is precisely how view-once
//    media arrives. `downloadContentFromMessage()` handles that case (it
//    derives the URL from `directPath`), so we use it directly.
//
// The reupload itself is done by us: `sock.updateMediaMessage()` sends the
// 'rmr' (server-error receipt) node to the SENDER's device asking it to
// re-upload the media, then applies the returned `directPath`/`url` to the
// media object. Note that Baileys waits for the 'messages.media-update' event
// with NO timeout (promiseTimeout(undefined) => waits forever), so we always
// race it against our own timeout.

const DEFAULT_TIMEOUT_MS = 20000;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024; // 100 MB — bigger than a Render free instance's RAM

// Where a Boom/axios style error carries its HTTP status.
function httpStatus(err) {
    if (!err) return null;
    const candidates = [err.status, err.output?.statusCode, err.response?.status, err.statusCode];
    for (const c of candidates) {
        const n = Number(c);
        if (Number.isFinite(n) && n >= 100) return n;
    }
    return null;
}

// 404/410 == "media gone from the CDN, ask the sender's device to re-upload".
// 403 == expired link: WhatsApp answers 403 when the signed link's `oe`
// (expiry, hex unix seconds) has passed. Upstream Baileys only treats
// 404/410 as reupload-worthy (PR #2835 asks for the 403 case too).
function needsReupload(err, mediaObj) {
    const st = httpStatus(err);
    if (st === 400 && /no valid media url or directpath/i.test(String(err?.message || ''))) {
        const key = mediaKeyToBytes(mediaObj?.mediaKey);
        return (Buffer.isBuffer(key) || key instanceof Uint8Array) && key.length === 32;
    }
    if (st === 404 || st === 410) return true;
    if (st === 403 && isExpiredLink(mediaObj)) return true;
    const msg = String(err?.message || '').toLowerCase();
    return /failed to fetch stream|not found|gone|expired/.test(msg) && !st;
}

// The signed media link carries `oe` = expiry as hex unix seconds.
function isExpiredLink(mediaObj) {
    const link = mediaObj?.directPath ? mediaObj.url : (mediaObj?.url || mediaObj?.directPath);
    if (!link) return false;
    try {
        const u = new URL(link);
        const all = u.searchParams.getAll('oe');
        if (all.length !== 1) return false;
        const hex = all[0];
        if (!/^[0-9a-fA-F]+$/.test(hex)) return false;
        const secs = parseInt(hex, 16);
        if (!Number.isSafeInteger(secs)) return false;
        return secs * 1000 <= Date.now();
    } catch {
        return false;
    }
}

// Baileys' `getMediaKeys()` decodes a base64 mediaKey, but `getMediaRetryKey()`
// (used to encrypt the re-upload request) does NOT — it feeds the raw string
// into HKDF, producing the wrong retry key, and the phone's answer then fails
// to decrypt ("Unsupported state or unable to authenticate data").
// Normalise the key to bytes before it is used for the re-upload.
// (Upstream: WhiskeySockets/Baileys#2834, follow-up commit 3.)
function mediaKeyToBytes(mediaKey) {
    if (typeof mediaKey === 'string') {
        const b64 = mediaKey.replace('data:;base64,', '');
        try { return Buffer.from(b64, 'base64'); } catch { return mediaKey; }
    }
    return mediaKey;
}

// Media type string used for the HKDF key derivation (see Baileys
// MEDIA_HKDF_KEY_MAPPING) — must match the media kind, not the proto key.
const MEDIA_TYPE_FOR = {
    imageMessage: 'image',
    videoMessage: 'video',
    audioMessage: 'audio',
    documentMessage: 'document',
    stickerMessage: 'sticker'
};

function mediaTypeFor(protoKey) {
    return MEDIA_TYPE_FOR[protoKey] || 'image';
}

async function collectStream(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks);
}

// Download the media object directly (supports directPath-only media).
// `host` is passed explicitly: Baileys otherwise derives the directPath host
// from `url`, and a stale `a.whatsapp.net` url makes the download fail with
// ENOTFOUND (upstream: WhiskeySockets/Baileys#2778).
async function downloadMediaObject(baileys, mediaObj, mediaType, host) {
    const { downloadContentFromMessage } = baileys;
    const opts = host ? { host } : {};
    const stream = await downloadContentFromMessage(mediaObj, mediaType, opts);
    return await collectStream(stream);
}

// Ask the sender's device to re-upload the media and apply the new
// directPath/url onto the same media object we download from.
async function reuploadMedia(sock, revealMsg, timeoutMs) {
    const request = Promise.resolve(sock.updateMediaMessage(revealMsg)).then(() => true);
    let timeout;
    const timer = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Reupload request timed out (primary phone unavailable?)')), timeoutMs);
        if (timeout.unref) timeout.unref();
    });
    try {
        return await Promise.race([request, timer]);
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * Download media from a message, with an explicit reupload (media retry)
 * fallback for media the CDN no longer serves.
 *
 * @param {object} sock         Baileys socket
 * @param {object} baileys      the Baileys module (for downloadContentFromMessage)
 * @param {object} opts
 *   key        – message key of the ORIGINAL message holding the media
 *   media      – media object (imageMessage/videoMessage/...)
 *   protoKey   – proto key name ('imageMessage', ...)
 *   timeoutMs  – reupload timeout
 * @returns {Promise<Buffer>}
 */
async function downloadMediaWithReupload(sock, baileys, opts) {
    const { key, media } = opts;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    if (!media) throw new Error('No media object to download');
    const mediaType = mediaTypeFor(opts.protoKey);

    // Normalise the media key to bytes: Baileys' retry-key derivation does not
    // decode a base64 string key, which breaks the re-upload handshake.
    const mediaKeyBytes = mediaKeyToBytes(media.mediaKey);
    const mediaForDownload = mediaKeyBytes === media.mediaKey
        ? media
        : { ...media, mediaKey: mediaKeyBytes };

    // Message shape used for the reupload request: the media object must be
    // reachable through assertMediaContent() and its mediaKey is needed to
    // encrypt the 'rmr' receipt.
    const revealMsg = { key, message: { [opts.protoKey]: mediaForDownload } };

    // Use the socket's known-good media host for directPath downloads.
    const host = (typeof sock?.getMediaHost === 'function' ? sock.getMediaHost() : undefined) || undefined;

    let firstErr = null;
    try {
        const buf = await downloadMediaObject(baileys, mediaForDownload, mediaType, host);
        if (buf && buf.length) return buf;
        firstErr = new Error('Downloaded media was empty');
    } catch (err) {
        firstErr = err;
        if (!needsReupload(err, media)) throw err;
    }

    // Media is gone from the CDN -> ask the sender's device to re-upload it.
    await reuploadMedia(sock, revealMsg, timeoutMs);
    const buf = await downloadMediaObject(baileys, mediaForDownload, mediaType, host);
    if (buf && buf.length) return buf;
    throw firstErr || new Error('Media could not be downloaded');
}

/**
 * Download media to a TEMP FILE instead of buffering it in memory.
 *
 * Why: a 100 MB status video buffered as a Buffer costs 100 MB of heap plus
 * the upload copy — on Render's 512 MB free instances that is an OOM. Baileys
 * uploads from a file path (getStream() falls through to createReadStream),
 * so the media can be streamed to disk and uploaded from there.
 *
 * @returns {Promise<{ path: string, size: number, cleanup: () => void }>}
 */
async function downloadMediaToFile(sock, baileys, opts) {
    const { key, media } = opts;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const maxBytes = opts.maxBytes ?? MAX_MEDIA_BYTES;
    if (!media) throw new Error('No media object to download');
    const mediaType = mediaTypeFor(opts.protoKey);

    const mediaKeyBytes = mediaKeyToBytes(media.mediaKey);
    const mediaForDownload = mediaKeyBytes === media.mediaKey
        ? media
        : { ...media, mediaKey: mediaKeyBytes };
    const revealMsg = { key, message: { [opts.protoKey]: mediaForDownload } };
    const host = (typeof sock?.getMediaHost === 'function' ? sock.getMediaHost() : undefined) || undefined;

    const ext = extensionFor(opts.protoKey, media);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autoviewer-media-'));
    const filePath = path.join(dir, `media-${Date.now()}${ext}`);

    const download = async () => {
        let stream;
        if (typeof baileys.downloadContentFromMessage === 'function') {
            const currentMedia = revealMsg.message[opts.protoKey] || mediaForDownload;
            stream = await baileys.downloadContentFromMessage(currentMedia, mediaType, host ? { host } : {});
        } else if (typeof baileys.downloadMediaMessage === 'function') {
            stream = await baileys.downloadMediaMessage(revealMsg, 'stream', {}, {
                logger: { info: () => {}, debug: () => {}, error: () => {}, warn: () => {} },
                reuploadRequest: sock.updateMediaMessage
            });
        } else {
            throw new Error('Baileys download function not found');
        }
        const out = fs.createWriteStream(filePath);
        let size = 0;
        try {
            for await (const chunk of stream) {
                size += chunk.length;
                if (size > maxBytes) throw new Error(`Media is larger than the ${Math.round(maxBytes / 1048576)} MB limit`);
                if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
            }
        } finally {
            await new Promise(r => out.end(r));
        }
        if (!size) throw new Error('Downloaded media was empty');
        return size;
    };

    let size;
    try {
        size = await download();
    } catch (err) {
        if (!needsReupload(err, media)) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
            throw err;
        }
        // Media is gone from the CDN -> ask the sender's device to re-upload.
        try {
            await reuploadMedia(sock, revealMsg, timeoutMs);
            size = await download();
        } catch (e2) {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
            throw e2;
        }
    }

    return {
        path: filePath,
        size,
        cleanup() {
            try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
        }
    };
}

// Best-effort file extension so Baileys can pick the right mime type when it
// uploads the file back to WhatsApp.
const EXTENSIONS = {
    imageMessage: '.jpg',
    videoMessage: '.mp4',
    audioMessage: '.ogg',
    documentMessage: '.bin',
    stickerMessage: '.webp'
};

function extensionFor(protoKey, media) {
    if (protoKey === 'imageMessage' && media?.mimetype === 'image/png') return '.png';
    if (protoKey === 'videoMessage' && media?.mimetype === 'video/mp4') return '.mp4';
    if (protoKey === 'audioMessage') return media?.ptt ? '.ogg' : '.mp3';
    if (protoKey === 'documentMessage') {
        const name = String(media?.fileName || '');
        const dot = name.lastIndexOf('.');
        if (dot > 0 && dot < name.length - 1 && /^[a-z0-9]{1,8}$/i.test(name.slice(dot + 1))) return name.slice(dot);
        return '.bin';
    }
    return EXTENSIONS[protoKey] || '.bin';
}

// Resolve the media object (and its proto key) out of a raw message,
// unwrapping ephemeral / view-once / edited envelopes.
const ENVELOPES = [
    'ephemeralMessage',
    'viewOnceMessage',
    'viewOnceMessageV2',
    'viewOnceMessageV2Extension',
    'documentWithCaptionMessage',
    'editedMessage',
    'groupMentionedMessage',
    'associatedChildMessage'
];

function unwrapMessage(msg) {
    let cur = msg;
    for (let i = 0; cur && i < 8; i++) {
        let found = false;
        for (const env of ENVELOPES) {
            if (cur[env]?.message) { cur = cur[env].message; found = true; break; }
        }
        if (!found) break;
    }
    return cur;
}

const MEDIA_PROTO_KEYS = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'];

function extractMedia(message) {
    const inner = unwrapMessage(message) || {};
    for (const k of MEDIA_PROTO_KEYS) {
        if (inner[k]) return { protoKey: k, media: inner[k], inner };
    }
    return { protoKey: null, media: null, inner };
}

module.exports = {
    downloadMediaWithReupload,
    downloadMediaToFile,
    extensionFor,
    MAX_MEDIA_BYTES,
    extractMedia,
    unwrapMessage,
    httpStatus,
    needsReupload,
    isExpiredLink,
    mediaKeyToBytes,
    mediaTypeFor,
    MEDIA_PROTO_KEYS
};
