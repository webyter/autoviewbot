'use strict';

// Filter trace output before writing it: never persist XML message bodies,
// encryption data, contact addresses, names, or receipt message IDs.
module.exports = function presenceDiagnostics(output) {
    return { write(line) {
        let entry;
        try { entry = JSON.parse(line); } catch { return; }
        if (entry.level >= 40) { output.write(line); return; }
        if (entry.msg !== 'xml send' || typeof entry.xml !== 'string') return;
        const header = entry.xml.trim().match(/^<(presence|receipt)\b([^>]*)>/);
        if (!header) return;
        const type = header[2].match(/\btype=["']([^"']*)["']/)?.[1];
        output.write(JSON.stringify({
            level: 30, time: entry.time, pid: entry.pid,
            msg: 'Notification transport diagnostic',
            stanza: header[1], type: type || (header[1] === 'presence' ? 'available (implicit)' : 'delivery')
        }) + '\n');
    } };
};
