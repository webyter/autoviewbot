'use strict';
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const safe = require('../lib/notification-presence');
const source = fs.readFileSync(require.resolve('../bot_worker'), 'utf8');
const functions = source.slice(source.indexOf('function clearPresence()'), source.indexOf('async function triggerPairingCode('));
const sent = [], timers = new Map();
let timerId = 0;
const context = vm.createContext({
    userSettings: { presence: 'auto' }, lastChatJid: '200@s.whatsapp.net',
    presenceTimer: null, pokeTimer: null,
    console: { log() {}, error() {} },
    setInterval: fn => { const id = ++timerId; timers.set(id, fn); return id; },
    clearInterval: id => timers.delete(id), clearTimeout() {}
});
vm.runInContext(functions, context);
const sock = {
    user: { name: 'Test' }, authState: { creds: { me: {} } },
    sendPresenceUpdate: async (...args) => sent.push(args)
};
let passed = 0;
function test(name, fn) { fn(); passed++; console.log(`  ok ${name}`); }
test('auto, none, off and unset modes preserve phone notifications', () => {
    for (const mode of ['auto', 'none', 'off', undefined]) {
        context.userSettings.presence = mode;
        context.applyPresence(sock);
        assert.strictEqual(sent.at(-1)[0], 'unavailable');
        assert.strictEqual(timers.size, 1);
        [...timers.values()][0]();
        assert.strictEqual(sent.at(-1)[0], 'unavailable');
    }
});
test('online to auto cancels the online heartbeat and sends unavailable', () => {
    context.userSettings.presence = 'online'; context.applyPresence(sock);
    assert.strictEqual(sent.at(-1)[0], 'available');
    context.userSettings.presence = 'auto'; context.applyPresence(sock);
    assert.strictEqual(timers.size, 1);
    sent.length = 0; [...timers.values()][0]();
    assert.deepStrictEqual(sent, [['unavailable']]);
});
test('incoming chats do not trigger typing or online presence in auto mode', () => {
    sent.length = 0; context.pokePresence(sock);
    assert.strictEqual(sent.length, 0);
});
test('explicit typing and recording modes still work when selected', () => {
    for (const mode of ['typing', 'recording']) {
        context.userSettings.presence = mode; context.applyPresence(sock);
        assert.deepStrictEqual(sent.at(-1), [mode === 'typing' ? 'composing' : 'recording', '200@s.whatsapp.net']);
        assert.strictEqual(timers.size, 0);
    }
});
test('automatic AI presence is suppressed in notification-safe modes', () => {
    for (const mode of ['auto', 'none', 'off', undefined]) assert.strictEqual(safe(mode), true);
    for (const mode of ['online', 'available', 'typing', 'recording']) assert.strictEqual(safe(mode), false);
});
test('closing the connection clears the unavailable heartbeat', () => {
    context.userSettings.presence = 'auto'; context.applyPresence(sock);
    context.clearPresence(); assert.strictEqual(timers.size, 0);
});
console.log(`\n${passed} passed, 0 failed`);
