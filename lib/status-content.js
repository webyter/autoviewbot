'use strict';

module.exports = function createStatusProcessor(sock, baileys, logger, log = () => {}) {
    return async node => {
        const from = node.attrs?.from || '';
        // Group stories have their own content and moderation semantics.
        if (from.endsWith('@g.us') || from.endsWith('@newsletter')) return;
        const participant = node.attrs.participant || (from !== 'status@broadcast' ? from : null);
        if (!participant) throw new Error('Status has no author');
        const envelope = {
            ...node, tag: 'message',
            attrs: { ...node.attrs, from: 'status@broadcast', participant }
        };
        await sock.messageMutex.mutex(async () => {
            const me = sock.authState.creds.me;
            const { fullMessage, decrypt } = baileys.decryptMessageNode(
                envelope, me.id, me.lid || '', sock.signalRepository, logger
            );
            await decrypt();
            // Always route contact stories as statuses, never as inbound DMs.
            fullMessage.key.remoteJid = 'status@broadcast';
            fullMessage.key.participant = participant;
            baileys.cleanMessage(fullMessage, me.id, me.lid || '');
            if (!fullMessage.message) {
                logger.warn({ id: fullMessage.key.id, reason: fullMessage.messageStubParameters }, 'status content unavailable');
                // Retry receipts must go back to the original transport
                // sender. Include our keys immediately so a primary device
                // can recreate a missing Signal session on its first retry.
                await sock.sendRetryRequest(node, true);
            }
            const offline = node.attrs.offline;
            await sock.upsertMessage(fullMessage, offline && offline !== '0' && offline !== 'false' ? 'append' : 'notify');
            log('[Status] Transport content processed:', {
                id: fullMessage.key.id, chat: fullMessage.key.remoteJid,
                types: Object.keys(fullMessage.message || {})
            });
        });
    };
};
