// PC backups belong to the same account, backend and workspace as this page.
// Only guest Work uses the original data/ path; other spaces get separate folders.
import { db, TABLES } from './db.js';
import { loadSettings, saveSettings } from './store.js';
import { toast } from './dom.js';
import { currentScope, assertScopeCurrent, scopeIsCurrent } from './scope.js';

const LOCAL = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
const PROTOCOL = 'ifsbridge-scoped-backup-v1';
const LOCAL_TABLES = ['history', 'conflicts', 'meta'];
const SCOPE = currentScope();
const scopeFields = scope => [scope.accountKey, scope.workspace, scope.key, scope.userId, scope.backend, scope.legacy];
let timer = null, tokenPromise = null, inFlight = null, pending = false;
let initialized = false, starting = null, supported = null, restoreBlocked = false;
let lastResult = { at: null, error: '' };

export function backupAvailable() { return LOCAL && supported !== false; }
export function lastBackup() { return lastResult; }

// Shared by manual JSON exports and PC snapshots. No session token is included.
export function backupScopeMetadata(scope = currentScope()) {
  return { version: 3, schema: 'ifsbridge.backup', scope: {
    accountKey: scope.accountKey, workspace: scope.workspace, key: scope.key,
    userId: scope.userId, backend: scope.backend, legacy: scope.legacy,
  } };
}

export function assertBackupScope(snap, scope = currentScope(), { allowLegacyGuestWork = true } = {}) {
  if (!snap || typeof snap !== 'object' || Array.isArray(snap)) throw Error('This file is not an IFS Bridge backup.');
  if (!snap.scope) {
    if (!(allowLegacyGuestWork && scope.legacy && scope.workspace === 'work' && scope.userId === null)) {
      throw Error('This older backup has no account or workspace label. Open guest Work to review it; it cannot be restored here.');
    }
    if (![1, 2].includes(snap.version)) throw Error('This backup format is not supported.');
  } else {
    if (snap.schema !== 'ifsbridge.backup' || snap.version !== 3) throw Error('This backup format is not supported.');
    if (JSON.stringify(scopeFields(snap.scope)) !== JSON.stringify(scopeFields(scope))) {
      throw Error('This backup belongs to a different account, backend or workspace. Switch to its original space before restoring it.');
    }
  }
  for (const table of [...TABLES, ...LOCAL_TABLES, 'receipts']) {
    if (snap[table] !== undefined && !Array.isArray(snap[table])) throw Error(`Invalid backup table: ${table}.`);
  }
  if (!Array.isArray(snap.expenses)) throw Error('This file does not contain an expense backup.');
  return snap;
}

async function scopeToken() {
  assertScopeCurrent();
  if (SCOPE.legacy) return 'legacy';
  tokenPromise ||= crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(scopeFields(SCOPE))))
    .then(buffer => [...new Uint8Array(buffer)].map(value => value.toString(16).padStart(2, '0')).join(''));
  const token = await tokenPromise;
  assertScopeCurrent();
  return token;
}

async function endpoint(path) {
  const token = await scopeToken();
  // The separate route also fails closed if an old server replaces the updated one.
  return token === 'legacy' ? path : `${path.replace('/api/', '/api/scoped/')}?scope=${token}`;
}

// Keep the timer active through the response body, not only until headers arrive.
// Aborting the request also prevents a late restore after startup has continued.
async function pcRequest(url, options = {}, format = 'json') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    assertScopeCurrent();
    const response = await fetch(url, { ...options, signal: controller.signal });
    assertScopeCurrent();
    const data = response.ok ? await (format === 'blob' ? response.blob() : response.json()) : null;
    assertScopeCurrent();
    return { response, data };
  } catch (error) {
    if (controller.signal.aborted) throw Error('The PC backup request timed out. Your browser data remains available; check the local server before backing up again.');
    throw error;
  } finally { clearTimeout(timeout); }
}

async function readMeta() {
  if (!LOCAL) return null;
  assertScopeCurrent();
  let response, meta;
  try { ({ response, data: meta } = await pcRequest(await endpoint('/api/backup/meta'), { cache: 'no-store' })); }
  catch (error) {
    if (error instanceof SyntaxError) { supported = false; return null; }
    throw error;
  }
  if ([404, 405, 501].includes(response.status)) { supported = false; return null; }
  if (!response.ok) throw Error(`PC backup server returned ${response.status}.`);
  // Old servers ignore query parameters. Require explicit support before upload.
  if (!meta || meta.protocol !== PROTOCOL || meta.scopeToken !== await scopeToken()) {
    supported = false;
    return null;
  }
  supported = true;
  return meta;
}

async function requireServer() {
  if (!(await readMeta())) throw Error('Scoped PC backup is unavailable. Start the updated IFS Bridge server; your browser data is still saved locally.');
}

export async function snapshot() {
  assertScopeCurrent();
  const out = { ...backupScopeMetadata(SCOPE), savedAt: new Date().toISOString(), settings: loadSettings() };
  for (const table of [...TABLES, ...LOCAL_TABLES]) {
    out[table] = await db.all(table);
    assertScopeCurrent();
  }
  return out;
}

// Receipt changes in undo history can contain Blobs even though current photos
// are also stored separately. JSON must preserve those binary snapshots as well.
async function encodeBinary(value) {
  if (value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    let binary = '';
    for (let start = 0; start < bytes.length; start += 32768) binary += String.fromCharCode(...bytes.subarray(start, start + 32768));
    return { __ifsBlob: btoa(binary), type: value.type || 'application/octet-stream' };
  }
  if (Array.isArray(value)) return Promise.all(value.map(encodeBinary));
  if (value && typeof value === 'object') return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await encodeBinary(item)])));
  return value;
}

function decodeBinary(value) {
  if (value instanceof Blob) return value;
  if (value && typeof value === 'object' && typeof value.__ifsBlob === 'string') {
    const bytes = Uint8Array.from(atob(value.__ifsBlob), character => character.charCodeAt(0));
    return new Blob([bytes], { type: typeof value.type === 'string' ? value.type : 'application/octet-stream' });
  }
  if (Array.isArray(value)) return value.map(decodeBinary);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, decodeBinary(item)]));
  return value;
}

export async function pushBackup() {
  if (!LOCAL) return null;
  if (inFlight) { pending = true; return inFlight; }
  inFlight = (async () => {
    try {
      if (restoreBlocked) throw Error('The PC backup could not be restored. Review that backup before replacing it with this browser’s data.');
      await requireServer();
      const body = JSON.stringify(await encodeBinary(await snapshot()));
      assertScopeCurrent();
      const { response, data: result } = await pcRequest(await endpoint('/api/backup'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
      if (!response.ok) throw Error(`PC backup server returned ${response.status}.`);
      if (!result || result.protocol !== PROTOCOL || result.scopeToken !== await scopeToken()) throw Error('The PC server did not confirm this workspace backup.');
      lastResult = { at: result.savedAt, error: '' };
      await pushReceipts();
    } catch (error) { lastResult = { at: lastResult.at, error: error.message }; }
    document.dispatchEvent(new CustomEvent('ifsbridge:backup', { detail: lastResult }));
    return lastResult;
  })();
  try { return await inFlight; }
  finally {
    inFlight = null;
    if (pending) { pending = false; scheduleBackup(500); }
  }
}

async function pushReceipts() {
  const token = await scopeToken();
  for (const receipt of await db.all('receipts')) {
    assertScopeCurrent();
    if (!receipt.blob || receipt.pcScope === token || (SCOPE.legacy && receipt.pc && !receipt.pcScope)) continue;
    const { response } = await pcRequest(await endpoint(`/api/receipt/${encodeURIComponent(receipt.id)}`), {
      method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: receipt.blob,
    });
    if (!response.ok) throw Error(`A receipt could not be backed up (${response.status}).`);
    await db.put('receipts', { ...receipt, pc: true, pcScope: token });
  }
}

export async function pcReceipt(id) {
  if (!LOCAL) return null;
  try {
    await requireServer();
    const { response, data: blob } = await pcRequest(await endpoint(`/api/receipt/${encodeURIComponent(id)}`), { cache: 'no-store' }, 'blob');
    if (!response.ok) return null;
    return blob;
  } catch { return null; }
}

export function scheduleBackup(delay = 2000) {
  if (!LOCAL || supported === false || restoreBlocked || !scopeIsCurrent()) return;
  if (!initialized) { pending = true; return; }
  clearTimeout(timer);
  timer = setTimeout(pushBackup, delay);
}

export async function fetchBackup() {
  if (!LOCAL) return null;
  await requireServer();
  const { response, data: snap } = await pcRequest(await endpoint('/api/backup'), { cache: 'no-store' });
  if (response.status === 404) return null;
  if (!response.ok) throw Error(`PC backup server returned ${response.status}.`);
  return assertBackupScope(snap, SCOPE);
}

export async function backupMeta() {
  try { return await readMeta(); } catch { return null; }
}

// Validate the document before any write. Newer local records win.
export async function restoreSnapshot(snap, { replaceSettings = true } = {}) {
  assertScopeCurrent();
  assertBackupScope(snap, SCOPE);
  snap = decodeBinary(snap);
  let count = 0;
  for (const table of [...TABLES, ...LOCAL_TABLES]) {
    for (const row of snap[table] || []) {
      const key = table === 'meta' ? row?.key : row?.id;
      if (!key) continue;
      const current = await db.get(table, key);
      assertScopeCurrent();
      if (current && Date.parse(current.updated_at || 0) > Date.parse(row.updated_at || 0)) continue;
      await db.put(table, TABLES.includes(table) ? { ...row, dirty: true } : row);
      assertScopeCurrent();
      count++;
    }
  }
  if (replaceSettings && snap.settings && typeof snap.settings === 'object') {
    const current = loadSettings();
    const merged = { ...snap.settings, supabase: current.supabase };
    if (!merged.clockify?.apiKey && current.clockify?.apiKey) merged.clockify = current.clockify;
    // Account/backend selection must never come from a backup.
    assertScopeCurrent();
    saveSettings(merged);
  }
  restoreBlocked = false;
  return count;
}

export async function initLocalBackup({ onRestored } = {}) {
  if (!LOCAL) return;
  if (starting) return starting;
  document.addEventListener('ifsbridge:changed', () => scheduleBackup());
  starting = (async () => {
    try {
      if (!(await readMeta())) return;
      let empty = true;
      for (const table of [...TABLES, 'history', 'conflicts']) {
        const rows = await db.all(table);
        assertScopeCurrent();
        if (rows.some(row => table !== 'sheets' || !row.autoCreated || row.expenseId)) empty = false;
      }
      if (empty) {
        const snap = await fetchBackup();
        if (snap) {
          const count = await restoreSnapshot(snap);
          toast(`Restored ${count} records from this workspace’s PC backup.`, 6000);
          if (onRestored) await onRestored();
        }
      }
    } catch (error) { restoreBlocked = true; lastResult = { at: null, error: error.message }; }
    finally {
      initialized = true;
      pending = false;
      // Failed restoration must not overwrite the only PC copy with an empty store.
      if (!lastResult.error && supported) scheduleBackup(500);
    }
  })();
  return starting;
}
