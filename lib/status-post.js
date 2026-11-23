'use strict';
module.exports = message => !!message &&
    !message.reactionMessage && !message.protocolMessage &&
    ['conversation','extendedTextMessage','imageMessage','videoMessage','audioMessage']
        .some(type => !!message[type]);
