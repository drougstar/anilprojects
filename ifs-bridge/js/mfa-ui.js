import { el, field } from './dom.js';

export const MFA_SETUP_MESSAGE = 'Personal security needs a database update first. Run supabase/personal-mfa-v3.sql in your Supabase SQL editor, then check again. Your saved records are unchanged.';

// This panel works on the locked sign-in screen as well as in Account settings.
// It never opens storage or reads private workspace settings.
export function authenticatorPanel({ client, onVerified, isCurrent = () => true } = {}) {
  const status = el('p', { role: 'status', 'aria-live': 'polite', class: 'help' });
  const content = el('div'), host = el('div', { class: 'authenticator-panel' }, content, status);
  let busy = false, serial = 0;
  const alive = request => request === serial && isCurrent() && host.isConnected;
  const run = async action => {
    if (busy || !isCurrent()) return;
    busy = true; const request = ++serial;
    for (const input of host.querySelectorAll('button,input,select')) input.disabled = true;
    status.textContent = 'Checking…';
    try { await action(request); }
    catch (error) { if (alive(request)) status.textContent = error.message || 'Try again.'; }
    finally {
      busy = false;
      if (alive(request)) for (const input of host.querySelectorAll('button,input,select')) input.disabled = false;
    }
  };
  const button = (label, action, primary = false) => el('button', {
    type: 'button', class: primary ? 'primary' : '', onclick: () => run(action)
  }, label);
  const verifyForm = (factorId, setup = null) => {
    const code = el('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code',
      pattern: '[0-9]{6}', maxlength: 6, placeholder: '123456', required: true, 'aria-label': 'Authenticator code' });
    const form = el('form', { class: 'mfa-verify', onsubmit: event => {
      event.preventDefault(); run(async request => {
        if (!/^\d{6}$/.test(code.value.trim())) throw Error('Enter the six-digit code from your authenticator.');
        // Recheck policy readiness immediately before activating/upgrading MFA.
        if (!await client.mfaPolicyReady()) throw Error(MFA_SETUP_MESSAGE);
        if (!alive(request)) return;
        await client.challengeAndVerifyTotp(typeof factorId === 'function' ? factorId() : factorId, code.value.trim());
        if (!alive(request)) return;
        code.value = ''; content.replaceChildren(); status.textContent = 'Authenticator verified. Opening your workspace…';
        onVerified?.();
      });
    } }, field('Six-digit code', code), el('button', { type: 'submit', class: 'primary' }, setup ? 'Verify and enable' : 'Verify'));
    if (setup) {
      const raw = String(setup.qr_code || '').trim();
      const src = raw.startsWith('<svg') ? 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(raw) :
        /^data:image\/svg\+xml[;,]/i.test(raw) ? raw : '';
      if (!src) throw Error('The setup QR code was invalid. Try again.');
      const secret = el('input', { type: 'text', value: setup.secret, readOnly: true, autocomplete: 'off', 'aria-label': 'Authenticator setup key' });
      content.replaceChildren(el('p', {}, 'In Google Authenticator, add an account and scan this QR code.'),
        el('img', { class: 'mfa-qr', src, alt: 'Authenticator setup QR code', width: 220, height: 220 }),
        el('details', {}, el('summary', {}, 'Setting up on this phone, or saving a backup?'),
          el('p', { class: 'help' }, 'Choose “Enter a setup key” in your authenticator, paste this key, and choose Time based. Keep a private copy of the key to restore access if you lose your phone.'),
          field('Setup key', secret)), form);
    } else content.append(form);
    status.textContent = setup ? 'Setup becomes active only after you verify a code.' : 'Enter the current code from Google Authenticator or another TOTP app.';
  };
  const check = async request => {
    content.replaceChildren();
    if (!await client.mfaPolicyReady()) {
      if (!alive(request)) return;
      status.textContent = MFA_SETUP_MESSAGE;
      content.append(el('p', {}, el('a', { href: './supabase/personal-mfa-v3.sql', download: 'personal-mfa-v3.sql' }, 'Download the security update')),
        button('Check setup again', check)); return;
    }
    if (!alive(request)) return;
    const { totp } = await client.listFactors();
    if (!alive(request)) return;
    if (totp.length) {
      content.append(el('p', {}, 'Your account has an authenticator. Enter a code to verify this visit.'));
      const factors = el('select', { 'aria-label': 'Authenticator' }, totp.map(f => el('option', { value: f.id }, f.friendly_name || 'Authenticator')));
      if (totp.length > 1) content.append(field('Authenticator', factors));
      verifyForm(() => factors.value || totp[0].id);
    } else {
      status.textContent = 'Personal requires a second sign-in step. Work remains available with your password.';
      content.append(el('p', {}, 'Connect Google Authenticator to protect Personal records.'),
        button('Set up Google Authenticator', async enrollment => {
          if (!await client.mfaPolicyReady()) throw Error(MFA_SETUP_MESSAGE);
          if (!alive(enrollment)) return;
          const factor = await client.enrollTotp();
          if (alive(enrollment)) verifyForm(factor.id, factor.totp);
        }, true));
    }
  };
  content.append(button('Check authenticator', check, true));
  status.textContent = 'Use Google Authenticator or any compatible TOTP app.';
  return host;
}
