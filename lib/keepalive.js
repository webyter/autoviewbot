'use strict';

// lib/keepalive.js — keep the service awake on hosts that sleep when idle.
//
// Render's free web services spin down after 15 minutes without inbound
// traffic. A request from the instance to its OWN public hostname travels
// out through Render's edge and comes back as ordinary inbound traffic, so a
// self-ping reliably prevents the spin-down.
//
// Two honest caveats (they are the reason this module reports its state
// loudly instead of failing silently):
//   1) A self-ping PREVENTS sleep; it cannot WAKE a service that is already
//      asleep. After a redeploy the first visitor still pays the cold start
//      (Render boots a Free service in roughly a minute). An external
//      monitor (UptimeRobot / cron-job.org / GitHub Actions) is the only
//      thing that can wake it — see docs/PRODUCTION.md.
//   2) Render's Free tier has an EPHEMERAL filesystem: WhatsApp sessions and
//      the user database are lost on every spin-down, restart or redeploy.
//      Keep-alive cannot fix that — it needs a persistent disk (paid) or
//      external storage.
//
// The pinger never throws into the request path and never keeps the process
// alive on its own.

const https = require('https');
const http = require('http');

const DEFAULT_INTERVAL_MIN = 9;      // Render sleeps at 15 min — stay well under
const MIN_INTERVAL_MIN = 2;
const MAX_INTERVAL_MIN = 14;
const REQUEST_TIMEOUT_MS = 8000;
const JITTER_RATIO = 0.15;

// Which platforms sleep when idle and how they advertise themselves.
const PLATFORMS = [
    { name: 'render', env: 'RENDER', urlEnv: 'RENDER_EXTERNAL_URL' },
    { name: 'railway', env: 'RAILWAY_ENVIRONMENT', urlEnv: 'RAILWAY_PUBLIC_DOMAIN' },
    { name: 'fly', env: 'FLY_APP_NAME', urlEnv: null },
    { name: 'replit', env: 'REPL_ID', urlEnv: null },
    { name: 'heroku', env: 'DYNO', urlEnv: null }
];

function detectPlatform(env = process.env) {
    for (const p of PLATFORMS) {
        if (env[p.env]) return p.name;
    }
    return 'generic';
}

function normalizeUrl(url) {
    let u = String(url || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u;
    return u.replace(/\/+$/, '');
}

/**
 * Work out what to ping and how often.
 *
 * Priority for the target URL:
 *   1. KEEPALIVE_URL  — explicit override
 *   2. PUBLIC_URL     — the app's public address
 *   3. RENDER_EXTERNAL_URL / RAILWAY_PUBLIC_DOMAIN — platform-provided
 *   4. (none) — keep-alive stays off, because pinging localhost would
 *      generate no inbound traffic and look alive while doing nothing.
 */
function resolveConfig(env = process.env) {
    const platform = detectPlatform(env);
    const explicit = normalizeUrl(env.KEEPALIVE_URL || env.PING_URL);
    const publicUrl = normalizeUrl(env.PUBLIC_URL);
    let platformUrl = '';
    for (const p of PLATFORMS) {
        if (p.urlEnv && env[p.urlEnv]) { platformUrl = normalizeUrl(env[p.urlEnv]); break; }
    }
    const target = explicit || publicUrl || platformUrl;

    let intervalMin = parseInt(env.KEEPALIVE_INTERVAL_MIN, 10);
    if (!Number.isFinite(intervalMin)) intervalMin = DEFAULT_INTERVAL_MIN;
    intervalMin = Math.min(Math.max(intervalMin, MIN_INTERVAL_MIN), MAX_INTERVAL_MIN);

    // Self-ping only makes sense when we know our PUBLIC address.
    const enabled = !!target && target.length > 0;
    return { platform, target, intervalMin, enabled, explicit: !!explicit, platformUrl, publicUrl };
}

/**
 * Start the keep-alive loop.
 *
 * @param {object} opts
 *   env        – environment to read (default process.env)
 *   log        – logger
 *   pingPath   – path to ping (default '/health')
 * @returns {object} controller with { state, stop() }
 */
function startKeepAlive(opts = {}) {
    const env = opts.env || process.env;
    const log = opts.log || (() => {});
    const pingPath = opts.pingPath || '/health';
    const cfg = resolveConfig(env);

    const state = {
        enabled: cfg.enabled,
        platform: cfg.platform,
        target: cfg.target,
        intervalMin: cfg.intervalMin,
        pings: 0,
        failures: 0,
        lastPingAt: null,
        lastStatus: null,
        lastError: null,
        startedAt: Date.now()
    };

    if (!cfg.enabled) {
        log(`[KeepAlive] disabled — no public URL (set PUBLIC_URL or KEEPALIVE_URL). Platform=${cfg.platform}.`);
        return { state, stop() {} };
    }

    const url = cfg.target + pingPath;

    const ping = () => {
        const lib = url.startsWith('http://') ? http : https;
        const req = lib.get(url, { family: 4, timeout: REQUEST_TIMEOUT_MS }, (res) => {
            state.pings++;
            state.lastPingAt = Date.now();
            state.lastStatus = res.statusCode;
            if (res.statusCode !== 200) {
                state.failures++;
                state.lastError = `HTTP ${res.statusCode}`;
                log(`[KeepAlive] ping returned ${res.statusCode}`);
            } else {
                state.lastError = null;
            }
            res.resume();
        });
        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
        });
        req.on('error', (e) => {
            state.pings++;
            state.failures++;
            state.lastPingAt = Date.now();
            state.lastStatus = null;
            state.lastError = e.message;
            log(`[KeepAlive] ping failed: ${e.message}`);
        });
    };

    // Ping straight away, then every interval with jitter so many instances
    // do not hit the platform in lockstep.
    const jitter = () => cfg.intervalMin * 60 * 1000 * (1 + (Math.random() * 2 - 1) * JITTER_RATIO);
    setTimeout(ping, 2000);
    const timer = setInterval(ping, jitter());
    if (timer.unref) timer.unref();

    log(`[KeepAlive] enabled (platform=${cfg.platform}) — pinging ${url} every ~${cfg.intervalMin} min`);

    if (cfg.platform === 'render') {
        log('[KeepAlive] NOTE: Render Free has an EPHEMERAL filesystem — WhatsApp sessions and the user DB are lost on spin-down/restart/redeploy. Keep-alive prevents sleep; it does not preserve data. See docs/PRODUCTION.md.');
    }

    return {
        state,
        stop() { clearInterval(timer); }
    };
}

module.exports = {
    startKeepAlive,
    resolveConfig,
    detectPlatform,
    normalizeUrl,
    DEFAULT_INTERVAL_MIN,
    MIN_INTERVAL_MIN,
    MAX_INTERVAL_MIN
};
