'use strict';
const assert = require('assert');
const fs = require('fs');
const { Readable } = require('stream');
const make = require('../commands');

const owner = '15550000001@s.whatsapp.net';
const contact = '15550000002@s.whatsapp.net';
const group = '123456@g.us';
function fixture(options = {}) {
    const sent = [], updates = [], retries = [], files = [];
    const settings = { mode: 'public', admins: [], commandPrefix: '.', antivv: false };
    const original = {
        key: { id: 'original-media', remoteJid: group, participant: contact, fromMe: false },
        message: { imageMessage: { directPath: '/test-media', mediaKey: Buffer.alloc(32) } }
    };
    const status = {
        key: { id: 'original-status', remoteJid: 'status@broadcast', participant: contact, fromMe: false },
        message: { conversation: 'A status' }, messageTimestamp: Math.floor(Date.now() / 1000)
    };
    const sock = {
        user: { id: owner },
        sendMessage: async (jid, content) => {
            const file = content.image?.url;
            if (file) {
                assert.ok(fs.existsSync(file), 'media file must exist during upload');
                assert.strictEqual(fs.readFileSync(file, 'utf8'), 'decrypted-media');
                files.push(file);
            }
            sent.push({ jid, content });
            return {};
        },
        updateMediaMessage: async message => retries.push(message.key)
    };
    let attempts = 0;
    const handler = make({
        userSettings: settings, sendToParent: msg => updates.push(msg),
        loadBaileys: async () => ({
            jidNormalizedUser: j => j.replace(/:\d+@/, '@'),
            isLidUser: j => !!j?.endsWith('@lid'), isPnUser: j => !!j?.endsWith('@s.whatsapp.net'),
            downloadContentFromMessage: async () => {
                if (options.expired && attempts++ === 0) {
                    const err = new Error('Media expired'); err.status = 410; throw err;
                }
                return Readable.from([Buffer.from('decrypted-media')]);
            }
        }),
        getCurrentSocket: () => sock, getProto: () => ({}),
        getStatusStore: () => new Map([[status.key.id, status]]),
        getMsgStore: () => options.cached ? new Map([[original.key.id, original]]) : new Map(),
        getOwnerJid: () => owner, copyNForward: require('../lib/forward'),
        clearHistory() {}, historyKey: jid => jid, markStatusAsViewed: async () => {}
    });
    const run = (body, overrides = {}) => handler(sock, body, {
        key: { id: 'command-message', remoteJid: group, fromMe: true, participant: owner, ...overrides.key },
        message: { extendedTextMessage: { text: body, contextInfo: {
            stanzaId: original.key.id, participant: contact, quotedMessage: original.message,
            ...overrides.context
        } } }
    }, group);
    return { run, settings, sent, updates, retries, files, original, status };
}

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ok ${name}`); }
(async () => {
    await test('.save forwards the original status with its key', async () => {
        const f = fixture(); await f.run('.save');
        const forwarded = f.sent.find(x => x.content.forward);
        assert.strictEqual(forwarded?.jid, owner);
        assert.deepStrictEqual(forwarded.content.forward, { key: f.status.key, message: f.status.message });
    });
    await test('.poll preserves the question and choices for every supported prefix form', async () => {
        for (const [prefix, body] of [['.', '.poll Lunch plans? | Rice | Soup'], ['!', '!poll Lunch plans? | Rice | Soup'], ['##', '##poll Lunch plans? | Rice | Soup'], ['!', '.poll Lunch plans? | Rice | Soup']]) {
            const f = fixture(); f.settings.commandPrefix = prefix; await f.run(body);
            assert.deepStrictEqual(f.sent[0]?.content.poll, { name: 'Lunch plans?', values: ['Rice', 'Soup'], selectableCount: 1 });
        }
    });
    await test('.avv and .antivv cannot be changed by an unauthorized public user', async () => {
        for (const alias of ['avv', 'antivv']) {
            const f = fixture(); await f.run(`.${alias} on`, { key: { fromMe: false, participant: contact } });
            assert.strictEqual(f.settings.antivv, false);
            assert.strictEqual(f.updates.length, 0);
            assert.strictEqual(f.sent.length, 0);
        }
    });
    await test('.avv remains available to the owner and listed admins', async () => {
        for (const fromMe of [true, false]) {
            const f = fixture(); f.settings.admins = ['15550000002'];
            await f.run('.avv on', { key: { fromMe, participant: fromMe ? owner : contact } });
            assert.strictEqual(f.settings.antivv, true);
            assert.deepStrictEqual(f.updates[0].changes, { antivv: true });
        }
    });
    await test('.media retries the uncached quoted original and removes the temp file', async () => {
        const f = fixture({ expired: true }); await f.run('.media');
        assert.deepStrictEqual(f.retries[0], f.original.key);
        assert.strictEqual(f.files.length, 1);
        assert.ok(f.files.every(file => !fs.existsSync(file)));
    });
    await test('.media reconstructs own quoted status keys correctly', async () => {
        const f = fixture({ expired: true });
        await f.run('.media', { context: { remoteJid: 'status@broadcast', participant: owner } });
        assert.deepStrictEqual(f.retries[0], { remoteJid: 'status@broadcast', id: 'original-media', fromMe: true, participant: owner });
    });
    await test('.media keeps the full original key when cached', async () => {
        const f = fixture({ expired: true, cached: true }); await f.run('.media');
        assert.deepStrictEqual(f.retries[0], f.original.key);
    });
    await test('.vv reconstructs own quoted media keys for re-upload', async () => {
        const f = fixture({ expired: true });
        await f.run('.vv', { context: { remoteJid: 'status@broadcast', participant: owner } });
        assert.deepStrictEqual(f.retries[0], { remoteJid: 'status@broadcast', id: 'original-media', fromMe: true, participant: owner });
        assert.strictEqual(f.files.length, 1);
        assert.ok(f.files.every(file => !fs.existsSync(file)));
    });
    console.log(`\n${passed} passed, 0 failed`);
})().catch(err => { console.error(err); process.exitCode = 1; });
