'use strict';
const fs = require('fs');
const path = require('path');

function canonical(value) {
    try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

// A process-name sweep crosses installation and test boundaries. Only reap
// workers using this exact script and session directory, optionally scoped
// to one account. The manager already holds that directory's instance lock.
module.exports = function cleanupWorkers({ script, sessionBase, username }) {
    const killed = [];
    let processes;
    try { processes = fs.readdirSync('/proc'); } catch { return killed; }
    const expectedScript = canonical(script);
    const expectedSession = canonical(sessionBase);
    for (const entry of processes) {
        if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
        const proc = path.join('/proc', entry);
        try {
            if (typeof process.getuid === 'function' && fs.statSync(proc).uid !== process.getuid()) continue;
            if (canonical(fs.readlinkSync(path.join(proc, 'exe'))) !== canonical(process.execPath)) continue;
            const args = fs.readFileSync(path.join(proc, 'cmdline'), 'utf8').split('\0');
            const index = args.findIndex(arg => arg === script || arg === expectedScript);
            if (index < 1 || (username && args[index + 1] !== username)) continue;
            const cwd = fs.readlinkSync(path.join(proc, 'cwd'));
            const env = fs.readFileSync(path.join(proc, 'environ'), 'utf8').split('\0');
            const configured = env.find(value => value.startsWith('SESSION_DIR='))?.slice(12);
            const actualSession = configured ? path.resolve(cwd, configured) : path.join(path.dirname(expectedScript), 'session');
            if (canonical(actualSession) !== expectedSession) continue;
            process.kill(Number(entry), 'SIGTERM');
            killed.push(Number(entry));
        } catch { /* Process exited, inaccessible, or not a matching worker. */ }
    }
    return killed;
};
