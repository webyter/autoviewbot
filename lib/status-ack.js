'use strict';

// Baileys rc14 does not acknowledge top-level status notifications (#2858).
// Encrypted contact statuses also need to enter the normal status pipeline;
// acknowledging them alone discards their content.
module.exports = function installStatusAck(sock, log = () => {}, processStatus) {
    if (typeof sock.ws.listenerCount === 'function' && sock.ws.listenerCount('CB:status')) return;
    sock.ws.on('CB:status', async node => {
        try {
            if (processStatus && Array.isArray(node.content) &&
                node.content.some(c => c.tag === 'enc' || c.tag === 'plaintext')) {
                await processStatus(node);
            }
        } catch (err) {
            log('[Status] Transport content processing failed:', err.message);
        }
        try {
            await sock.sendMessageAck(node);
            log('[Status] Transport notification acknowledged:', {
                id: node.attrs?.id, type: node.attrs?.type,
                children: Array.isArray(node.content) ? node.content.map(c => c.tag) : []
            });
        } catch (err) {
            log('[Status] Transport acknowledgement failed:', err.message);
        }
    });
};
