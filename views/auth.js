// views/auth.js — server-rendered auth pages (sign in / sign up).
// Extracted from autoviewer.js as part of the modular split (behavior-identical).
const { loadDB } = require('../lib/db');
const crypto = require('crypto');

function csrfToken(req) {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    return req.session.csrf;
}

// ── Templates ───────────────────────────────────────────────────────────────
function escapeHTML(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

function sPage(title, subtitle, icon, accent, fields, footer, error) {
    return `<!DOCTYPE html><html lang="en"><head>
        <meta charset="UTF-8">
        <title>AutoViewer • ${title}</title>
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <style>
            @keyframes bgMove{0%{background-position:0% 50%}50%{background-position:100% 50%}100%{background-position:0% 50%}}
            @keyframes floatIn{0%{opacity:0;transform:translateY(20px) scale(0.96)}100%{opacity:1;transform:translateY(0) scale(1)}}
            :root{--accent:${accent}}
            *{box-sizing:border-box;-webkit-font-smoothing:antialiased;margin:0}
            body{
                margin:0;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Display","SF Pro Text",sans-serif;
                background:linear-gradient(135deg,#0a0a0f 0%,#0d0d1a 30%,#0a0f14 60%,#0f0f0f 100%);
                background-size:200% 200%;animation:bgMove 20s ease infinite;
                min-height:100vh;display:flex;align-items:center;justify-content:center;
                color:#f0f0f5;padding:16px;
            }
            .card{
                background:rgba(255,255,255,0.04);backdrop-filter:blur(40px) saturate(1.4);
                -webkit-backdrop-filter:blur(40px) saturate(1.4);
                border-radius:32px;border:1px solid rgba(255,255,255,0.06);
                box-shadow:0 32px 64px rgba(0,0,0,0.5),inset 0 1px 0 rgba(255,255,255,0.06);
                padding:40px 28px;width:100%;max-width:420px;text-align:center;
                animation:floatIn 0.7s cubic-bezier(0.16,1,0.3,1);
            }
            .icon{
                width:64px;height:64px;
                background:linear-gradient(135deg,rgba(255,255,255,0.08),rgba(255,255,255,0.03));
                border-radius:20px;margin:0 auto 24px;
                display:flex;align-items:center;justify-content:center;
                border:1px solid rgba(255,255,255,0.04);
            }
            .icon svg{width:26px;height:26px}
            h1{font-size:26px;font-weight:800;color:#fff;letter-spacing:-0.6px;line-height:1.15}
            .sub{font-size:13px;color:rgba(255,255,255,0.35);margin:6px 0 28px;font-weight:500;letter-spacing:0.2px}
            .err{
                background:rgba(255,69,58,0.08);color:#ff6b6b;
                border:1px solid rgba(255,69,58,0.1);border-radius:14px;
                padding:12px 16px;font-size:12px;font-weight:600;margin-bottom:20px;
                text-align:left;backdrop-filter:blur(8px);
            }
            input{
                width:100%;padding:15px 16px;border-radius:14px;
                border:1px solid rgba(255,255,255,0.06);
                background:rgba(0,0,0,0.3);color:#fff;font-size:15px;margin-bottom:10px;
                outline:none;transition:all 0.3s cubic-bezier(0.16,1,0.3,1);
            }
            input:focus{border-color:var(--accent);box-shadow:0 0 0 4px rgba(255,255,255,0.03),0 4px 12px rgba(0,0,0,0.2);background:rgba(0,0,0,0.4)}
            input::placeholder{color:rgba(255,255,255,0.2)}
            button{
                background:linear-gradient(135deg,var(--accent),#0056cc);color:#fff;border:none;width:100%;padding:15px;
                border-radius:14px;font-weight:700;font-size:15px;cursor:pointer;
                margin-top:8px;transition:all 0.3s cubic-bezier(0.16,1,0.3,1);
                box-shadow:0 4px 16px rgba(0,122,255,0.25);
            }
            button:hover{filter:brightness(1.1);transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,122,255,0.35)}
            button:active{transform:scale(0.97)}
            .pw-wrap{position:relative}
            .pw-wrap input{padding-right:46px}
            .pw-toggle{
                position:absolute;right:8px;top:50%;transform:translateY(-50%);
                width:32px;height:32px;padding:0;margin:0;background:transparent;
                border:none;border-radius:8px;font-size:15px;cursor:pointer;
                display:flex;align-items:center;justify-content:center;opacity:0.55;
                box-shadow:none;transition:all 0.2s;
            }
            .pw-toggle:hover{opacity:1;filter:none;background:rgba(255,255,255,0.06);transform:translateY(-50%)}
            .pw-toggle:active{transform:translateY(-50%) scale(0.88)}
            .footer{margin-top:24px;font-size:13px;color:rgba(255,255,255,0.3)}
            a{color:var(--accent);text-decoration:none;font-weight:600;letter-spacing:0.2px}
            a:hover{opacity:0.8}
            @media(max-width:420px){.card{padding:28px 18px}h1{font-size:22px}}
        </style>
    </head><body>
        <div class="card">
            <div class="icon">${icon}</div>
            <h1>${title}</h1>
            <p class="sub">${subtitle}</p>
            ${error ? `<div class="err">${escapeHTML(error)}</div>` : ''}
            <form method="POST">${fields}</form>
            <div class="footer">${footer}</div>
        </div>
        <script>
            function togglePw(btn){
                const input = btn.previousElementSibling;
                const show = input.type === 'password';
                input.type = show ? 'text' : 'password';
                btn.textContent = show ? '🙈' : '👁';
            }
        </script>
    </body></html>`;
}

function loginPage(error = '', req = null) {
    const csrf = req ? csrfToken(req) : '';
    return sPage('Sign In', 'Sign in to your account',
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z" fill="#007aff"/></svg>',
        '#007aff',
        `<input type="hidden" name="_csrf" value="${csrf}">
         <input name="username" placeholder="Username" required autofocus>
         <div class="pw-wrap">
             <input name="password" type="password" placeholder="Password" required>
             <button type="button" class="pw-toggle" onclick="togglePw(this)" aria-label="Show password">👁</button>
         </div>
         <button type="submit">Sign In</button>`,
        `Having problems? Contact the admin on <a href="https://wa.me/${ADMIN_CONTACT}" target="_blank" rel="noopener" style="color:var(--accent)">WhatsApp</a>.<br>New here? <a href="/register">Create account</a>`,
        error
    );
}

// Invite codes are only demanded once the first account exists — a fresh
// install has a chicken-and-egg problem otherwise. The first signup is the
// admin (via ADMIN_USERNAMES). On a DB error this fails closed (invite
// required) rather than open.
function inviteRequired() {
    try { return Object.keys(loadDB()).length > 0; }
    catch (e) { return true; }
}

// Registration is invite-only. Admin sets INVITE_CODE (comma separated for
// multiple codes); with none set, registration is closed. Users with problems
// are pointed at the admin's WhatsApp.
const ADMIN_CONTACT = process.env.ADMIN_CONTACT || '233531556024';
const contactFooter = `Having problems or want an account? Contact the admin on <a href="https://wa.me/${ADMIN_CONTACT}" target="_blank" rel="noopener" style="color:var(--accent)">WhatsApp</a>.`;

function registerPage(error = '', req = null) {
    const csrf = req ? csrfToken(req) : '';
    return sPage('Create Account', 'Join the AutoViewer platform',
        '<svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z" fill="#007aff"/></svg>',
        '#007aff',
        `<input type="hidden" name="_csrf" value="${csrf}">
         <input name="username" placeholder="Choose Username" required autofocus>
         <div class="pw-wrap">
             <input name="password" type="password" placeholder="Choose Password" required>
             <button type="button" class="pw-toggle" onclick="togglePw(this)" aria-label="Show password">👁</button>
         </div>
         ${inviteRequired() ? '<input name="invite" placeholder="Invite Code" required>' : ''}
         <button type="submit">Sign Up</button>`,
        `${inviteRequired() ? `Registration is invite-only. ${contactFooter}<br>` : `<strong>First account</strong> — no invite needed; it becomes the admin.${contactFooter ? '<br>' + contactFooter : ''}<br>`}Already registered? <a href="/login">Sign In</a>`,
        error
    );
}


module.exports = {
    csrfToken,
    escapeHTML,
    sPage,
    loginPage,
    registerPage,
    inviteRequired,
};
