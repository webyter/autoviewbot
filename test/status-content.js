'use strict';
const assert = require('assert');
const create = require('../lib/status-content');
(async () => {
    const b = await import('@whiskeysockets/baileys');
    const emitted = [], retries = [], groups = [];
    const payload = b.proto.Message.encode({ conversation: 'contact status' }).finish();
    const sock = {
        authState:{creds:{me:{id:'100@s.whatsapp.net',lid:'101@lid'}}},
        messageMutex:{mutex:fn=>fn()},
        signalRepository:{
            lidMapping:{getLIDForPN:async()=>null},
            decryptGroupMessage:async args=>{
                groups.push(args);
                return Buffer.concat([payload,Buffer.from([1])]);
            }
        },
        upsertMessage:async(msg,type)=>emitted.push({msg,type}),
        sendRetryRequest:async (node,forceKeys)=>retries.push({node,forceKeys})
    };
    const logger={warn(){},error(){},debug(){},info(){}};
    const process = create(sock,b,logger);
    const node={tag:'status',attrs:{from:'200@s.whatsapp.net',id:'plain',type:'text',t:String(Math.floor(Date.now()/1000)),offline:'0'},content:[{tag:'plaintext',attrs:{},content:payload}]};
    await process(node);
    assert.strictEqual(emitted[0].msg.message.conversation,'contact status');
    assert.strictEqual(emitted[0].msg.key.remoteJid,'status@broadcast');
    assert.strictEqual(emitted[0].msg.key.participant,'200@s.whatsapp.net');
    assert.strictEqual(emitted[0].type,'notify');
    assert.strictEqual(node.attrs.from,'200@s.whatsapp.net','original acknowledgement address must survive');
    await process({...node,attrs:{...node.attrs,id:'encrypted',offline:'true'},content:[{tag:'enc',attrs:{type:'skmsg'},content:Buffer.from('ciphertext')}]});
    assert.strictEqual(groups[0].group,'status@broadcast');
    assert.strictEqual(groups[0].authorJid,'200@s.whatsapp.net');
    assert.strictEqual(emitted[1].msg.message.conversation,'contact status');
    assert.strictEqual(emitted[1].type,'append');
    sock.signalRepository.decryptGroupMessage=async()=>{throw new Error('No session found');};
    await process({...node,content:[{tag:'enc',attrs:{type:'skmsg'},content:Buffer.from('ciphertext')}]});
    assert.strictEqual(retries.length,1);
    assert.strictEqual(retries[0].node.attrs.from,'200@s.whatsapp.net');
    assert.strictEqual(retries[0].forceKeys,true);
    const n=emitted.length;
    await process({...node,attrs:{...node.attrs,from:'200@g.us'}});
    assert.strictEqual(emitted.length,n,'group stories must not be treated as contact stories');
    console.log('Status content pipeline: 13 passed');
})().catch(err=>{console.error(err);process.exitCode=1;});
