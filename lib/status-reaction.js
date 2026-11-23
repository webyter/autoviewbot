'use strict';

module.exports = async function sendStatusReaction(sock, baileys, key, text, timeoutMs = 20000) {
    if (!key?.id || !key.participant || key.fromMe) throw new Error('A contact status key is required');
    const participant = baileys.jidNormalizedUser(key.participant);
    const id = baileys.generateMessageIDV2(sock.user?.id);
    let listener, timer;
    const acknowledgement = new Promise((resolve, reject) => {
        listener = node => {
            if (node.attrs?.id !== id) return;
            if (node.attrs.error) reject(new Error(`Status reaction rejected by WhatsApp (${node.attrs.error})`));
            else resolve(id);
        };
        sock.ws.on('CB:ack,class:message', listener);
        timer = setTimeout(() => reject(new Error('Status reaction acknowledgement timed out')), timeoutMs);
    });
    try {
        await Promise.all([
            sock.sendMessage('status@broadcast', {
                react: { text, key: {remoteJid:'status@broadcast',fromMe:false,id:key.id,participant} }
            }, { messageId:id, statusJidList:[participant] }),
            acknowledgement
        ]);
        return id;
    } finally {
        clearTimeout(timer);
        sock.ws.off('CB:ack,class:message', listener);
    }
};
