'use strict';

// Shared message forward helper (audit L15).
// Previously duplicated in bot_worker.js and commands.js, and both copies
// passed `forwardContent: true` — not a real Baileys field, silently dropped.
// Baileys rc14 reads `forward` + `force`:
//   sendMessage(jid, { forward, force }) -> generateForwardMessageContent(message.forward, message.force)
// `forward` must be { key, message } (it reads message.message and
// message.key.fromMe); content is normalizeMessageContent()-ed internally, so
// view-once/ephemeral envelopes do not need manual unwrapping here.
module.exports = async function copyNForward(sock, jid, message, forceForward = false, options = {}) {
    if (!message || !message.message) throw new Error('copyNForward: no message content');
    return await sock.sendMessage(jid, {
        forward: { key: message.key, message: message.message },
        force: !!forceForward,
        ...options
    });
};
