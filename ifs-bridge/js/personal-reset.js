import { db, atomicBatchSave } from './db.js';
import { currentScope, assertScopeCurrent, scopeIsCurrent } from './scope.js';
import { sync } from './sync.js';
import { el, openDialog } from './dom.js';

function assertPersonal() {
  assertScopeCurrent();
  if (currentScope().workspace !== 'personal') throw Error('This action is only available in Personal.');
}

// Reset only stored Personal transactions. Work display projections never enter
// this plan, and the original records are retained by the normal History Undo.
export function personalResetPlan(rows) {
  if (!Array.isArray(rows)) throw Error('Personal transactions could not be read.');
  const active = rows.filter(row => !row.deleted);
  if (active.length > 5000) throw Error('More than 5,000 transactions need a batched reset. Nothing was changed.');
  if (active.some(row => row.sourceWorkspace === 'work' || row.ledgerReadOnly)) throw Error('Work display records cannot be cleared here.');
  return active.map(row => ({ table: 'expenses', record: { ...row, deleted: true, personalResetForReimport: true }, expectedUpdatedAt: row.updated_at }));
}

export async function openPersonalReset({ client, backup, onReset }) {
  assertPersonal();
  const owner = currentScope().key;
  const check = () => { assertPersonal(); if (currentScope().key !== owner) throw Error('Account changed. Reopen Personal reset.'); };
  let snapshot, downloaded = false, busy = false;
  const status = el('p', { role: 'status', class: 'help' }, 'Checking Personal cloud sync…');
  const count = el('p');
  const backupButton = el('button', { type: 'button', disabled: true, onclick: async () => {
    if (busy) return;
    busy = true; backupButton.disabled = true;
    try { check(); await backup(); check(); downloaded = true; clearButton.disabled = false; status.textContent = 'Recovery copy downloaded. Clearing is also reversible in Account → History.'; }
    catch (error) { status.textContent = error.message; }
    finally { busy = false; backupButton.disabled = false; }
  } }, 'Download recovery copy');
  const clearButton = el('button', { type: 'button', class: 'danger', disabled: true, onclick: async () => {
    if (busy || !downloaded) return;
    busy = true; clearButton.disabled = backupButton.disabled = true;
    try {
      check();
      const items = personalResetPlan(snapshot);
      await atomicBatchSave(items, { label: `Clear ${items.length} Personal transactions for reimport`, expectedExpenses: snapshot });
      check(); status.textContent = 'Personal transactions cleared. Syncing the reset…';
      const result = await sync(client(), message => { if (scopeIsCurrent()) status.textContent = message || 'Checking reset…'; });
      check();
      const remaining = (await db.all('expenses')).filter(row => !row.deleted); check();
      const issues = result?.skipped ? ['Another sync is running. Use Sync now to finish the reset.'] : result?.errors || [];
      count.textContent = `${remaining.length} Personal transactions remain.`;
      status.textContent = issues.length ? `Cleared on this device. Sync needs attention: ${issues[0]}` : remaining.length ? 'Other transactions arrived while syncing. Review before another reset.' : 'Personal is empty and synced. Close this window to import your files again.';
      await onReset();
    } catch (error) { if (scopeIsCurrent()) status.textContent = error.message; }
    finally { busy = false; }
  } }, 'Clear Personal transactions');
  const dialog = openDialog('Reset Personal transactions', el('div', {},
    el('p', {}, 'Deletes Personal purchases, refunds and bank reference movements across all months. Work records, settings, receipts, trips and budgets stay as they are.'),
    count, el('div', { class: 'actions' }, backupButton, clearButton), status));
  try {
    if (!navigator.onLine || !client().configured || !client().signedIn) throw Error('Sign in and connect to the internet to clear Personal across your devices.');
    const result = await sync(client(), message => { if (dialog.isConnected && scopeIsCurrent()) status.textContent = message || 'Checking Personal records…'; });
    check(); if (!dialog.isConnected) return;
    if (result?.skipped) throw Error('Another sync is running. Let it finish, then reopen Reset Personal transactions.');
    if (result?.errors?.length) throw Error(result.errors[0]);
    if ((await db.all('conflicts')).length) throw Error('Resolve Personal sync conflicts before clearing transactions.');
    snapshot = await db.all('expenses'); check();
    const items = personalResetPlan(snapshot);
    count.textContent = `${items.length} Personal transactions will be cleared.`;
    status.textContent = items.length ? 'Download the recovery copy first.' : 'Personal has no stored transactions to clear.';
    backupButton.disabled = !items.length;
  } catch (error) { if (dialog.isConnected && scopeIsCurrent()) status.textContent = error.message; }
}
