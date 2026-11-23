'use strict';

const form = document.getElementById('register-form');
const errorMessage = document.getElementById('register-error');
const submit = document.getElementById('register-submit');

const params = new URLSearchParams(window.location.search);
// v2 links use ?invite=, v1 links use ?code= — accept both.
const invite = params.get('invite') || params.get('code');
if (invite) document.getElementById('register-invite').value = invite.trim();

async function initRegisterContactAdmin() {
  const link = document.getElementById('register-contact-admin');
  if (!link) return;
  try {
    const response = await fetch('/api/public-settings', { cache: 'no-store' });
    const data = await response.json().catch(() => ({}));
    if (data.adminWhatsApp) {
      const phone = data.adminWhatsApp.replace(/[^0-9]/g, '');
      const text = encodeURIComponent('Hello Admin, I would like an invite code for Autoviewer.');
      link.href = `https://wa.me/${phone}?text=${text}`;
      link.hidden = false;
    } else {
      link.hidden = true;
    }
  } catch {
    // Fail silently
  }
}
initRegisterContactAdmin();

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorMessage.hidden = true;
  const password = document.getElementById('register-password').value;
  const confirmation = document.getElementById('confirm-password').value;
  if (password !== confirmation) {
    errorMessage.textContent = 'Passwords do not match.';
    errorMessage.hidden = false;
    return;
  }

  submit.disabled = true;
  try {
    const csrf = (document.cookie.match(/(?:^|; )av_csrf=([^;]*)/) || [])[1];
    const headers = { 'content-type': 'application/json' };
    if (csrf) headers['X-CSRF-Token'] = decodeURIComponent(csrf);
    const response = await fetch('/api/register', {
      method: 'POST',
      credentials: 'same-origin',
      headers,
      body: JSON.stringify({
        username: document.getElementById('register-username').value.trim(),
        password,
        invite: document.getElementById('register-invite').value.trim(),
      }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || result.message || `Registration failed (${response.status}).`);
    window.location.replace('/');
  } catch (error) {
    errorMessage.textContent = error.message;
    errorMessage.hidden = false;
  } finally {
    submit.disabled = false;
  }
});
