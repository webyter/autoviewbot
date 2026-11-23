'use strict';
const assert = require('assert');
const fs = require('fs');
const { Readable } = require('stream');
const { needsReupload, downloadMediaToFile, downloadMediaWithReupload } = require('../lib/media');
(async () => {
    const b = await import('@whiskeysockets/baileys');
    const error = Object.assign(new Error('No valid media URL or directPath present in message'), {status:400});
    assert.strictEqual(needsReupload(error, {mediaKey:Buffer.alloc(32)}), true);
    assert.strictEqual(needsReupload(error, {mediaKey:Buffer.alloc(32).toString('base64')}), true);
    assert.strictEqual(needsReupload(error, {}), false);
    assert.strictEqual(needsReupload(error, {mediaKey:Buffer.alloc(4)}), false);
    assert.strictEqual(needsReupload(Object.assign(new Error('Other bad request'),{status:400}),{mediaKey:Buffer.alloc(32)}), false);
    for (const download of [downloadMediaToFile, downloadMediaWithReupload]) {
        let attempts=0, retries=0;
        const media={mediaKey:Buffer.alloc(32).toString('base64')};
        const sock={updateMediaMessage:async message=>{
            retries++;
            assert.strictEqual(message.key.id,'original');
            assert.ok(Buffer.isBuffer(message.message.imageMessage.mediaKey));
            message.message.imageMessage.directPath='/refreshed';
        }};
        const baileys={downloadContentFromMessage:async (m,type,opts)=>{
            attempts++;
            // Exercise the real library's metadata validation without making
            // a network request. The retry then supplies a usable location.
            if(!m.directPath) return b.downloadContentFromMessage(m,type,opts);
            assert.strictEqual(m.directPath,'/refreshed');
            return Readable.from([Buffer.from('recovered-media')]);
        }};
        const result=await download(sock,baileys,{key:{id:'original',remoteJid:'200@lid',fromMe:false},media,protoKey:'imageMessage'});
        assert.strictEqual(attempts,2);
        assert.strictEqual(retries,1);
        if(Buffer.isBuffer(result))assert.strictEqual(result.toString(),'recovered-media');
        else {assert.strictEqual(fs.readFileSync(result.path,'utf8'),'recovered-media');result.cleanup();assert.ok(!fs.existsSync(result.path));}
    }
    console.log('Missing media metadata recovery: 7 passed');
})().catch(err=>{console.error(err);process.exitCode=1;});
