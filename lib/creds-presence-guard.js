'use strict';

// rc14's creds.update listener announces a bare <presence/> when a partial
// patch has no push name (#2553/#2789). Bare presence means available and
// suppresses primary-phone notifications. Supply the unchanged identity in
// partial patches before the library's own listener sees them.
module.exports = function guardCredentialPresence(sock, state) {
    const emit = sock.ev.emit.bind(sock.ev);
    sock.ev.emit = (event, update) => {
        if (event === 'creds.update' && update && state.creds.me) {
            const me = { ...state.creds.me, ...update.me };
            if (typeof me.name !== 'string' || !me.name.length) me.name = state.creds.me.name;
            return emit(event, { ...update, me });
        }
        return emit(event, update);
    };
};
