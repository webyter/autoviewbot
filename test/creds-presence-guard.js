'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { EventEmitter } = require('events');
const guard = require('../lib/creds-presence-guard');

// Run the installed library's real credential listener: a generic mock
// emitter alone would miss the unintended bare presence announcement.
const source = fs.readFileSync(require.resolve('@whiskeysockets/baileys').replace(/index\.js$/, 'Socket/socket.js'), 'utf8');
const start = source.indexOf("    ev.on('creds.update', update => {");
const end = source.indexOf('    const updateServerTimeOffset', start);
assert.ok(start >= 0 && end > start);
const listener = source.slice(start, end);
function fixture(withGuard) {
    const ev = new EventEmitter();
    const creds = { me: { id: '100@s.whatsapp.net', name: 'Test User', lid: '101@lid' } };
    const announcements = [];
    vm.runInNewContext(listener, {
        ev, creds, logger: { debug() {}, warn() {} },
        sendNode: async node => announcements.push(node)
    });
    if (withGuard) guard({ ev }, { creds });
    return { ev, creds, announcements };
}
const broken = fixture(false);
broken.ev.emit('creds.update', { nextPreKeyId: 42 });
assert.strictEqual(broken.announcements.length, 1, 'reproduce the rc14 presence bug');
const f = fixture(true);
const patch = { nextPreKeyId: 42 };
f.ev.emit('creds.update', patch);
assert.strictEqual(f.announcements.length, 0);
assert.deepStrictEqual(patch, { nextPreKeyId: 42 }, 'do not mutate caller data');
assert.strictEqual(f.creds.nextPreKeyId, 42);
f.ev.emit('creds.update', { me: { lid: '102@lid' } });
assert.strictEqual(f.announcements.length, 0);
assert.strictEqual(f.creds.me.name, 'Test User');
assert.strictEqual(f.creds.me.id, '100@s.whatsapp.net');
assert.strictEqual(f.creds.me.lid, '102@lid');
f.ev.emit('creds.update', { me: { name: 'New Name' } });
assert.strictEqual(f.announcements.length, 1, 'real push name changes remain supported');
assert.strictEqual(f.creds.me.name, 'New Name');
let other;
f.ev.on('other', value => { other = value; });
f.ev.emit('other', patch);
assert.strictEqual(other, patch);
console.log('Credential presence guard: 11 passed');
