'use strict';

// Tests for the streaming (file-based) media download path.
//
// A 100 MB status video buffered as a Buffer would blow up a Render free
// instance (512 MB). lib/media.js therefore streams the download to a temp
// file and the caller uploads from disk.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { downloadMediaToFile, extensionFor, MAX_MEDIA_BYTES } = require('../lib/media');

let passed = 0;
let failed = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; }
}

const fakeBaileys = (chunks, opts = {}) => ({
    downloadMediaMessage: async () => {
        if (opts.throwFirst) { opts.throwFirst = null; throw opts.err; }
        return (async function* () { for (const c of chunks) yield c; })();
    }
});

(async () => {
    console.log('\nstreaming media download (lib/media)');

    await t('downloads the media to a temp file', async () => {
        const payload = Buffer.from('X'.repeat(4096));
        const sock = { updateMediaMessage: async () => {}, getMediaHost: () => 'mmg.whatsapp.net' };
        const res = await downloadMediaToFile(sock, fakeBaileys([payload]), {
            key: { id: 'M1' },
            media: { mediaKey: Buffer.alloc(32), directPath: '/o1/x' },
            protoKey: 'imageMessage'
        });
        assert.ok(fs.existsSync(res.path), 'the file must exist');
        assert.strictEqual(res.size, payload.length);
        assert.strictEqual(fs.readFileSync(res.path).length, payload.length);
        res.cleanup();
        assert.ok(!fs.existsSync(res.path), 'cleanup must remove the file');
    });

    await t('keeps the file extension aligned with the media type', async () => {
        const sock = { updateMediaMessage: async () => {} };
        const res = await downloadMediaToFile(sock, fakeBaileys([Buffer.from('x')]), {
            key: { id: 'M2' },
            media: { mediaKey: Buffer.alloc(32), mimetype: 'image/png' },
            protoKey: 'imageMessage'
        });
        assert.ok(res.path.endsWith('.png'), `expected .png, got ${res.path}`);
        res.cleanup();
    });

    await t('a 404 triggers the reupload and then succeeds', async () => {
        const { Boom } = require('@hapi/boom');
        let reuploaded = false;
        let calls = 0;
        const sock = {
            updateMediaMessage: async () => { reuploaded = true; },
            getMediaHost: () => 'mmg.whatsapp.net'
        };
        const baileys = {
            downloadMediaMessage: async () => {
                calls++;
                if (calls === 1) throw new Boom('Failed to fetch stream', { statusCode: 404 });
                return (async function* () { yield Buffer.from('fresh'); })();
            }
        };
        const res = await downloadMediaToFile(sock, baileys, {
            key: { id: 'M3' },
            media: { mediaKey: Buffer.alloc(32), directPath: '/o1/x' },
            protoKey: 'imageMessage'
        });
        assert.ok(reuploaded, 'the reupload must be requested');
        assert.strictEqual(fs.readFileSync(res.path, 'utf8'), 'fresh');
        res.cleanup();
    });

    await t('oversized media is rejected and the file is cleaned up', async () => {
        const sock = { updateMediaMessage: async () => {} };
        const big = Buffer.alloc(1024);
        const baileys = {
            downloadMediaMessage: async () => (async function* () {
                for (let i = 0; i < 40; i++) yield big; // 40 KB in 1 KB chunks
            })()
        };
        await assert.rejects(downloadMediaToFile(sock, baileys, {
            key: { id: 'M4' },
            media: { mediaKey: Buffer.alloc(32), directPath: '/o1/x' },
            protoKey: 'videoMessage',
            maxBytes: 2048
        }), /larger than/i);
    });

    await t('extensionFor maps proto keys to sensible extensions', () => {
        assert.strictEqual(extensionFor('imageMessage', { mimetype: 'image/png' }), '.png');
        assert.strictEqual(extensionFor('imageMessage', { mimetype: 'image/jpeg' }), '.jpg');
        assert.strictEqual(extensionFor('videoMessage', {}), '.mp4');
        assert.strictEqual(extensionFor('audioMessage', { ptt: true }), '.ogg');
        assert.strictEqual(extensionFor('audioMessage', { ptt: false }), '.mp3');
        assert.strictEqual(extensionFor('stickerMessage', {}), '.webp');
        assert.strictEqual(extensionFor('documentMessage', { fileName: 'invoice.pdf' }), '.pdf');
        assert.strictEqual(extensionFor('documentMessage', {}), '.bin');
    });

    await t('the media size cap is sane for a 512 MB instance', () => {
        assert.ok(MAX_MEDIA_BYTES <= 256 * 1024 * 1024, 'the cap must stay well below the RAM limit');
        assert.ok(MAX_MEDIA_BYTES >= 16 * 1024 * 1024, 'the cap must still allow normal videos');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
})();
