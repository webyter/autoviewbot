'use strict';

const $ = (id) => document.getElementById(id);
let timer;
let toastTimer;
let refreshing = false;
let settingsDirty = false;
let refreshError = '';
let settingsSaveTimer;
let settingsSaving = false;
let settingsSaveQueued = false;
let settingsRevision = 0;
let pairingMode = false;
let currentConnectionMethod = 'qr';
let connectionRequestPending = false;
try {
  const savedMethod = localStorage.getItem('wa_conn_method');
  if (savedMethod === 'pairing') currentConnectionMethod = 'pairing';
} catch {}

function setConnectionMethod(method) {
  currentConnectionMethod = method === 'pairing' ? 'pairing' : 'qr';
  try {
    localStorage.setItem('wa_conn_method', currentConnectionMethod);
  } catch {}
  updateConnectionMethodUI();
}

function updateConnectionMethodUI() {
  const section = $('connection-section');
  const qrTab = $('switch-method-qr');
  const pairingTab = $('switch-method-pairing');
  if (!section) return;

  section.setAttribute('data-conn-method', currentConnectionMethod);

  if (qrTab && pairingTab) {
    const isQr = currentConnectionMethod === 'qr';
    qrTab.classList.toggle('active', isQr);
    qrTab.setAttribute('aria-selected', isQr ? 'true' : 'false');
    pairingTab.classList.toggle('active', !isQr);
    pairingTab.setAttribute('aria-selected', !isQr ? 'true' : 'false');
  }
}

function readCookie(name) {
  const m = document.cookie.match(new RegExp('(?:^|; )' + name.replace(/([.$?*|{}()[\]\\/+^])/g, '\\$1') + '=([^;]*)'));
  return m ? decodeURIComponent(m[1]) : '';
}

async function api(path, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const headers = {
    ...(options.body ? { 'content-type': 'application/json' } : {}),
    ...options.headers,
  };
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) {
    const csrf = readCookie('av_csrf');
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const response = await fetch(path, { cache: 'no-store', credentials: 'same-origin', ...options, headers });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || data.message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function show(message, isError = false) {
  const toast = $('message');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3600);
}

function markDirty() {
  settingsRevision += 1;
  settingsDirty = true;
  const button = document.getElementById('save-settings');
  if (button) button.disabled = false;
}

function queueAutoSave(delay = 400) {
  markDirty();
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null;
    saveSettings({ silent: true });
  }, delay);
}

// Server errors are technical; say what the person can do about them.
function friendlyError(error) {
  const status = error?.status;
  if (status === 429) return 'Too many attempts just now. Wait a few minutes and try again.';
  if (status === 413) return 'That request was too large.';
  if (status === 403) return error?.message && error.message !== 'Request failed (403)' ? error.message : 'You do not have access to that.';
  if (status >= 500) return 'The server had a problem. Try again in a moment.';
  if (error?.name === 'TypeError') return 'Cannot reach the server. Check your connection and try again.';
  return error?.message || 'Something went wrong. Try again.';
}

function setAuthenticated(authenticated) {
  $('login').hidden = authenticated;
  $('dashboard').hidden = !authenticated;
  if (authenticated) {
    try {
      localStorage.setItem('wa_auth', '1');
      document.documentElement.classList.add('is-auth');
    } catch {}
  } else {
    try {
      localStorage.removeItem('wa_auth');
      localStorage.removeItem('wa_status');
      document.documentElement.classList.remove('is-auth', 'is-connected');
    } catch {}
  }
  clearInterval(timer);
  window.dispatchEvent(new CustomEvent('workspace-auth', { detail: { authenticated } }));
  if (!authenticated) {
    // A failure from the previous session must not silence the next one.
    refreshError = '';
    return;
  }
  settingsDirty = false;
  refresh();
  timer = setInterval(() => {
    // A background tab does not need to poll; returning to it refreshes once.
    if (!document.hidden) refresh();
  }, 5000);
}

function setStatus(status = 'unknown') {
  const normalized = String(status).toLowerCase();
  const connected = normalized === 'connected';
  const pending = connectionRequestPending || ['connecting', 'pairing', 'reconnecting', 'disconnecting'].includes(normalized);

  if (connected) {
    try {
      localStorage.setItem('wa_status', 'connected');
      document.documentElement.classList.add('is-connected');
    } catch {}
  } else {
    try {
      localStorage.removeItem('wa_status');
      document.documentElement.classList.remove('is-connected');
    } catch {}
  }

  $('status').dataset.state = normalized;
  $('status-label').textContent = normalized.replaceAll('-', ' ');
  $('connection-title').textContent = connected
    ? 'Your WhatsApp is linked.'
    : normalized === 'pairing'
      ? 'Waiting for pairing…'
      : pending
        ? 'Connecting…'
        : normalized === 'logged-out'
          ? 'WhatsApp logged this device out.'
          : 'Link your WhatsApp to start.';
  $('connection-note').textContent = connected
    ? 'Commands and settings apply to this account.'
    : normalized === 'pairing'
      ? 'Enter the pairing code in WhatsApp on your phone.'
      : normalized === 'logged-out'
        ? 'Link it again with a QR code or a pairing code.'
        : 'In WhatsApp, open Settings → Linked devices → Link a device, then scan the QR code. Or enter your number to use a pairing code.';
  $('connection-controls').hidden = connected;
  $('qr-panel').hidden = connected;
  $('linked-account').hidden = !connected;
  if ($('connection-method-switcher')) {
    $('connection-method-switcher').hidden = connected;
  }
  if (!connected) {
    updateConnectionMethodUI();
  }
  $('connect').disabled = pending;
  $('generate-qr').disabled = pending || connected;
  if ($('refresh-qr')) $('refresh-qr').disabled = pending || connected;
  const canDisconnect = !['disconnected', 'logged-out', 'unknown'].includes(normalized);
  $('disconnect').disabled = !canDisconnect;
  if ($('disconnect-hint')) {
    $('disconnect-hint').textContent = connected
      ? 'Unlink this WhatsApp account from Autoviewer.'
      : canDisconnect
        ? 'Stop the current connection attempt or pairing session.'
        : 'No active WhatsApp session.';
  }
}

function renderLinkedAccount(account) {
  const image = $('linked-avatar');
  const fallback = $('linked-avatar-fallback');
  let profilePictureUrl = '';
  $('linked-account-name').textContent = account?.name || 'WhatsApp account';
  $('linked-account-phone').textContent = account?.phoneNumber
    ? `+${account.phoneNumber}`
    : 'Connected to WhatsApp';
  if (typeof account?.profilePictureUrl === 'string') {
    try {
      const url = new URL(account.profilePictureUrl);
      if (url.protocol === 'https:') profilePictureUrl = url.href;
    } catch {}
  }

  if (image.dataset.profileUrl === profilePictureUrl) return;
  image.dataset.profileUrl = profilePictureUrl;
  image.hidden = true;
  fallback.hidden = false;
  if (!profilePictureUrl) {
    image.onload = null;
    image.onerror = null;
    image.removeAttribute('src');
    return;
  }
  image.onload = () => {
    image.hidden = false;
    fallback.hidden = true;
  };
  image.onerror = () => {
    image.hidden = true;
    fallback.hidden = false;
  };
  image.src = profilePictureUrl;
}

function applySettings(settings = {}) {
  $('recoveryMessages').checked = settings.recoverDeleted === true;
  $('recoveryStatuses').checked = settings.recoverDeletedStatus === true;
  $('antiViewOnce').checked = settings.antiViewOnce !== false;
  $('anticall').checked = settings.anticall === true;
  const autoReplyActive = settings.chatAI === true && settings.autoReply !== false;
  $('autoReply').checked = autoReplyActive;
  $('voiceNotes').checked = Boolean(settings.voiceNotes !== false && autoReplyActive);
  $('voiceNotes').disabled = !autoReplyActive;
  $('voiceNotes').closest('.row')?.classList.toggle('row-disabled', !autoReplyActive);
  const rawPresence = settings.presence ?? (settings.ghostMode ? 'off' : 'auto');
  const normalizedPresence = rawPresence === true ? 'auto' : (rawPresence === false ? 'off' : (rawPresence === 'available' ? 'online' : (rawPresence === 'composing' ? 'typing' : String(rawPresence))));
  $('presence').value = ['auto', 'online', 'typing', 'recording', 'off'].includes(normalizedPresence) ? normalizedPresence : 'auto';
  $('autoStatusView').checked = settings.autoStatusView === true;
  const statusReactOn = settings.statusReact !== false && (Array.isArray(settings.statusReaction) ? settings.statusReaction.length > 0 : Boolean(settings.statusReaction));
  $('statusReact').checked = statusReactOn;
  const reactions = Array.isArray(settings.statusReaction)
    ? settings.statusReaction.join(', ')
    : (typeof settings.statusReaction === 'string' && settings.statusReaction ? settings.statusReaction.split(/[\s,]+/).filter(Boolean).join(', ') : '💚');
  $('statusReactionEmojis').value = reactions;
  $('statusReactionRow')?.classList.toggle('row-disabled', !statusReactOn);
  $('statusReactionEmojis').disabled = !statusReactOn;
  $('antiTagStatus').checked = settings.antiTagStatus === true;
  $('groupAI').checked = settings.groupChatAI === true;
  const adminToolsActive = settings.groupAdminTools === true;
  $('groupAdminTools').checked = adminToolsActive;
  $('antiLink').checked = adminToolsActive && settings.antiLink === true;
  $('antiLink').disabled = !adminToolsActive;
  $('antiLink').closest('.row')?.classList.toggle('row-disabled', !adminToolsActive);
  $('publicMode').checked = (settings.mode || 'public') === 'public';
  $('commandPrefix').value = settings.commandPrefix || '.';
  $('aiPersona').value = settings.aiSystemPrompt || '';
  const saveButton = document.getElementById('save-settings');
  if (saveButton) saveButton.disabled = true;
}

function clearQr() {
  $('qr').removeAttribute('src');
  $('qr').hidden = true;
  $('qr-wrap').hidden = true;
  if (!pairingMode) $('qr-placeholder').hidden = false;
}

function showPairingPanel(code, message) {
  pairingMode = true;
  $('qr-placeholder').hidden = true;
  $('qr-wrap').hidden = true;
  $('pairing-panel').hidden = false;
  $('pairing-panel-copy').textContent = message || (code ? 'Enter this code in WhatsApp → Linked devices → Link with phone number.' : 'Generating pairing code…');
  $('pairing-panel-code-wrap').hidden = !code;
  $('pairing-panel-code').textContent = code || '';
  const copyBtn = $('copy-pairing-panel');
  if (copyBtn) copyBtn.dataset.code = code || '';
}

function hidePairingPanel() {
  pairingMode = false;
  $('pairing-panel').hidden = true;
  $('pairing-panel-code-wrap').hidden = true;
  $('pairing-panel-code').textContent = '';
  const copyBtn = $('copy-pairing-panel');
  if (copyBtn) copyBtn.dataset.code = '';
}

function updateRentalStatus(data = {}) {
  const banner = $('rental-banner');
  const message = $('rental-message');
  const icon = $('rental-icon');
  if (!banner || !message) return;

  if (data.isAdmin) {
    banner.hidden = true;
    return;
  }

  if (data.rentalExpired) {
    banner.hidden = false;
    banner.classList.add('expired');
    message.textContent = 'Rental expired. Your WhatsApp bot has been wiped. Please contact the administrator to renew access.';
    $('connect').disabled = true;
    $('generate-qr').disabled = true;
    if ($('refresh-qr')) $('refresh-qr').disabled = true;
    $('connection-title').textContent = 'Rental Expired';
    $('connection-note').textContent = 'Your rental duration has ended and your bot was wiped. Contact the administrator for access.';
    $('qr-panel').hidden = true;
    $('connection-controls').hidden = true;
    clearQr();
    hidePairingPanel();
  } else if (data.rentalExpiresAt) {
    banner.hidden = false;
    banner.classList.remove('expired');
    const days = data.rentalDaysLeft ?? 0;
    message.textContent = days === 1
      ? 'Rental access: 1 day remaining'
      : `Rental access: ${days} days remaining`;
  } else {
    banner.hidden = true;
  }
}

async function loadNotifications() {
  const wrap = $('notifications-wrap');
  if (!wrap || $('dashboard').hidden) return;
  try {
    const data = await api('/api/notifications');
    const items = Array.isArray(data.notifications) ? data.notifications : [];
    if (!items.length) {
      wrap.replaceChildren();
      wrap.hidden = true;
      return;
    }
    wrap.replaceChildren();
    wrap.hidden = false;
    for (const notif of items) {
      const card = document.createElement('div');
      card.className = `notification-banner ${notif.type || 'announcement'}`;
      card.setAttribute('role', 'alert');

      const iconWrap = document.createElement('span');
      iconWrap.className = 'notification-icon';
      iconWrap.setAttribute('aria-hidden', 'true');
      iconWrap.innerHTML = notif.type === 'alert'
        ? '<svg class="icon-svg" viewBox="0 0 24 24"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>'
        : notif.type === 'warning'
          ? '<svg class="icon-svg" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
          : '<svg class="icon-svg" viewBox="0 0 24 24"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>';

      const content = document.createElement('div');
      content.className = 'notification-content';
      const heading = document.createElement('strong');
      heading.className = 'notification-heading';
      heading.textContent = notif.title;
      const text = document.createElement('p');
      text.className = 'notification-text';
      text.textContent = notif.message;
      const time = document.createElement('span');
      time.className = 'notification-time';
      time.textContent = notif.created_at ? new Date(notif.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
      content.append(heading, text, time);

      const dismissBtn = document.createElement('button');
      dismissBtn.type = 'button';
      dismissBtn.className = 'button button-quiet notification-dismiss';
      dismissBtn.textContent = 'Dismiss';
      dismissBtn.addEventListener('click', async () => {
        try {
          await api(`/api/notifications/${encodeURIComponent(notif.id)}/dismiss`, { method: 'POST', body: '{}' });
          card.remove();
          if (!wrap.children.length) wrap.hidden = true;
        } catch (err) {
          show(friendlyError(err), true);
        }
      });

      card.append(iconWrap, content, dismissBtn);
      wrap.appendChild(card);
    }
  } catch {
    // Keep existing
  }
}

async function refresh() {
  if ($('dashboard').hidden || refreshing) return;
  refreshing = true;
  try {
    const data = await api('/api/session');
    refreshError = '';
    setStatus(data.status);
    renderLinkedAccount(data.linkedAccount);
    updateRentalStatus(data);
    loadNotifications();
    $('admin-nav').hidden = data.isAdmin !== true;
    if (!settingsDirty && !settingsSaving && !settingsSaveTimer) applySettings(data.settings);

    if (data.rentalExpired) {
      return;
    }

    const hasPairingCode = data.status !== 'connected' && Boolean(data.pairingCode);

    if (hasPairingCode) {
      showPairingPanel(data.pairingCode, 'Enter this code in WhatsApp → Linked devices → Link with phone number.');
      $('pairing').hidden = false;
      const formatted = (data.pairingCode.length === 8 && !data.pairingCode.includes('-'))
        ? `${data.pairingCode.slice(0, 4)}-${data.pairingCode.slice(4)}`
        : data.pairingCode;
      $('pairing-code').textContent = formatted;
      if ($('copy-pairing')) $('copy-pairing').dataset.code = data.pairingCode;
    } else if (pairingMode) {
      $('pairing').hidden = true;
      // Keep showing pairing panel while waiting for code in pairing/connecting states.
      if (data.status === 'qr') {
        hidePairingPanel();
      } else if (['connecting', 'pairing', 'reconnecting'].includes(data.status)) {
        showPairingPanel('', data.status === 'pairing' ? 'Waiting for pairing code…' : 'Requesting pairing code…');
      } else if (['disconnected', 'logged-out', 'connected'].includes(data.status)) {
        hidePairingPanel();
      } else {
        showPairingPanel('', 'Requesting pairing code…');
      }
    }

    if (!pairingMode && data.qr) {
      try {
        const qr = await api('/api/session/qr');
        $('qr').onerror = () => {
          clearQr();
          show('Could not display the QR code. Request a new one.', true);
        };
        $('qr').src = qr.dataUrl;
        $('qr').hidden = false;
        $('qr-wrap').hidden = false;
        $('qr-placeholder').hidden = true;
      } catch (error) {
        if (error.status !== 404) throw error;
        clearQr();
      }
    } else if (!pairingMode) {
      clearQr();
    }
  } catch (error) {
    if (error.status === 401) {
      signOut();
      return;
    }
    // This poll repeats every five seconds: announce a new failure once.
    const message = friendlyError(error);
    if (message !== refreshError) {
      refreshError = message;
      show(message, true);
    }
  } finally {
    refreshing = false;
  }
}

function signOut() {
  try {
    localStorage.removeItem('wa_auth');
    localStorage.removeItem('wa_status');
    document.documentElement.classList.remove('is-auth', 'is-connected');
  } catch {}
  api('/api/logout', { method: 'POST', body: '{}' }).catch(() => {});
  clearInterval(timer);
  setAuthenticated(false);
}



async function submitLogin() {
  const username = $('username').value.trim();
  const password = $('password').value;
  if (!username || !password) {
    show('Enter your username and password.', true);
    return;
  }
  $('login-button').disabled = true;
  try {
    await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    $('password').value = '';
    setAuthenticated(true);
    show('Signed in.');
  } catch (error) {
    show(friendlyError(error), true);
  } finally {
    $('login-button').disabled = false;
  }
}

async function requestConnection(phoneNumber) {
  if (connectionRequestPending) return;
  connectionRequestPending = true;
  for (const id of ['connect', 'generate-qr', 'refresh-qr']) $(id).disabled = true;
  try {
    if (phoneNumber) {
      showPairingPanel('', 'Requesting pairing code…');
    } else {
      hidePairingPanel();
    }
    await api('/api/session/connect', {
      method: 'POST',
      body: JSON.stringify({ phoneNumber }),
    });
    show(phoneNumber ? 'Pairing code requested.' : 'Connection requested.');
  } catch (error) {
    if (phoneNumber) hidePairingPanel();
    show(friendlyError(error), true);
  } finally {
    connectionRequestPending = false;
    await refresh().catch(() => {});
  }
}

async function disconnectSession() {
  try {
    await api('/api/session/disconnect', { method: 'POST', body: '{}' });
    show('Disconnect requested.');
    await refresh();
  } catch (error) {
    show(friendlyError(error), true);
  }
}

function extractEmojis(value) {
  if (Array.isArray(value)) return value.filter((e) => typeof e === 'string' && e.trim()).slice(0, 10);
  if (typeof value !== 'string') return [];
  const tokens = value.includes(',') ? value.split(',') : value.trim().split(/\s+/);
  const result = [];
  const segmenter = typeof Intl?.Segmenter === 'function' ? new Intl.Segmenter('en', { granularity: 'grapheme' }) : null;
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    if (segmenter) {
      for (const seg of segmenter.segment(trimmed)) {
        const s = seg.segment.trim();
        if (/\p{Extended_Pictographic}/u.test(s)) result.push(s);
      }
    } else {
      if (/\p{Extended_Pictographic}/u.test(trimmed)) result.push(trimmed);
    }
  }
  return result.slice(0, 10);
}

async function saveSettings({ silent = false } = {}) {
  if (settingsSaving) {
    settingsSaveQueued = true;
    return;
  }
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = null;
  const saveRevision = settingsRevision;
  settingsSaving = true;
  const saveButton = document.getElementById('save-settings');
  if (saveButton) saveButton.disabled = true;
  try {
    const autoReply = $('autoReply').checked;
    const statusReactChecked = $('statusReact').checked;
    const emojiList = extractEmojis($('statusReactionEmojis').value);
    const statusReaction = statusReactChecked ? (emojiList.length ? emojiList : ['💚']) : [];
    const payload = {
      recoverDeleted: $('recoveryMessages').checked,
      recoverDeletedStatus: $('recoveryStatuses').checked,
      recoverDeletedMedia: $('recoveryMessages').checked || $('recoveryStatuses').checked,
      antiViewOnce: $('antiViewOnce').checked,
      anticall: $('anticall').checked,
      voiceNotes: autoReply ? $('voiceNotes').checked : false,
      chatAI: autoReply,
      autoReply,
      presence: $('presence').value,
      ghostMode: $('presence').value === 'off',
      autoStatusView: $('autoStatusView').checked,
      statusReact: statusReactChecked,
      statusReaction,
      antiTagStatus: $('antiTagStatus').checked,
      groupChatAI: $('groupAI').checked,
      groupAdminTools: $('groupAdminTools').checked,
      antiLink: $('antiLink').checked,
      mode: $('publicMode').checked ? 'public' : 'self',
      commandPrefix: $('commandPrefix').value.trim() || '.',
      aiSystemPrompt: $('aiPersona').value.trim(),
    };
    let chatAIDeclined = false;
    let result;
    try {
      result = await api('/api/settings', { method: 'PATCH', body: JSON.stringify(payload) });
    } catch (error) {
      // ChatAI cannot be switched on without the server's Groq key. Retrying
      // without that one field keeps every other setting in the save — status
      // viewing among them — instead of losing all of them to it.
      if (!/ChatAI requires/i.test(error?.message || '')) throw error;
      chatAIDeclined = true;
      payload.chatAI = false;
      payload.autoReply = false;
      result = await api('/api/settings', { method: 'PATCH', body: JSON.stringify(payload) });
    }
    if (settingsRevision === saveRevision) {
      settingsDirty = false;
      applySettings(result.settings);
      if (!silent) {
        show(chatAIDeclined
          ? 'Saved. ChatAI needs the administrator’s Groq key, so auto-reply stayed off.'
          : 'Settings saved.');
      }
    } else {
      // Keep edits made while the request was in flight and persist them next.
      settingsDirty = true;
      settingsSaveQueued = true;
    }
  } catch (error) {
    show(friendlyError(error), true);
  } finally {
    settingsSaving = false;
    if (saveButton) saveButton.disabled = !settingsDirty;
    if (settingsSaveQueued) {
      settingsSaveQueued = false;
      saveSettings({ silent: true });
    }
  }
}

async function restoreAuthentication() {
  // Sessions live in an HttpOnly cookie, so only the server can confirm one.
  try {
    await api('/api/session');
    setAuthenticated(true);
  } catch {
    setAuthenticated(false);
  }
}

$('login-button').addEventListener('click', submitLogin);
$('username').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('login-button').click();
});
$('password').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') $('login-button').click();
});

$('connect').addEventListener('click', async () => {
  const phoneNumber = $('phone').value.trim();
  if (!phoneNumber) {
    show('Enter your phone number with country code to get a pairing code.', true);
    $('phone').focus();
    return;
  }
  const clean = phoneNumber.replace(/\D/g, '');
  if (clean.startsWith('0')) {
    show('Include your country code (e.g. 233... or 1...) without leading 0.', true);
    $('phone').focus();
    return;
  }
  setConnectionMethod('pairing');
  await requestConnection(phoneNumber);
});
$('generate-qr').addEventListener('click', async () => {
  setConnectionMethod('qr');
  await requestConnection(null);
});
$('refresh-qr').addEventListener('click', async () => {
  setConnectionMethod('qr');
  await requestConnection(null);
});
$('disconnect').addEventListener('click', disconnectSession);

const saveSettingsButton = document.getElementById('save-settings');
if (saveSettingsButton) saveSettingsButton.addEventListener('click', saveSettings);
$('signout').addEventListener('click', signOut);
$('copy-pairing').addEventListener('click', async () => {
  const code = $('copy-pairing').dataset.code || $('pairing-code')?.textContent || '';
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code.trim());
    show('Pairing code copied.');
  } catch {
    show('Select the code and copy it by hand.', true);
  }
});
const copyPairingPanel = document.getElementById('copy-pairing-panel');
if (copyPairingPanel) copyPairingPanel.addEventListener('click', async () => {
  const code = copyPairingPanel.dataset.code || $('pairing-panel-code')?.textContent || '';
  if (!code) return;
  try {
    await navigator.clipboard.writeText(code.trim());
    show('Pairing code copied.');
  } catch {
    show('Select the code and copy it by hand.', true);
  }
});
const backToQr = document.getElementById('back-to-qr');
if (backToQr) backToQr.addEventListener('click', async () => {
  setConnectionMethod('qr');
  hidePairingPanel();
  await requestConnection(null);
});

$('switch-method-qr').addEventListener('click', () => setConnectionMethod('qr'));
$('switch-method-pairing').addEventListener('click', () => setConnectionMethod('pairing'));

for (const id of [
  'recoveryMessages', 'recoveryStatuses', 'antiViewOnce', 'anticall', 'voiceNotes',
  'autoReply', 'autoStatusView', 'statusReact', 'antiTagStatus', 'groupAI',
  'groupAdminTools', 'antiLink', 'publicMode', 'presence',
]) {
  $(id).addEventListener('change', () => queueAutoSave(250));
}
$('statusReact').addEventListener('change', () => {
  const on = $('statusReact').checked;
  $('statusReactionEmojis').disabled = !on;
  $('statusReactionRow')?.classList.toggle('row-disabled', !on);
});
$('statusReactionEmojis').addEventListener('input', () => queueAutoSave(600));
$('autoReply').addEventListener('change', () => {
  const on = $('autoReply').checked;
  $('voiceNotes').disabled = !on;
  $('voiceNotes').closest('.row')?.classList.toggle('row-disabled', !on);
  if (!on) {
    $('voiceNotes').checked = false;
  }
});
$('groupAdminTools').addEventListener('change', () => {
  const on = $('groupAdminTools').checked;
  $('antiLink').disabled = !on;
  $('antiLink').closest('.row')?.classList.toggle('row-disabled', !on);
  if (!on) {
    $('antiLink').checked = false;
  }
});
$('commandPrefix').addEventListener('input', () => queueAutoSave(700));
$('aiPersona').addEventListener('input', () => queueAutoSave(900));
document.querySelectorAll('.persona-pill').forEach((pill) => {
  pill.addEventListener('click', () => {
    const prompt = pill.dataset.prompt ?? pill.textContent.trim();
    $('aiPersona').value = prompt;
    queueAutoSave(300);
  });
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !$('dashboard').hidden) refresh();
});

async function initContactAdmin() {
  const link = $('login-contact-admin');
  if (!link) return;
  try {
    const res = await fetch('/api/public-settings', { cache: 'no-store' });
    const data = await res.json().catch(() => ({}));
    if (data.adminWhatsApp) {
      const phone = data.adminWhatsApp.replace(/[^0-9]/g, '');
      const text = encodeURIComponent('Hello Admin, I need help with my Autoviewer account.');
      link.href = `https://wa.me/${phone}?text=${text}`;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
  } catch {
    // Fail silently
  }
}

initContactAdmin();
restoreAuthentication();
