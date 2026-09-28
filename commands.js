// commands.js — dot-command engine, ported verbatim from the GitHub version's
// bot_worker.js so the two stay in sync. Commands: .menu .ping .alive
// .settings .chatai .persona .allow .block .admin .autostatus .statusreact
// .antidelete .antideletestatus .antilink .groupadmin .save .vv .clear
// (.kick/.promote/.demote/.mute/.unmute/.tagall stay with the VPS worker's
// own group-admin block — this module skips them via the dispatch order.)
//
// Adapter: the original closes over worker module state; here it's injected.
// GitHub settings keys are translated to the VPS schema via a Proxy
// (chatai→autoreply, antidelete→antideleteMsg).

module.exports = function makeHandleOwnerCommand(deps) {
    const { sendToParent, loadBaileys, getCurrentSocket, getProto, getStatusStore, clearHistory, historyKey } = deps;

    // Adapt the VPS worker's native status cache (id -> Baileys message) to
    // the GitHub command engine's shape (id -> { message, participant, ts }).
    const wrapStatus = (m) => m ? {
        message: m,
        participant: m.key?.participant || m.participant || '',
        ts: (typeof m.messageTimestamp?.toNumber === 'function' ? m.messageTimestamp.toNumber() : Number(m.messageTimestamp || 0)) * 1000 || Date.now()
    } : null;
    const _statusStore = {
        get size() { return getStatusStore().size; },
        has(id) { return getStatusStore().has(id); },
        get(id) { return wrapStatus(getStatusStore().get(id)); },
        *values() { for (const m of getStatusStore().values()) yield wrapStatus(m); }
    };
    const _seenStatusIds = { get size() { return getStatusStore().size; } };

    // Unwrap ephemeral/view-once envelopes for .vv without depending on
    // private worker globals.
    const unwrapMessage = (msg) => {
        let cur = msg;
        for (let i = 0; cur && i < 6; i++) {
            if (cur.ephemeralMessage?.message) cur = cur.ephemeralMessage.message;
            else if (cur.viewOnceMessage?.message) cur = cur.viewOnceMessage.message;
            else if (cur.viewOnceMessageV2?.message) cur = cur.viewOnceMessageV2.message;
            else if (cur.viewOnceMessageV2Extension?.message) cur = cur.viewOnceMessageV2Extension.message;
            else if (cur.documentWithCaptionMessage?.message) cur = cur.documentWithCaptionMessage.message;
            else if (cur.editedMessage?.message) cur = cur.editedMessage.message;
            else if (cur.groupMentionedMessage?.message) cur = cur.groupMentionedMessage.message;
            else break;
        }
        return cur || msg;
    };

    const KEYMAP = {
        chatai: 'autoreply',
        antidelete: 'antideleteMsg',
        persona: 'botInstructions'
    };
    const userSettings = new Proxy(deps.userSettings, {
        get(t, k) { return (typeof k === 'string') ? t[KEYMAP[k] || k] : t[k]; },
        set(t, k, v) { t[KEYMAP[k] || k] = v; return true; }
    });

    const currentSocket = new Proxy({}, {
        get(_, k) { const s = deps.getCurrentSocket(); return s ? s[k] : undefined; }
    });
    const proto = new Proxy({}, {
        get(_, k) { const p = deps.getProto(); return p ? p[k] : undefined; }
    });

const normNum = (n) => {
    let d = String(n || '').replace(/\D/g, '');
    if (d.startsWith('00233')) d = d.slice(2);
    if (d.startsWith('233')) d = d.slice(3);
    else if (d.startsWith('0')) d = d.slice(1);
    return d;
};
const digitsOf = (s) => String(s || '').replace(/\D/g, '');
const numMatch = (a, b) => {
    const x = normNum(a), y = normNum(b);
    if (!x || !y) return false;
    if (x === y) return true;
    return (x.length >= 6 && y.length >= 6) && (x.endsWith(y) || y.endsWith(x));
};

// Sender's bare number: group participant for groups, chat jid for DMs.
// LID-aware: on LID accounts the raw jid's digits are NOT the phone number,
// so allow/block/admin lists (which hold phone numbers) never match. Resolve
// via the alt fields WhatsApp ships alongside the key, then the LID mapping
// store; fall back to the raw jid.
async function senderNumber(m, jid) {
    const src = (jid.endsWith('@g.us') || jid === 'status@broadcast')
        ? (m.key?.participant || m.participant || '')
        : (m.key?.remoteJid || jid);
    if (!src) return '';
    try {
        const { isLidUser, isPnUser, jidNormalizedUser } = await loadBaileys();
        if (isLidUser(src)) {
            const alt = m.key?.participantAlt || m.key?.remoteJidAlt;
            if (alt && isPnUser(alt)) return jidNormalizedUser(alt).split('@')[0];
            const sock = getCurrentSocket();
            const res = sock?.signalRepository?.lidMapping?.getPNForLID
                ? await sock.signalRepository.lidMapping.getPNForLID(src).catch(() => null)
                : null;
            if (res) return jidNormalizedUser(res).split('@')[0];
        }
        return jidNormalizedUser(src).split('@')[0];
    } catch {
        return String(src).split('@')[0];
    }
}

// Group admin checks (sender + bot itself).
async function isGroupAdmin(sock, jid, num) {
    try {
        const meta = await sock.groupMetadata(jid);
        const p = (meta?.participants || []).find(pt => numMatch(pt.id, num));
        return !!(p && (p.admin === 'admin' || p.admin === 'superadmin' || p.isSuperAdmin));
    } catch { return false; }
}
async function botIsGroupAdmin(sock, jid) {
    try {
        const meta = await sock.groupMetadata(jid);
        // The bot's own jid is often a LID — match both the PN id and the
        // roster's lid entry before concluding it's not an admin.
        const myIds = [sock.user?.id, sock.user?.lid].filter(Boolean);
        const isAdmin = (meta?.participants || []).some(pt =>
            [pt.id, pt.lid].filter(Boolean).some(jid2 =>
                myIds.some(mine => mine && numMatch(jid2, mine))
            ) && (pt.admin === 'admin' || pt.admin === 'superadmin' || pt.isSuperAdmin)
        );
        return !!isAdmin;
    } catch { return false; }
}

// Shared forward helper (lib/forward.js) — Baileys rc14 reads `forward`
// and `force`; `forwardContent` was never a real field.
const copyNForward = deps.copyNForward;

// ── User Settings ───────────────────────────────────────────────────────────
// NOTE: groqKey is intentionally NOT here. The Groq key is fixed in code
const DIV = '─────────────────────';

// Unicode letterforms — WhatsApp has no font choice, so titles use
// Mathematical Sans-Serif Bold glyphs (render as a distinct font on Android).
const fb = (s) => String(s).replace(/[A-Za-z0-9]/g, (c) => {
    const o = c.codePointAt(0);
    if (c >= 'A' && c <= 'Z') return String.fromCodePoint(0x1D5D4 + o - 65);
    if (c >= 'a' && c <= 'z') return String.fromCodePoint(0x1D5EE + o - 97);
    if (c >= '0' && c <= '9') return String.fromCodePoint(0x1D7EC + o - 48);
    return c;
});
const FOOT = ' _AutoViewer_';
const fmtMs = (ms) => ms == null ? '`—`' : '`' + ms + ' ms`';
const onOff = (v) => v ? 'ON ✅' : 'OFF ❌';

const MENU_TEXT =
`*🤖 ${fb('AUTOVIEWER')}* — commands
${DIV}
⚙️ *${fb('General')}
⠿ \`.ping\` — speed check
⠿ \`.alive\` — full status
⠿ \`.settings\` — show settings
⠿ \`.clear\` — reset ChatAI memory here

💬 *${fb('ChatAI')}*
⠿ \`.chatai on/off\` — auto-reply to DMs
⠿ \`.autoreply on/off\` — alias for chatai
⠿ \`.persona <text>\` — set personality
⠿ \`.persona clear\` — reset personality
⠿ \`.allow add/del/list <number>\`
⠿ \`.block add/del/list <number>\`
_Send a voice note and I listen + reply._
_Allow = who gets replies (empty = all). Block = never reply, always wins._

👑 *${fb('Access')}*
⠿ \`.mode public/self\` — who can run commands
_Mode + admin list always stay locked to your phone._

👁️ *${fb('Automation')}
⠿ \`.autostatus on/off\`
⠿ \`.statusreact on/off\`
⠿ \`.antidelete on/off\` — messages
⠿ \`.antideletestatus on/off\` — statuses
⠿ \`.antitagstatus on/off\` — group tags in status
⠿ \`.antitag on/off\` — alias

🔱 *${fb('Admin & Moderation')}
⠿ \`.groupadmin on/off\` — toggle group mod
⠿ \`.antilink on/off\` — delete ALL links
⠿ \`.admin add/del/list <number>\`
⠿ \`.kick/.promote/.demote @user\`
⠿ \`.mute/.unmute\` · \`.tagall\`
_Listed admins run commands. Group
actions need my admin rights._

📥 *${fb('Status')}*
⠿ \`.save\` — save a status
⠿ \`.vv\` — reveal view-once media
_Status: reply to it, or send alone for the latest. View-once: reply to the message — groups see it in the group, DMs come to you._
${DIV}${FOOT}`;
async function handleOwnerCommand(sock, body, m, jid) {
    // Baileys helpers are NOT in scope at module level (they're destructured
    // inside start()). Pull them fresh so cases like .save / .vv don't crash
    // with "jidNormalizedUser is not defined" — which the upsert catch swallows
    // and the command silently does nothing.
    const { jidNormalizedUser } = await loadBaileys();
    const reply = async (text) => {
        try { await sock.sendMessage(jid, { text }, { quoted: m }); }
        catch (e) { console.error('[Cmd] reply error:', e.message); }
    };
    const parts = body.slice(1).trim().split(/\s+/).filter(Boolean);
    const cmd = (parts.shift() || '').toLowerCase();
    const apply = (changes, okMsg) => {
        for (const [k, v] of Object.entries(changes)) userSettings[k] = v;
        sendToParent({ type: 'UPDATE_SETTINGS', changes });
        reply(okMsg);
    };
    // Real round-trip latency: protocol ping on the live socket, 3s cap.
    const socketLatency = async () => {
        const ws = currentSocket?.ws;
        if (!ws?.ping) {
            console.log(`[Ping] latency unavailable: ws=${!!ws} ping=${typeof ws?.ping}`);
            return null;
        }
        return new Promise((resolve) => {
            const start = Date.now();
            const t = setTimeout(() => {
                console.error(`[Ping] ws pong timed out after 3s (readyState=${ws.readyState})`);
                resolve(null);
            }, 3000);
            try {
                ws.ping((err) => {
                    clearTimeout(t);
                    if (err) { console.error('[Ping] ws ping error:', err.message); return resolve(null); }
                    resolve(Date.now() - start);
                });
            } catch (e) { clearTimeout(t); console.error('[Ping] ws ping threw:', e.message); resolve(null); }
        });
    };

    // ── Authorization ─────────────────────────────────────────────────────
    const isOwner = !!m.key.fromMe;
    const isGroup = jid.endsWith('@g.us');
    const senderNum = await senderNumber(m, jid);
    const adminList = Array.isArray(userSettings.admins) ? userSettings.admins : [];
    const listedAdmin = !isOwner && adminList.some(n => numMatch(senderNum, n));
    // .mode public: anyone may run commands. But some commands must NEVER
    // open up: .admin/.mode (owner-only, no exceptions) and anything that
    // mutates PERSISTED settings (.allow/.block/.persona) — public mode must
    // never let strangers poison the allow/block lists or the bot's persona.
    const OWNER_ONLY_CMDS = new Set(['admin', 'mode']);
    const PERSIST_CMDS = new Set(['allow', 'block', 'persona']);
    const publicMode = !isOwner && userSettings.mode === 'public' && !OWNER_ONLY_CMDS.has(cmd) && !PERSIST_CMDS.has(cmd);
    // Group admins (not in the list) may only use group moderation commands.
    const MOD_CMDS = new Set(['kick', 'promote', 'demote', 'mute', 'unmute', 'tagall']);
    if (MOD_CMDS.has(cmd)) {
        if (userSettings.groupAdmin === false) {
            return;
        }
    }
    if (!isOwner && !listedAdmin && !publicMode) {
        const canMod = isGroup && MOD_CMDS.has(cmd) && await isGroupAdmin(sock, jid, senderNum);
        if (!canMod) {
            // Unauthorized commands are ignored silently everywhere —
            // the bot never reveals itself or its command list to randos.
            return;
        }
    }
    // The admin list itself is owner-only, no exceptions.
    if (!isOwner && cmd === 'admin') {
        return;
    }

    switch (cmd) {
        case 'menu':
            await reply(MENU_TEXT);
            break;

        case 'ping': {
            const ms = await socketLatency();
            // Baileys messageTimestamp can be a Long — Number() on it yields NaN.
            const tsNum = typeof m.messageTimestamp?.toNumber === 'function'
                ? m.messageTimestamp.toNumber()
                : Number(m.messageTimestamp || 0);
            const delta = tsNum > 0 ? Math.max(0, Date.now() - tsNum * 1000) : null;
            const up = process.uptime();
            const hh = String(Math.floor(up / 3600)).padStart(2, '0');
            const mm2 = String(Math.floor((up % 3600) / 60)).padStart(2, '0');
            const ss = String(Math.floor(up % 60)).padStart(2, '0');
            await reply(
`*⚡ ${fb('PONG')}
${DIV}
🟢 Socket    ${fmtMs(ms)}
📨 Delivery  ${fmtMs(delta)}
⏱ Uptime    \`${hh}:${mm2}:${ss}\`
${DIV}${FOOT}`);
            break;
        }

        case 'clear': {
            // Per-speaker key must match the one askGroq uses (audit L20)
            clearHistory(historyKey(jid, m.key.participant));
            await reply(
`*🧹 ${fb('MEMORY CLEARED')}
${DIV}
ChatAI forgot everything from this chat.
Next reply starts fresh.
${DIV}${FOOT}`);
            break;
        }

        case 'alive': {
            const ms = await socketLatency();
            const up = process.uptime();
            const hh = String(Math.floor(up / 3600)).padStart(2, '0');
            const mm2 = String(Math.floor((up % 3600) / 60)).padStart(2, '0');
            const ss = String(Math.floor(up % 60)).padStart(2, '0');
            const rss = Math.round(process.memoryUsage().rss / 1024 / 1024);
            const now = new Date().toLocaleString('en-GB', { timeZone: 'Africa/Accra', hour12: false });
            await reply(
`*💚 ${fb("I'M ALIVE")}
${DIV}
🟢 Socket    ${fmtMs(ms)}
⏱ Uptime    \`${hh}:${mm2}:${ss}\`
🧠 Memory    \`${rss} MB\`
🕐 Time      \`${now}\` GMT
💬 ChatAI    ${userSettings.chatai ? 'on ✅' : 'off ❌'}
👁 Statuses  \`${_statusStore.size}\` saved · \`${_seenStatusIds.size}\` viewed
${DIV}${FOOT}`);
            break;
        }

        case 'setting':
        case 'settings': {
            const allow = userSettings.allow || [], block = userSettings.block || [];
            await reply(
`*⚙️ ${fb('SETTINGS')}
${DIV}
💬 *${fb('ChatAI')}*
▸ Replies     ${onOff(userSettings.chatai)}
▸ Persona     ${userSettings.persona ? `"${userSettings.persona.slice(0, 40)}${userSettings.persona.length > 40 ? '…' : ''}"` : '—'}
▸ Allow       ${allow.length ? allow.length + ' contact(s)' : 'everyone'}
▸ Block       ${block.length} contact(s)

👁️ *${fb('Automation')}
▸ View status      ${onOff(userSettings.autostatus)}
▸ React status     ${onOff(userSettings.statusReact)}
▸ Anti-delete Msg  ${onOff(userSettings.antidelete)}
▸ Anti-delete Stat ${onOff(userSettings.antideleteStatus)}
▸ Anti-tag Status  ${onOff(userSettings.antiTagStatus)}
▸ Anti-link        ${onOff(userSettings.antilink)}
▸ Group Admin      ${onOff(userSettings.groupAdmin)}

👑 *${fb('Access')}
▸ Mode        ${userSettings.mode === 'public' ? 'public' : 'self (owner + admins)'}
▸ Admins      ${(userSettings.admins || []).length} listed
${DIV}${FOOT}`);
            break;
        }

        case 'autostatus':
        case 'antidelete':
        case 'antideletestatus':
        case 'antitag':
        case 'antitagstatus':
        case 'antilink':
        case 'autoreply':
        case 'groupadmin':
        case 'chatai': {
            const v = (parts[0] || '').toLowerCase();
            if (v !== 'on' && v !== 'off') return;
            const keyMap = {
                autostatus: 'autostatus',
                antidelete: 'antidelete',
                antideletestatus: 'antideleteStatus',
                antitag: 'antiTagStatus',
                antitagstatus: 'antiTagStatus',
                antilink: 'antilink',
                groupadmin: 'groupAdmin',
                chatai: 'chatai',
                autoreply: 'autoreply'
            };
            const settingKey = keyMap[cmd] || cmd;
            apply({ [settingKey]: v === 'on' },
`${v === 'on' ? '✅' : '⛔'} *${fb(cmd.toUpperCase())} ${fb(v.toUpperCase())}*
${DIV}
Done. ${v === 'on' ? 'Feature enabled.' : 'Feature disabled.'}
${DIV}${FOOT}`);
            break;
        }

        case 'mode': {
            // Access mode — owner-only, enforced here AND in the auth gate.
            if (!isOwner) return;
            const v = (parts[0] || '').toLowerCase();
            if (v !== 'public' && v !== 'self') return reply(
`*👑 ${fb('ACCESS MODE')}
${DIV}
\`.mode public\` — anyone can use commands
\`.mode self\` — only you + listed admins
${DIV}
_Current: \`${userSettings.mode === 'public' ? 'public' : 'self'}\`_
_${fb('WARN')}: public mode lets strangers run
commands in any chat I'm in. .admin and
.mode stay locked to your phone._
${DIV}${FOOT}`);
            apply({ mode: v === 'public' ? 'public' : 'self' },
`*👑 ${fb('ACCESS MODE')} — ${fb(v.toUpperCase())}*
${DIV}
${v === 'public' ? 'Anyone can use commands now.' : 'Only you + listed admins can use commands.'}
_${fb('WARN')}: .admin and .mode stay locked to your phone either way._
${DIV}${FOOT}`);
            break;
        }

        case 'statusreact': {
            const v = (parts[0] || '').toLowerCase();
            if (v !== 'on' && v !== 'off') return;
            apply({ statusReact: v === 'on' },
`${v === 'on' ? '✅' : '⛔'} *${fb('STATUS REACT')} ${fb(v.toUpperCase())}*
${DIV}
Done. ${v === 'on' ? 'Reactions enabled.' : 'Reactions disabled.'}
${DIV}${FOOT}`);
            break;
        }

        case 'allow':
        case 'block': {
            const action = (parts[0] || 'list').toLowerCase();
            const num = digitsOf(parts.slice(1).join(' '));
            const list = Array.isArray(userSettings[cmd]) ? [...userSettings[cmd]] : [];
            const head = cmd === 'allow' ? '💬 ' + fb('ALLOW LIST') : '🚫 ' + fb('BLOCK LIST');
            if (action === 'add') {
                if (num.length < 7) return;
                if (!list.some(n => numMatch(n, num))) list.push(num);
                apply({ [cmd]: list },
`*➕ ${head}*
${DIV}
\`+${num}\` added.
Total: *${list.length}* contact${list.length === 1 ? '' : 's'}
${DIV}${FOOT}`);
            } else if (action === 'del' || action === 'remove') {
                if (num.length < 7) return;
                const next = list.filter(n => !numMatch(n, num));
                if (next.length === list.length) break;
                apply({ [cmd]: next },
`*➖ ${head}*
${DIV}
\`+${num}\` removed.
Total: *${next.length}* contact${next.length === 1 ? '' : 's'}
${DIV}${FOOT}`);
            } else {
                await reply(
`*📋 ${head}* (${list.length})
${DIV}
${list.length ? list.map(n => `\`+${n}\``).join('\n') : '_' + (cmd === 'allow' ? 'empty — everyone gets replies' : 'empty — nobody is blocked') + '_'}
${DIV}${FOOT}`);
            }
            break;
        }

        case 'persona': {
            // (audit L20) parts already has the command shifted off — join the
            // args directly. The old body.slice().slice() arithmetic produced
            // garbage for unexpected spacing.
            const text = parts.join(' ').trim();
            if (!text) return reply(
`*🎭 ${fb('PERSONA')}
${DIV}
Current: ${userSettings.persona ? `"${userSettings.persona}"` : '_none_'}

Set:  \`.persona <text>\`
Reset:  \`.persona clear\`
_Max 300 characters._
${DIV}${FOOT}`);
            if (text.toLowerCase() === 'clear') return apply({ persona: '' },
`*🎭 ${fb('PERSONA')}
${DIV}
Reset to default ✅
${DIV}${FOOT}`);
            if (text.length > 300) return;
            apply({ persona: text },
`*🎭 ${fb('PERSONA SET')} ✅
${DIV}
❝ ${text} ❞
${DIV}${FOOT}`);
            break;
        }

        case 'save': {
            const ownerJid = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
            if (!ownerJid) return reply(
`*📥 ${fb('STATUS SAVER')}
${DIV}
Bot not connected yet —
wait for it to come online.
${DIV}${FOOT}`);
            const ctx = m.message?.extendedTextMessage?.contextInfo;
            let target = null, latestTs = 0;
            if (ctx?.stanzaId && _statusStore.has(ctx.stanzaId)) {
                target = _statusStore.get(ctx.stanzaId);
            } else if (ctx?.participant) {
                for (const v of _statusStore.values()) {
                    if (v.participant && numMatch(v.participant, ctx.participant) && v.ts > latestTs) { target = v; latestTs = v.ts; }
                }
            } else {
                for (const v of _statusStore.values()) {
                    if (v.ts > latestTs) { target = v; latestTs = v.ts; }
                }
            }
            if (!target) return reply(
`*📥 ${fb('STATUS SAVER')}
${DIV}
No saved status found.

_View some statuses, then reply
to one with_ \`.save\` _— or send_
\`.save\` _alone for the latest._
${DIV}${FOOT}`);
            try {
                const who = (target.participant || 'unknown').split('@')[0];
                await sock.sendMessage(ownerJid, { text:
`*📥 ${fb('SAVING STATUS…')}
${DIV}
From: \`+${who}\`` });
                await copyNForward(sock, ownerJid, target.message);
                await reply(
`*✅ ${fb('STATUS SAVED')}
${DIV}
\`+${who}\`'s status delivered
to your chats.
${DIV}${FOOT}`);
            } catch (e) {
                console.error('[Cmd] status save failed:', e.message);
            }
            break;
        }

        case 'vv': {
            const ownerJid2 = sock.user?.id ? jidNormalizedUser(sock.user.id) : null;
            const isGroup = jid.endsWith('@g.us');
            const dest = isGroup ? jid : ownerJid2;
            if (!dest) return reply(
`*🔓 ${fb('VIEW-ONCE')}
${DIV}
Bot not connected yet.
${DIV}${FOOT}`);
            const qctx = m.message?.extendedTextMessage?.contextInfo;
            const qmsg = qctx?.quotedMessage;
            if (!qmsg) return reply(
`*🔓 ${fb('VIEW-ONCE')}
${DIV}
Reply to a view-once message
with \`.vv\`.

_Groups: revealed in the group._
_DMs: delivered to your chat._
${DIV}${FOOT}`);
            try {
                // qmsg is the quotedMessage from contextInfo - it may be wrapped in viewOnce/ephemeral
                let inner = unwrapMessage(qmsg);
                // Also handle case where qmsg itself is the viewOnce wrapper without needing unwrap
                if (!inner || Object.keys(inner).length === 0) inner = qmsg;
                const type = ['imageMessage', 'videoMessage', 'audioMessage', 'documentMessage', 'stickerMessage'].find(t => inner[t]);
                const senderNum = (qctx.participant || qctx.participantPn || '').split('@')[0];
                const tag = senderNum ? `\`+${senderNum}\`` : '_unknown_';
                let payload;
                if (type) {
                    const media = inner[type];
                    if (!media || !media.url) throw new Error('Media not available — may have expired or already viewed.');
                    const kind = type === 'imageMessage' ? 'image'
                        : type === 'videoMessage' ? 'video'
                        : type === 'audioMessage' ? 'audio'
                        : type === 'stickerMessage' ? 'sticker' : 'document';
                    const { downloadContentFromMessage } = await loadBaileys();
                    const stream = await downloadContentFromMessage(media, kind);
                    const chunks = [];
                    for await (const chunk of stream) chunks.push(chunk);
                    const buf = Buffer.concat(chunks);
                    if (buf.length === 0) throw new Error('Downloaded media is empty — may have expired.');
                    if (kind === 'image') payload = { image: buf, caption: `🔓 _view-once revealed — from ${tag}_` };
                    else if (kind === 'video') payload = { video: buf, caption: `🔓 _view-once revealed — from ${tag}_` };
                    else if (kind === 'audio') payload = { audio: buf, mimetype: media.mimetype || 'audio/mpeg', ptt: media.ptt || false };
                    else if (kind === 'sticker') payload = { sticker: buf };
                    else payload = { document: buf, mimetype: media.mimetype || 'application/octet-stream', fileName: media.fileName || `reveal-${Date.now()}` };
                } else {
                    const text = inner.conversation || inner.extendedTextMessage?.text || inner.caption || "";
                    if (!text || !String(text).trim()) throw new Error('No media found — not a view-once message. Make sure you reply to a view-once photo/video/voice.');
                    payload = { text: `🔓 _view-once revealed — from ${tag}_\n\`\`\`\n${text}\n\`\`\`` };
                }
                await sock.sendMessage(dest, payload);
                if (!isGroup && dest !== jid) {
                    await sock.sendMessage(dest, { text:
`*🔓 ${fb('VIEW-ONCE')}
${DIV}
From: ${tag}
_Media above — delivered here._
${DIV}${FOOT}` }).catch(() => {});
                }
            } catch (e) {
                console.error('[Cmd] reveal failed:', e.message);
                // Never leak bot output into a contact's chat — dest is either
                // the group itself or the owner's own chat, so failing there is
                // safe. Silence here would just look like the bot ignoring .vv.
                try {
                    await sock.sendMessage(dest, { text:
`*🔓 ${fb('VIEW-ONCE')} — FAILED*
${DIV}
${e.message}
${DIV}${FOOT}` });
                } catch (e2) { console.error('[Cmd] reveal feedback failed:', e2.message); }
            }
            break;
        }

        case 'admin': {
            const action = (parts[0] || '').toLowerCase();
            const list = Array.isArray(userSettings.admins) ? userSettings.admins : [];
            if (action === 'list') {
                await reply(
`*👑 ${fb('ADMIN LIST')} (${list.length})
${DIV}
${list.length ? list.map(n => `\`+${n}\``).join('\n') : '_empty — only the linked phone runs commands_'}
${DIV}
_Add:_ \`.admin add <number>\`
_Remove:_ \`.admin del <number>\`
${DIV}${FOOT}`);
                break;
            }
            const num = (parts[1] || '').replace(/\D/g, '');
            if ((action !== 'add' && action !== 'del') || !num || num.length < 6) {
                // silent
                break;
            }
            const next = action === 'add'
                ? (list.some(n => numMatch(n, num)) ? list : [...list, num])
                : list.filter(n => !numMatch(n, num));
            if (next.length !== list.length) {
                apply({ admins: next },
`*👑 ${fb(action === 'add' ? 'ADMIN ADDED' : 'ADMIN REMOVED')}
${DIV}
\`+${num}\` — ${action === 'add' ? 'can now use' : 'removed from'} commands.

_${next.length} admin(s) total._
${DIV}${FOOT}`);
            }
            break;
        }

        case 'kick':
        case 'promote':
        case 'demote': {
            if (!(await botIsGroupAdmin(sock, jid))) {
                // silent
                break;
            }
            const ctxInfo = m.message?.extendedTextMessage?.contextInfo;
            let targetJids = (ctxInfo?.mentionedJid || []).filter(Boolean);
            if (!targetJids.length && ctxInfo?.participant) targetJids = [ctxInfo.participant];
            for (const a of parts) {
                const d = a.replace(/\D/g, '');
                if (d.length >= 7) {
                    const candidateJid = `${d}@s.whatsapp.net`;
                    if (!targetJids.some(j => j.split('@')[0] === d)) targetJids.push(candidateJid);
                }
            }
            targetJids = targetJids.map(j => j.includes('@') ? j : `${j}@s.whatsapp.net`);
            if (!targetJids.length) {
                // silent
                break;
            }
            try {
                await sock.groupParticipantsUpdate(jid, targetJids, cmd === 'kick' ? 'remove' : cmd);
                await reply(
`*✅ ${fb(cmd === 'kick' ? 'KICKED' : cmd === 'promote' ? 'PROMOTED' : 'DEMOTED')}
${DIV}
${targetJids.map(j => `\`+${j.split('@')[0]}\``).join('\n')}
${DIV}${FOOT}`);
            } catch (e) {
                console.error(`[Cmd] ${cmd} failed:`, e.message);
            }
            break;
        }

        case 'mute':
        case 'unmute': {
            if (!(await botIsGroupAdmin(sock, jid))) {
                // silent
                break;
            }
            try {
                await sock.groupSettingUpdate(jid, cmd === 'mute' ? 'announcement' : 'not_announcement');
                await reply(
`*${cmd === 'mute' ? '🔇' : '🔊'} ${fb(cmd === 'mute' ? 'GROUP MUTED' : 'GROUP UNMUTED')}
${DIV}
${cmd === 'mute' ? '_Only admins can send now._' : '_Everyone can send again._'}
${DIV}${FOOT}`);
            } catch (e) {
                console.error(`[Cmd] ${cmd} failed:`, e.message);
            }
            break;
        }

        case 'tagall': {
            const meta = await sock.groupMetadata(jid).catch(() => null);
            if (!meta) break;
            const note = parts.length ? parts.join(' ') : '';
            await sock.sendMessage(jid, {
                text: `📣 *${fb('ATTENTION')}*${note ? '\n' + note : ''}\n\n` +
                    meta.participants.map(p => `@${p.id.split('@')[0]}`).join(' '),
                mentions: meta.participants.map(p => p.id)
            });
            break;
        }

        default:
            // unknown commands: silent
    }
}
    return handleOwnerCommand;
};
