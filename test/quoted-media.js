'use strict';
const assert = require('assert');
const { EventEmitter } = require('events');
const resolve = require('../lib/quoted-media');
(async()=>{
    const key={id:'original',remoteJid:'200@lid',fromMe:false};
    const stub={key,message:{imageMessage:{viewOnce:true}}};
    const original={key,message:{imageMessage:{mediaKey:Buffer.alloc(32),directPath:'/original'}}};
    const ev=new EventEmitter();let requests=0;
    const sock={ev,requestPlaceholderResend:async(k,m)=>{
        requests++;assert.strictEqual(k,key);assert.strictEqual(m,stub);
        ev.emit('messages.upsert',{messages:[{...original,key:{...key,id:'unrelated'}}]});
        ev.emit('messages.upsert',{messages:[original]});
    }};
    assert.strictEqual(await resolve(sock,original),original);
    assert.strictEqual(requests,0);
    const text={key,message:{conversation:'hello'}};
    assert.strictEqual(await resolve(sock,text),text);
    assert.strictEqual(await resolve(sock,stub),original);
    assert.strictEqual(requests,1);
    assert.strictEqual(ev.listenerCount('messages.upsert'),0);
    sock.requestPlaceholderResend=async()=>{};
    await assert.rejects(resolve(sock,stub,10),/encryption key/);
    assert.strictEqual(ev.listenerCount('messages.upsert'),0);
    sock.requestPlaceholderResend=async()=>{throw new Error('disconnected');};
    await assert.rejects(resolve(sock,stub),/disconnected/);
    assert.strictEqual(ev.listenerCount('messages.upsert'),0);
    sock.requestPlaceholderResend=async(k)=>{
        assert.strictEqual(k.participant,undefined);
        ev.emit('messages.upsert',{messages:[original]});
    };
    assert.strictEqual(await resolve(sock,{...stub,key:{...key,participant:'200@lid'}}),original);
    let count=0;
    sock.signalRepository={lidMapping:{getPNForLID:async()=> '15550000002@s.whatsapp.net'}};
    sock.requestPlaceholderResend=async(k)=>{
        count++;
        if(k.remoteJid.endsWith('@s.whatsapp.net'))ev.emit('messages.upsert',{messages:[original]});
    };
    assert.strictEqual(await resolve(sock,stub,10),original);
    assert.strictEqual(count,2);
    assert.strictEqual(ev.listenerCount('messages.upsert'),0);
    console.log('Quoted original media retrieval: 14 passed');
})().catch(e=>{console.error(e);process.exitCode=1;});
