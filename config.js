const fs = require('fs');
const path = require('path');

// Which env files to load, in order. The defaults keep the historical
// behaviour (config.env first, then .env). CONFIG_ENV_FILES lets a deployment
// point at a specific file (Docker secrets, Render, tests) without changing
// the code:
//   CONFIG_ENV_FILES=/run/secrets/app.env
const envFiles = (process.env.CONFIG_ENV_FILES || 'config.env,.env')
    .split(',')
    .map(f => f.trim())
    .filter(Boolean);

for (const file of envFiles) {
    const envPath = path.isAbsolute(file) ? file : path.join(__dirname, file);
    if (!fs.existsSync(envPath)) continue;
    try { require('dotenv').config({ path: envPath, quiet: true }); }
    catch (e) { console.warn('[config] dotenv failed:', e.message); }
}

// The Groq key is NOT shipped with the code — it must be supplied by the
// operator (environment or .env). ChatAI and voice-note transcription stay
// disabled until a key is configured, and the dashboard says so.
//
// On Render: set GROQ_API_KEY in the service environment (the blueprint
// already declares it as a `sync: false` value).
module.exports = {
    BOT_NAME:      process.env.BOT_NAME      || 'Alex',
    OWNER_NAME:    process.env.OWNER_NAME    || 'Owner',
    GROQ_API_KEY:  (process.env.GROQ_API_KEY || '').trim(),
};
