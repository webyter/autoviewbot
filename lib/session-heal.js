'use strict';

// Group/broadcast ciphertext is encrypted by the participant's device.
// Preserve its device suffix; normalising the JID would select device 0.
module.exports = function sessionHealJid(key) {
    if (!key) return null;
    const chat = key.remoteJid || '';
    const author = chat.endsWith('@g.us') || chat.endsWith('@broadcast')
        ? key.participant : chat;
    return typeof author === 'string' && /@(s\.whatsapp\.net|lid)$/.test(author)
        ? author : null;
};
