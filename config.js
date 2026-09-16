const fs = require('fs');
const path = require('path');
const envPath = path.join(__dirname, 'config.env');
if (fs.existsSync(envPath)) {
    try { require('dotenv').config({ path: envPath }); }
    catch (e) { console.warn('[config] dotenv failed:', e.message); }
}

module.exports = {
    BOT_NAME:      process.env.BOT_NAME      || 'Alex',
    OWNER_NAME:    process.env.OWNER_NAME    || 'Owner',
    GROQ_API_KEY:  process.env.GROQ_API_KEY  || '',
};
