'use strict';

// lib/backup.js — settings import.
//
// Settings EXPORT was removed (the dashboard no longer produces a backup
// file). This module keeps the import path so a settings file that was
// exported earlier can still be restored.
//
// An import must never be able to set secrets: the password hash, the
// session secret and the Groq key are always skipped.
// Credentials live in the live DB and in the WhatsApp session files.

const SECRET_FIELDS = new Set([
    'password', 'groqKey', 'sessionSecret'
]);

const IMPORT_VERSION = 1;
const BOOLEAN_SETTINGS = new Set([
    'autoreply', 'autostatus', 'statusReact', 'antideleteMsg', 'antideleteStatus',
    'antiTagStatus', 'antivv', 'anticall', 'antilink', 'groupAdmin', 'groupChatAI', 'voiceNotes'
]);
const LIST_SETTINGS = new Set(['allow', 'block', 'admins']);
const ALIASES = { chatai: 'autoreply', antidelete: 'antideleteMsg', persona: 'botInstructions', prefix: 'commandPrefix', groupai: 'groupChatAI' };

function validateSetting(key, value) {
    if (BOOLEAN_SETTINGS.has(key)) return typeof value === 'boolean';
    if (LIST_SETTINGS.has(key)) return Array.isArray(value) && value.length <= 500 &&
        value.every(item => typeof item === 'string' && /^\+?\d{1,32}$/.test(item));
    if (key === 'botName') return typeof value === 'string' && value.length <= 64;
    if (key === 'botInstructions') return typeof value === 'string' && value.length <= 3000;
    if (key === 'commandPrefix') return typeof value === 'string' && /^\S{1,3}$/.test(value);
    if (key === 'presence') return ['auto', 'none', 'off', 'online', 'available', 'typing', 'recording'].includes(value);
    if (key === 'mode') return ['public', 'self'].includes(value);
    if (key === 'reactEmojis') return typeof value === 'string' ? value.length <= 256 :
        Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === 'string' && item.length <= 32);
    return null; // Account, billing, lifecycle and secret fields are never imported.
}

// Import one user's settings onto an existing user (keys present in the
// payload overwrite; the rest are left alone). Never touches secrets.
function importUser(db, username, payload) {
    const row = db?.[username];
    if (!row) throw new Error('Unknown user');
    const incoming = payload?.settings || payload;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) throw new Error('Nothing to import');
    let applied = 0;
    const changes = {};
    for (const [inputKey, value] of Object.entries(incoming)) {
        const key = Object.prototype.hasOwnProperty.call(ALIASES, inputKey) ? ALIASES[inputKey] : inputKey;
        const valid = validateSetting(key, value);
        if (valid === null) continue;
        if (!valid) throw new Error(`Invalid setting: ${inputKey}`);
        changes[key] = Array.isArray(value) ? [...value] : value;
        applied++;
    }
    Object.assign(row, changes);
    return { applied, username };
}

module.exports = { SECRET_FIELDS, IMPORT_VERSION, importUser };
