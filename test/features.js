'use strict';

// Regression tests for the feature modules added in this round:
//   lib/store.js      durable recovery cache
//   lib/backup.js     settings import

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { RecoveryCache } = require('../lib/store');
const backup = require('../lib/backup');

let passed = 0;
let failed = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; }
}

(async () => {
    console.log('\nfeature modules (store / backup)');

    await t('recovery cache persists messages across instances', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-store-'));
        const file = path.join(dir, 'recovery.json');
        const c1 = new RecoveryCache({ file });
        c1.putMessage('m1', { imageMessage: { mediaKey: Buffer.alloc(32) } }, { id: 'm1', remoteJid: '1@s.whatsapp.net' });
        c1.putStatus('s1', { imageMessage: { mediaKey: Buffer.alloc(32) } }, { id: 's1' });
        c1.save();

        const c2 = new RecoveryCache({ file });
        assert.ok(c2.load(), 'cache must load');
        assert.ok(c2.getMessage('m1'), 'message must survive a restart');
        assert.ok(c2.getStatus('s1'), 'status must survive a restart');
        assert.strictEqual(c2.getMessage('m1').message.imageMessage.mediaKey.length, 32);
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await t('recovery cache is bounded and TTL-evicts', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-store-'));
        const c = new RecoveryCache({ file: path.join(dir, 'r.json'), maxMessages: 3, ttlMs: 50 });
        for (let i = 0; i < 10; i++) c.putMessage('m' + i, { conversation: 'x' }, { id: 'm' + i });
        assert.strictEqual(c.messages.size, 3, 'must not exceed maxMessages');
        await new Promise(r => setTimeout(r, 80));
        assert.strictEqual(c.getMessage('m9'), null, 'expired entries must not be returned');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await t('recovery cache survives a corrupt file', async () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-store-'));
        const file = path.join(dir, 'bad.json');
        fs.writeFileSync(file, '{not json');
        const c = new RecoveryCache({ file });
        assert.strictEqual(c.load(), false, 'must fail closed, not throw');
        c.putMessage('m1', { conversation: 'hi' }, { id: 'm1' });
        assert.ok(c.getMessage('m1'));
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await t('backup import applies settings but never secrets', () => {
        const db = { moi: { botInstructions: 'old', allow: [], password: 'HASH' } };
        const res = backup.importUser(db, 'moi', {
            settings: { botInstructions: 'new', allow: ['233'], password: 'EVIL', isAdmin: true }
        });
        assert.strictEqual(db.moi.botInstructions, 'new');
        assert.deepStrictEqual(db.moi.allow, ['233']);
        assert.strictEqual(db.moi.password, 'HASH', 'password must not be overwritten');
        assert.strictEqual(db.moi.isAdmin, undefined, 'admin flag must not be importable');
        assert.ok(res.applied >= 2);
    });

    await t('commands engine handles .anticall and .emojis', async () => {
        const makeHandleOwnerCommand = require('../commands');
        const userSettings = {
            anticall: false,
            statusReact: true,
            reactEmojis: ['❤️', '💚'],
            admins: ['233502289002']
        };
        const parentMessages = [];
        const handler = makeHandleOwnerCommand({
            userSettings,
            sendToParent: (msg) => parentMessages.push(msg),
            loadBaileys: async () => ({
                jidNormalizedUser: (j) => j,
                isLidUser: () => false,
                isPnUser: () => true
            }),
            getCurrentSocket: () => ({ ws: { ping: (cb) => cb(null) } }),
            getProto: () => ({}),
            getStatusStore: () => new Map(),
            getMsgStore: () => new Map(),
            getOwnerJid: () => '233531556024@s.whatsapp.net',
            clearHistory: () => {},
            historyKey: () => 'k',
            markStatusAsViewed: async () => {},
            copyNForward: async () => {}
        });

        const replies = [];
        const mockSock = {
            sendMessage: async (jid, content) => { replies.push({ jid, content }); }
        };
        const ownerMsg = {
            key: { fromMe: true, remoteJid: '233531556024@s.whatsapp.net' },
            message: { conversation: '.anticall on' }
        };

        // Test .anticall on
        await handler(mockSock, '.anticall on', ownerMsg, '233531556024@s.whatsapp.net');
        assert.strictEqual(userSettings.anticall, true);
        assert.strictEqual(parentMessages[0].type, 'UPDATE_SETTINGS');
        assert.strictEqual(parentMessages[0].changes.anticall, true);

        // Test .emojis
        await handler(mockSock, '.emojis 🔥 👏 💙', ownerMsg, '233531556024@s.whatsapp.net');
        assert.deepStrictEqual(userSettings.reactEmojis, ['🔥', '👏', '💙']);

        // Test .statusreact emojis
        await handler(mockSock, '.statusreact emojis 🌟 ✨', ownerMsg, '233531556024@s.whatsapp.net');
        assert.deepStrictEqual(userSettings.reactEmojis, ['🌟', '✨']);

        // Test .settings includes anticall and emojis
        replies.length = 0;
        await handler(mockSock, '.settings', ownerMsg, '233531556024@s.whatsapp.net');
        assert.ok(replies.length > 0, 'settings should reply');
        const settingsText = replies[0].content.text;
        assert.ok(settingsText.includes('Anti-call'), 'settings must contain Anti-call');
        assert.ok(settingsText.includes('React emojis'), 'settings must contain React emojis');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
})();
