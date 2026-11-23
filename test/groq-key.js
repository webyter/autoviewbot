'use strict';

// Tests for the Groq key resolution rule:
//
//   "No key is shipped with the code — the operator must supply one."
//
// The key may come from the environment or from an env file; without it the
// AI features stay OFF (and say so) instead of silently using a public
// key that anyone could abuse.
//
// The real key is never printed — only whether a key resolved.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const config = require('../config');

let passed = 0;
let failed = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; }
}

// Resolve the key in a child process with a controlled environment so the
// machine's real .env cannot influence the result.
function resolveInChild({ env = {}, envFileContent = null } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-groq-'));
    let configEnvFiles = path.join(dir, 'none.env');
    if (envFileContent !== null) {
        const f = path.join(dir, 'app.env');
        fs.writeFileSync(f, envFileContent);
        configEnvFiles = f;
    }
    const script = `
        const config = require(${JSON.stringify(path.join(ROOT, 'config.js'))});
        const groq = require(${JSON.stringify(path.join(ROOT, 'lib', 'groqAI.js'))});
        console.log(JSON.stringify({
            key: config.GROQ_API_KEY,
            configured: groq.getGroqStatus().configured,
            hasDefault: Object.prototype.hasOwnProperty.call(config, 'DEFAULT_GROQ_API_KEY')
        }));
    `;
    const res = spawnSync(process.execPath, ['-e', script], {
        env: { PATH: process.env.PATH, NODE_ENV: 'test', CONFIG_ENV_FILES: configEnvFiles, ...env },
        encoding: 'utf8'
    });
    fs.rmSync(dir, { recursive: true, force: true });
    if (res.status !== 0) throw new Error((res.stderr || '').split('\n').slice(0, 3).join(' '));
    const line = (res.stdout || '').trim().split('\n').filter(l => l.startsWith('{')).pop();
    if (!line) throw new Error('no output from child: ' + res.stdout + res.stderr);
    return JSON.parse(line);
}

console.log('\nGroq key resolution (operator-supplied only)');

t('no key is shipped with the code', () => {
    assert.ok(!('DEFAULT_GROQ_API_KEY' in config), 'config must not export a default key');
    const src = fs.readFileSync(path.join(ROOT, 'config.js'), 'utf8');
    assert.ok(!/gsk_[A-Za-z0-9_-]{20,}/.test(src), 'config.js must not contain a key literal');
});

t('without a key the AI is NOT configured (features stay off)', () => {
    const r = resolveInChild();
    assert.strictEqual(r.key, '', 'no key must resolve');
    assert.strictEqual(r.configured, false, 'the AI must report as unconfigured');
});

t('an empty key in the env file is treated as unset', () => {
    const r = resolveInChild({ envFileContent: 'GROQ_API_KEY=\n' });
    assert.strictEqual(r.key, '');
    assert.strictEqual(r.configured, false);
});

t('a whitespace key is treated as unset', () => {
    const r = resolveInChild({ envFileContent: 'GROQ_API_KEY="   "\n' });
    assert.strictEqual(r.key, '');
    assert.strictEqual(r.configured, false);
});

t('a key in the environment IS used', () => {
    const r = resolveInChild({ env: { GROQ_API_KEY: 'operator-supplied-key-value' } });
    assert.strictEqual(r.key, 'operator-supplied-key-value');
    assert.strictEqual(r.configured, true);
});

t('a key in the env file IS used', () => {
    const r = resolveInChild({ envFileContent: 'GROQ_API_KEY=env-file-key-value\n' });
    assert.strictEqual(r.key, 'env-file-key-value');
    assert.strictEqual(r.configured, true);
});

t('the environment wins over the env file', () => {
    const r = resolveInChild({
        env: { GROQ_API_KEY: 'environment-key-value' },
        envFileContent: 'GROQ_API_KEY=env-file-key-value\n'
    });
    assert.strictEqual(r.key, 'environment-key-value');
});

t('the ChatAI path degrades gracefully with no key', async () => {
    // askGroq must not throw or hang when the key is missing — it returns a
    // friendly message instead.
    const { askGroq } = require('../lib/groqAI.js');
    const saved = process.env.GROQ_API_KEY;
    delete process.env.GROQ_API_KEY;
    try {
        const reply = await askGroq('1@s.whatsapp.net', 'hi', 'Tester', {});
        assert.ok(typeof reply === 'string' && reply.length > 0, 'must return a message');
    } finally {
        if (saved !== undefined) process.env.GROQ_API_KEY = saved;
    }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
