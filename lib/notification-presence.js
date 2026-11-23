'use strict';

// Automatic presence must leave the linked client inactive so the primary
// phone can receive push notifications. Explicit visual presence is opt-in.
module.exports = mode => !['online', 'available', 'typing', 'recording'].includes(mode);
