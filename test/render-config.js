'use strict';

// Tests for lib/render-config.js — the Render blueprint generator.
//
// The blueprint is what Render reads at deploy time, so a malformed value
// (an unquoted version, a phone number turned into an int, a missing health
// path) breaks the deployment. These tests pin the shape of the output and
// guarantee that secrets are never written into git.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { renderBlueprint, writeRenderConfig, readExisting, readEnvFile, yamlString } = require('../lib/render-config');

let passed = 0;
let failed = 0;
async function t(name, fn) {
    try { await fn(); console.log(`  ok ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; }
}

(async () => {
    console.log('\nrender blueprint generator (lib/render-config)');

    await t('renders the fields Render needs', () => {
        const y = renderBlueprint({});
        for (const needle of ['type: web', 'runtime: node', 'plan: free', 'healthCheckPath: /health',
            'startCommand: node autoviewer.js', 'autoDeploy: true']) {
            assert.ok(y.includes(needle), `missing: ${needle}`);
        }
    });

    await t('never writes secrets into the blueprint', () => {
        const y = renderBlueprint({ env: { GROQ_API_KEY: 'gsk_supersecret', SESSION_SECRET: 'topsecret', INVITE_CODE: 'INV-SECRET' } });
        assert.ok(!y.includes('gsk_supersecret'), 'the Groq key must not be written');
        assert.ok(!y.includes('topsecret'), 'the session secret must not be written');
        assert.ok(!y.includes('INV-SECRET'), 'invite codes must not be written');
        assert.ok(y.includes('key: GROQ_API_KEY'));
        assert.ok(y.includes('sync: false'), 'secrets must be placeholders');
    });

    await t('quotes values YAML would misread', () => {
        assert.strictEqual(yamlString('20.18.0'), '"20.18.0"');
        assert.strictEqual(yamlString('233531556024'), '"233531556024"');
        assert.strictEqual(yamlString('true'), '"true"');
        assert.strictEqual(yamlString('free'), 'free');
        assert.strictEqual(yamlString('has: colon'), '"has: colon"');
    });

    await t('keeps the public URL when it is known', () => {
        const y = renderBlueprint({ overrides: { publicUrl: 'https://bot.onrender.com' } });
        assert.ok(y.includes('https://bot.onrender.com'));
        assert.ok(/key: PUBLIC_URL\s*\n\s*value:/.test(y), 'PUBLIC_URL must be a value');
    });

    await t('falls back to a placeholder without a public URL', () => {
        const y = renderBlueprint({});
        assert.ok(/key: PUBLIC_URL\s*\n\s*sync: false/.test(y));
    });

    await t('preserves hand-made choices when regenerating', () => {
        const existing = { name: 'my-bot', plan: 'starter', region: 'frankfurt', adminContact: '233000111' };
        const y = renderBlueprint({ existing });
        assert.ok(y.includes('name: my-bot'));
        assert.ok(y.includes('plan: starter'));
        assert.ok(y.includes('region: frankfurt'));
        assert.ok(y.includes('233000111'));
    });

    await t('reads values out of an existing blueprint', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-render-'));
        const file = path.join(dir, 'render.yaml');
        fs.writeFileSync(file, [
            'services:',
            '  - type: web',
            '    name: kept-name',
            '    plan: starter',
            '    region: oregon',
            '    healthCheckPath: /healthz',
            '    envVars:',
            '      - key: NODE_VERSION',
            '        value: 22.0.0',
            '      - key: ADMIN_CONTACT',
            '        value: "233111222"'
        ].join('\n'));
        const ex = readExisting(file);
        assert.strictEqual(ex.name, 'kept-name');
        assert.strictEqual(ex.plan, 'starter');
        assert.strictEqual(ex.healthCheckPath, '/healthz');
        assert.strictEqual(ex.nodeVersion, '22.0.0');
        assert.strictEqual(ex.adminContact, '233111222');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await t('reads values out of an env file', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-render-'));
        const file = path.join(dir, '.env');
        fs.writeFileSync(file, 'ADMIN_CONTACT="233999888"\nPORT=3000\n# comment\nGROQ_API_KEY=secret\n');
        const env = readEnvFile(file);
        assert.strictEqual(env.ADMIN_CONTACT, '233999888');
        assert.strictEqual(env.PORT, '3000');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await t('writes the file and reports whether it changed', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'av-render-'));
        const file = path.join(dir, 'render.yaml');
        const r1 = writeRenderConfig({ file, envFile: path.join(dir, '.env'), overrides: { publicUrl: 'https://x.onrender.com' } });
        assert.strictEqual(r1.changed, true, 'first write must report a change');
        assert.ok(fs.existsSync(file));
        const r2 = writeRenderConfig({ file, envFile: path.join(dir, '.env'), overrides: { publicUrl: 'https://x.onrender.com' } });
        assert.strictEqual(r2.changed, false, 'an identical rewrite must report no change');
        fs.rmSync(dir, { recursive: true, force: true });
    });

    await t('the shipped render.yaml is in sync with the generator', () => {
        const file = path.join(__dirname, '..', 'render.yaml');
        const res = writeRenderConfig({ file, envFile: path.join(__dirname, '..', '.env'), write: false });
        assert.strictEqual(res.changed, false, 'run `npm run render:init` and commit render.yaml');
    });

    console.log(`\n${passed} passed, ${failed} failed`);
    if (failed) process.exitCode = 1;
})();
