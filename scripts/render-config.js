#!/usr/bin/env node
'use strict';

// Generate render.yaml (the Render blueprint) for this deployment.
//
//   npm run render:init
//   node scripts/render-config.js --plan starter --name my-bot --public-url https://my-bot.onrender.com
//
// Values that already exist in render.yaml (name, plan, region, admin
// contact) are preserved; secrets are NEVER written — the Groq key, session
// secret and invite codes are emitted as `sync: false` placeholders.

const path = require('path');
const { writeRenderConfig } = require('../lib/render-config');

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        const next = argv[i + 1];
        if (!next || next.startsWith('--')) {
            out[key] = 'true';
        } else {
            out[key] = next;
            i++;
        }
    }
    return out;
}

const args = parseArgs(process.argv.slice(2));
const overrides = {};
if (args.name) overrides.name = args.name;
if (args.plan) overrides.plan = args.plan;
if (args.region) overrides.region = args.region;
if (args['public-url']) overrides.publicUrl = args['public-url'];
if (args['admin-contact']) overrides.adminContact = args['admin-contact'];
if (args['node-version']) overrides.nodeVersion = args['node-version'];
if (args['keepalive-interval-min']) overrides.keepAliveIntervalMin = args['keepalive-interval-min'];

const result = writeRenderConfig({
    appDir: path.join(__dirname, '..'),
    overrides
});

console.log(`Render blueprint ${result.changed ? 'updated' : 'already up to date'}: ${result.path}`);
console.log('');
console.log('Next steps:');
console.log('  1. git add render.yaml && git commit -m "chore: update render blueprint"');
console.log('  2. Render dashboard -> New -> Blueprint -> select this repo');
console.log('  3. Set the secret values it asks for (GROQ_API_KEY, ADMIN_USERNAMES, INVITE_CODE)');
console.log('  4. GitHub -> Settings -> Secrets -> Actions -> SELF_URL = https://<service>.onrender.com');
console.log('     (that is the external pinger that can WAKE the service after a spin-down)');
console.log('  5. Render Free has an ephemeral filesystem: attach a disk and set SESSION_DIR,');
console.log('     or run the bot on a VPS (deploy/autoviewer.service)');
