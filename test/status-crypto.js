'use strict';
const assert = require('assert');
const create = require('../lib/status-content');
(async () => {
    const b = await import('@whiskeysockets/baileys');
    const { makeLibSignalRepository } = await import('../node_modules/@whiskeysockets/baileys/lib/Signal/libsignal.js');
    const logger = { trace(){},debug(){},info(){},warn(){},error(){} };
    const auth = () => {
        const data = {};
        return { creds:b.initAuthCreds(), keys:{
            get:async(type,ids)=>Object.fromEntries(ids.map(id=>[id,data[type]?.[id]])),
            set:async patch=>{for(const [type,entries] of Object.entries(patch))Object.assign(data[type] ||= {}, entries);},
            transaction:async fn=>fn()
        } };
    };
    const sender = makeLibSignalRepository(auth(),logger);
    const recipient = makeLibSignalRepository(auth(),logger);
    const emitted=[];
    const sock={
        authState:{creds:{me:{id:'100@s.whatsapp.net',lid:'101@lid'}}},
        signalRepository:recipient,messageMutex:{mutex:fn=>fn()},
        upsertMessage:async(msg,type)=>emitted.push({msg,type}),
        sendRetryRequest:async()=>{throw new Error('Unexpected retry for valid ciphertext');}
    };
    const processStatus=create(sock,b,logger);
    // Exercise the actual Signal group cipher, independently for the primary
    // device and a linked device, using fresh test keys rather than live auth.
    for(const author of ['200@s.whatsapp.net','200:4@s.whatsapp.net','201@lid']) {
        const message=b.proto.Message.encode({conversation:`status from ${author}`}).finish();
        const {ciphertext,senderKeyDistributionMessage}=await sender.encryptGroupMessage({
            group:'status@broadcast',meId:author,data:Buffer.concat([message,Buffer.from([1])])
        });
        await recipient.processSenderKeyDistributionMessage({authorJid:author,item:{groupId:'status@broadcast',axolotlSenderKeyDistributionMessage:senderKeyDistributionMessage}});
        await processStatus({tag:'status',attrs:{from:author,id:author,t:String(Math.floor(Date.now()/1000)),type:'text'},content:[{tag:'enc',attrs:{type:'skmsg'},content:ciphertext}]});
        const result=emitted.at(-1);
        assert.strictEqual(result.msg.message?.conversation,`status from ${author}`);
        assert.strictEqual(result.msg.key.remoteJid,'status@broadcast');
        assert.strictEqual(result.type,'notify');
    }
    console.log('Real Signal status decryption: 9 passed');
})().catch(err=>{console.error(err);process.exitCode=1;});
