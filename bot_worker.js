/**
 * AutoViewer — Bot Worker
 * Handles individual WhatsApp connections and automation logic.
 */

const P = require('pino');
const fs = require('fs');
const path = require('path');
const { askGroq, clearHistory, transcribeVoice } = require('./lib/groqAI');
// Dot-command engine — ported from the GitHub version (see commands.js header).
const makeHandleOwnerCommand = require('./commands');

const userId = process.argv[2];
if (!userId) process.exit(1);

const SESSION_BASE = process.env.SESSION_DIR || path.join(__dirname, 'session');
const sessionDir = path.join(SESSION_BASE, userId);
if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

const DB_PATH = path.join(SESSION_BASE, 'users.json');

let Baileys;
async function loadBaileys() {
    if (!Baileys) Baileys = await import('@whiskeysockets/baileys');
    return Baileys;
}

// ── Connection Agent ──────────────────────────────────────────────────────
// Force IPv4 — Node.js v22 Happy Eyeballs breaks on some hosts with unreachable IPv6
const https = require('https');
let connectAgent = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000 });

// Proxy Support (overrides IPv4 agent if set)
try {
    const proxyUrl = process.env.SOCKS5_PROXY || process.env.HTTPS_PROXY || process.env.PROXY || process.env.ALL_PROXY || '';
    if (proxyUrl) {
        if (proxyUrl.startsWith('socks')) {
            const { SocksProxyAgent } = require('socks-proxy-agent');
            connectAgent = new SocksProxyAgent(proxyUrl);
        } else {
            const { HttpsProxyAgent } = require('https-proxy-agent');
            connectAgent = new HttpsProxyAgent(proxyUrl);
        }
        console.log(`[Worker:${userId}] Using proxy: ${proxyUrl.replace(/\/\/.*@/, '//***@')}`);
    }
} catch (e) {
    process.stderr.write(`[Worker:${userId}] Proxy setup failed: ${e.message}\n`);
}

// ── Helpers ─────────────────────────────────────────────────────────────────
// Unwrap view-once wrappers so the inner media/text content is reachable
function unwrapContent(msg) {
    let m = msg;
    while (m && (m.viewOnceMessageV2Extension || m.viewOnceMessageV2 || m.viewOnceMessage)) {
        m = (m.viewOnceMessageV2Extension || m.viewOnceMessageV2 || m.viewOnceMessage).message;
    }
    return m;
}

// Resolve a LID (e.g. 123...@lid) to the contact's real phone jid.
// WhatsApp delivers the LID user's real PN alongside the key:
//   - statuses / 1:1 chats: key.remoteJidAlt
//   - groups:              key.participantAlt
// Fall back to Baileys' LID mapping store, then to the raw author jid.
// Results are memoized per-process — statuses arrive in bursts.
// IMPORTANT: only truthy results are cached. The mapping store returns null
// for not-yet-synced LIDs, and those resolve later (alt fields, history sync).
// Caching null would permanently skip the author AND keep the status never-viewed.
const _lidPnCache = new Map();
async function resolveAuthorJid(sock, key) {
    try {
        const { isLidUser, isPnUser, jidNormalizedUser } = await loadBaileys();
        const author = key.participant || key.remoteJid;
        if (!author) return null;
        const alt = key.participantAlt || key.remoteJidAlt;
        if (isLidUser(author)) {
            if (alt && isPnUser(alt)) {
                const norm = jidNormalizedUser(alt);
                _lidPnCache.set(author, norm);
                if (_lidPnCache.size > 500) { const firstKey = _lidPnCache.keys().next().value; _lidPnCache.delete(firstKey); }
                return norm;
            }
            if (_lidPnCache.has(author)) return _lidPnCache.get(author);
            if (sock.signalRepository?.lidMapping?.getPNForLID) {
                const res = await sock.signalRepository.lidMapping.getPNForLID(author);
                if (res) {
                    const norm = jidNormalizedUser(res);
                    _lidPnCache.set(author, norm);
                    if (_lidPnCache.size > 500) { const firstKey = _lidPnCache.keys().next().value; _lidPnCache.delete(firstKey); }
                    return norm;
                }
            }
            return null;
        }
        return jidNormalizedUser(author);
    } catch { return null; }
}

// Fingerprint a message's content — used to dedup status delete alerts.
// WhatsApp re-delivers unviewed statuses with FRESH key ids but the same
// media/text, so one deleted status can otherwise alert N times.
function msgSignature(msg) {
    const c = unwrapContent(msg.message) || {};
    if (c.imageMessage) return 'img:' + (c.imageMessage.mediaKey || c.imageMessage.url || c.imageMessage.fileLength || '');
    if (c.videoMessage) return 'vid:' + (c.videoMessage.mediaKey || c.videoMessage.url || c.videoMessage.fileLength || '');
    if (c.audioMessage) return 'aud:' + (c.audioMessage.mediaKey || c.audioMessage.url || c.audioMessage.fileLength || '');
    if (c.documentMessage) return 'doc:' + (c.documentMessage.mediaKey || c.documentMessage.url || c.documentMessage.fileName || '');
    if (c.stickerMessage) return 'stk:' + (c.stickerMessage.mediaKey || c.stickerMessage.url || '');
    return 'txt:' + (c.conversation || c.extendedTextMessage?.text || c.conversationMessage?.message || '');
}

async function recoverDeletedContent(sock, ownerJid, oldMsg, displayJid, isStatus) {
    const content = unwrapContent(oldMsg.message) || {};
    const who = displayJid ? displayJid.split('@')[0] : 'unknown';
    const mentions = displayJid ? [displayJid] : undefined;
    const mediaType = content.imageMessage ? 'image'
        : content.videoMessage ? 'video'
        : content.audioMessage ? 'audio'
        : content.stickerMessage ? 'sticker'
        : content.documentMessage ? 'document'
        : null;
    if (mediaType) {
        // Media is ENCRYPTED on WhatsApp's servers — fetching the raw url
        // returns ciphertext that WhatsApp rejects as invalid media on
        // re-upload. Must download + decrypt via downloadMediaMessage.
        const dlOpts = { logger: P({ level: 'silent' }) };
        if (sock.updateMediaMessage) dlOpts.reuploadRequest = sock.updateMediaMessage;
        const buffer = await Baileys.downloadMediaMessage(oldMsg, 'buffer', {}, dlOpts);
        if (!buffer || !buffer.length) throw new Error('Media download failed');
        const msg = { [mediaType]: buffer };
        if (mediaType === 'image' || mediaType === 'video') {
            msg.caption = (isStatus ? `📌 *Recovered status* from @${who}` : '') || content.imageMessage?.caption || content.videoMessage?.caption || '';
            if (mentions) msg.mentions = mentions;
        } else if (mediaType === 'document') {
            msg.fileName = content.documentMessage?.fileName || 'recovered';
        }
        return await sock.sendMessage(ownerJid, msg);
    }
    const txt = content.conversation || content.extendedTextMessage?.text || content.conversationMessage?.message || '';
    if (txt) {
        const msg = { text: (isStatus ? `📌 *Recovered status* from @${who}\n\n` : '') + txt };
        if (mentions) msg.mentions = mentions;
        return await sock.sendMessage(ownerJid, msg);
    }
    // Unknown type — fall back to forwarding the raw original
    return await copyNForward(sock, ownerJid, oldMsg);
}
async function copyNForward(sock, jid, message, forceForward = false, options = {}) {
    if (!message || !message.message) throw new Error('copyNForward: no message content');
    const vtype = Object.keys(message.message)[0];
    const isViewOnce = vtype === 'viewOnceMessage' || vtype === 'viewOnceMessageV2';
    const content = isViewOnce ? message.message[vtype].message : message.message;
    
    return await sock.sendMessage(jid, { 
        forward: {
            key: message.key,
            message: content,
            forwardContent: true
        },
        ...options
    });
}

// ── Console Forward ────────────────────────────────────────────────────────
// Benign libsignal noise: "Bad MAC" = a decryption retry that WhatsApp
// automatically re-delivers. It self-heals and just floods the log.
const BENIGN_PATTERNS = [/Session error.*Bad MAC/, /Failed to decrypt/, /Decrypted.*closed session/, /MessageCounterError/, /Closing open session/, /Bad MAC/, /decrypt/];

// JIDs whose stale Signal session was already healed this worker lifetime.
// One heal attempt per JID — a broken session either heals on the first
// forced key exchange or the problem isn't a stale session.
const healedSessions = new Set();
const logFwd = (data) => {
    try {
        const str = String(data);
        if (BENIGN_PATTERNS.some(p => p.test(str))) return;
        process.send({ type: 'LOG', data: str });
    } catch {}
};
console.log = logFwd;
console.warn = logFwd;
console.error = logFwd;

// ── User Settings ───────────────────────────────────────────────────────────
const SETTINGS_KEYS = ['autoreply', 'autostatus', 'statusReact', 'reactEmojis', 'antideleteMsg', 'antideleteStatus', 'antiTagStatus', 'presence', 'mode', 'anticall', 'botName', 'botInstructions', 'antilink', 'groupAdmin', 'allow', 'block', 'persona', 'admins'];
let userSettings = {
    autoreply: false,
    autostatus: true,
    statusReact: true,
    antiTagStatus: false,
    antilink: false,
    groupAdmin: false,
    reactEmojis: '❤️,🖤,💚,🤍,💙,🩷,🩵',
    presence: 'none',
    mode: 'self',       // command access: self (owner/admins) or public
    anticall: false,
    botName: '',
    botInstructions: '',
    // Command-managed settings (dot commands, ported from GitHub version)
    allow: [],      // ChatAI allowlist (numbers). Empty = reply to everyone.
    block: [],      // ChatAI blocklist (numbers). Always wins over allow.
    persona: '',    // owner-defined persona text for ChatAI (max 300 chars)
    admins: []      // trusted numbers that may run bot commands
};

function refreshSettings() {
    try {
        if (fs.existsSync(DB_PATH)) {
            const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
            if (db[userId]) {
                for (const key of SETTINGS_KEYS) {
                    if (key in db[userId]) userSettings[key] = db[userId][key];
                }
                // Backward-compat: legacy single 'antidelete' -> split flags
                if ('antidelete' in db[userId]) {
                    if (!('antideleteMsg' in db[userId])) userSettings.antideleteMsg = db[userId].antidelete;
                    if (!('antideleteStatus' in db[userId])) userSettings.antideleteStatus = db[userId].antidelete;
                }
            }
        }
    } catch (e) {
        console.error(`[Worker:${userId}] Settings Refresh Error:`, e.message);
    }
}

function sendToParent(msg) {
    try { process.send(msg); } catch {}
}

// ── Dot-command engine (ported from GitHub version) ───────────────────────
// proto is destructured inside start(); captured here for the command module.
let _proto = null;
const handleOwnerCommand = makeHandleOwnerCommand({
    userSettings,
    sendToParent,
    loadBaileys,
    clearHistory,
    getCurrentSocket: () => currentSocket,
    getStatusStore: () => _statusMsgStore,
    getProto: () => _proto
});

// ── Presence ────────────────────────────────────────────────────────────────
let presenceTimer = null;       // keepalive for typing/recording + online re-assert
let pokeTimer = null;           // single pending delayed presence poke
let lastChatJid = null;         // most recent 1:1 chat, target for typing/recording
let lastReactAt = 0;            // batch-wide throttle for status reactions

function clearPresence() {
    if (presenceTimer) {
        clearInterval(presenceTimer);
        presenceTimer = null;
    }
    if (pokeTimer) {
        clearTimeout(pokeTimer);
        pokeTimer = null;
    }
}

// Immediate presence push (used when a new chat messages the bot, so typing
// shows up instantly instead of waiting for the next 15s keepalive tick).
function pokePresence(sock) {
    if (!sock) return;
    const mode = userSettings.presence || 'none';
    if (mode === 'typing' || mode === 'recording') {
        const jid = lastChatJid;
        if (!jid) return;
        const action = mode === 'typing' ? 'composing' : 'recording';
        sock.sendPresenceUpdate(action, jid)
            .then(() => console.log(`[Presence] ${action} -> ${jid.split('@')[0]}`))
            .catch(e => console.error('[Presence] Error:', e.message));
    } else if (mode === 'online') {
        sock.sendPresenceUpdate('available')
            .catch(e => console.error('[Presence] Error:', e.message));
    }
}

function applyPresence(sock) {
    clearPresence();
    if (!sock) return;
    const mode = userSettings.presence || 'none';

    if (mode === 'typing' || mode === 'recording') {
        // WhatsApp 'composing'/'recording' are per-chat and require a target jid.
        // Only run once a real 1:1 chat has messaged us (lastChatJid) — the poke
        // on incoming messages handles the first chat. Pushing to our own jid
        // at startup is useless.
        const jid = lastChatJid;
        if (!jid) return;
        const action = mode === 'typing' ? 'composing' : 'recording';
        // Single poke — WhatsApp auto-expires the indicator after ~15s.
        // Deliberately NOT re-asserted: perpetual typing in a chat makes
        // WhatsApp treat it as "active on another device" and mute the
        // owner's phone notifications for that chat.
        sock.sendPresenceUpdate(action, jid)
            .catch(e => console.error('[Presence] Error:', e.message));
    } else {
        const action = mode === 'online' ? 'available' : 'unavailable';
        const push = async () => {
            try { await sock.sendPresenceUpdate(action); } catch (e) { console.error('[Presence] Error:', e.message); }
        };
        push();
        if (mode === 'online') {
            // Re-assert 'available' continuously so no reconnect, race, or
            // server-side expiry can ever leave the account showing as offline.
            presenceTimer = setInterval(push, 25000);
            if (presenceTimer.unref) presenceTimer.unref();
        }
    }
}
process.on('message', (msg) => {
    if (!msg || msg.type !== 'SETTINGS' || !msg.settings || typeof msg.settings !== 'object') return;
    for (const key of SETTINGS_KEYS) {
        if (key in msg.settings && msg.settings[key] !== undefined) userSettings[key] = msg.settings[key];
    }
    if ('presence' in msg.settings && currentSocket) {
        applyPresence(currentSocket);
    }
    sendToParent({ type: 'LOG', data: 'Settings updated' });
});

// Load initial
refreshSettings();

let retryCount = 0;
const MAX_RETRIES = 15;
const BASE_DELAY = 2000;
const QR_RETRY_DELAY = 15000; // 15s between QR retries (no session yet)
const RATE_LIMIT_DELAY = 30000; // 30s base delay for rate-limit (405)
let hasSession = false; // set to true once we've had a successful login

let starting = false;
let startingTimer = null;
let reconnectTimer = null;
let currentSocket = null;

// Hoisted state that survives reconnect cycles
const _msgStore = new Map();       // recent 1:1/group messages for anti-delete
const _statusMsgStore = new Map(); // recent status deliveries for anti-delete
const _revokedIds = new Set();     // already-alerted delete ids (revokes re-deliver)
const _alertedStatus = new Map();  // status content signature -> ts (same status re-delivers with fresh ids)
const STATUS_ALERT_TTL = 60 * 60 * 1000; // dedup window for one status' delete alert
const _reactedStatus = new Map();  // status content signature -> ts (one reaction per unique status)
const STATUS_REACT_TTL = 60 * 60 * 1000; // dedup window for one status reaction
const antilinkWarns = new Map(); // anti-link: "jid:sender" -> strike count (1-2=warned, 3=kick)

async function start() {
    if (starting) return;
    starting = true;
    // Announce life immediately — prevents the manager's startup watchdog
    // from killing a slow-but-healthy worker (overloaded host, session-less
    // account waiting for its first QR, slow WA version fetch, ...)
    sendToParent({ type: 'STATUS', status: 'connecting' });
    clearTimeout(startingTimer);
    startingTimer = setTimeout(() => { starting = false; }, 90000);

    const Baileys = await loadBaileys();
    const { makeWASocket, useMultiFileAuthState, DisconnectReason, Browsers, jidNormalizedUser, isJidNewsletter, isLidUser, proto } = Baileys;
    _proto = proto;

    // Reload settings in case they changed while we were disconnected
    refreshSettings();

    // Fetch latest WA Web version to avoid 405 (client_too_old) rejection
    let waVersion;
    try {
        const result = await Baileys.fetchLatestWaWebVersion();
        waVersion = result.version;
        console.log(`[Worker:${userId}] WA Web version: ${waVersion ? waVersion.join('.') : 'using default'}`);
    } catch (e) {
        console.warn(`[Worker:${userId}] Failed to fetch WA Web version, using default: ${e.message}`);
    }

    // Cancel any pending reconnect
    if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
    }

    // Clean up old socket if hanging
    if (currentSocket) {
        try { currentSocket.ev?.removeAllListeners(); } catch {}
        try { currentSocket.ws?.close(); } catch {}
        currentSocket = null;
    }

    // Prune session bloat — app-state-sync keys + stale pre-keys/sessions accumulate forever
    try {
        const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        const prekeyCutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const files = fs.readdirSync(sessionDir);
        let prekeyCount = 0;
        for (const f of files) if (f.startsWith('pre-key-')) prekeyCount++;
        for (const f of files) {
            const isAppState = f.startsWith('app-state-sync-key-');
            const isPreKey = f.startsWith('pre-key-');
            const isSession = f.startsWith('session-');
            if (!isAppState && !isPreKey && !isSession) continue;
            try {
                const fp = path.join(sessionDir, f);
                const st = fs.statSync(fp);
                if (isAppState && st.mtimeMs < cutoff) fs.rmSync(fp);
                else if ((isPreKey || isSession) && (st.mtimeMs < prekeyCutoff || prekeyCount > 1000)) {
                    // Keep most recent 1000 pre-keys, delete older sparse, but also age-based
                    if (st.mtimeMs < prekeyCutoff || prekeyCount > 2000) {
                        fs.rmSync(fp);
                        if (isPreKey) prekeyCount--;
                    }
                }
            } catch {}
        }
        // LID cache cleanup — prevent unbounded growth (also cleaned on set, but periodic full prune)
        if (_lidPnCache.size > 500) {
            const toDelete = _lidPnCache.size - 500;
            let i=0;
            for (const k of _lidPnCache.keys()) {
                if (i++ >= toDelete) break;
                _lidPnCache.delete(k);
            }
        }
    } catch {}

    const { state, saveCreds } = await useMultiFileAuthState(sessionDir);

    // Detect if we have an existing session (previously logged in)
    hasSession = hasSession || !!state.creds?.me?.id;

    const sockOptions = {
        logger: P({ level: 'silent' }),
        auth: state,
        agent: connectAgent,
        browser: Browsers.ubuntu('Chrome'),
        mobile: false,
        markOnlineOnConnect: userSettings.presence === 'online',
        syncFullHistory: false,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        // Raised from 15000 -> 60000. Baileys closes the socket itself
        // (DisconnectReason.connectionLost / 408) when no WS message is
        // received within keepAliveIntervalMs+5000. A 15s interval makes that
        // threshold only 20s — any brief network stall on the VPS<->WA path trips
        // it and self-closes the connection. 60000 raises the tolerance to 65s
        // (still far below any ~90s NAT idle timeout, and pings remain frequent
        // enough to keep the socket alive), absorbing transient stalls without
        // a full reconnect cycle.
        keepAliveIntervalMs: 60000,
        maxRetries: 5,
        qrTimeout: 120000
    };
    // IMPORTANT: never pass `version: undefined` — makeWASocket merges the
    // config over DEFAULT_CONNECTION_CONFIG, so an explicit undefined wipes
    // the default and crashes registration ("Cannot read properties of
    // undefined (reading 'join')"), killing every session-less account.
    if (Array.isArray(waVersion)) sockOptions.version = waVersion;

    const sock = makeWASocket(sockOptions);

    sock.ev.on('creds.update', () => {
        try { saveCreds(); } catch (e) { console.error('Failed to save creds:', e.message); }
    });

    // ── Connection ──────────────────────────────────────────────────────────
    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
            sendToParent({ type: 'QR', qr });
        } else if (connection === 'connecting') {
            sendToParent({ type: 'STATUS', status: 'connecting' });
        }

        if (connection === 'close') {
            clearTimeout(startingTimer);
            startingTimer = null;
            clearPresence();
            lastChatJid = null; // don't poke a pre-reconnect chat as 'typing'
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = (statusCode !== DisconnectReason.loggedOut);
            
            sendToParent({ type: 'STATUS', status: 'offline' });
            let errData = 'none';
            try { errData = lastDisconnect?.error?.data ? JSON.stringify(lastDisconnect.error.data) : 'none'; } catch {}
            console.log(`Disconnect: ${lastDisconnect?.error?.message || 'unknown'}, code: ${statusCode}, data: ${errData}`);
            
            // Detect rate-limit (405/429) vs other errors
            const isRateLimited = statusCode === 405 || statusCode === 429;
            if (isRateLimited) {
                sendToParent({ type: 'ERROR', code: 405, message: 'WhatsApp rejected the connection. This may be a temporary IP block.' });
            }
            
            currentSocket = null;
            
            if (shouldReconnect && retryCount < MAX_RETRIES) {
                retryCount++;
                let base;
                if (isRateLimited) {
                    base = Math.min(RATE_LIMIT_DELAY * Math.pow(1.5, retryCount - 1), 120000);
                } else if (!hasSession) {
                    // No session yet (QR not scanned) — longer delay between QR retries
                    base = Math.min(QR_RETRY_DELAY * retryCount, 60000);
                } else {
                    // Was connected before — shorter backoff for network issues
                    base = Math.min(BASE_DELAY * Math.pow(2, retryCount - 1), 30000);
                }
                const jitter = 0.75 + Math.random() * 0.5;
                const delay = Math.round(base * jitter);
                console.log(`Connection lost. Reconnecting in ${delay/1000}s (attempt ${retryCount}/${MAX_RETRIES})...`);
                starting = false;
                reconnectTimer = setTimeout(start, delay);
            } else if (shouldReconnect) {
                console.log(`Max retries (${MAX_RETRIES}) reached.${isRateLimited ? ' Rate-limit suspected. Waiting 2min before final retry...' : ' Clearing session for fresh re-link.'}`);
                if (isRateLimited) {
                    if (!global._rateLimitCycles) global._rateLimitCycles = 0;
                    global._rateLimitCycles++;
                    if (global._rateLimitCycles > 3) {
                        console.log('Rate-limited after 3 cycles. Giving up.');
                        sendToParent({ type: 'LOGGED_OUT' });
                        process.exit(1);
                    }
                    retryCount = 0;
                    starting = false;
                    reconnectTimer = setTimeout(start, 120000);
                } else if (!hasSession) {
                    // Only wipe the session when there was never a valid
                    // login — a long outage with a valid session must NOT
                    // force the owner to re-link.
                    try {
                        const files = fs.readdirSync(sessionDir);
                        for (const f of files) {
                            fs.rmSync(path.join(sessionDir, f), { recursive: true, force: true });
                        }
                    } catch (e) {
                        console.error('Failed to clear session:', e.message);
                    }
                    process.exit(1);
                } else {
                    // Transient server/network close with a VALID session
                    // (428 "in favor of incoming prekey bundle" / 408 from a
                    // dropped WA WebSocket). Caused by host/WA, not auth
                    // failure. Do NOT exit: a new process issues a new prekey
                    // bundle that WA 428s the dropped session for, amplifying
                    // the disconnect loop and churning the worker every ~11 min
                    // (each refork ~ MAX_RETRIES*~45s). Back off and keep
                    // reconnecting in-process at a throttled interval instead.
                    console.log(`Max retries reached on transient disconnect (${statusCode}) — backing off 30s and continuing.`);
                    starting = false;
                    reconnectTimer = setTimeout(start, 30000);
                }
            } else {
                console.log('Logged out. Clearing session for fresh re-link.');
                try {
                    const files = fs.readdirSync(sessionDir);
                    for (const f of files) {
                        fs.rmSync(path.join(sessionDir, f), { recursive: true, force: true });
                    }
                } catch (e) {
                    console.error('Failed to clear session:', e.message);
                }
                sendToParent({ type: 'LOGGED_OUT' });
                process.exit(0);
            }
        } else if (connection === 'open') {
            clearTimeout(startingTimer);
            startingTimer = null;
            starting = false;
            retryCount = 0;
            hasSession = true;
            global._rateLimitCycles = 0;
            sendToParent({ type: 'STATUS', status: 'online' });
            // Apply configured presence (none/online/typing/recording)
            applyPresence(sock);
            // Fetch profile picture — use the REAL phone jid, not sock.user.id
            // (which is the LID on these accounts and returns no picture)
            try {
                const selfJid = state.creds?.me?.id ? jidNormalizedUser(state.creds.me.id) : (sock.user?.id ? jidNormalizedUser(sock.user.id) : null);
                if (selfJid) {
                    const ppUrl = await sock.profilePictureUrl(selfJid, 'image');
                    sendToParent({ type: 'PP_URL', url: ppUrl });
                }
            } catch (e) { /* ignore if no PP */ }
        }
    });

    currentSocket = sock;

    // ── Message Handling ────────────────────────────────────────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        try {
        // ── Session heal (MUST run BEFORE the history-sync skip below) ────
        // A restored session can hold a stale Signal session for a contact
        // (their phone advanced the ratchet while the bot was down). Their
        // messages then fail decryption with Bad MAC forever: rc14's
        // auto-session-recreation only recreates when it thinks there is
        // NO session, so a corrupt-but-present session blocks the fix.
        // The CIPHERTEXT stub arrives BOTH as 'notify' (live) AND as
        // 'append' (offline batch right after reconnect — the most common
        // case), and libsignal converts per-session "Bad MAC" errors into
        // `SessionError("No matching sessions found for message")` before
        // the stub is built — so match that string too.
        const healCheck = (m) => {
            const stubParams = m.messageStubParameters || [];
            return m.messageStubType === proto.WebMessageInfo.StubType.CIPHERTEXT
                && stubParams.some(p => /No matching sessions|Bad MAC|SessionError|No session/i.test(p));
        };
        for (const m of messages) {
            if (!healCheck(m)) continue;
            const healJid = jidNormalizedUser(m.key.remoteJid);
            if (healedSessions.has(healJid)) continue;
            healedSessions.add(healJid);
            try {
                const sessionId = sock.signalRepository.jidToSignalProtocolAddress(healJid);
                await state.keys.set({ session: { [sessionId]: null } });
                console.log(`[SessionHeal] Deleted stale Signal session for ${healJid} (Bad MAC).`);
                console.log(`[SessionHeal] Fresh key exchange forced with ${healJid}.`);
            } catch (e) { console.error('[SessionHeal] Failed:', e.message); }
        }
        // History sync normally gets dropped. Baileys delivers messages sent
        // from the linked phone as fresh `append` events, though, including
        // owner dot-commands. Let ONLY fresh fromMe commands through; this
        // prevents stale commands replaying whenever the worker reconnects.
        if (type === 'prepend' || type === 'replace') return;
        if (type === 'append') {
            const nowSec = Math.floor(Date.now() / 1000);
            messages = messages.filter(m => {
                const text = (m.message?.conversation || m.message?.extendedTextMessage?.text || '').trim();
                const ts = typeof m.messageTimestamp?.toNumber === 'function' ? m.messageTimestamp.toNumber() : Number(m.messageTimestamp || 0);
                return m.key?.fromMe === true && text.startsWith('.') && text.length > 1
                    && ts > 0 && Math.abs(nowSec - ts) <= 120;
            });
            if (messages.length === 0) return;
        }
        // Single 3s head start per batch — the first reply waits, the rest
        // of a burst don't stack extra delays
        let delayDone = false;
        for (const m of messages) {
            // One bad message must not abort the whole batch (revokes, statuses
            // and replies in the rest of this batch are all dropped by a throw)
            try {
            if (!m.key || !m.message) continue;
            const jid = m.key.remoteJid;
            if (!jid) continue;
            
            // Skip newsletter/channel messages entirely
            const msgParticipant = m.key.participant;
            if (isJidNewsletter(jid) || (msgParticipant && isJidNewsletter(msgParticipant))) continue;

            // Track the most recent 1:1 chat as a target for typing/recording presence
            if (!jid.endsWith('@g.us') && jid !== 'status@broadcast' && !m.key.fromMe) {
                console.log(`[Msg] from ${(m.key.participant || jid).split('@')[0]}${m.key.fromMe ? ' (fromMe)' : ''}: ${(m.message.conversation || m.message.extendedTextMessage?.text || '').slice(0, 40)}`);
                lastChatJid = jid;
                // Wait 3s before marking the chat active (typing/recording) so the
                // owner's phone has time to show the notification first. Single
                // pending poke — new messages just reschedule it.
                if (pokeTimer) clearTimeout(pokeTimer);
                pokeTimer = setTimeout(() => {
                    pokeTimer = null;
                    if (currentSocket) pokePresence(currentSocket);
                }, 3000);
                if (pokeTimer.unref) pokeTimer.unref();
            }

            // Anti-Delete: Save messages to the store. Statuses go in their
            // OWN store — they flood constantly (WhatsApp re-delivers unviewed
            // statuses with fresh ids) and would otherwise crowd out real chats.
            if (!m.key.fromMe) {
                if (jid === 'status@broadcast') {
                    if (userSettings.antideleteStatus !== false) {
                        _statusMsgStore.set(m.key.id, m);
                        if (_statusMsgStore.size > 200) _statusMsgStore.delete(_statusMsgStore.keys().next().value);
                    }
                } else {
                    if (userSettings.antideleteMsg !== false) {
                        _msgStore.set(m.key.id, m);
                        if (_msgStore.size > 100) _msgStore.delete(_msgStore.keys().next().value);
                    }
                }
            }

            // 1. Anti-Delete (Detect Revoke)
            const msgType = Object.keys(m.message)[0];
            if (!msgType) continue;
            if (msgType === 'protocolMessage' && m.message.protocolMessage?.type === 0) {
                const protoKey = m.message.protocolMessage.key || {};
                const targetId = protoKey.id;
                // Revokes for statuses come with the original status key
                const isStatus = protoKey.remoteJid === 'status@broadcast' || jid === 'status@broadcast';
                const adEnabled = isStatus ? (userSettings.antideleteStatus !== false) : (userSettings.antideleteMsg !== false);
                if (adEnabled && targetId) {
                    // A single delete is re-delivered several times by WhatsApp —
                    // the deleted original also keeps re-delivering and re-fills the
                    // store, so WITHOUT this, one delete spams N alerts.
                    if (!_revokedIds.has(targetId)) {
                        _revokedIds.add(targetId);
                        if (_revokedIds.size > 300) _revokedIds.delete(_revokedIds.values().next().value);
                        const oldMsg = isStatus ? _statusMsgStore.get(targetId) : _msgStore.get(targetId);
                        if (oldMsg && oldMsg.key && oldMsg.message) {
                            // LID authors resolve to their real phone number via
                            // Baileys' LID mapping store (participantPn/senderPn
                            // are NOT populated on regular message keys)
                            const authorJid = await resolveAuthorJid(sock, oldMsg.key);
                            const displayJid = authorJid || oldMsg.key.participant || oldMsg.key.remoteJid || 'sender';
                            if (isStatus) {
                                // Same status is re-delivered with fresh ids then
                                // revoked repeatedly — dedup by author+content
                                const sig = (oldMsg.key.participant || '') + '|' + msgSignature(oldMsg);
                                const last = _alertedStatus.get(sig);
                                if (last && Date.now() - last < STATUS_ALERT_TTL) {
                                    console.log(`[Anti-Delete] Suppressed duplicate status alert (${displayJid.split('@')[0]})`);
                                    _statusMsgStore.delete(targetId);
                                    _msgStore.delete(targetId);
                                    continue;
                                }
                                _alertedStatus.set(sig, Date.now());
                                if (_alertedStatus.size > 300) _alertedStatus.delete(_alertedStatus.keys().next().value);
                            }
                            // Target the owner's REAL phone jid (their "Message
                            // yourself" chat). sock.user.id is the LID on these
                            // accounts — messages sent to the LID are silently
                            // dropped and never appear in the owner's DM.
                            const ownerJid = state.creds?.me?.id ? jidNormalizedUser(state.creds.me.id) : null;
                            if (!ownerJid) continue;
                            
                            console.log(`[Anti-Delete] Detected deleted ${isStatus ? 'status' : 'message'} from ${displayJid}`);
                            // Must not abort the whole batch — a failed alert send only
                            // costs this one alert
                            try {
                                const alert = { 
                                    text: `🛡️ *Anti-Delete Detected*\n\n*From:* @${displayJid.split('@')[0]}${isStatus ? '\n*Type:* Deleted status' : ''}\n*Message:*`,
                                    mentions: [displayJid]
                                };
                                // Don't quote a status@broadcast message in a private chat
                                if (!isStatus) alert.quoted = oldMsg;
                                await sock.sendMessage(ownerJid, alert);
                            } catch (e) {
                                console.error('[Anti-Delete] Alert error:', e?.stack || e);
                            }
                            try {
                                // Statuses can't be forwarded as-is to a 1:1 chat
                                // (their key points at status@broadcast). Text and
                                // media are re-sent directly (media goes through
                                // download+decrypt — raw forwards of encrypted blobs
                                // come out as invalid media, and forwards of deleted
                                // messages are blocked by WhatsApp entirely).
                                await recoverDeletedContent(sock, ownerJid, oldMsg, displayJid, isStatus);
                            } catch (e) {
                                console.error('[Anti-Delete] Forward error:', e?.stack || e);
                            }
                        }
                    }
                }
                if (isStatus) _statusMsgStore.delete(targetId);
                _msgStore.delete(targetId);
                continue;
            }

            // 1b. Anti-Link (3 strikes: warn, final warning, remove)
            if (jid.endsWith('@g.us') && userSettings.antilink && userSettings.groupAdmin && !m.key.fromMe) {
                const txt = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption || m.message.documentMessage?.caption || '';
                const isLink = /(https?:\/\/|www\.|chat\.whatsapp\.com|t\.me|discord\.gg|youtube\.com|youtu\.be|instagram\.com|facebook\.com|tiktok\.com|bit\.ly|tinyurl|wa\.me|\b\w+\.(com|net|org|io|gh|info)\b)/i.test(txt);
                if (isLink) {
                    try {
                        const metaAL = await sock.groupMetadata(jid).catch(()=>null);
                        const senderAL = m.key.participant;
                        const botIds = [sock.user?.id, sock.user?.lid, state.creds?.me?.id].filter(Boolean).map(j=>jidNormalizedUser(j));
                        const isSenderAdminAL = metaAL?.participants.find(p=> jidNormalizedUser(p.id) === jidNormalizedUser(senderAL) || (isLidUser(senderAL) && p.lid && jidNormalizedUser(p.lid)===jidNormalizedUser(senderAL)) )?.admin;
                        const isBotAdminAL = metaAL?.participants.find(p=> botIds.includes(jidNormalizedUser(p.id)) || (p.lid && botIds.includes(jidNormalizedUser(p.lid))) )?.admin;
                        // debug log for dogbyte
                        if (isLink) console.log(`[AntiLink] check jid=${jid} sender=${senderAL} isSenderAdmin=${!!isSenderAdminAL} isBotAdmin=${!!isBotAdminAL} botIds=${botIds.join(',')}`);
                        if (!isSenderAdminAL && isBotAdminAL) {
                            await sock.sendMessage(jid, {delete: m.key});
                            const wKey = `${jid}:${senderAL}`;
                            const wCount = (antilinkWarns.get(wKey) || 0) + 1;
                            antilinkWarns.set(wKey, wCount);
                            setTimeout(()=> antilinkWarns.delete(wKey), 24*60*60*1000).unref?.();
                            // Mention with the sender's REAL phone jid — a LID
                            // mention renders as raw digits, not the contact name
                            const senderPnAL = await resolveAuthorJid(sock, m.key);
                            const mentionAL = senderPnAL || senderAL;
                            if (wCount < 3) {
                                await sock.sendMessage(jid, {text: `@${mentionAL.split('@')[0]} links not allowed`, mentions: [mentionAL]});
                                console.log(`[AntiLink] Warn ${wCount}/3 for ${senderAL.split('@')[0]} in ${jid}`);
                            } else {
                                await sock.groupParticipantsUpdate(jid, [senderAL], 'remove');
                                console.log(`[AntiLink] Removed ${senderAL.split('@')[0]} in ${jid} (3rd link)`);
                                antilinkWarns.delete(wKey);
                            }
                        }
                    } catch(e){ console.error('[AntiLink] error', e.message) }
                }
            }

            // 1c. Group Admin Tools (dot commands, reply/tag/number all work, gated by groupAdmin toggle)
            if (jid.endsWith('@g.us') && userSettings.groupAdmin) {
                const rawTxt = m.message.conversation || m.message.extendedTextMessage?.text || '';
                const txt = rawTxt.trim();
                if (txt.startsWith('.')) {
                    const args = txt.slice(1).split(/\s+/);
                    const cmd = args[0].toLowerCase();
                    const groupCmds = new Set(['promote','demote','kick','remove','add','mute','unmute','invite','tagall','hidetag','antilink']);
                    if (groupCmds.has(cmd)) {
                        const ctx = m.message.extendedTextMessage?.contextInfo || {};
                        const getTarget = () => {
                            if (ctx.participant) return jidNormalizedUser(ctx.participant);
                            if (ctx.mentionedJid?.[0]) return jidNormalizedUser(ctx.mentionedJid[0]);
                            const num = args[1]?.replace(/[^0-9]/g,''); if (num && num.length>=8) return num + '@s.whatsapp.net';
                            return null;
                        };
                        const target = getTarget();
                        try {
                            const metaGA = await sock.groupMetadata(jid).catch(()=>null);
                            if (!metaGA) return;
                            const senderGA = m.key.participant;
                            const botIdsGA = [sock.user?.id, sock.user?.lid, state.creds?.me?.id].filter(Boolean).map(j=>jidNormalizedUser(j));
                            const isSenderAdminGA = metaGA?.participants.find(p=> jidNormalizedUser(p.id) === jidNormalizedUser(senderGA) || (isLidUser(senderGA) && p.lid && jidNormalizedUser(p.lid)===jidNormalizedUser(senderGA)) )?.admin;
                            const isBotAdminGA = metaGA?.participants.find(p=> botIdsGA.includes(jidNormalizedUser(p.id)) || (p.lid && botIdsGA.includes(jidNormalizedUser(p.lid))) )?.admin;
                            // Mention the target's REAL phone jid (prefer the group
                            // roster's pn entry) so @mentions show names, not digits
                            const targetPnGA = target ? ((metaGA.participants.find(p=> jidNormalizedUser(p.id)===target || (p.lid && jidNormalizedUser(p.lid)===target)) || {}).id || target) : target;
                            if (!isSenderAdminGA) { await sock.sendMessage(jid, {text: '❌ Admin only'}); return; }
                            if (!isBotAdminGA) { await sock.sendMessage(jid, {text: '❌ Make me admin first'}); return; }
                            if (cmd==='promote' && target) { await sock.groupParticipantsUpdate(jid, [target], 'promote'); await sock.sendMessage(jid, {text: `✅ Promoted @${targetPnGA.split('@')[0]}`, mentions:[targetPnGA]}); }
                            else if (cmd==='demote' && target) { await sock.groupParticipantsUpdate(jid, [target], 'demote'); await sock.sendMessage(jid, {text: `✅ Demoted @${targetPnGA.split('@')[0]}`, mentions:[targetPnGA]}); }
                            else if ((cmd==='kick'||cmd==='remove') && target) { await sock.groupParticipantsUpdate(jid, [target], 'remove'); await sock.sendMessage(jid, {text: `✅ Removed @${targetPnGA.split('@')[0]}`, mentions:[targetPnGA]}); }
                            else if (cmd==='add' && target) { await sock.groupParticipantsUpdate(jid, [target], 'add'); await sock.sendMessage(jid, {text: `✅ Added @${targetPnGA.split('@')[0]}`, mentions:[targetPnGA]}); }
                            else if (cmd==='mute') { await sock.groupSettingUpdate(jid, 'announcement'); await sock.sendMessage(jid, {text: '🔒 Group muted (announcement)'}); }
                            else if (cmd==='unmute') { await sock.groupSettingUpdate(jid, 'not_announcement'); await sock.sendMessage(jid, {text: '🔓 Group unmuted'}); }
                            else if (cmd==='invite') { const code=await sock.groupInviteCode(jid); await sock.sendMessage(jid, {text: `https://chat.whatsapp.com/${code}`}); }
                            else if (cmd==='tagall') { const txtAll=metaGA.participants.map(p=>'@'+p.id.split('@')[0]).join(' '); await sock.sendMessage(jid, {text: txtAll, mentions: metaGA.participants.map(p=>p.id)}); }
                            else if (cmd==='hidetag' && args.slice(1).join(' ').trim()) { const txtH=args.slice(1).join(' '); await sock.sendMessage(jid, {text: txtH, mentions: metaGA.participants.map(p=>p.id)}); }
                            else if (cmd==='antilink') {
                                const sub=args[1]?.toLowerCase();
                                if (sub==='on') { userSettings.antilink=true; await sock.sendMessage(jid,{text:'🔗 Anti-Link ON'});  }
                                else if (sub==='off') { userSettings.antilink=false; await sock.sendMessage(jid,{text:'🔗 Anti-Link OFF'});  }
                                else await sock.sendMessage(jid,{text:'Usage: .antilink on/off (also dashboard toggle)'});
                            }
                        } catch(e){ console.error('[GroupAdmin] error', e.stack||e); await sock.sendMessage(jid,{text:'❌ Error: '+e.message}).catch(()=>{}) }
                        // do not fallthrough to autoreply for commands
                        continue;
                    }
                }
            }

            // 2. Auto View Status — EVERY delivery is viewed, even duplicates
            //    (WhatsApp re-delivers unviewed statuses with fresh ids)
            //    Never skip the read when the author can't be resolved — skipping
            //    is what makes the status stay unviewed and re-deliver forever
            //    (an unbounded CPU loop on flood days).
            if (jid === 'status@broadcast' && userSettings.autostatus !== false && !m.key.fromMe) {
                const statusId = m.key.id;
                const authorJid = await resolveAuthorJid(sock, m.key);
                // The read receipt participant must be the author's real phone
                // jid (LID accounts deliver statuses with a LID participant —
                // receipts sent with a LID key are dropped and the status keeps
                // re-delivering). Fall back to the original key when unknown.
                const readKey = (m.key.participant && isLidUser(m.key.participant) && authorJid)
                    ? { ...m.key, participant: authorJid }
                    : m.key;
                try { 
                    await sock.readMessages([readKey]);
                    console.log(`[Status] Viewed: ${(authorJid || m.key.participant || 'unknown').split('@')[0]} (${statusId})`);
                } catch (e) {
                    console.error('[Status] View Error:', e?.stack || e);
                }
            }

            // 3. Auto React Status — EVERY delivery gets a reaction, even duplicates
            if (jid === 'status@broadcast' && userSettings.statusReact !== false && !m.key.fromMe) {
                const statusId = m.key.id;
                const reactSig = (m.key.participant || '') + '|' + msgSignature(m);
                if (_reactedStatus.has(reactSig) && Date.now() - _reactedStatus.get(reactSig) < STATUS_REACT_TTL) continue;
                _reactedStatus.set(reactSig, Date.now());
                if (_reactedStatus.size > 300) _reactedStatus.delete(_reactedStatus.keys().next().value);
                const emojis = (userSettings.reactEmojis || '❤️,🖤,💚,🤍,💙,🩷,🩵').split(',').map(e => e.trim()).filter(Boolean);
                const randomEmoji = emojis.length > 0 ? emojis[Math.floor(Math.random() * emojis.length)] : '❤️';
                try { 
                    // WhatsApp requires the status to be registered as viewed first,
                    // otherwise the reaction is silently rejected.
                    try {
                        const authorJid = await resolveAuthorJid(sock, m.key);
                        const readKey = (m.key.participant && isLidUser(m.key.participant) && authorJid)
                            ? { ...m.key, participant: authorJid }
                            : m.key;
                        await sock.readMessages([readKey]);
                    } catch (e) { /* ignore read failures */ }
                    // Throttle bursts: only wait out the 800ms if the previous
                    // react in this batch already did (batch-wide, not per-status)
                    const elapsed = Date.now() - lastReactAt;
                    if (elapsed < 800) await new Promise(r => setTimeout(r, 800 - elapsed));
                    lastReactAt = Date.now();
                    // Reaction key uses the ORIGINAL key participant (may be a LID
                    // jid) — it must match the delivered status key exactly.
                    // statusJidList gets the REAL jid so WhatsApp can attribute it.
                    const statusJid = (await resolveAuthorJid(sock, m.key)) || m.key.participant || 'status@broadcast';
                    await sock.sendMessage("status@broadcast", { 
                        react: { 
                            text: randomEmoji, 
                            key: { 
                                remoteJid: "status@broadcast", 
                                fromMe: false, 
                                id: statusId, 
                                participant: m.key.participant 
                            } 
                        } 
                    }, { 
                        statusJidList: [statusJid] 
                    }); 
                    console.log(`[Status] Reacted with ${randomEmoji} to ${statusJid.split('@')[0]}`);
                } catch (e) {
                    console.error('[Status] React Error:', e?.stack || e);
                }
            }

            // 3b. Anti-Tag Status — detect statuses that tag groups.
            if (jid === 'status@broadcast' && userSettings.antiTagStatus === true && userSettings.groupAdmin !== false) {
                const ctxInfo = m.message.extendedTextMessage?.contextInfo || m.message.imageMessage?.contextInfo || m.message.videoMessage?.contextInfo || {};
                const mentionedJid = ctxInfo.mentionedJid || [];
                const groupMentions = ctxInfo.groupMentions || [];
                const text = m.message.conversation || m.message.extendedTextMessage?.text || m.message.imageMessage?.caption || m.message.videoMessage?.caption || '';
                const hasGroupTag = mentionedJid.some(j => String(j).endsWith('@g.us')) ||
                    groupMentions.some(g => String(g.groupJid || g.jid || '').endsWith('@g.us')) ||
                    /@\s*(all|everyone|group)/i.test(text);
                if (hasGroupTag) {
                    const senderJid = (await resolveAuthorJid(sock, m.key)) || m.key.participant || m.key.remoteJid;
                    try {
                        await sock.sendMessage(jid, { delete: m.key });
                        console.log(`[Anti-Tag] Deleted status with group tag from ${senderJid?.split('@')[0] || 'unknown'}`);
                    } catch (e) { console.error('[Anti-Tag] Delete error:', e.message); }
                    try {
                        if (senderJid) {
                            await sock.sendMessage('status@broadcast', {
                                text: `⚠️ @${senderJid.split('@')[0]} do not tag groups in status`,
                                mentions: [senderJid]
                            });
                        }
                    } catch (e) { console.error('[Anti-Tag] Warn error:', e.message); }
                    continue;
                }
            }

            // 4. Skip Auto-Reply for all status broadcasts
            if (jid === 'status@broadcast') continue;

            // 4.5 Bot commands (prefix ".") — owner (linked phone) or listed
            // admins. Ported from the GitHub version; runs after the group
            // admin block above so group tools keep priority in groups.
            {
                const cmdText = (m.message?.conversation || m.message?.extendedTextMessage?.text || '').trim();
                if (cmdText.startsWith('.') && cmdText.length > 1) {
                    console.log(`[Cmd] ${m.key.fromMe ? 'owner' : 'remote'} ${cmdText.split(/\s+/)[0]} in ${jid}`);
                    await handleOwnerCommand(sock, cmdText, m, jid);
                    continue;
                }
            }

            // 5. Auto-Reply (master switch) — ChatAI toggle gates the AI replies below
            if (!m.key.fromMe && userSettings.autoreply === true) {
                const msgText = m.message.conversation || 
                              m.message.extendedTextMessage?.text || 
                              m.message.imageMessage?.caption || 
                              m.message.videoMessage?.caption || 
                              m.message.documentMessage?.caption || "";

                // Voice notes: no text → transcribe, then let the AI reply.
                // Only real voice notes (ptt), only DMs. Inherits allow/block
                // gates below. Media download retries: WhatsApp frequently
                // serves the media URL before it's usable.
                let voiceText = "";
                if (!msgText.trim() && !jid.endsWith('@g.us') && m.message.audioMessage?.ptt === true && m.message.audioMessage?.url) {
                    try {
                        await sock.sendPresenceUpdate('recording', jid).catch(() => {});
                        const { downloadContentFromMessage } = await loadBaileys();
                        let buf = null;
                        for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
                            try {
                                const stream = await downloadContentFromMessage(m.message.audioMessage, 'audio');
                                const chunks = [];
                                for await (const ch of stream) chunks.push(ch);
                                const b = Buffer.concat(chunks);
                                if (b.length) buf = b;
                            } catch (e) {
                                if (attempt < 3) await new Promise(r => setTimeout(r, attempt * 1500));
                                else console.error('[AutoReply] Voice download failed after 3 attempts:', e.message);
                            }
                        }
                        if (buf) {
                            voiceText = await transcribeVoice(buf, m.message.audioMessage.mimetype || 'audio/ogg');
                            console.log(`[AutoReply] Voice from ${(m.key.participant || jid).split('@')[0]}: "${voiceText.slice(0, 80)}"`);
                        }
                    } catch (e) {
                        console.error('[AutoReply] Voice transcribe error:', e.message);
                    }
                }
                const chatInput = (msgText.trim() || voiceText);

                // Allow/block gates (managed via .allow / .block dot commands).
                // Block always wins; empty allow = reply to everyone.
                const gateNum = (n) => String(n || '').replace(/\D/g, '').replace(/^00233/, '').replace(/^233/, '').replace(/^0/, '');
                const senderNum = String((jid.endsWith('@g.us') || jid === 'status@broadcast') ? (m.key?.participant || '') : (m.key?.remoteJid || jid)).split('@')[0];
                const allowList = Array.isArray(userSettings.allow) ? userSettings.allow : [];
                const blockList = Array.isArray(userSettings.block) ? userSettings.block : [];
                if (blockList.some(n => gateNum(n) && gateNum(n) === gateNum(senderNum))) continue;
                if (allowList.length > 0 && !allowList.some(n => gateNum(n) === gateNum(senderNum))) continue;

                if (chatInput) {
                    const isGroup = jid.endsWith('@g.us');
                    // The bot's identity: real phone jid (sock.user.id is the LID
                    // on these accounts — mentions of the real number would never
                    // match and group auto-reply would stay silent)
                    const botId = jidNormalizedUser(state.creds?.me?.id || sock.user?.id || '');
                    const botNumber = botId.split('@')[0];
                    const botLid = sock.user?.lid ? jidNormalizedUser(sock.user.lid) : null;
                    const mentioned = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
                    const botMentioned = mentioned.some(j => {
                        const n = jidNormalizedUser(j);
                        return n === botId || (botLid && n === botLid) || n.split('@')[0] === botNumber;
                    });
                    const numberInText = botNumber && new RegExp('(?:^|\\s|@)' + botNumber.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?:$|\\s)').test(msgText);
                    const isMentioned = botMentioned || numberInText;

                    // Skip group messages unless bot is mentioned
                    if (isGroup && !isMentioned) continue;

                    // 3s head start so the owner's phone notification can show
                    // before the bot reads the chat and replies
                    if (!delayDone) {
                        await new Promise(r => setTimeout(r, 3000));
                        delayDone = true;
                    }

                    let groqTimeout = null;
                    try {
                        // Presence pokes are cosmetic — a failure here must not
                        // abort the whole AI reply
                        try { await sock.sendPresenceUpdate('composing', jid); } catch (e) {}

                        const reply = await Promise.race([
                            askGroq(jid, chatInput, m.pushName, { botName: (userSettings.botName || '').trim() || sock.user?.name || 'Alex', instructions: userSettings.botInstructions }),
                            new Promise((_, reject) => {
                                groqTimeout = setTimeout(() => reject(new Error('Groq timeout')), 30000);
                            })
                        ]);
                        if (reply) {
                            const replyOpts = { text: reply };
                            if (isGroup) {
                                // @mention with the real number — a LID participant
                                // in the mention list silently fails to tag anyone
                                const senderPn = await resolveAuthorJid(sock, m.key);
                                replyOpts.mentions = [senderPn || m.key.participant || jid];
                            }
                            await sock.sendMessage(jid, replyOpts, { quoted: m });
                            console.log(`[AutoReply] Replied to ${m.pushName || jid} in ${isGroup ? 'Group' : 'Private'}`);
                        }
                    } catch (err) {
                        console.error('[AutoReply] Error:', err.message);
                    } finally {
                        if (groqTimeout) clearTimeout(groqTimeout);
                        try { await sock.sendPresenceUpdate('paused', jid); } catch (e) {}
                    }
                }
            }
            } catch (err) {
                console.error('[Msg] Error:', err.message);
            }
        }
        } catch (err) {
            console.error('[Upsert] Unhandled error:', err.message);
        }
    });

    // ── Anti-Call ──────────────────────────────────────────────────────────
    sock.ev.on('call', async (calls) => {
        if (userSettings.anticall !== true) return;
        for (const call of calls) {
            if (call.status !== 'offer' || call.fromMe || call.offline) continue;
            try {
                await sock.rejectCall(call.id, call.from);
                const caller = call.callerPn || call.callerJid?.split('@')[0] || call.from?.split('@')[0] || 'Unknown';
                console.log(`[AntiCall] Rejected call from ${caller}${call.isGroup ? ' (group)' : ''}`);
            } catch (e) {
                console.error('[AntiCall] Reject error:', e.message);
            }
        }
    });
}

// ── Parent Disconnect ───────────────────────────────────────────────────────
process.on('disconnect', () => {
    // Exit cleanly (code 0) — a parent disconnect is NOT a crash. Exiting non-zero
    // would trip the manager's crash-loop counter and risk a session wipe after
    // rapid pm2 restarts.
    console.error('[Worker] Parent disconnected, exiting.');
    if (currentSocket) {
        try { currentSocket.ws?.close(); } catch {}
    }
    process.exit(0);
});

// ── Global Error Handlers ───────────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
    console.error('[Worker] Unhandled Rejection:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[Worker] Uncaught Exception:', err);
});

// ── Signal Handling ─────────────────────────────────────────────────────────
function shutdownWorker() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    clearPresence();
    if (currentSocket) {
        // Close the connection WITHOUT logging out — the session stays valid
        // so the next start reconnects without needing a new QR scan.
        try { currentSocket.ws?.close(); } catch {}
        try { currentSocket.ev?.removeAllListeners(); } catch {}
    }
    process.exit(0);
}
process.on('SIGTERM', () => {
    console.log('Stopping worker...');
    shutdownWorker();
});
process.on('SIGINT', () => {
    shutdownWorker();
});

start().catch(err => {
    console.error('Worker startup failed:', err.message);
    process.exit(1);
});

