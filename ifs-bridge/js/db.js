import { currentScope, assertScopeCurrent } from './scope.js';
const SCOPE = currentScope();
const NAME = SCOPE.legacy ? 'ifsbridge' : 'ifsbridge.' + SCOPE.key;
const VERSION = 3;
export const TABLES = ['sheets', 'trips', 'expenses', 'weeks', 'templates', 'budgets', 'inbox'];
const RECORD_STORES = [...TABLES, 'receipts'];
let opening = null;
export const now = () => new Date().toISOString();
export const uuid = () => crypto.randomUUID();
function open() {
  assertScopeCurrent();
  opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = () => {
      try { assertScopeCurrent(); } catch (error) { req.transaction.abort(); reject(error); return; }
      const d = req.result;
      for (const s of [...RECORD_STORES, 'history', 'conflicts']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      try { assertScopeCurrent(); }
      catch (error) { req.result.close(); reject(error); return; }
      req.result.onversionchange = () => req.result.close(); resolve(req.result);
    };
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(Error('Close other IFS Bridge tabs and reload to update local storage.'));
  });
  return opening;
}
// A request can finish after the user signs out. Abort pending transactions on
// an account change, and check again before using results or queuing writes.
function guardTransaction(t, resolve, reject, result = () => undefined) {
  let failure;
  const cleanup = () => {
    globalThis.removeEventListener?.('storage', verify);
    globalThis.removeEventListener?.('ifsbridge:session-changed', verify);
  };
  const cancel = error => {
    failure = error;
    try { t.abort(); } catch { /* It may have completed before the event arrived. */ }
    cleanup(); reject(error);
  };
  const guarded = action => {
    try { assertScopeCurrent(); return action(); }
    catch (error) { cancel(error); }
  };
  const verify = () => guarded(() => {});
  globalThis.addEventListener?.('storage', verify);
  globalThis.addEventListener?.('ifsbridge:session-changed', verify);
  t.oncomplete = () => { cleanup(); guarded(() => resolve(result())); };
  t.onerror = t.onabort = () => { cleanup(); reject(failure || t.error || Error('Storage operation cancelled.')); };
  return guarded;
}
async function run(store, mode, fn) {
  const d = await open(); assertScopeCurrent();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode); let req;
    const guarded = guardTransaction(t, resolve, reject, () => req && req.result);
    guarded(() => { req = fn(t.objectStore(store)); });
  });
}
async function revise(store, id, replacement) {
  const d = await open(); assertScopeCurrent();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, 'readwrite'), o = t.objectStore(store), req = o.get(id); let changed = false;
    const guarded = guardTransaction(t, resolve, reject, () => changed);
    req.onsuccess = () => guarded(() => { const next = replacement(req.result); if (next) { o.put(next); changed = true; } });
  });
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' && !(value instanceof Blob) ?
  Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
export function sameVersion(a, b) {
  if (!a || !b) return a === b;
  const data = row => { const { dirty, _remoteRevision, ...rest } = row; return rest; };
  return JSON.stringify(canonical(data(a))) === JSON.stringify(canonical(data(b)));
}
export const db = {
  get: (store, id) => run(store, 'readonly', o => o.get(id)),
  all: store => run(store, 'readonly', o => o.getAll()),
  put: (store, value) => run(store, 'readwrite', o => o.put(value)),
  remove: (store, id) => run(store, 'readwrite', o => o.delete(id)),
  meta: async key => (await run('meta', 'readonly', o => o.get(key)))?.value,
  setMeta: (key, value) => run('meta', 'readwrite', o => o.put({ key, value })),
  close: async () => { try { if (opening) (await opening).close(); } catch { /* A cancelled open has no connection to close. */ } finally { opening = null; } },
  name: NAME,
  markSynced: async (store, snapshot, revision) => {
    let acknowledged = false;
    await revise(store, snapshot.id, current => {
      if (!current) return null;
      acknowledged = sameVersion(current, snapshot);
      // Advance the server revision of an in-flight edit without clearing it.
      return { ...current, dirty: acknowledged ? false : current.dirty, ...(revision == null ? {} : { _remoteRevision: revision }) };
    });
    return acknowledged;
  },
  mergeRemote: (store, row) => revise(store, row.id, current =>
    !current || (!current.dirty && (Number(current._remoteRevision ?? -1) < Number(row._remoteRevision ?? -1) || Date.parse(current.updated_at) < Date.parse(row.updated_at))) ? row : null),
};
const changed = (store, id) => { assertScopeCurrent(); document.dispatchEvent(new CustomEvent('ifsbridge:changed', { detail: { store, id, scope: SCOPE.key } })); };
const stamp = prior => new Date(Math.max(Date.now(), (Date.parse(prior?.updated_at) || 0) + 1)).toISOString();

function assertUniqueWorkLinks(existing, replacements) {
  const projected = new Map(existing.map(row => [row.id, row]));
  for (const row of replacements) projected.set(row.id, row);
  const linked = new Set();
  for (const row of projected.values()) {
    const id = !row.deleted && row.workExpenseLink?.expenseId;
    if (!id) continue;
    if (linked.has(id)) throw Error('A Work expense is already linked to another card transaction. Refresh and review the matches.');
    linked.add(id);
  }
}

// Splits, imports and recurring entries commit together, with one undo step.
// Preconditions are checked in that same transaction, before any record changes.
export async function atomicBatchSave(items, { label = 'Edit records', uniqueWorkExpenseLinks = false } = {}) {
  if (!items.length) return [];
  const seen = new Set();
  const changes = items.map(item => {
    if (!RECORD_STORES.includes(item.table)) throw Error('Unsupported record type.');
    const record = { ...item.record, id: item.record.id || uuid() }, key = item.table + ':' + record.id;
    if (seen.has(key)) throw Error('The same record appears twice in this change.');
    seen.add(key); return { ...item, record };
  });
  // Splits, templates and other editors must respect links too, even when they
  // did not originate in the card-review tool.
  uniqueWorkExpenseLinks ||= changes.some(item => item.table === 'expenses' && item.record.workExpenseLink?.expenseId);
  const d = await open(); assertScopeCurrent();
  const saved = await new Promise((resolve, reject) => {
    const t = d.transaction([...new Set([...changes.map(c => c.table), ...(uniqueWorkExpenseLinks ? ['expenses'] : [])]), 'history'], 'readwrite');
    const before = [], output = [], audit = []; let left = changes.length + (uniqueWorkExpenseLinks ? 1 : 0), existingExpenses = [];
    const guarded = guardTransaction(t, resolve, reject, () => output);
    const commit = () => {
        if (--left) return;
        changes.forEach((item, j) => {
          const prior = before[j];
          if ('expectedUpdatedAt' in item && (item.expectedUpdatedAt === null ? !!prior : prior?.updated_at !== item.expectedUpdatedAt)) throw Error('A record changed in another tab. Refresh and review it before trying again.');
          if (item.expectedRecord && !sameVersion(prior, item.expectedRecord)) throw Error('A record changed. Refresh and review it before trying again.');
        });
        if (uniqueWorkExpenseLinks) {
          // Check the final state inside the write transaction. A second review
          // in another tab cannot claim the same Work expense concurrently.
          assertUniqueWorkLinks(existingExpenses, changes.filter(item => item.table === 'expenses').map(item => item.record));
        }
        changes.forEach((item, j) => {
          const prior = before[j];
          const full = { ...item.record, updated_at: stamp(prior), dirty: true, deleted: !!item.record.deleted, ...(prior?._remoteRevision == null ? {} : { _remoteRevision: prior._remoteRevision }) };
          t.objectStore(item.table).put(full); output.push(full); audit.push({ table: item.table, id: full.id, before: prior, after: full });
        });
        t.objectStore('history').put({ id: uuid(), at: now(), label, scope: SCOPE.key, changes: audit });
    };
    if (uniqueWorkExpenseLinks) {
      const req = t.objectStore('expenses').getAll();
      req.onsuccess = () => guarded(() => { existingExpenses = req.result; commit(); });
    }
    changes.forEach((c, i) => {
      const req = t.objectStore(c.table).get(c.record.id);
      req.onsuccess = () => guarded(() => {
        before[i] = req.result || null; commit();
      });
    });
  });
  changes.forEach((c, i) => changed(c.table, saved[i].id)); return saved;
}
export async function save(store, row) { return (await atomicBatchSave([{ table: store, record: row }], { label: (row.deleted ? 'Delete ' : 'Save ') + store + ' record' }))[0]; }
export async function softDelete(store, id) {
  const row = await db.get(store, id);
  if (row) return (await atomicBatchSave([{ table: store, record: { ...row, deleted: true }, expectedUpdatedAt: row.updated_at }], { label: 'Delete ' + store + ' record' }))[0];
}
export async function live(store) { return (await db.all(store)).filter(r => !r.deleted); }
export async function listHistory(limit = 100) { return (await db.all('history')).sort((a, b) => b.at.localeCompare(a.at)).slice(0, limit); }
export async function undoChange(id) {
  const entry = await db.get('history', id);
  if (!entry || entry.undoneAt) throw Error('This change is no longer available to undo.');
  const d = await open(); assertScopeCurrent();
  await new Promise((resolve, reject) => {
    const t = d.transaction([...new Set(entry.changes.map(c => c.table)), 'history'], 'readwrite');
    const checkLinks = entry.changes.some(c => c.table === 'expenses' && (c.before?.workExpenseLink?.expenseId || c.after?.workExpenseLink?.expenseId));
    let left = entry.changes.length + (checkLinks ? 1 : 0), existingExpenses = []; const current = [], undo = [];
    const guarded = guardTransaction(t, resolve, reject);
    const commit = () => {
        if (--left) return;
        entry.changes.forEach((change, j) => { if (!sameVersion(current[j], change.after)) throw Error('This record has newer edits. Undo those changes first.'); });
        if (checkLinks) assertUniqueWorkLinks(existingExpenses, entry.changes.filter(c => c.table === 'expenses').map(c => c.before || { id: c.id, deleted: true }));
        entry.changes.forEach((change, j) => {
          const before = current[j];
          const restored = { ...(change.before || before), id: change.id, deleted: change.before ? !!change.before.deleted : true, dirty: true, updated_at: stamp(before), _remoteRevision: before?._remoteRevision };
          t.objectStore(change.table).put(restored); undo.push({ table: change.table, id: change.id, before, after: restored });
        });
        t.objectStore('history').put({ ...entry, undoneAt: now() });
        t.objectStore('history').put({ id: uuid(), at: now(), label: 'Undo: ' + entry.label, scope: SCOPE.key, changes: undo });
    };
    if (checkLinks) {
      const read = t.objectStore('expenses').getAll();
      read.onsuccess = () => guarded(() => { existingExpenses = read.result; commit(); });
    }
    entry.changes.forEach((c, i) => {
      const req = t.objectStore(c.table).get(c.id);
      req.onsuccess = () => guarded(() => {
        current[i] = req.result; commit();
      });
    });
  });
  entry.changes.forEach(c => changed(c.table, c.id));
}
export async function resolveStoredConflict(id, choice) {
  if (!['local', 'remote'].includes(choice)) throw Error('Choose this device or the cloud version.');
  const conflict = await db.get('conflicts', id);
  if (!conflict) throw Error('This conflict has already been resolved.');
  const d = await open(); assertScopeCurrent();
  await new Promise((resolve, reject) => {
    const t = d.transaction([conflict.table, 'conflicts', 'history'], 'readwrite');
    const o = t.objectStore(conflict.table), req = o.get(conflict.recordId);
    const guarded = guardTransaction(t, resolve, reject);
    req.onsuccess = () => guarded(() => {
      const before = req.result;
      if (!sameVersion(before, conflict.local)) throw Error('The local record changed. Sync again and review the updated conflict.');
      const remote = conflict.remote;
      const after = choice === 'local' ? { ...before, updated_at: stamp(before), dirty: true, _remoteRevision: remote?._remoteRevision ?? null } :
        remote ? { ...remote, dirty: false } : { ...before, deleted: true, dirty: false, _remoteRevision: null };
      o.put(after); t.objectStore('conflicts').delete(id);
      t.objectStore('history').put({ id: uuid(), at: now(), label: 'Resolve conflict: use ' + (choice === 'local' ? 'this device' : 'cloud'), scope: SCOPE.key, changes: [{ table: conflict.table, id: before.id, before, after }] });
    });
  });
  changed(conflict.table, conflict.recordId);
}
