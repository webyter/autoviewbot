'use strict';
const { extractMedia } = require('./media');

function hasMediaKey(message) {
    const media = extractMedia(message?.message).media;
    const key = typeof media?.mediaKey === 'string' ? Buffer.from(media.mediaKey, 'base64') : media?.mediaKey;
    return (Buffer.isBuffer(key) || key instanceof Uint8Array) && key.length === 32;
}

// A quoted view-once stub may omit the encryption key. Ask our primary
// phone for the original through Baileys' supported placeholder resend API.
async function requestOriginal(sock, source, timeoutMs) {
    if (!extractMedia(source?.message).media || hasMediaKey(source)) return source;
    const unavailable = () => Object.assign(new Error('WhatsApp did not supply the media encryption key. The primary phone did not return a recoverable original; this quoted view-once message cannot be downloaded.'), { code: 'MEDIA_KEY_UNAVAILABLE' });
    if (!source.key?.id || !sock.ev?.on || !sock.ev?.off || typeof sock.requestPlaceholderResend !== 'function') throw unavailable();
    let listener, timer;
    try {
        return await new Promise((resolve, reject) => {
            listener = ({ messages = [] }) => {
                const original = messages.find(m => m.key?.id === source.key.id && hasMediaKey(m));
                if (original) resolve(original);
            };
            sock.ev.on('messages.upsert', listener);
            timer = setTimeout(() => reject(unavailable()), timeoutMs);
            Promise.resolve().then(() => sock.requestPlaceholderResend(source.key, source))
                .catch(reject);
        });
    } finally {
        clearTimeout(timer);
        sock.ev.off('messages.upsert', listener);
    }
}

module.exports = async function resolveQuotedMedia(sock, source, timeoutMs = 15000) {
    if (!extractMedia(source?.message).media || hasMediaKey(source)) return source;
    const chat = source.key?.remoteJid || '';
    // Participant belongs to group/broadcast message keys, not private chat
    // keys. Quoting a message includes its author even in a private chat.
    if (source.key?.participant && /@(lid|s\.whatsapp\.net)$/.test(chat)) {
        const key = { ...source.key };
        delete key.participant;
        source = { ...source, key };
    }
    try {
        return await requestOriginal(sock, source, timeoutMs);
    } catch (err) {
        if (err.code !== 'MEDIA_KEY_UNAVAILABLE' || !chat.endsWith('@lid')) throw err;
        const lookup = sock.signalRepository?.lidMapping?.getPNForLID;
        if (!lookup) throw err;
        const pn = await lookup.call(sock.signalRepository.lidMapping, chat);
        if (!pn || !pn.endsWith('@s.whatsapp.net')) throw err;
        return requestOriginal(sock, { ...source, key: { ...source.key, remoteJid: pn } }, timeoutMs);
    }
};
