import { el, $, field, openDialog, toast } from './dom.js';
import { currentScope, scopedKey, selectWorkspace, getConnection, setConnection, scopeIsCurrent, scopeIdentityIsCurrent, assertScopeCurrent, lockScope, savedSessionFor, sessionExpiresAt } from './scope.js';
import { Supabase } from './supabase.js';
import { db, live, listHistory, undoChange } from './db.js';
import { sync, checkSetup, listConflicts, resolveConflict } from './sync.js';
import { rateFor, fmtMoney } from './expense-ifs.js';
import { mondayOf } from './rules.js';

let ctx;
const reload = () => {
  if (privateViewOpened && !scopeIdentityIsCurrent()) lockPrivateView('Opening the selected account or workspace…');
  location.reload();
};
const textInput = (value = '', options = {}) => el('input', { value, ...options });

let authTimer, authExpiryTimer, checkingSession = false, privateViewOpened = false, onAuthLock;

function signedOutScreen(message = '') {
  clearTimeout(authTimer);
  clearTimeout(authExpiryTimer);
  document.documentElement.dataset.auth = 'locked';
  document.title = 'Sign in · Pocket / IFS Bridge';
  for (const node of document.querySelectorAll('.top, #main-content')) {
    node.hidden = true; node.inert = true; node.replaceChildren();
  }
  for (const dialog of document.querySelectorAll('dialog')) { dialog.close(); dialog.remove(); }
  $('#toast-host')?.remove();
  onAuthLock?.();
  const host = $('#auth-screen');
  if (!host) return;
  host.hidden = false;
  host.replaceChildren(el('div', { class: 'auth-card' },
    el('h1', {}, 'Sign in'),
    el('p', { class: 'help' }, 'Open your private Work and Personal records.'),
    message ? el('p', { class: 'auth-message', role: 'status' }, message) : null,
    accountPanel({ signedOut: true })));
}

function lockPrivateView(message) {
  lockScope();
  privateViewOpened = false;
  signedOutScreen(message);
}

function scheduleSessionCheck() {
  clearTimeout(authTimer);
  clearTimeout(authExpiryTimer);
  const expiry = sessionExpiresAt(savedSessionFor(currentScope().backend));
  // Refresh a minute early, then check again at the expiry if the network fails.
  const remaining = expiry - Date.now();
  const delay = remaining > 60000 ? remaining - 60000 : Math.max(1000, remaining);
  authTimer = setTimeout(checkSession, Math.min(60000, delay));
  authExpiryTimer = setTimeout(() => {
    if (!scopeIsCurrent()) lockPrivateView('Your session expired. Sign in again. Your records are still saved.');
  }, Math.max(0, Math.min(2147483647, remaining)));
}

async function checkSession() {
  if (!privateViewOpened) return;
  if (!scopeIsCurrent()) { lockPrivateView('Sign in again to open your records.'); return; }
  if (checkingSession) return;
  if (!scopeIdentityIsCurrent()) { lockPrivateView('Your account or workspace changed. Sign in again to continue.'); return; }
  checkingSession = true;
  try {
    const c = new Supabase(getConnection());
    if (navigator.onLine !== false) await c.ensureToken();
    if (!scopeIsCurrent()) { lockPrivateView('Your session expired. Sign in again. Your records are still saved.'); return; }
    scheduleSessionCheck();
  } catch {
    if (!scopeIsCurrent()) lockPrivateView('Your session expired. Sign in again. Your records are still saved.');
    else scheduleSessionCheck();
  } finally { checkingSession = false; }
}

// Called before the application reads settings, opens storage, or restores a PC
// backup. Cached records remain on disk but never become a signed-out workspace.
export async function initAuthGate({ onLock } = {}) {
  onAuthLock = onLock;
  const sessionChanged = () => {
    if (privateViewOpened && !scopeIdentityIsCurrent()) lockPrivateView('You are signed out. Your records are still saved.');
  };
  window.addEventListener('storage', sessionChanged);
  window.addEventListener('ifsbridge:session-changed', sessionChanged);
  window.addEventListener('focus', checkSession);
  window.addEventListener('online', checkSession);
  window.addEventListener('pagehide', () => {
    if (!privateViewOpened) return;
    // A browser back/forward snapshot must not remember a visible ledger.
    document.documentElement.dataset.auth = 'locked';
    for (const node of document.querySelectorAll('.top, #main-content')) { node.hidden = true; node.inert = true; }
    if ($('#auth-screen')) { $('#auth-screen').hidden = false; $('#auth-screen').replaceChildren(el('p', { role: 'status' }, 'Checking sign in…')); }
  });
  window.addEventListener('pageshow', async () => {
    await checkSession();
    if (privateViewOpened && scopeIsCurrent()) revealPrivateApp();
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSession(); });
  // A suspended/background tab can receive input before its timer runs.
  for (const type of ['click', 'submit', 'input', 'change']) document.addEventListener(type, event => {
    if (privateViewOpened && document.documentElement.dataset.auth === 'ready' && !scopeIsCurrent()) {
      event.preventDefault(); event.stopImmediatePropagation();
      lockPrivateView('Sign in again to open your records.');
    }
  }, true);
  if (!currentScope().userId) { signedOutScreen(); return false; }
  try {
    const c = new Supabase(getConnection());
    if (navigator.onLine !== false) await c.ensureToken();
  } catch { /* A still-valid cached session can open its own records offline. */ }
  if (!scopeIsCurrent()) { signedOutScreen('Sign in again to open your records.'); return false; }
  privateViewOpened = true;
  scheduleSessionCheck();
  return true;
}

export function revealPrivateApp() {
  if (!scopeIsCurrent()) { lockPrivateView('Sign in again to open your records.'); return; }
  document.documentElement.dataset.auth = 'ready';
  for (const node of document.querySelectorAll('.top, #main-content')) { node.hidden = false; node.inert = false; }
  if ($('#auth-screen')) { $('#auth-screen').hidden = true; $('#auth-screen').replaceChildren(); }
}

export function initWorkspaceUI(context) {
  ctx = context;
  const picker = $('#workspace-select');
  if (picker) {
    picker.value = currentScope().workspace;
    picker.addEventListener('change', () => { selectWorkspace(picker.value); reload(); });
  }
  $('#account-button')?.addEventListener('click', () => openDialog('Account', accountPanel()));
  // Other windows follow the selected account/space before showing any new data.
  // The auth gate clears private content before an account/workspace reload.
  document.documentElement.dataset.workspace = currentScope().workspace;
}

export function accountPanel({ signedOut = false } = {}) {
  const connection = getConnection(), c = new Supabase(connection);
  const status = el('p', { class: 'help', role: 'status', 'aria-live': 'polite' });
  const controls = [];
  const run = async (action, label) => {
    controls.forEach(b => b.disabled = true); status.textContent = label;
    try { await action(); }
    catch (error) { status.textContent = error.message; }
    finally { controls.forEach(b => b.disabled = false); }
  };
  const button = (label, action, className = '') => {
    const b = el('button', { type: 'button', class: className, onclick: () => run(action, 'Working…') }, label);
    controls.push(b); return b;
  };
  const url = textInput(signedOut ? '' : connection.url, { type: 'url', placeholder: 'https://your-project.supabase.co', autocomplete: 'off' });
  const key = textInput('', { type: 'password', autocomplete: 'off', placeholder: c.configured ? 'Public key saved · enter to change' : 'Project public key' });
  const connectionSection = el('details', { class: 'more-opts', open: !c.configured },
    el('summary', {}, 'Cloud connection'),
    el('p', { class: 'help' }, 'Use your Supabase project URL and public key. The workspace migration in the project folder enables private Work and Personal sync.'),
    field('Project URL', url), field('Public key', key),
    button('Save connection', async () => {
      const next = { url: url.value.trim().replace(/\/+$/, ''), anonKey: key.value.trim() };
      if (next.url && !/^https:\/\/[^\s/]+(?:\/.*)?$/.test(next.url)) throw new Error('Use an HTTPS project URL.');
      if (!next.anonKey && next.url === connection.url) next.anonKey = connection.anonKey;
      if (!next.url || !next.anonKey) throw new Error('Enter both the URL and public key.');
      setConnection(next); reload();
    }));
  const box = el('div', { class: 'account-panel' });
  if (!signedOut && c.signedIn) box.append(el('p', {}, `Signed in as ${c.email}`), el('p', { class: 'help' }, `${currentScope().workspace === 'personal' ? 'Personal' : 'Work'} space · private to this account`));
  if (signedOut || !c.signedIn) {
    const email = textInput('', { type: 'email', autocomplete: 'username', placeholder: 'you@example.com' });
    const password = textInput('', { type: 'password', autocomplete: 'current-password' });
    const credentials = () => {
      if (!c.configured) throw new Error('Save a cloud connection first.');
      if (!email.value.trim() || !password.value) throw new Error('Enter your email and password.');
      return [email.value.trim(), password.value];
    };
    box.append(field('Email', email), field('Password', password), el('div', { class: 'row' },
      button('Sign in', async () => { await c.signIn(...credentials()); reload(); }, 'primary'),
      button('Create account', async () => {
        const result = await c.signUp(...credentials());
        if (result === 'confirm-email') status.textContent = 'Check your confirmation email, then sign in here.';
        else reload();
      })), el('p', { class: 'help' }, 'Signing in opens that account’s records. Existing local Work records remain on this device and are not uploaded automatically.'));
  } else {
    box.append(el('div', { class: 'row' },
      button('Sync now', async () => {
        assertScopeCurrent();
        const ready = await checkSetup(c);
        if (!ready.startsWith('ok')) throw new Error(ready);
        const result = await sync(c, value => { status.textContent = value; });
        status.textContent = result.errors?.length ? result.errors.join(' ') : `Synced: ${result.pushed || 0} sent, ${result.pulled || 0} received.`;
        if (result.pulled) ctx?.refresh?.();
      }, 'primary'),
      button('Sign out', async () => { c.signOut(); reload(); })),
      el('p', { class: 'help' }, 'Signing out hides every workspace. Your saved records stay on this device.'));
  }
  box.append(connectionSection);
  if (!signedOut && c.signedIn) box.append(el('div', { class: 'row' }, el('button', { type: 'button', onclick: openActivity }, 'History and conflicts')));
  box.append(status);
  return box;
}

const recordLabel = row => row?.written || row?.description || row?.title || row?.name || row?.monday || row?.date || 'Record';
const displayValue = row => row ? `${recordLabel(row)}${row.amount != null ? ' · ' + fmtMoney(row.amount, row.currency || 'TRY') : ''}${row.deleted ? ' · deleted' : ''}` : 'Not present';

function compareFields(local, remote) {
  const omit = new Set(['id', 'dirty', 'updated_at', '_remoteRevision', '_baseRevision']);
  const names = [...new Set([...Object.keys(local || {}), ...Object.keys(remote || {})])].filter(name => !omit.has(name));
  const display = value => value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  const changed = names.filter(name => JSON.stringify(local?.[name]) !== JSON.stringify(remote?.[name]));
  return el('details', {}, el('summary', {}, 'Compare changed fields'),
    el('div', { class: 'tbl' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Field', 'This device', 'Cloud'].map(label => el('th', {}, label)))),
      el('tbody', {}, changed.map(name => el('tr', {}, el('td', {}, name), el('td', {}, display(local?.[name])), el('td', {}, display(remote?.[name]))))))));
}
export async function openActivity() {
  assertScopeCurrent();
  const host = el('div'), status = el('p', { class: 'help', role: 'status' });
  const dialog = openDialog('History and conflicts', el('div', {}, host, status), { wide: true });
  const refresh = async () => {
    const [history, conflicts] = await Promise.all([listHistory(), listConflicts()]);
    if (!dialog.open || !scopeIsCurrent()) return;
    host.replaceChildren();
    host.append(el('h4', {}, `Sync conflicts (${conflicts.length})`));
    if (!conflicts.length) host.append(el('p', { class: 'help' }, 'No unresolved conflicts.'));
    for (const conflict of conflicts) {
      const choose = async choice => {
        try { await resolveConflict(conflict.id, choice); status.textContent = choice === 'local' ? 'Kept this device’s version. It is ready to sync.' : 'Kept the cloud version.'; await refresh(); ctx?.refresh?.(); ctx?.sync?.(); }
        catch (e) { status.textContent = e.message; }
      };
      host.append(el('div', { class: 'activity-item' },
        el('b', {}, conflict.table || 'Record'),
        el('p', {}, 'This device: ', displayValue(conflict.local)),
        el('p', {}, 'Cloud: ', displayValue(conflict.remote)),
        compareFields(conflict.local, conflict.remote),
        el('div', { class: 'row' }, el('button', { onclick: () => choose('local') }, 'Keep this device'), el('button', { onclick: () => choose('remote') }, 'Keep cloud'))));
    }
    host.append(el('h4', {}, 'Changes in this space'));
    if (!history.length) host.append(el('p', { class: 'help' }, 'Changes made from this version onward appear here.'));
    for (const change of history.slice(0, 100)) {
      host.append(el('div', { class: 'activity-item' },
        el('b', {}, change.label || 'Saved a change'),
        el('small', {}, new Date(change.at || change.created_at || change.updated_at).toLocaleString()),
        (change.changes || []).slice(0, 5).map(item => el('p', { class: 'help' }, displayValue(item.before), ' → ', displayValue(item.after))),
        el('button', { type: 'button', disabled: !!change.undoneAt, onclick: async () => {
          try { await undoChange(change.id); status.textContent = 'Change undone.'; await refresh(); ctx?.refresh?.(); ctx?.sync?.(); }
          catch (error) { status.textContent = error.message; }
        } }, change.undoneAt ? 'Undone' : 'Undo')));
    }
  };
  try { await refresh(); } catch (error) { status.textContent = error.message; }
}

export function attentionItems({ lines, sheets, weeks, inbox, conflicts, settings, rates = {}, workspace, today }) {
  const items = [];
  const active = lines.filter(line => !line.deleted), sheetsById = new Map(sheets.map(sheet => [sheet.id, sheet]));
  const business = active.filter(line => line.business && !line.perdiem && !line.entered);
  if (workspace === 'work') {
    const noReceipt = business.filter(line => !line.receipt && !line.receiptId && !line.receiptIds?.length);
    if (noReceipt.length) items.push({ kind: 'receipts', label: 'Missing receipts', count: noReceipt.length, ids: noReceipt.map(line => line.id) });
    const noRate = business.filter(line => !rateFor(line, sheetsById.get(line.sheetId), settings, rates).rate);
    if (noRate.length) items.push({ kind: 'rates', label: 'Missing exchange rates', count: noRate.length, ids: noRate.map(line => line.id) });
    if (settings.clockify?.apiKey) {
      const last = new Date(mondayOf(today) + 'T12:00:00Z'); last.setUTCDate(last.getUTCDate() - 7);
      const monday = last.toISOString().slice(0, 10);
      if (!weeks.some(week => !week.deleted && week.monday === monday && week.enteredAt)) items.push({ kind: 'week', label: 'Review last week', count: 1, monday });
    }
  }
  const receipts = inbox.filter(row => !row.deleted && row.status !== 'done' && row.status !== 'created' && row.status !== 'matched' && row.status !== 'imported');
  if (receipts.length) items.push({ kind: 'inbox', label: 'Receipts waiting for review', count: receipts.length });
  if (conflicts.length) items.push({ kind: 'conflicts', label: 'Sync conflicts to resolve', count: conflicts.length });
  return items;
}

export async function attentionPanel() {
  const [lines, sheets, weeks, inbox, conflicts, cache] = await Promise.all([
    live('expenses'), live('sheets'), live('weeks'), live('inbox'), listConflicts(), db.meta('rateCache')
  ]);
  if (!scopeIsCurrent()) return null;
  const settings = ctx.settings();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const rates = cache?.field === (settings.tcmbField || 'ForexBuying') ? cache.byKey : {};
  const items = attentionItems({ lines, sheets, weeks, inbox, conflicts, settings, rates, workspace: currentScope().workspace, today });
  const action = item => {
    if (item.kind === 'conflicts') return openActivity();
    if (item.kind === 'week') return ctx.reviewWeek(item.monday);
    ctx.openExpenses(item.kind);
  };
  return el('section', { class: 'attention-panel', 'aria-label': 'Needs attention' },
    el('div', { class: 'section-head' }, el('h3', {}, 'Needs attention'), el('button', { type: 'button', class: 'link', onclick: openActivity }, 'History')),
    items.length ? el('div', { class: 'attention-list' }, items.map(item => el('button', { type: 'button', onclick: () => action(item) }, el('span', {}, item.label), el('b', {}, String(item.count))))) : el('p', { class: 'help' }, 'No missing items found in this space.'));
}



