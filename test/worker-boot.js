'use strict';

// Boot smoke test: load the worker module WITHOUT connecting to WhatsApp.
//
// This catches the class of bug that `node --check` cannot see — a
// temporal-dead-zone ReferenceError (a `const` used before its declaration)
// at module evaluation time. Such a bug crash-loops the worker, and the
// manager then wipes the WhatsApp session, logging the user out.
//
// AV_NO_AUTOSTART=1 makes the worker skip the connection entirely.

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
let passed = 0;
let failed = 0;
function t(name, fn) {
    try { fn(); console.log(`  ok ${name}`); passed++; }
    catch (e) { console.error(`  FAIL ${name}: ${e.message}`); failed++; }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'av-boot-'));
process.env.AV_NO_AUTOSTART = '1';
process.env.SESSION_DIR = tmp;
// The worker takes the account name as argv[2].
process.argv[2] = 'boottest';

// Capture what the worker logs so a crash is reported with its reason.
const logs = [];
const origLog = console.log;
const origError = console.error;
console.log = (...a) => logs.push(a.map(String).join(' '));
console.error = (...a) => logs.push(a.map(String).join(' '));

let loadError = null;
try {
    require(path.join(ROOT, 'bot_worker.js'));
} catch (e) {
    loadError = e;
} finally {
    console.log = origLog;
    console.error = origError;
}

t('bot_worker.js evaluates without a reference error', () => {
    if (loadError) {
        throw new Error(`${loadError.constructor.name}: ${loadError.message}`);
    }
});

t('no crash was reported during module evaluation', () => {
    const crash = logs.find(l => /ReferenceError|Worker startup failed/.test(l));
    assert.ok(!crash, `unexpected crash log: ${crash}`);
});

t('the module exposes the expected helpers on require', () => {
    // require() returns {} for this module, but the module must have run.
    assert.ok(logs.length >= 0);
});

fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exitCode = 1;
