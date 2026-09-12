import { el, $, field, openDialog, toast } from './dom.js';
import { currentScope, scopedKey, selectWorkspace, getConnection, setConnection, scopeIsCurrent, scopeIdentityIsCurrent, assertScopeCurrent, lockScope, savedSessionFor, sessionExpiresAt, prepareVisitReload, returnToWork, sessionAssurance } from './scope.js';
import { authenticatorPanel } from './mfa-ui.js';
import { Supabase } from './supabase.js';
import { db, live, listHistory, undoChange } from './db.js';
import { sync, checkSetup, listConflicts, resolveConflict } from './sync.js';
import { rateFor, fmtMoney } from './expense-ifs.js';
import { mondayOf } from './rules.js';
import { expenseReviewQueue, setupReviewItems, personalReviewItems, uniqueReviewCount } from './review-queue.js';

let ctx;
const reload = ({ continueVisit = false } = {}) => {
  if (pageDeparted) return;
  // Only a completed sign-in or the workspace picker can carry this visit across a reload.
  if (continueVisit) prepareVisitReload();
  if (privateViewOpened && !scopeIdentityIsCurrent()) lockPrivateView('Opening the selected account or workspace…');
  location.reload();
};
const textInput = (value = '', options = {}) => el('input', { value, ...options });

let authTimer, authExpiryTimer, checkingSession = false, privateViewOpened = false, onAuthLock;
let pageDeparted = false, authActionId = 0, personalChallengeOpened = false;

function signedOutScreen(message = '') {
  personalChallengeOpened = false;
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

function personalAuthScreen(client) {
  personalChallengeOpened = true;
  document.documentElement.dataset.auth = 'locked';
  document.title = 'Verify Personal · Pocket / IFS Bridge';
  for (const node of document.querySelectorAll('.top, #main-content')) { node.hidden = true; node.inert = true; node.replaceChildren(); }
  for (const dialog of document.querySelectorAll('dialog')) { dialog.close(); dialog.remove(); }
  $('#toast-host')?.remove();
  onAuthLock?.();
  const request = authActionId, host = $('#auth-screen');
  if (!host) return;
  const current = () => !pageDeparted && request === authActionId && scopeIdentityIsCurrent();
  host.hidden = false;
  host.replaceChildren(el('div', { class: 'auth-card' },
    el('h1', {}, 'Unlock Personal'),
    authenticatorPanel({ client, isCurrent: current, onVerified: () => { if (current()) reload({ continueVisit: true }); } }),
    el('div', { class: 'row' },
      el('button', { type: 'button', onclick: () => { if (current()) { returnToWork(); reload({ continueVisit: true }); } } }, 'Open Work instead'),
      el('button', { type: 'button', onclick: () => { ++authActionId; client.signOut(); reload(); } }, 'Sign out'))));
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
    else if (personalChallengeOpened && !scopeIdentityIsCurrent()) { ++authActionId; signedOutScreen('Sign in again to continue.'); }
  };
  window.addEventListener('storage', sessionChanged);
  window.addEventListener('ifsbridge:session-changed', sessionChanged);
  window.addEventListener('focus', checkSession);
  window.addEventListener('online', checkSession);
  window.addEventListener('pagehide', () => {
    pageDeparted = true; ++authActionId;
    // Clear private DOM before a back/forward snapshot is stored. Returning is a new visit.
    lockPrivateView('Sign in again to open your records.');
  });
  window.addEventListener('pageshow', () => { pageDeparted = false; });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkSession(); });
  // A suspended/background tab can receive input before its timer runs.
  for (const type of ['click', 'submit', 'input', 'change']) document.addEventListener(type, event => {
    if (privateViewOpened && document.documentElement.dataset.auth === 'ready' && !scopeIsCurrent()) {
      event.preventDefault(); event.stopImmediatePropagation();
      lockPrivateView('Sign in again to open your records.');
    }
  }, true);
  if (!currentScope().userId) { signedOutScreen(); return false; }
  const c = new Supabase(getConnection());
  try {
    if (navigator.onLine !== false) await c.ensureToken({ identityOnly: true });
  } catch { /* A still-valid cached session can open its own records offline. */ }
  if (currentScope().workspace === 'personal' && scopeIdentityIsCurrent() && sessionExpiresAt(savedSessionFor(currentScope().backend)) > Date.now() && sessionAssurance(savedSessionFor(currentScope().backend)) !== 'aal2') {
    personalAuthScreen(c); return false;
  }
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
    picker.addEventListener('change', () => { selectWorkspace(picker.value); reload({ continueVisit: true }); });
  }
  $('#account-button')?.addEventListener('click', openAccount);
  // Other windows follow the selected account/space before showing any new data.
  // The auth gate clears private content before an account/workspace reload.
  document.documentElement.dataset.workspace = currentScope().workspace;
}

export function openAccount() {
  if (!scopeIsCurrent()) return;
  return openDialog('Account and security', accountPanel());
}

// Explicit read-only diagnostics: schema version and verified factors only.
// This never reads transactions, synchronizes records or starts MFA enrollment.
export async function testCloudConnection(client, { isCurrent = scopeIsCurrent } = {}) {
  if (!isCurrent()) throw Error('Sign in again before testing this connection.');
  if (!client.configured || !client.signedIn) throw Error('Connect your account before testing cloud access.');
  client.assertScope();
  const version = Number(await client.schemaVersion());
  if (!isCurrent()) throw Error('The account or workspace changed. Open the connection panel again.');
  client.assertScope();
  if (![2, 3].includes(version)) throw Error('Cloud connection reached. The workspace database update is required before sync.');
  const factors = await client.listFactors();
  if (!isCurrent()) throw Error('The account or workspace changed. Open the connection panel again.');
  client.assertScope();
  return { version, personalReady: version >= 3, authenticatorSetUp: factors.totp.length > 0, verifiedThisVisit: sessionAssurance(client.session) === 'aal2' };
}

export function connectionStatusPanel({ showAccountLink = true } = {}) {
  const c = new Supabase(getConnection());
  const status = el('p', { class: 'help', role: 'status', 'aria-live': 'polite' },
    !c.configured ? 'Cloud connection is not configured.' : !c.signedIn ? 'Sign in to test this connection.' : 'Account connected. Cloud access and authenticator setup have not been tested here.');
  const box = el('div', { class: 'connection-status-panel' });
  const current = () => box.isConnected && !pageDeparted && scopeIsCurrent();
  const test = el('button', { type: 'button', onclick: async () => {
    if (!current() || test.disabled) return;
    test.disabled = true; status.textContent = 'Checking cloud access…';
    try {
      const result = await testCloudConnection(c, { isCurrent: current });
      if (!current()) return;
      status.textContent = `Cloud connection works. Work sync is ready. ${result.personalReady ? 'Personal security update is installed.' : 'Personal security still needs the database update.'} ${result.authenticatorSetUp ? 'An authenticator is set up.' : 'No verified authenticator is set up.'} ${result.verifiedThisVisit ? 'This visit has passed authenticator verification.' : 'Personal still requires authenticator verification for this visit.'} No records were synced.`;
    } catch (error) { if (current()) status.textContent = `Connection test: ${error.message}`; }
    finally { if (current()) test.disabled = false; }
  } }, 'Test cloud connection');
  box.append(status, el('div', { class: 'row' }, test, showAccountLink ? el('button', { type: 'button', class: 'link', onclick: openAccount }, 'Account and security') : null),
    el('small', { class: 'help' }, 'The test reads connection and security status. Use Sync now to transfer records.'));
  return box;
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
  if (!signedOut && c.signedIn) box.append(el('p', {}, `Signed in as ${c.email}`), el('p', { class: 'help' }, `${currentScope().workspace === 'personal' ? 'Personal' : 'Work'} space · private to this account`),
    el('div', { class: 'account-security-status' }, el('p', {}, 'Work: password sign-in for each visit.'),
      el('p', {}, sessionAssurance(c.session) === 'aal2' ? 'Personal: authenticator verified for this visit.' : 'Personal: authenticator verification required before records open.'),
      el('small', { class: 'help' }, 'Authenticator enrollment and the Personal database update are separate requirements. Test the connection to check both.')),
    connectionStatusPanel({ showAccountLink: false }));
  if (signedOut || !c.signedIn) {
    const email = textInput('', { type: 'email', autocomplete: 'username', placeholder: 'you@example.com' });
    const password = textInput('', { type: 'password', autocomplete: 'current-password' });
    const credentials = () => {
      if (!c.configured) throw new Error('Save a cloud connection first.');
      if (!email.value.trim() || !password.value) throw new Error('Enter your email and password.');
      return [email.value.trim(), password.value];
    };
    box.append(field('Email', email), field('Password', password), el('div', { class: 'row' },
      button('Sign in', async () => {
        const request = authActionId;
        await c.signIn(...credentials());
        if (request === authActionId) reload({ continueVisit: true });
      }, 'primary'),
      button('Create account', async () => {
        const request = authActionId;
        const result = await c.signUp(...credentials());
        if (request !== authActionId || pageDeparted) return;
        if (result === 'confirm-email') status.textContent = 'Check your confirmation email, then sign in here.';
        else reload({ continueVisit: true });
      })), el('p', { class: 'help' }, 'Sign in for each visit. Opening or refreshing the site asks again; your saved settings and records stay on this device.'));
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
  if (!signedOut && c.signedIn) box.append(el('div', { class: 'row' }, el('button', { type: 'button', onclick: () => {
    const request = authActionId;
    let dialog;
    const panel = authenticatorPanel({ client: c, isCurrent: () => !pageDeparted && request === authActionId && scopeIsCurrent() && !!dialog?.open,
      onVerified: () => reload({ continueVisit: true }) });
    dialog = openDialog('Personal authenticator', panel);
  } }, 'Google Authenticator')));
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

export function attentionItems({ lines = [], sheets = [], weeks = [], inbox = [], conflicts = [], settings = {}, rates = {}, workspace, today }) {
  const items = [];
  if (workspace === 'work') {
    const queue = expenseReviewQueue({ lines, sheets, settings, rates });
    items.push(...queue.stages.filter(stage => stage.count).map(stage => ({ ...stage, severity: stage.kind === 'setup' && !queue.blockingCount ? 'followup' : stage.severity })));
    items.push(...setupReviewItems(settings));
    if (settings.clockify?.apiKey) {
      const last = new Date(mondayOf(today) + 'T12:00:00Z'); last.setUTCDate(last.getUTCDate() - 7);
      const monday = last.toISOString().slice(0, 10);
      if (!weeks.some(week => !week.deleted && week.monday === monday && week.enteredAt)) items.push({ kind: 'week', label: 'Review last week', severity: 'next', count: 1, monday, keys: [`week:${monday}`] });
    }
  } else items.push(...personalReviewItems(lines));
  const receipts = inbox.filter(row => !row.deleted && row.status !== 'done' && row.status !== 'created' && row.status !== 'matched' && row.status !== 'imported');
  if (receipts.length) items.push({ kind: 'inbox', label: 'Receipt inbox', severity: 'followup', count: receipts.length, keys: receipts.map(row => `inbox:${row.id}`) });
  if (conflicts.length) items.push({ kind: 'conflicts', label: 'Sync conflicts', severity: 'blocking', count: conflicts.length, keys: conflicts.map((row, index) => row.table === 'expenses' && (row.recordId || row.local?.id || row.remote?.id) ? `expense:${row.recordId || row.local?.id || row.remote?.id}` : `conflict:${row.id || index}`) });
  return items;
}

export async function attentionPanel() {
  let snapshot;
  try { snapshot = await Promise.all([
    live('expenses'), live('sheets'), live('weeks'), live('inbox'), listConflicts(), db.meta('rateCache')
  ]); } catch (error) {
    if (!scopeIsCurrent()) return null;
    return el('section', { class: 'attention-panel', 'aria-label': 'Review' }, el('h3', {}, 'Review unavailable'), el('p', { class: 'help', role: 'status' }, error.message));
  }
  if (!scopeIsCurrent()) return null;
  const [lines, sheets, weeks, inbox, conflicts, cache] = snapshot;
  const settings = ctx.settings();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const rates = cache?.field === (settings.tcmbField || 'ForexBuying') ? cache.byKey : {};
  const items = attentionItems({ lines, sheets, weeks, inbox, conflicts, settings, rates, workspace: currentScope().workspace, today });
  const action = item => {
    if (!scopeIsCurrent()) return;
    if (item.kind === 'conflicts') return openActivity();
    if (item.kind === 'week') return ctx.reviewWeek(item.monday);
    if (item.section) return ctx.openSettings?.(item.section, item.focus);
    if (currentScope().workspace === 'personal' && ctx.reviewPersonal) return ctx.reviewPersonal(item.kind);
    (ctx.reviewExpenses || ctx.openExpenses)?.(item.kind);
  };
  const count = uniqueReviewCount(items);
  return el('section', { class: 'attention-panel', 'aria-label': 'Review' },
    el('div', { class: 'section-head' }, el('h3', {}, `Review ${count}`), el('button', { type: 'button', class: 'link', onclick: () => { if (scopeIsCurrent()) openActivity(); } }, 'History')),
    items.length ? el('p', { class: 'help review-overview-summary' }, 'Each item is counted once. An expense can appear in more than one group.') : null,
    items.length ? el('div', { class: 'attention-list' }, items.map(item => el('button', { type: 'button', 'data-attention-kind': item.kind, onclick: () => action(item) },
      el('span', { class: 'review-attention-label' }, item.label, el('small', { class: item.severity === 'blocking' ? 'warn-text' : 'muted' }, item.severity === 'blocking' ? 'Blocked · action needed' : item.severity === 'next' ? 'Next step' : 'Follow-up')),
      el('b', {}, String(item.count))))) : el('p', { class: 'help' }, 'No records need review.'));
}



