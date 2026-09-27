// Test persist.js: pack/encrypt/decrypt/unpack roundtrip + stub-server restore.
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

process.env.SESSION_SECRET = 'test-secret-123';
process.env.BACKUP_SUPABASE_URL = 'http://127.0.0.1:4599';
process.env.BACKUP_SUPABASE_KEY = 'svc-key';
process.env.BACKUP_BUCKET = 'test-bucket';

const persist = require('../lib/persist.js');
assert.strictEqual(persist.enabled, true, 'should be enabled with env set');

const SECRET = 'test-secret-123';

// 1. Pure roundtrip
const tmp = fs.mkdtempSync('/tmp/avb-src-');
fs.mkdirSync(path.join(tmp, 'alice'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'users.json'), JSON.stringify({ alice: { running: true } }));
fs.writeFileSync(path.join(tmp, 'alice', 'creds.json'), '{"me":{"id":"123"}}');
fs.mkdirSync(path.join(tmp, 'alice', 'app-state'), { recursive: true });
fs.writeFileSync(path.join(tmp, 'alice', 'app-state', 'x.json'), '{"k":1}');

const packed = persist.packSnapshot(tmp);
const enc = persist.encryptBuffer(packed, SECRET);
assert.ok(enc.subarray(0, 4).toString() === 'AVB1');
const dec = persist.decryptBuffer(enc, SECRET);
assert.deepStrictEqual(dec, packed, 'decrypt(encrypt(x)) === x');

// Tamper check — GCM must reject modified ciphertext
const tampered = Buffer.from(enc);
tampered[tampered.length - 1] ^= 0xff;
assert.throws(() => persist.decryptBuffer(tampered, SECRET), 'tampered blob must fail');

// 2. Restore into an "empty" dir via stub Supabase
let storedBlob = enc;
let seenAuth = null;
const server = http.createServer((req, res) => {
    seenAuth = req.headers.authorization;
    if (req.method === 'GET') {
        if (seenAuth !== 'Bearer svc-key') { res.writeHead(401); return res.end(); }
        if (!storedBlob) { res.writeHead(404); return res.end('{"error":"not found"}'); }
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
        return res.end(storedBlob);
    }
    if (req.method === 'POST') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => {
            storedBlob = Buffer.concat(chunks);
            try {
                const peek = JSON.parse(persist.decryptBuffer(storedBlob, 'test-secret-123').toString());
                console.log('STUB POST users.json =', peek.files.find((f) => f.p === 'users.json'));
            } catch (e) { console.log('STUB POST (undecryptable):', e.message); }
            res.writeHead(200); res.end('{"Key":"ok"}');
        });
        return;
    }
    res.writeHead(404); res.end();
});

server.listen(4599, '127.0.0.1', async () => {
    try {
        const dest = fs.mkdtempSync('/tmp/avb-dst-');
        const dbPath = path.join(dest, 'users.json');
        const restored = await persist.restoreIfEmpty(dest, dbPath);
        assert.strictEqual(restored, true, 'should restore into empty dir');
        assert.strictEqual(fs.readFileSync(dbPath, 'utf8'), JSON.stringify({ alice: { running: true } }));
        assert.strictEqual(fs.readFileSync(path.join(dest, 'alice', 'creds.json'), 'utf8'), '{"me":{"id":"123"}}');
        assert.strictEqual(fs.readFileSync(path.join(dest, 'alice', 'app-state', 'x.json'), 'utf8'), '{"k":1}');

        // 3. Re-restore must skip when data exists
        const again = await persist.restoreIfEmpty(dest, dbPath);
        assert.strictEqual(again, false, 'must not clobber existing data');

        // 4. saveNow re-uploads
        const prevBlob = storedBlob;
        fs.writeFileSync(path.join(dest, 'users.json'), '{"alice":{"running":false}}');
        const saved = await persist.saveNow(dest);
        assert.ok(saved, 'saveNow should upload');
        // Wait until the stub has actually swapped the stored blob (bun's axios
        // can resolve a tick before the server-side handler assignment lands).
        for (let i = 0; i < 50 && storedBlob === prevBlob; i++) {
            await new Promise((r) => setTimeout(r, 20));
        }
        assert.notStrictEqual(storedBlob, prevBlob, 'stub should have received the new upload');
        const dec2 = JSON.parse(persist.decryptBuffer(storedBlob, SECRET).toString());
        const usersEntry = dec2.files.find((f) => f.p === 'users.json');
        assert.ok(usersEntry && Buffer.from(usersEntry.b, 'base64').toString() === '{"alice":{"running":false}}',
            're-uploaded snapshot reflects the change');

        // 5. 404 (first boot, no backup) → clean false, no throw
        const emptyDest = fs.mkdtempSync('/tmp/avb-empty-');
        storedBlob = null;
        const noBackup = await persist.restoreIfEmpty(emptyDest, path.join(emptyDest, 'users.json'));
        assert.strictEqual(noBackup, false, 'missing backup returns false cleanly');

        // 6. Path traversal rejected
        const evil = Buffer.from(JSON.stringify({ v: 1, files: [{ p: '../evil.txt', b: Buffer.from('x').toString('base64') }] }));
        assert.throws(() => persist.unpackSnapshot(evil, dest), 'traversal must throw');

        console.log('ALL PERSIST TESTS PASSED');
        server.close();
        process.exit(0);
    } catch (e) {
        console.error('TEST FAILED:', e);
        server.close();
        process.exit(1);
    }
});
