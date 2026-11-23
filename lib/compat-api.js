'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

module.exports = function registerCompatApi(app, deps) {
    const {
        SESSION_BASE,
        loadDB,
        dbTransaction,
        instances,
        lastQrCache,
        lastPairingCodeCache,
        MAX_INSTANCES,
        clearPendingRestart,
        clearStartupWatchdog,
        startUserBot,
        writeLimiter,
        requireUser,
        requireAdmin,
        ah,
        auditLog,
        adminTarget,
        startingLock,
        crashCounts,
        wipeCounts,
        startedAtMap,
        workerSettingsPayload,
        getAnnouncement,
        setAnnouncement,
        inviteTransaction,
        inviteTxFailed,
        buildInviteLink,
        loadInvites,
        inviteStatus,
        isValidUsername,
        config,
    } = deps;

    function readAppSettings() {
        const file = path.join(SESSION_BASE, 'app_settings.json');
        try {
            const j = JSON.parse(fs.readFileSync(file, 'utf8'));
            return j && typeof j === 'object' ? j : {};
        } catch { return {}; }
    }

    function writeAppSettings(patch) {
        const file = path.join(SESSION_BASE, 'app_settings.json');
        const cur = readAppSettings();
        const next = { ...cur, ...patch };
        const tmp = file + '.tmp.' + process.pid + '.' + Date.now();
        fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
        fs.renameSync(tmp, file);
        return next;
    }

    function notificationsPath() { return path.join(SESSION_BASE, 'notifications.json'); }
    function notifReadsPath() { return path.join(SESSION_BASE, 'notification_reads.json'); }

    function loadNotificationsStore() {
        try {
            const j = JSON.parse(fs.readFileSync(notificationsPath(), 'utf8'));
            return Array.isArray(j) ? j : [];
        } catch { return []; }
    }

    function saveNotificationsStore(list) {
        const file = notificationsPath();
        const tmp = file + '.tmp.' + process.pid + '.' + Date.now();
        fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
        fs.renameSync(tmp, file);
    }

    function loadNotifReads() {
        try {
            const j = JSON.parse(fs.readFileSync(notifReadsPath(), 'utf8'));
            return j && typeof j === 'object' ? j : {};
        } catch { return {}; }
    }

    function saveNotifReads(obj) {
        const file = notifReadsPath();
        const tmp = file + '.tmp.' + process.pid + '.' + Date.now();
        fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
        fs.renameSync(tmp, file);
    }

    function toV2Status(inst, dbRow, cached, cachedPairing) {
        if (!inst) return (dbRow && dbRow.running) ? 'connecting' : 'disconnected';
        const s = String(inst.status || '').toLowerCase();
        if (s === 'online') return 'connected';
        if (s === 'stopped') return 'disconnected';
        const isPairingFresh = cachedPairing && (Date.now() - (cachedPairing.ts || 0) < 180000);
        const pairingCode = (inst && inst.pairingCode) || (isPairingFresh ? cachedPairing.code : null);
        if (pairingCode || s === 'pairing') return 'pairing';
        const hasQr = Boolean((inst && (inst.qr || inst.qrDataUrl)) || (cached && (cached.qr || cached.qrDataUrl)));
        if (hasQr) return 'qr';
        if (s === 'starting' || s === 'connecting' || s === 'offline' || (dbRow && dbRow.running)) return 'connecting';
        return s || 'disconnected';
    }

    function splitEmojis(value) {
        if (Array.isArray(value)) return value.filter(e => typeof e === 'string' && e.trim()).slice(0, 10);
        if (typeof value !== 'string' || !value.trim()) return [];
        return value.split(/[\s,]+/).map(s => s.trim()).filter(Boolean).slice(0, 10);
    }

    function joinEmojis(arr) {
        if (!Array.isArray(arr)) return '❤️, 🖤, 💚, 🤍, 💙, 🩷, 🩵';
        const clean = arr.map(e => String(e).trim()).filter(Boolean).slice(0, 10);
        return clean.length ? clean.join(', ') : '❤️, 🖤, 💚, 🤍, 💙, 🩷, 🩵';
    }

    function v1PresenceToV2(p) {
        const v = String(p || 'auto').toLowerCase();
        if (v === 'off') return 'off';
        if (v === 'online' || v === 'available') return 'online';
        if (v === 'typing' || v === 'composing') return 'typing';
        if (v === 'recording') return 'recording';
        if (v === 'auto' || v === 'none') return 'auto';
        return 'auto';
    }

    function v2PresenceToV1(p) {
        const v = String(p || 'auto').toLowerCase();
        if (v === 'auto') return 'auto';
        if (v === 'online' || v === 'available') return 'online';
        if (v === 'typing' || v === 'composing') return 'typing';
        if (v === 'recording') return 'recording';
        if (v === 'off' || v === 'none') return 'off';
        return 'auto';
    }

    function settingsToV2(row) {
        row = row || {};
        const autoreply = !!row.autoreply;
        const statusReactionArr = splitEmojis(row.reactEmojis);
        const presenceV2 = v1PresenceToV2(row.presence);
        return {
            recoverDeleted: row.antideleteMsg !== false,
            recoverDeletedStatus: row.antideleteStatus !== false,
            recoverDeletedMedia: (row.antideleteMsg !== false) || (row.antideleteStatus !== false),
            antiViewOnce: row.antivv !== false,
            anticall: !!row.anticall,
            chatAI: autoreply,
            autoReply: autoreply,
            voiceNotes: row.voiceNotes !== undefined ? !!row.voiceNotes : autoreply,
            presence: presenceV2,
            ghostMode: presenceV2 === 'off',
            autoStatusView: row.autostatus !== false,
            statusReact: row.statusReact !== false,
            statusReaction: statusReactionArr.length ? statusReactionArr : ['💚'],
            antiTagStatus: !!row.antiTagStatus,
            groupChatAI: row.groupChatAI !== undefined ? !!row.groupChatAI : false,
            groupAdminTools: !!row.groupAdmin,
            antiLink: !!row.antilink,
            mode: row.mode === 'public' ? 'public' : 'self',
            commandPrefix: row.commandPrefix || '.',
            aiSystemPrompt: String(row.botInstructions || row.persona || ''),
        };
    }

    function sessionPayload(req) {
        const username = req.session.user && req.session.user.username;
        const db = loadDB();
        const row = db[username] || {};
        const inst = instances.get(username) || null;
        const cached = lastQrCache.get(username);
        const cachedPairing = lastPairingCodeCache ? lastPairingCodeCache.get(username) : null;
        const isPairingFresh = cachedPairing && (Date.now() - (cachedPairing.ts || 0) < 180000);
        const qrAvailable = inst && inst.status !== 'stopped' && (inst.qr || inst.qrDataUrl || (cached && (cached.qr || cached.qrDataUrl)));
        const pairingCode = (inst && inst.pairingCode) || (isPairingFresh ? cachedPairing.code : null);
        const status = toV2Status(inst, row, cached, cachedPairing);
        let linkedAccount = null;
        if (status === 'connected') {
            linkedAccount = {
                name: (inst && inst.accountName) || row.botName || 'WhatsApp account',
                phoneNumber: (inst && inst.phone) || row.phoneNumber || null,
                profilePictureUrl: inst && inst.ppUrl ? inst.ppUrl : null,
            };
        }
        const rentalDays = row.rentalDays || null;
        const rentalExpiresAt = row.rentalExpiresAt ? new Date(row.rentalExpiresAt).toISOString() : null;
        const rentalExpired = !row.isAdmin && !!row.rentalExpiresAt && (Date.now() >= row.rentalExpiresAt);
        const rentalDaysLeft = row.rentalExpiresAt ? Math.max(0, Math.ceil((row.rentalExpiresAt - Date.now()) / (24 * 3600 * 1000))) : null;

        return {
            userId: username,
            isAdmin: !!row.isAdmin,
            enabled: !!row.running,
            status,
            qr: qrAvailable ? '/api/session/qr' : null,
            pairingCode: status === 'connected' ? null : pairingCode,
            linkedAccount,
            settings: settingsToV2(row),
            updatedAt: row.updatedAt || null,
            rentalDays,
            rentalExpiresAt,
            rentalExpired,
            rentalDaysLeft,
        };
    }

    // Public settings (contact link on login/register pages)
    app.get('/api/public-settings', (req, res) => {
        res.set('Cache-Control', 'no-store');
        const s = readAppSettings();
        let adminWhatsApp = (s.adminWhatsApp || s.admin_whatsapp || process.env.ADMIN_WHATSAPP || process.env.ADMIN_CONTACT || '').toString().replace(/[^0-9]/g, '');
        res.json({ ok: true, adminWhatsApp: adminWhatsApp || null });
    });

    // Session status for SPA
    app.get('/api/session', requireUser, (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.json(sessionPayload(req));
    });

    // QR image data URL
    app.get('/api/session/qr', requireUser, ah(async (req, res) => {
        res.set('Cache-Control', 'no-store');
        const username = req.session.user.username;
        const inst = instances.get(username);
        const cached = lastQrCache.get(username);
        const dataUrl = (inst && inst.qrDataUrl) || (cached && cached.qrDataUrl) || null;
        if (dataUrl) return res.json({ dataUrl });
        const qr = (inst && inst.qr) || (cached && cached.qr) || null;
        if (qr) {
            try {
                const url = await QRCode.toDataURL(qr, { width: 560, margin: 4, errorCorrectionLevel: 'H' });
                return res.json({ dataUrl: url });
            } catch (e) {
                return res.status(404).json({ error: 'No QR code is currently available.' });
            }
        }
        return res.status(404).json({ error: 'No QR code is currently available.' });
    }));

    // Connect (QR or Pairing Code flow)
    app.post('/api/session/connect', writeLimiter, requireUser, ah(async (req, res) => {
        const username = req.session.user.username;
        const db = loadDB();
        const userRow = db[username];
        if (userRow && !userRow.isAdmin && userRow.rentalExpiresAt && Date.now() >= userRow.rentalExpiresAt) {
            return res.status(403).json({ error: 'Rental expired. Please contact the administrator to renew access.' });
        }
        const phone = req.body && req.body.phoneNumber ? String(req.body.phoneNumber).replace(/\D/g, '') : null;
        if (phone && (phone.length < 7 || phone.length > 15)) {
            return res.status(400).json({ error: 'Please enter a valid phone number with country code (e.g. 233501234567).' });
        }
        if (instances.size >= MAX_INSTANCES && !instances.has(username)) {
            return res.status(503).json({ error: `Max capacity (${MAX_INSTANCES} bots) reached.` });
        }
        clearPendingRestart(username);
        const inst = instances.get(username);
        if (inst && inst.status === 'online') {
            return res.status(409).json({ error: 'This account is already connected. Disconnect it first.' });
        }

        if (phone && inst && inst.child && inst.status !== 'stopped') {
            inst.status = 'pairing';
            inst.phoneNumber = phone;
            inst.child.send({ type: 'REQUEST_PAIRING_CODE', phoneNumber: phone });
            await dbTransaction((db) => { if (db[username]) { db[username].running = true; db[username].updatedAt = Date.now(); } });
            return res.status(202).json({ status: 'pairing', mode: 'pairing' });
        }

        if (!phone && inst && inst.child && inst.status !== 'stopped') {
            inst.pairingCode = null;
            if (lastPairingCodeCache) lastPairingCodeCache.delete(username);
            inst.child.send({ type: 'REQUEST_PAIRING_CODE', phoneNumber: null });
            return res.status(202).json({ status: inst.qr ? 'qr' : 'connecting', mode: 'qr' });
        }

        const started = startUserBot(username, false, !!inst, phone);
        if (started === 'busy') return res.status(409).json({ error: 'Bot is already starting.' });
        if (started === 'capacity') return res.status(503).json({ error: `Max capacity (${MAX_INSTANCES} bots) reached.` });
        await dbTransaction((db) => { if (db[username]) { db[username].running = true; db[username].updatedAt = Date.now(); } });
        res.status(202).json({ status: phone ? 'pairing' : 'connecting', mode: phone ? 'pairing' : 'qr' });
    }));

    // Disconnect
    app.post('/api/session/disconnect', writeLimiter, requireUser, ah(async (req, res) => {
        const username = req.session.user.username;
        clearPendingRestart(username);
        clearStartupWatchdog(username);
        const saved = await dbTransaction((db) => { if (!db[username]) return; db[username].running = false; db[username].updatedAt = Date.now(); });
        if (!saved) return res.status(500).json({ error: 'Could not save the account state. Try again.' });
        const inst = instances.get(username);
        if (inst && inst.child) {
            inst.child.kill();
            await new Promise(r => setTimeout(r, 1000));
            if (inst.child.exitCode === null && inst.child.signalCode === null) {
                try { inst.child.kill('SIGKILL'); } catch (e) {}
            }
            if (instances.get(username) === inst) instances.delete(username);
        }
        crashCounts.delete(username);
        wipeCounts.delete(username);
        startedAtMap.delete(username);
        lastQrCache.delete(username);
        if (lastPairingCodeCache) lastPairingCodeCache.delete(username);
        res.json({ ok: true, status: 'disconnecting' });
    }));

    // Settings (v2 PATCH)
    app.patch('/api/settings', writeLimiter, requireUser, ah(async (req, res) => {
        const username = req.session.user.username;
        const body = req.body || {};
        const allowed = new Set([
            'autoStatusView', 'ghostMode', 'statusReact', 'statusReaction',
            'recoverDeleted', 'recoverDeletedStatus', 'recoverDeletedMedia',
            'chatAI', 'autoReply', 'groupChatAI', 'groupAdminTools', 'antiLink',
            'voiceNotes', 'presence', 'antiTagStatus', 'antiViewOnce', 'anticall',
            'mode', 'commandPrefix', 'aiSystemPrompt'
        ]);
        for (const k of Object.keys(body)) {
            if (!allowed.has(k)) return res.status(400).json({ error: `Unknown setting: ${k}` });
        }
        if (body.statusReaction !== undefined) {
            if (Array.isArray(body.statusReaction)) body.statusReaction = body.statusReaction.filter(e => typeof e === 'string' && e.trim()).slice(0, 10);
            else if (typeof body.statusReaction !== 'string') return res.status(400).json({ error: 'statusReaction must be an array of emojis or string.' });
        }
        if (body.mode !== undefined && !['public', 'self'].includes(body.mode)) return res.status(400).json({ error: 'mode must be public or self.' });

        let chatAiDeclined = false;
        const saved = await dbTransaction((db) => {
            if (!db[username]) return;
            const u = db[username];
            if ('recoverDeleted' in body) u.antideleteMsg = !!body.recoverDeleted;
            if ('recoverDeletedStatus' in body) u.antideleteStatus = !!body.recoverDeletedStatus;
            if ('antiViewOnce' in body) u.antivv = !!body.antiViewOnce;
            if ('anticall' in body) u.anticall = !!body.anticall;
            if ('autoStatusView' in body) u.autostatus = !!body.autoStatusView;
            if ('statusReact' in body) u.statusReact = !!body.statusReact;
            if ('statusReaction' in body) u.reactEmojis = joinEmojis(Array.isArray(body.statusReaction) ? body.statusReaction : splitEmojis(body.statusReaction));
            if ('antiTagStatus' in body) u.antiTagStatus = !!body.antiTagStatus;
            if ('groupAdminTools' in body) u.groupAdmin = !!body.groupAdminTools;
            if ('antiLink' in body) {
                const adminActive = ('groupAdminTools' in body) ? !!body.groupAdminTools : !!u.groupAdmin;
                u.antilink = !!body.antiLink && adminActive;
            }
            if ('groupChatAI' in body) u.groupChatAI = !!body.groupChatAI;
            if ('voiceNotes' in body) u.voiceNotes = !!body.voiceNotes;
            if ('commandPrefix' in body) u.commandPrefix = String(body.commandPrefix || '.').slice(0, 3) || '.';
            if ('mode' in body) u.mode = body.mode === 'public' ? 'public' : 'self';
            if ('aiSystemPrompt' in body) {
                u.botInstructions = String(body.aiSystemPrompt || '').slice(0, 1000);
                u.persona = u.botInstructions;
            }
            if ('presence' in body) {
                u.presence = v2PresenceToV1(body.presence);
            } else if ('ghostMode' in body) {
                u.presence = body.ghostMode ? 'off' : 'auto';
            }

            const wantsChat = ('chatAI' in body) ? !!body.chatAI : (('autoReply' in body) ? !!body.autoReply : undefined);
            if (wantsChat !== undefined) {
                if (wantsChat) {
                    const groqKey = ((readAppSettings().groqApiKey || readAppSettings().groq_api_key || process.env.GROQ_API_KEY || config.GROQ_API_KEY || '') + '').trim();
                    if (!groqKey) { chatAiDeclined = true; u.autoreply = false; }
                    else u.autoreply = true;
                } else {
                    u.autoreply = false;
                }
            }

            u.updatedAt = Date.now();
            const inst = instances.get(username);
            if (inst && inst.child) {
                try { inst.child.send({ type: 'SETTINGS', settings: workerSettingsPayload(u) }); }
                catch (e) { /* worker will pick up on restart */ }
            }
        });
        if (!saved) return res.status(500).json({ error: 'Could not save settings. Try again.' });
        if (chatAiDeclined) return res.status(400).json({ error: 'ChatAI requires the server Groq API key to be configured.' });
        const updatedDb = loadDB();
        res.json({ ok: true, settings: settingsToV2(updatedDb[username] || {}) });
    }));

    // User notifications
    app.get('/api/notifications', requireUser, (req, res) => {
        res.set('Cache-Control', 'no-store');
        const username = req.session.user.username;
        const reads = loadNotifReads();
        const readSet = new Set(Array.isArray(reads[username]) ? reads[username] : []);
        const all = loadNotificationsStore();
        const items = all
            .filter(n => !n.target || n.target === 'all' || n.target === username)
            .filter(n => !readSet.has(n.id))
            .sort((a, b) => (b.created_at_ts || 0) - (a.created_at_ts || 0))
            .slice(0, 10)
            .map(n => ({ id: n.id, title: n.title, message: n.message, type: n.type || 'announcement', created_at: n.created_at }));
        const ann = getAnnouncement();
        if (ann && !readSet.has('__announcement__')) {
            items.unshift({ id: '__announcement__', title: 'Announcement', message: ann, type: 'announcement', created_at: new Date().toISOString() });
        }
        res.json({ notifications: items });
    });

    app.post('/api/notifications/:id/dismiss', requireUser, (req, res) => {
        const username = req.session.user.username;
        const id = String(req.params.id || '');
        if (!id) return res.status(400).json({ error: 'Invalid notification ID.' });
        const reads = loadNotifReads();
        const arr = new Set(Array.isArray(reads[username]) ? reads[username] : []);
        const wasRead = arr.has(id);
        arr.add(id);
        reads[username] = [...arr];
        try { saveNotifReads(reads); } catch {}
        if (!wasRead && id !== '__announcement__') {
            try {
                const list = loadNotificationsStore();
                const item = list.find(n => n.id === id);
                if (item) {
                    item.read_count = (item.read_count || 0) + 1;
                    saveNotificationsStore(list);
                }
            } catch {}
        }
        res.json({ ok: true });
    });

    // Admin notifications
    app.get(['/api/admin/notifications', '/api/admin/notifications-v2'], requireUser, requireAdmin, (req, res) => {
        const items = loadNotificationsStore().sort((a, b) => (b.created_at_ts || 0) - (a.created_at_ts || 0)).slice(0, 50);
        res.json({ notifications: items });
    });

    app.post(['/api/admin/notifications', '/api/admin/notifications-v2'], writeLimiter, requireUser, requireAdmin, (req, res) => {
        const title = String((req.body || {}).title || '').trim();
        const message = String((req.body || {}).message || '').trim();
        if (!title || title.length > 120) return res.status(400).json({ error: 'Title is required (1 to 120 characters).' });
        if (!message || message.length > 2000) return res.status(400).json({ error: 'Message is required (1 to 2000 characters).' });
        const type = ['announcement', 'info', 'warning', 'alert'].includes((req.body || {}).type) ? req.body.type : 'announcement';
        let targetUserId = (req.body || {}).targetUserId || null;
        if (targetUserId === 'all' || targetUserId === '') targetUserId = null;
        const n = {
            id: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
            user_id: targetUserId,
            target: targetUserId || 'all',
            target_username: targetUserId || null,
            title, message, type,
            send_whatsapp: (req.body || {}).sendWhatsapp !== false,
            created_at: new Date().toISOString(),
            created_at_ts: Date.now(),
            read_count: 0,
            delivered_count: 0,
        };
        const list = loadNotificationsStore();
        list.push(n);
        try { saveNotificationsStore(list); } catch (e) { return res.status(500).json({ error: 'Could not save notification.' }); }
        try { setAnnouncement(message); } catch {}

        if (n.send_whatsapp) {
            const notifText = `📢 *[${n.type.toUpperCase()}] ${n.title}*\n\n${n.message}`;
            if (targetUserId) {
                const inst = instances.get(targetUserId);
                if (inst && inst.child && inst.status === 'online') {
                    try { inst.child.send({ type: 'SEND_NOTIFICATION', notificationId: n.id, text: notifText }); } catch {}
                }
            } else {
                for (const [, inst] of instances.entries()) {
                    if (inst && inst.child && inst.status === 'online') {
                        try { inst.child.send({ type: 'SEND_NOTIFICATION', notificationId: n.id, text: notifText }); } catch {}
                    }
                }
            }
        }

        res.status(201).json({ ok: true, notification: n });
    });

    app.delete(['/api/admin/notifications/:id', '/api/admin/notifications-v2/:id'], writeLimiter, requireUser, requireAdmin, (req, res) => {
        const id = String(req.params.id || '');
        const list = loadNotificationsStore();
        const idx = list.findIndex(n => n.id === id);
        if (idx === -1) return res.status(404).json({ error: 'Notification not found.' });
        list.splice(idx, 1);
        try { saveNotificationsStore(list); } catch {}
        res.json({ ok: true, id });
    });

    // Admin settings (admin WhatsApp contact + groq key)
    function handleGetAdminSettings(req, res) {
        const s = readAppSettings();
        let adminWhatsApp = (s.adminWhatsApp || s.admin_whatsapp || process.env.ADMIN_WHATSAPP || process.env.ADMIN_CONTACT || '').toString().replace(/[^0-9]/g, '');
        const storedGroq = (s.groqApiKey || s.groq_api_key || process.env.GROQ_API_KEY || config.GROQ_API_KEY || '').toString().trim();
        res.json({ ok: true, settings: s, adminWhatsApp: adminWhatsApp || '', groqApiKey: storedGroq });
    }
    app.get(['/api/admin/settings', '/api/admin/settings-v2'], requireUser, requireAdmin, handleGetAdminSettings);

    async function handleSaveAdminSettings(req, res) {
        const body = req.body || {};
        const patch = {};
        if (typeof body.adminWhatsApp === 'string') {
            patch.adminWhatsApp = body.adminWhatsApp.replace(/[^0-9]/g, '');
        }
        if (typeof body.groqApiKey === 'string') {
            const trimmed = body.groqApiKey.trim();
            patch.groqApiKey = trimmed;
            if (trimmed) {
                process.env.GROQ_API_KEY = trimmed;
                try { config.GROQ_API_KEY = trimmed; } catch {}
            } else {
                delete process.env.GROQ_API_KEY;
                try { config.GROQ_API_KEY = ''; } catch {}
            }
            for (const [, inst] of instances.entries()) {
                if (inst && inst.child) {
                    try { inst.child.send({ type: 'GROQ_API_KEY', key: trimmed }); } catch {}
                }
            }
        }
        let saved = {};
        try { saved = writeAppSettings(patch); } catch (e) { return res.status(500).json({ error: 'Could not save settings.' }); }
        res.json({ ok: true, ...('adminWhatsApp' in patch ? { adminWhatsApp: saved.adminWhatsApp || '' } : {}), ...('groqApiKey' in patch ? { groqApiKey: saved.groqApiKey || '' } : {}) });
    }
    app.post(['/api/admin/settings', '/api/admin/settings-v2'], writeLimiter, requireUser, requireAdmin, ah(handleSaveAdminSettings));
    app.patch(['/api/admin/settings', '/api/admin/settings-v2'], writeLimiter, requireUser, requireAdmin, ah(handleSaveAdminSettings));

    // Admin user operations: DELETE /api/admin/users/:userId
    app.delete('/api/admin/users/:userId', writeLimiter, requireUser, requireAdmin, ah(async (req, res) => {
        const username = String(req.params.userId || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!username) return res.status(400).json({ error: 'Invalid user ID.' });
        if (username === req.session.user.username) {
            return res.status(400).json({ error: 'You cannot delete your own account.' });
        }
        const db = loadDB();
        const isLastAdmin = db[username]?.isAdmin && Object.values(db).filter(u => u.isAdmin).length <= 1;
        if (isLastAdmin) return res.status(400).json({ error: 'Cannot delete the last admin account.' });

        clearPendingRestart(username);
        clearStartupWatchdog(username);

        let deleted = false;
        const txOk = await dbTransaction((tdb) => {
            if (!tdb[username]) return;
            const last = tdb[username].isAdmin && Object.values(tdb).filter(u => u.isAdmin).length <= 1;
            if (last) return;
            delete tdb[username];
            deleted = true;
        });
        if (!txOk) return res.status(500).json({ error: 'Delete failed due to a server error. Try again.' });
        if (!deleted) return res.status(400).json({ error: 'Account no longer exists or is the last admin.' });

        const inst = instances.get(username);
        if (inst && inst.child) {
            inst.child.kill();
            await new Promise(r => setTimeout(r, 1000));
            if (inst.child.exitCode === null && inst.child.signalCode === null) {
                try { inst.child.kill('SIGKILL'); } catch (e) {}
            }
            if (instances.get(username) === inst) instances.delete(username);
        }
        startingLock.delete(username);
        crashCounts.delete(username);
        wipeCounts.delete(username);
        startedAtMap.delete(username);
        lastQrCache.delete(username);

        const sessionDir = path.join(SESSION_BASE, username);
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {
            console.error(`[Manager] Failed to remove session dir for ${username}:`, e.message);
        }
        res.json({ ok: true, status: 'ok' });
    }));

    // Admin user operations: DELETE /api/admin/users/:userId/bot (unlink WhatsApp session)
    app.delete('/api/admin/users/:userId/bot', writeLimiter, requireUser, requireAdmin, ah(async (req, res) => {
        const username = String(req.params.userId || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!username) return res.status(400).json({ error: 'Invalid user ID.' });
        const db = loadDB();
        if (!db[username]) return res.status(404).json({ error: 'User not found.' });

        clearPendingRestart(username);
        clearStartupWatchdog(username);

        await dbTransaction((tdb) => {
            if (tdb[username]) {
                tdb[username].running = false;
                tdb[username].updatedAt = Date.now();
            }
        });

        const inst = instances.get(username);
        if (inst && inst.child) {
            inst.child.kill();
            await new Promise(r => setTimeout(r, 1000));
            if (inst.child.exitCode === null && inst.child.signalCode === null) {
                try { inst.child.kill('SIGKILL'); } catch (e) {}
            }
            if (instances.get(username) === inst) instances.delete(username);
        }
        startingLock.delete(username);
        crashCounts.delete(username);
        wipeCounts.delete(username);
        startedAtMap.delete(username);
        lastQrCache.delete(username);

        const sessionDir = path.join(SESSION_BASE, username);
        try { fs.rmSync(sessionDir, { recursive: true, force: true }); } catch (e) {
            console.error(`[Manager] Failed to remove WhatsApp credentials for ${username}:`, e.message);
        }
        res.json({ ok: true, message: 'Bot unlinked and credentials cleared.' });
    }));

    // Admin user operations: PATCH /api/admin/users/:userId (e.g. enabled, rentalDays, isAdmin)
    app.patch('/api/admin/users/:userId', writeLimiter, requireUser, requireAdmin, ah(async (req, res) => {
        const username = String(req.params.userId || '').trim().toLowerCase().replace(/[^a-z0-9]/g, '');
        if (!username) return res.status(400).json({ error: 'Invalid user ID.' });
        const body = req.body || {};
        let updated = false;

        // Toggle worker enabled/running state
        if (typeof body.enabled === 'boolean') {
            if (body.enabled) {
                if (instances.size >= MAX_INSTANCES && !instances.has(username)) {
                    return res.status(503).json({ error: `Max capacity (${MAX_INSTANCES} bots) reached.` });
                }
                clearPendingRestart(username);
                const started = startUserBot(username, false);
                if (started === 'busy') return res.status(409).json({ error: 'Bot is already starting.' });
                if (started === 'capacity') return res.status(503).json({ error: `Max capacity (${MAX_INSTANCES} bots) reached.` });
                await dbTransaction((tdb) => {
                    if (tdb[username]) {
                        tdb[username].running = true;
                        tdb[username].updatedAt = Date.now();
                        updated = true;
                    }
                });
            } else {
                clearPendingRestart(username);
                clearStartupWatchdog(username);
                await dbTransaction((tdb) => {
                    if (tdb[username]) {
                        tdb[username].running = false;
                        tdb[username].updatedAt = Date.now();
                        updated = true;
                    }
                });
                const inst = instances.get(username);
                if (inst && inst.child) {
                    inst.child.kill();
                    await new Promise(r => setTimeout(r, 1000));
                    if (inst.child.exitCode === null && inst.child.signalCode === null) {
                        try { inst.child.kill('SIGKILL'); } catch (e) {}
                    }
                    if (instances.get(username) === inst) instances.delete(username);
                }
                startingLock.delete(username);
                crashCounts.delete(username);
                wipeCounts.delete(username);
                startedAtMap.delete(username);
                lastQrCache.delete(username);
                if (lastPairingCodeCache) lastPairingCodeCache.delete(username);
                updated = true;
            }
        }

        await dbTransaction((tdb) => {
            if (!tdb[username]) return;
            const u = tdb[username];
            if (Number.isInteger(body.rentalDays) && body.rentalDays > 0) {
                const baseTime = (u.rentalExpiresAt && u.rentalExpiresAt > Date.now()) ? u.rentalExpiresAt : Date.now();
                u.rentalExpiresAt = baseTime + body.rentalDays * 24 * 60 * 60 * 1000;
                u.rentalDays = Math.ceil((u.rentalExpiresAt - Date.now()) / (24 * 3600 * 1000));
            }
            if (typeof body.isAdmin === 'boolean' && username !== req.session.user.username) {
                u.isAdmin = body.isAdmin;
            }
            u.updatedAt = Date.now();
            updated = true;
        });
        if (!updated) return res.status(404).json({ error: 'User not found.' });
        res.json({ ok: true });
    }));
};
