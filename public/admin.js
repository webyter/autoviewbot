'use strict';

const $ = (id) => document.getElementById(id);
let users = [];
let toastTimer;

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
  const response = await fetch(path, {
    cache: 'no-store',
    credentials: 'same-origin',
    ...options,
    headers,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || data.message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function show(message, isError = false) {
  const toast = $('admin-message');
  toast.textContent = message;
  toast.classList.toggle('error', isError);
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 3600);
}

function setError(message) {
  $('admin-error').textContent = message;
  $('admin-error').hidden = !message;
}

let pendingRentalUserId = null;

function openRentalModal(userId, username) {
  pendingRentalUserId = userId;
  $('rental-modal-title').textContent = `Extend Rental · ${username || 'Member'}`;
  $('rental-modal-desc').textContent = `Grant or extend rental days for ${username || 'this user'}. Active rental deadlines will have these days appended.`;
  $('rental-modal-days').value = '30';
  $('rental-modal').hidden = false;
  $('rental-modal-days').focus();
}

function closeRentalModal() {
  pendingRentalUserId = null;
  $('rental-modal').hidden = true;
}

function renderUsers() {
  const list = $('admin-users');
  const query = $('user-search').value.trim().toLowerCase();
  const filtered = users.filter((user) =>
    `${user.username || ''} ${user.email || ''}`.toLowerCase().includes(query));
  list.replaceChildren();

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state admin-empty';
    const title = document.createElement('strong');
    title.textContent = users.length ? 'No matching accounts' : 'No accounts found';
    empty.append(title);
    list.append(empty);
    return;
  }

  for (const user of filtered) {
    const card = document.createElement('article');
    card.className = 'admin-user-card';
    const details = document.createElement('div');
    details.className = 'admin-user-details';

    const name = document.createElement('strong');
    name.className = 'admin-user-name';
    name.textContent = user.username || user.email || 'Account';
    const role = document.createElement('span');
    role.className = `admin-role-badge${user.is_admin ? ' admin' : ''}`;
    role.textContent = user.is_admin ? 'Administrator' : 'Member';
    const meta = document.createElement('span');
    meta.className = 'admin-user-meta';
    const joined = user.created_at ? new Date(user.created_at).toLocaleDateString() : 'unknown';
    meta.textContent = `Worker ${user.enabled ? 'enabled' : 'disabled'} · ${user.status || 'unknown'} · Joined ${joined}`;

    const rentalMeta = document.createElement('span');
    rentalMeta.className = 'admin-user-meta';
    if (user.is_admin) {
      rentalMeta.textContent = 'Rental: Permanent administrator access';
    } else if (user.rental_expires_at) {
      const expiresAt = new Date(user.rental_expires_at);
      const diffDays = Math.ceil((expiresAt.getTime() - Date.now()) / (24 * 3600 * 1000));
      if (diffDays <= 0) {
        rentalMeta.textContent = `Rental: EXPIRED (bot deleted on ${expiresAt.toLocaleDateString()})`;
        rentalMeta.style.color = 'var(--danger)';
        rentalMeta.style.fontWeight = '700';
      } else {
        rentalMeta.textContent = `Rental: ${diffDays} day${diffDays === 1 ? '' : 's'} remaining (deadline: ${expiresAt.toLocaleDateString()})`;
      }
    } else {
      rentalMeta.textContent = 'Rental: No deadline set';
    }
    details.append(name, role, meta, rentalMeta);

    const actions = document.createElement('div');
    actions.className = 'admin-user-actions';
    const workerButton = document.createElement('button');
    workerButton.type = 'button';
    workerButton.className = 'button button-outline';
    workerButton.textContent = user.enabled ? 'Disable worker' : 'Enable worker';
    workerButton.addEventListener('click', () => updateUser(user.user_id, { enabled: !user.enabled }));
    actions.append(workerButton);

    if (!user.is_admin) {
      const extendButton = document.createElement('button');
      extendButton.type = 'button';
      extendButton.className = 'button button-outline';
      extendButton.textContent = 'Extend rental';
      extendButton.addEventListener('click', () => {
        openRentalModal(user.user_id, user.username || user.email || '');
      });
      actions.append(extendButton);
    }

    const deleteBotButton = document.createElement('button');
    deleteBotButton.type = 'button';
    deleteBotButton.className = 'button button-danger';
    deleteBotButton.textContent = 'Delete bot';
    deleteBotButton.addEventListener('click', () => deleteBot(user.user_id, user.username || user.email || 'this user'));
    actions.append(deleteBotButton);

    if (!user.is_admin) {
      const deleteUserButton = document.createElement('button');
      deleteUserButton.type = 'button';
      deleteUserButton.className = 'button button-danger';
      deleteUserButton.textContent = 'Delete user';
      deleteUserButton.addEventListener('click', () => deleteAccount(user.user_id, user.username || user.email || 'this user'));
      actions.append(deleteUserButton);
    }
    card.append(details, actions);
    list.append(card);
  }
}

async function loadUsers() {
  const refresh = $('refresh-users');
  refresh.disabled = true;
  setError('');
  try {
    const data = await api('/api/admin/users');
    users = Array.isArray(data.users) ? data.users : [];
    $('member-count').textContent = String(users.length);
    $('worker-count').textContent = String(users.filter((user) => user.enabled).length);
    $('admin-count').textContent = String(users.filter((user) => user.is_admin).length);
    renderUsers();
    updateNotifyTargets();
  } catch (error) {
    // 403 is a valid session without administrator rights, not a dead table.
    if (error.status === 401 || error.status === 403) {
      window.location.replace('/');
      return;
    }
    users = [];
    renderUsers();
    setError(error.message);
  } finally {
    refresh.disabled = false;
  }
}

async function updateUser(userId, changes) {
  try {
    await api(`/api/admin/users/${encodeURIComponent(userId)}`, {
      method: 'PATCH',
      body: JSON.stringify(changes),
    });
    show('Account updated.');
    await loadUsers();
  } catch (error) {
    show(error.message, true);
  }
}

async function deleteBot(userId, label) {
  if (!window.confirm(`Delete the bot data for ${label}? This will unlink WhatsApp and remove cached/recovered bot data for this account.`)) {
    return;
  }
  try {
    await api(`/api/admin/users/${encodeURIComponent(userId)}/bot`, { method: 'DELETE' });
    show('Bot deleted.');
    await loadUsers();
  } catch (error) {
    show(error.message, true);
  }
}

async function deleteAccount(userId, label) {
  if (!window.confirm(`Permanently delete account "${label}"? This will delete the user account and wipe all bot data.`)) {
    return;
  }
  try {
    await api(`/api/admin/users/${encodeURIComponent(userId)}`, { method: 'DELETE' });
    show('Account deleted.');
    await loadUsers();
  } catch (error) {
    show(error.message, true);
  }
}

function formatInviteState(invite) {
  if (invite.claimed_at) return 'Used';
  if (new Date(invite.expires_at).getTime() <= Date.now()) return 'Expired';
  return 'Active';
}

async function loadInvites() {
  const list = $('invite-list');
  if (!list) return;
  try {
    const data = await api('/api/admin/invites');
    const invites = Array.isArray(data.invites) ? data.invites : [];
    list.replaceChildren();
    if (!invites.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state admin-empty';
      empty.textContent = 'No invites yet.';
      list.append(empty);
      return;
    }
    for (const invite of invites) {
      const card = document.createElement('article');
      card.className = 'admin-user-card';
      const details = document.createElement('div');
      details.className = 'admin-user-details';
      const name = document.createElement('strong');
      name.className = 'admin-user-name';
      name.textContent = `Invite ${String(invite.id || '').slice(0, 12)}`;
      const role = document.createElement('span');
      role.className = `admin-role-badge${invite.active ? ' admin' : ''}`;
      role.textContent = formatInviteState(invite);
      const meta = document.createElement('span');
      meta.className = 'admin-user-meta';
      const expires = invite.expires_at ? new Date(invite.expires_at).toLocaleString() : 'unknown';
      const rental = invite.rental_days ? `${invite.rental_days}d rental` : '30d rental';
      meta.textContent = `${rental} · Link expires ${expires}`;
      details.append(name, role, meta);
      const actions = document.createElement('div');
      actions.className = 'admin-user-actions';
      if (invite.active && invite.inviteLink) {
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'button button-outline';
        copy.textContent = 'Copy link';
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(invite.inviteLink);
            show('Invite link copied.');
          } catch {
            show('Clipboard access is unavailable in this browser.', true);
          }
        });
        actions.append(copy);
      }
      if (invite.active) {
        const revoke = document.createElement('button');
        revoke.type = 'button';
        revoke.className = 'button button-outline';
        revoke.textContent = 'Revoke';
        revoke.addEventListener('click', () => revokeInvite(invite.id));
        actions.append(revoke);
      } else {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'button button-danger';
        delBtn.textContent = 'Delete';
        delBtn.addEventListener('click', () => deleteInvite(invite.id));
        actions.append(delBtn);
      }
      card.append(details, actions);
      list.append(card);
    }
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      window.location.replace('/');
      return;
    }
    list.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'empty-state admin-empty';
    empty.textContent = 'Could not load invites.';
    list.append(empty);
  }
}

async function createInvite() {
  const hours = Number($('invite-hours').value);
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) {
    show('Invite expiry must be between 1 and 168 hours.', true);
    return;
  }
  const rentalDays = Number($('invite-rental-days').value) || 30;
  if (!Number.isInteger(rentalDays) || rentalDays < 1 || rentalDays > 365) {
    show('Rental duration must be between 1 and 365 days.', true);
    return;
  }

  const button = $('create-invite');
  button.disabled = true;
  try {
    const data = await api('/api/admin/invites', {
      method: 'POST',
      body: JSON.stringify({ expiresInHours: hours, rentalDays }),
    });
    const value = data.inviteLink || data.invite || '';
    $('invite-code').textContent = value;
    $('invite-code').dataset.copyValue = value;
    $('invite-result').hidden = false;
    show('Invite link created. Copy it now or from the active invites list.');
    loadInvites();
  } catch (error) {
    show(error.message, true);
  } finally {
    button.disabled = false;
  }
}

async function copyInvite() {
  try {
    const value = $('invite-code').dataset.copyValue || $('invite-code').textContent || '';
    await navigator.clipboard.writeText(value);
    show('Invite link copied.');
  } catch {
    show('Clipboard access is unavailable in this browser.', true);
  }
}

async function revokeInvite(id) {
  try {
    await api('/api/admin/invites/revoke', {
      method: 'POST',
      body: JSON.stringify({ id }),
    });
    show('Invite revoked.');
    loadInvites();
  } catch (error) {
    show(error.message, true);
  }
}

async function deleteInvite(id) {
  try {
    await api('/api/admin/invites/delete', {
      method: 'POST',
      body: JSON.stringify({ id, code: id }),
    });
    show('Invite deleted.');
    loadInvites();
  } catch (error) {
    show(error.message, true);
  }
}

async function signOut() {
  try {
    await api('/api/logout', { method: 'POST', body: '{}' });
  } catch {
    // Leave the dashboard even if the session has already expired.
  }
  window.location.assign('/');
}

function updateNotifyTargets() {
  const select = $('notify-target');
  if (!select) return;
  const currentVal = select.value;
  select.replaceChildren();

  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = 'All members (Broadcast)';
  select.append(allOpt);

  for (const user of users) {
    const opt = document.createElement('option');
    opt.value = user.user_id;
    const name = user.username || user.email || 'Account';
    const status = user.status ? ` — ${user.status}` : '';
    opt.textContent = `${name}${status}${user.is_admin ? ' (Admin)' : ''}`;
    select.append(opt);
  }
  if (currentVal && [...select.options].some((o) => o.value === currentVal)) {
    select.value = currentVal;
  }
}

async function loadNotifications() {
  const list = $('notifications-list');
  const refresh = $('refresh-notifications');
  if (refresh) refresh.disabled = true;
  try {
    const data = await api('/api/admin/notifications');
    const items = Array.isArray(data.notifications) ? data.notifications : [];
    list.replaceChildren();
    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'empty-state admin-empty';
      empty.textContent = 'No sent notifications yet.';
      list.append(empty);
      return;
    }
    for (const notif of items) {
      const card = document.createElement('article');
      card.className = 'admin-user-card';

      const details = document.createElement('div');
      details.className = 'admin-user-details';

      const titleRow = document.createElement('div');
      titleRow.style.display = 'flex';
      titleRow.style.alignItems = 'center';
      titleRow.style.gap = '8px';

      const title = document.createElement('strong');
      title.className = 'admin-user-name';
      title.textContent = notif.title;

      const typeBadge = document.createElement('span');
      typeBadge.className = `admin-role-badge ${notif.type === 'alert' ? 'admin' : ''}`;
      typeBadge.textContent = notif.type.toUpperCase();

      titleRow.append(title, typeBadge);

      const msg = document.createElement('p');
      msg.style.margin = '4px 0';
      msg.style.fontSize = '13.5px';
      msg.style.color = '#c9e4d6';
      msg.textContent = notif.message;

      const meta = document.createElement('span');
      meta.className = 'admin-user-meta';
      const targetLabel = notif.target_username ? `Recipient: @${notif.target_username}` : 'Recipient: All members';
      const created = notif.created_at ? new Date(notif.created_at).toLocaleString() : 'unknown';
      const reads = `${notif.read_count ?? 0} read`;
      const delivered = notif.send_whatsapp ? ` · ${notif.delivered_count ?? 0} delivered via WA` : ' · Web only';
      meta.textContent = `${targetLabel} · Sent ${created} · ${reads}${delivered}`;

      details.append(titleRow, msg, meta);

      const actions = document.createElement('div');
      actions.className = 'admin-user-actions';

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'button button-danger';
      delBtn.textContent = 'Delete';
      delBtn.addEventListener('click', async () => {
        if (!window.confirm(`Delete notification "${notif.title}"?`)) return;
        try {
          await api(`/api/admin/notifications/${encodeURIComponent(notif.id)}`, { method: 'DELETE' });
          show('Notification deleted.');
          loadNotifications();
        } catch (err) {
          show(err.message, true);
        }
      });
      actions.append(delBtn);

      card.append(details, actions);
      list.append(card);
    }
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      window.location.replace('/');
      return;
    }
    list.replaceChildren();
    const empty = document.createElement('div');
    empty.className = 'empty-state admin-empty';
    empty.textContent = 'Could not load notifications.';
    list.append(empty);
  } finally {
    if (refresh) refresh.disabled = false;
  }
}

async function sendNotification() {
  const title = $('notify-title').value.trim();
  const message = $('notify-message').value.trim();
  const targetUserId = $('notify-target').value;
  const type = $('notify-type').value;
  const sendWhatsapp = $('notify-whatsapp').checked;

  if (!title) {
    show('Notification title is required.', true);
    return;
  }
  if (!message) {
    show('Notification message is required.', true);
    return;
  }

  const btn = $('send-notification');
  btn.disabled = true;
  try {
    await api('/api/admin/notifications', {
      method: 'POST',
      body: JSON.stringify({
        title,
        message,
        targetUserId,
        type,
        sendWhatsapp,
      }),
    });
    $('notify-title').value = '';
    $('notify-message').value = '';
    show('Notification sent successfully.');
    loadNotifications();
  } catch (err) {
    show(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function loadSettings() {
  try {
    const data = await api('/api/admin/settings');
    if (data.adminWhatsApp) {
      $('admin-whatsapp').value = data.adminWhatsApp;
    }
    if (data.groqApiKey) {
      $('admin-groq').value = data.groqApiKey;
      $('admin-groq').placeholder = 'Configured (enter new key to replace)';
    }
  } catch {
    // Fail gracefully
  }
}

async function saveAdminWhatsApp() {
  const number = $('admin-whatsapp').value.trim();
  const btn = $('save-admin-whatsapp');
  btn.disabled = true;
  try {
    const data = await api('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify({ adminWhatsApp: number }),
    });
    $('admin-whatsapp').value = data.adminWhatsApp || '';
    show(data.adminWhatsApp ? `Admin WhatsApp number saved: +${data.adminWhatsApp}` : 'Admin WhatsApp number cleared.');
  } catch (err) {
    show(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

async function saveAdminGroq() {
  const key = $('admin-groq').value.trim();
  const btn = $('save-admin-groq');
  btn.disabled = true;
  try {
    const data = await api('/api/admin/settings', {
      method: 'POST',
      body: JSON.stringify({ groqApiKey: key }),
    });
    $('admin-groq').value = data.groqApiKey || '';
    show(data.groqApiKey ? 'Server Groq API key saved.' : 'Server Groq API key cleared.');
  } catch (err) {
    show(err.message, true);
  } finally {
    btn.disabled = false;
  }
}

$('refresh-users').addEventListener('click', loadUsers);
$('user-search').addEventListener('input', renderUsers);
$('create-invite').addEventListener('click', createInvite);
$('copy-invite').addEventListener('click', copyInvite);
$('refresh-invites').addEventListener('click', loadInvites);
$('send-notification').addEventListener('click', sendNotification);
$('refresh-notifications').addEventListener('click', loadNotifications);
$('save-admin-whatsapp').addEventListener('click', saveAdminWhatsApp);
$('save-admin-groq').addEventListener('click', saveAdminGroq);
$('admin-signout').addEventListener('click', signOut);

$('rental-modal-close').addEventListener('click', closeRentalModal);
$('rental-modal-cancel').addEventListener('click', closeRentalModal);
$('rental-modal').addEventListener('click', (e) => {
  if (e.target === $('rental-modal')) closeRentalModal();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !$('rental-modal').hidden) closeRentalModal();
});
$('rental-modal-confirm').addEventListener('click', async () => {
  const input = $('rental-modal-days').value.trim();
  const days = Number(input);
  if (!Number.isInteger(days) || days < 1 || days > 3650) {
    show('Enter a valid number of days between 1 and 3650.', true);
    return;
  }
  const targetUserId = pendingRentalUserId;
  closeRentalModal();
  if (targetUserId) {
    await updateUser(targetUserId, { rentalDays: days });
  }
});
loadUsers();
loadInvites();
loadNotifications();
loadSettings();
