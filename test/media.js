'use strict';

// Regression test for the .vv / antivv media download path.
//
// Two bugs in Baileys rc14 broke view-once reveals, both reproduced here:
//
//  1) `downloadMediaMessage()` only re-requests the media from the sender's
//     device when `typeof error?.status === 'number'`. The CDN fetch error is
//     a Boom error, whose status lives in `error.output.statusCode` — so the
//     reupload never fired and expired media always failed.
//  2) `downloadMediaMessage()` rejects media that has no `url` key at all
//     ("message is not a media message"), but current WhatsApp builds
//     deliver view-once media with only `directPath` + `mediaKey`.
//
// lib/media.js fixes both: it downloads via `downloadContentFromMessage()`
// (which handles directPath-only media) and performs the reupload itself.

const assert = require('assert');
const { Boom } = require('@hapi/boom');
const { downloadMediaWithReupload, httpStatus, needsReupload, extractMedia, unwrapMessage, mediaTypeFor, isExpiredLink, mediaKeyToBytes } = require('../lib/media');

let passed = 0;
let failed = 0;

async function t(name, fn) {
    try { await fn(); console.log(`  ok ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; }
}

(async () => {
    console.log('\nmedia download resilience (lib/media)');

    await t('httpStatus reads Boom output.statusCode', () => {
        const err = new Boom('Failed to fetch stream from https://mmg.whatsapp.net/x', { statusCode: 404 });
        assert.strictEqual(httpStatus(err), 404);
        // The property Baileys checks is NOT set on Boom errors — this is the
        // reason its built-in reupload never fires.
        assert.strictEqual(err.status, undefined);
    });

    await t('needsReupload detects 404 and 410 from the CDN', () => {
        assert.ok(needsReupload(new Boom('Failed to fetch stream from x', { statusCode: 404 })));
        assert.ok(needsReupload(new Boom('Failed to fetch stream from x', { statusCode: 410 })));
        assert.ok(!needsReupload(new Boom('nope', { statusCode: 403 })));
    });

    await t('media type mapping drives HKDF key derivation', () => {
        assert.strictEqual(mediaTypeFor('imageMessage'), 'image');
        assert.strictEqual(mediaTypeFor('videoMessage'), 'video');
        assert.strictEqual(mediaTypeFor('audioMessage'), 'audio');
        assert.strictEqual(mediaTypeFor('documentMessage'), 'document');
        assert.strictEqual(mediaTypeFor('stickerMessage'), 'sticker');
    });

    await t('extractMedia finds media behind view-once wrappers', () => {
        const media = { mediaKey: Buffer.alloc(32), directPath: '/o1/t62.7117-24/abc' };
        const ex = extractMedia({ viewOnceMessageV2: { message: { imageMessage: media } } });
        assert.strictEqual(ex.protoKey, 'imageMessage');
        assert.strictEqual(ex.media, media);
    });

    await t('extractMedia finds media behind viewOnceMessageV2Extension', () => {
        const media = { mediaKey: Buffer.alloc(32), directPath: '/o1/x' };
        const ex = extractMedia({ viewOnceMessageV2Extension: { message: { videoMessage: media } } });
        assert.strictEqual(ex.protoKey, 'videoMessage');
        assert.strictEqual(ex.media, media);
    });

    await t('extractMedia handles ephemeral wrapping a view-once', () => {
        const media = { mediaKey: Buffer.alloc(32), directPath: '/o1/x' };
        const ex = extractMedia({ ephemeralMessage: { message: { viewOnceMessage: { message: { imageMessage: media } } } } });
        assert.strictEqual(ex.protoKey, 'imageMessage');
        assert.strictEqual(ex.media, media);
    });

    await t('extractMedia handles a plain (already unwrapped) media message', () => {
        const media = { mediaKey: Buffer.alloc(32), directPath: '/o1/x' };
        const ex = extractMedia({ imageMessage: media });
        assert.strictEqual(ex.protoKey, 'imageMessage');
        assert.strictEqual(ex.media, media);
    });

    await t('extractMedia returns no media for a text message', () => {
        const ex = extractMedia({ conversation: 'hello' });
        assert.strictEqual(ex.protoKey, null);
        assert.strictEqual(ex.media, null);
    });

    await t('unwrapMessage strips the envelope chain', () => {
        const inner = { imageMessage: { mediaKey: Buffer.alloc(32) } };
        assert.strictEqual(unwrapMessage({ ephemeralMessage: { message: { viewOnceMessage: { message: inner } } } }), inner);
    });

    await t('directPath-only media (no url) is accepted', async () => {
        // The shape current WhatsApp builds use for view-once media.
        const media = { mediaKey: Buffer.alloc(32), directPath: '/o1/t62.7117-24/xyz', mimetype: 'image/jpeg' };
        const ex = extractMedia({ viewOnceMessageV2: { message: { imageMessage: media } } });
        assert.ok(ex.media, 'media must be found');
        assert.ok(!('url' in ex.media), 'media intentionally has no url');
        // Baileys' downloadMediaMessage would have thrown "not a media message"
        // for this shape; downloadContentFromMessage (used by lib/media) does not.
        const { downloadContentFromMessage } = await import('@whiskeysockets/baileys');
        assert.strictEqual(typeof downloadContentFromMessage, 'function');
    });

    await t('downloadMediaWithReupload re-requests the media from the sender on 404', async () => {
        let attempts = 0;
        let reuploaded = false;
        const media = { mediaKey: Buffer.alloc(32), directPath: '/o1/old', url: 'https://mmg.whatsapp.net/o1/old' };
        const fakeBaileys = {
            downloadContentFromMessage: async () => {
                attempts++;
                if (attempts === 1) {
                    throw new Boom('Failed to fetch stream from https://mmg.whatsapp.net/o1/old', { statusCode: 404 });
                }
                return (async function* () { yield Buffer.from('MEDIA-OK'); })();
            }
        };
        const fakeSock = {
            updateMediaMessage: async (msg) => {
                reuploaded = true;
                // Baileys mutates content.directPath / content.url in place.
                msg.message.imageMessage.directPath = '/o1/new';
                msg.message.imageMessage.url = 'https://mmg.whatsapp.net/o1/new';
                return msg;
            }
        };
        const buf = await downloadMediaWithReupload(fakeSock, fakeBaileys, {
            key: { id: 'MSG1', remoteJid: '123@s.whatsapp.net' },
            media,
            protoKey: 'imageMessage',
            timeoutMs: 2000
        });
        assert.ok(reuploaded, 'reupload must have been requested');
        assert.strictEqual(buf.toString(), 'MEDIA-OK');
        assert.strictEqual(attempts, 2, 'download retried after reupload');
    });

    await t('downloadMediaWithReupload does NOT reupload on a non-404 error', async () => {
        let reuploaded = false;
        const fakeBaileys = {
            downloadContentFromMessage: async () => { throw new Boom('boom', { statusCode: 403 }); }
        };
        const fakeSock = { updateMediaMessage: async () => { reuploaded = true; } };
        await assert.rejects(
            downloadMediaWithReupload(fakeSock, fakeBaileys, {
                key: { id: 'MSG2' }, media: { mediaKey: Buffer.alloc(32) }, protoKey: 'imageMessage'
            })
        );
        assert.ok(!reuploaded, 'reupload must not be attempted for a 403');
    });

    await t('downloadMediaWithReupload surfaces a clear error when the sender is offline', async () => {
        const fakeBaileys = {
            downloadContentFromMessage: async () => { throw new Boom('Failed to fetch stream from x', { statusCode: 410 }); }
        };
        const fakeSock = {
            updateMediaMessage: async () => { throw new Error('Reupload request timed out (sender device offline?)'); }
        };
        await assert.rejects(
            downloadMediaWithReupload(fakeSock, fakeBaileys, {
                key: { id: 'MSG3' }, media: { mediaKey: Buffer.alloc(32) }, protoKey: 'imageMessage', timeoutMs: 500
            }),
            /offline|timed out/i
        );
    });


    await t('a base64 mediaKey is decoded to bytes for the re-upload', async () => {
        // Baileys' getMediaKeys() decodes a base64 key but getMediaRetryKey()
        // does not -> wrong retry key -> the phone's answer cannot be
        // decrypted (upstream #2834, follow-up commit 3).
        const raw = Buffer.from('0123456789abcdef0123456789abcdef');
        const b64 = raw.toString('base64');
        const bytes = mediaKeyToBytes(b64);
        assert.ok(Buffer.isBuffer(bytes), 'must be a Buffer');
        assert.strictEqual(bytes.toString('hex'), raw.toString('hex'));
        // A Buffer key must be passed through untouched.
        assert.strictEqual(mediaKeyToBytes(raw), raw);
    });

    await t('the re-upload receives the decoded media key', async () => {
        let seenKey = null;
        const raw = Buffer.from('0123456789abcdef0123456789abcdef');
        const b64 = raw.toString('base64');
        let attempts = 0;
        const fakeBaileys = {
            downloadContentFromMessage: async () => {
                attempts++;
                if (attempts === 1) throw new Boom('Failed to fetch stream', { statusCode: 410 });
                return (async function* () { yield Buffer.from('OK'); })();
            }
        };
        const fakeSock = {
            updateMediaMessage: async (msg) => {
                seenKey = msg.message.imageMessage.mediaKey;
                return msg;
            }
        };
        await downloadMediaWithReupload(fakeSock, fakeBaileys, {
            key: { id: 'MSG4' },
            media: { mediaKey: b64, directPath: '/o1/x' },
            protoKey: 'imageMessage',
            timeoutMs: 1000
        });
        assert.ok(Buffer.isBuffer(seenKey), 'mediaKey must be bytes, not a base64 string');
        assert.strictEqual(seenKey.toString('hex'), raw.toString('hex'));
    });

    await t('a 403 on an expired signed link triggers a re-upload', async () => {
        // WhatsApp answers 403 once the link signature's `oe` (hex unix
        // seconds) has passed (upstream #2835).
        const past = Math.floor(Date.now() / 1000) - 3600;
        const oe = past.toString(16);
        const media = {
            mediaKey: Buffer.alloc(32),
            directPath: '/o1/x',
            url: `https://mmg.whatsapp.net/o1/x?oe=${oe}`
        };
        assert.ok(isExpiredLink(media), 'link must be detected as expired');
        const err = new Boom('Failed to fetch stream', { statusCode: 403 });
        assert.ok(needsReupload(err, media), '403 on an expired link must ask for a re-upload');
    });

    await t('a 403 on a link that is NOT expired does not trigger a re-upload', async () => {
        const future = Math.floor(Date.now() / 1000) + 3600;
        const media = {
            mediaKey: Buffer.alloc(32),
            directPath: '/o1/x',
            url: `https://mmg.whatsapp.net/o1/x?oe=${future.toString(16)}`
        };
        assert.ok(!isExpiredLink(media));
        assert.ok(!needsReupload(new Boom('Failed to fetch stream', { statusCode: 403 }), media));
    });

    await t('the socket media host is used for directPath downloads', async () => {
        // A stale `a.whatsapp.net` url would otherwise be reused as the
        // directPath host -> ENOTFOUND (upstream #2778).
        let seenHost = null;
        const fakeBaileys = {
            downloadContentFromMessage: async (m, type, opts) => {
                seenHost = opts && opts.host;
                return (async function* () { yield Buffer.from('OK'); })();
            }
        };
        const fakeSock = { getMediaHost: () => 'mmg.whatsapp.net' };
        await downloadMediaWithReupload(fakeSock, fakeBaileys, {
            key: { id: 'MSG5' },
            media: { mediaKey: Buffer.alloc(32), directPath: '/o1/x', url: 'https://a.whatsapp.net/o1/x' },
            protoKey: 'imageMessage'
        });
        assert.strictEqual(seenHost, 'mmg.whatsapp.net');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
})();
