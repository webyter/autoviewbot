'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { once } = require('events');
const backup = require('../lib/backup');
const cleanup = require('../lib/worker-cleanup');
const ROOT = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-project-fixes-'));
const children = [];
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`  ok ${name}`); }
function envFor(dir) {
    return { ...process.env, SESSION_DIR: dir, CONFIG_ENV_FILES: path.join(temp, 'missing.env'), ADMIN_USERNAMES: '', GROQ_API_KEY: '' };
}
function normalEntry(name, source, env) {
    const file = path.join(temp, `${name}.cjs`);
    fs.writeFileSync(file, source);
    const result = spawnSync(process.execPath, [file], { env, encoding: 'utf8' });
    assert.strictEqual(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout.trim().split('\n').at(-1));
}
async function waitExit(child) {
    if (child.exitCode !== null || child.signalCode !== null) return;
    let timer;
    try {
        await Promise.race([once(child, 'exit'), new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Worker did not exit')), 3000);
        })]);
    } finally { clearTimeout(timer); }
}
(async () => {
    await test('settings imports preserve account, billing and prototype fields', () => {
        const row = { isAdmin: false, rentalExpiresAt: 1234, running: false, enabled: false, password: 'HASH', createdAt: 10 };
        const db = { alice: row };
        const payload = JSON.parse('{"rentalExpiresAt":9999999999999,"running":true,"enabled":true,"isAdmin":true,"password":"changed","createdAt":20,"__proto__":{"isAdmin":true},"botName":"Imported","persona":"Allowed instructions","allow":["233"]}');
        const result = backup.importUser(db, 'alice', { settings: payload });
        assert.deepStrictEqual(row, { isAdmin: false, rentalExpiresAt: 1234, running: false, enabled: false, password: 'HASH', createdAt: 10, botName: 'Imported', botInstructions: 'Allowed instructions', allow: ['233'] });
        assert.strictEqual(Object.getPrototypeOf(row), Object.prototype);
        assert.strictEqual(result.applied, 3);
    });
    await test('invalid import types fail before any setting is applied', () => {
        for (const bad of [{ autostatus: 'yes' }, { allow: [123] }, { mode: 'admin' }, { presence: 'invalid' }, { commandPrefix: 'two words' }]) {
            const db = { alice: { botName: 'Original' } };
            assert.throws(() => backup.importUser(db, 'alice', { settings: { botName: 'Changed', ...bad } }), /Invalid setting/);
            assert.deepStrictEqual(db.alice, { botName: 'Original' });
        }
    });
    await test('first-time admin promotion boots and persists with initialized queues', () => {
        const dir = path.join(temp, 'admin'); fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'users.json'), JSON.stringify({ alice: { isAdmin: false } }));
        const result = normalEntry('admin-probe', `const db=require(${JSON.stringify(path.join(ROOT, 'lib/db.js'))});setImmediate(()=>console.log(JSON.stringify(db.loadDB().alice)));`, { ...envFor(dir), ADMIN_USERNAMES: 'alice' });
        assert.strictEqual(result.isAdmin, true);
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'users.json'))).alice.isAdmin, true);
    });
    await test('stored-only Groq keys load in a normal CommonJS process', () => {
        const dir = path.join(temp, 'groq'); fs.mkdirSync(dir);
        fs.writeFileSync(path.join(dir, 'app_settings.json'), JSON.stringify({ groqApiKey: 'gsk_test_placeholder_only' }));
        const result = normalEntry('groq-probe', `console.log(JSON.stringify(require(${JSON.stringify(path.join(ROOT, 'lib/groqAI.js'))}).getGroqStatus()));`, envFor(dir));
        assert.strictEqual(result.configured, true);
    });
    await test('backup and restore preserve all session data from configured symlink paths', () => {
        const app = path.join(temp, 'backup-app'); fs.mkdirSync(app);
        const actual = path.join(app, 'actual-session'); fs.mkdirSync(actual);
        const alias = path.join(app, 'configured-session'); fs.symlinkSync(actual, alias);
        fs.writeFileSync(path.join(app, 'config.js'), "process.env.SESSION_DIR = 'configured-session';");
        const data = {
            'users.json': '{"alice":{}}', 'app_settings.json': '{"groqApiKey":"fixture"}',
            '.session_secret': 'test-secret', 'invites.json': '[]', 'notifications.json': '[]',
            'alice/creds.json': '{}', 'alice/pre-key-1.json': '{"fixture":"pre-key"}',
            'alice/sender-key-1.json': '{"fixture":"sender-key"}',
            'alice/session-1.json': '{}', 'alice/recovery-cache.json': '{}',
            'sessions/test-session.json': '{}'
        };
        for (const [file, value] of Object.entries(data)) {
            fs.mkdirSync(path.dirname(path.join(actual, file)), { recursive: true });
            fs.writeFileSync(path.join(actual, file), value);
        }
        fs.writeFileSync(path.join(actual, 'autoviewer.lock'), '123');
        const dest = path.join(app, 'archives');
        const env = { ...process.env, APP_DIR: app }; delete env.SESSION_DIR;
        const result = spawnSync('bash', [path.join(ROOT, 'scripts/backup.sh'), dest], { env, encoding: 'utf8' });
        assert.strictEqual(result.status, 0, result.stderr);
        const archive = path.join(dest, fs.readdirSync(dest).find(f => f.endsWith('.tar.gz')));
        assert.strictEqual(fs.statSync(archive).mode & 0o777, 0o600);
        const restore = path.join(app, 'restore'); fs.mkdirSync(restore);
        assert.strictEqual(spawnSync('tar', ['-xzf', archive, '-C', restore]).status, 0);
        for (const [file, value] of Object.entries(data)) assert.strictEqual(fs.readFileSync(path.join(restore, 'session', file), 'utf8'), value);
        assert.ok(!fs.existsSync(path.join(restore, 'session/autoviewer.lock')));
        const nested = spawnSync('bash', [path.join(ROOT, 'scripts/backup.sh'), path.join(actual, 'archives')], { env, encoding: 'utf8' });
        assert.notStrictEqual(nested.status, 0);
        assert.match(nested.stderr, /outside the session directory/);
    });
    await test('backup refuses a missing configured session directory', () => {
        const result = spawnSync('bash', [path.join(ROOT, 'scripts/backup.sh'), path.join(temp, 'missing-archives')], { env: { ...envFor(path.join(temp, 'absent')), APP_DIR: temp }, encoding: 'utf8' });
        assert.notStrictEqual(result.status, 0);
        assert.match(result.stderr, /Session directory does not exist/);
    });
    await test('worker cleanup preserves other sessions, accounts and scripts', async () => {
        const script = path.join(temp, 'bot_worker.js');
        const otherScript = path.join(temp, 'other-worker.js');
        const body = "process.stdout.write('ready\\n');setInterval(()=>{},1000);";
        fs.writeFileSync(script, body); fs.writeFileSync(otherScript, body);
        const a = path.join(temp, 'session-a'), b = path.join(temp, 'session-b');
        fs.mkdirSync(a); fs.mkdirSync(b);
        async function launch(file, session, user) {
            const child = spawn(process.execPath, [file, user], { env: envFor(session), stdio: ['ignore', 'pipe', 'pipe'] });
            children.push(child); await once(child.stdout, 'data'); return child;
        }
        const alice = await launch(script, a, 'alice');
        const bob = await launch(script, a, 'bob');
        const isolated = await launch(script, b, 'alice');
        const unrelated = await launch(otherScript, a, 'alice');
        assert.deepStrictEqual(cleanup({ script, sessionBase: a, username: 'alice' }), [alice.pid]);
        await waitExit(alice);
        for (const child of [bob, isolated, unrelated]) assert.doesNotThrow(() => process.kill(child.pid, 0));
        assert.deepStrictEqual(cleanup({ script, sessionBase: a }), [bob.pid]);
        await waitExit(bob);
        for (const child of [isolated, unrelated]) assert.doesNotThrow(() => process.kill(child.pid, 0));
    });
    console.log(`\n${passed} passed, 0 failed`);
})().catch(err => { console.error(err); process.exitCode = 1; }).finally(async () => {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    await Promise.allSettled(children.map(waitExit));
    fs.rmSync(temp, { recursive: true, force: true });
});
