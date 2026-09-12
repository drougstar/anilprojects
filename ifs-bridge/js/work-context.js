import { currentScope, assertScopeCurrent, getConnection } from './scope.js';
import { Supabase } from './supabase.js';

const TABLES = ['expenses', 'sheets', 'trips'];
const empty = () => Object.fromEntries(TABLES.map(table => [table, []]));

async function readLocalWork(scope) {
  const name = 'ifsbridge.' + scope.accountKey + '.work';
  if (indexedDB.databases) {
    const databases = await indexedDB.databases(); assertScopeCurrent();
    if (!databases.some(database => database.name === name)) return empty();
  }
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name); let missing = false;
    // Older browsers cannot list databases. Abort upgrades so this read never
    // creates a Work database or changes its schema.
    request.onupgradeneeded = () => { missing = true; request.transaction.abort(); };
    request.onerror = () => missing ? resolve(empty()) : reject(request.error);
    request.onblocked = () => reject(Error('Close other tabs before reading Work records.'));
    request.onsuccess = () => {
      const database = request.result;
      try {
        assertScopeCurrent();
        const tables = TABLES.filter(table => database.objectStoreNames.contains(table));
        if (!tables.length) { database.close(); resolve(empty()); return; }
        const transaction = database.transaction(tables, 'readonly'), result = empty(); let failure;
        const verify = () => { try { assertScopeCurrent(); } catch (error) { failure = error; try { transaction.abort(); } catch {} } };
        const close = () => { database.close(); globalThis.removeEventListener('storage', verify); globalThis.removeEventListener('ifsbridge:session-changed', verify); };
        globalThis.addEventListener('storage', verify); globalThis.addEventListener('ifsbridge:session-changed', verify);
        transaction.oncomplete = () => { close(); try { assertScopeCurrent(); resolve(result); } catch (error) { reject(error); } };
        transaction.onabort = transaction.onerror = () => { close(); reject(failure || transaction.error || Error('Work lookup was cancelled.')); };
        for (const table of tables) {
          const read = transaction.objectStore(table).getAll();
          read.onsuccess = () => { verify(); if (!failure) result[table] = read.result; };
        }
      } catch (error) { database.close(); reject(error); }
    };
  });
}

async function readCloudWork(client, scope) {
  const result = empty();
  // This is a dedicated read-only cross-workspace lookup. The normal sync client
  // always forces the current workspace, and remains unchanged.
  for (const table of TABLES) {
    for (let offset = 0; ; offset += 1000) {
      assertScopeCurrent();
      const headers = await client.headers(); assertScopeCurrent();
      const query = new URLSearchParams({ select: '*', user_id: 'eq.' + scope.userId,
        workspace_id: 'eq.work', order: 'id.asc', limit: '1000', offset: String(offset) });
      const response = await fetch(client.url + '/rest/v1/' + table + '?' + query, { headers, cache: 'no-store' });
      const page = await response.json(); assertScopeCurrent();
      if (!response.ok || !Array.isArray(page)) throw Error('Could not refresh Work records. Try again when your cloud connection is available.');
      for (const row of page) {
        if (row.user_id !== scope.userId || row.workspace_id !== 'work') throw Error('Work lookup returned a different account or workspace. Review stopped.');
        result[table].push({ ...row.data, id: row.id, updated_at: row.updated_at, deleted: !!row.deleted,
          dirty: false, _remoteRevision: Number(row.revision) });
      }
      if (page.length < 1000) break;
    }
  }
  return result;
}

export async function readOnlyWorkContext() {
  assertScopeCurrent();
  const scope = currentScope();
  if (scope.workspace !== 'personal') throw Error('Open Personal to review card spending.');
  const local = await readLocalWork(scope); assertScopeCurrent();
  const client = new Supabase(getConnection());
  if (!client.configured || globalThis.navigator?.onLine === false) {
    return { ...Object.fromEntries(TABLES.map(table => [table, local[table].filter(row => !row.deleted)])),
      notice: 'Using Work records saved on this device. Connect to refresh cloud matches.' };
  }
  const remote = await readCloudWork(client, scope); assertScopeCurrent();
  let conflicts = 0;
  const result = empty();
  for (const table of TABLES) {
    const combined = new Map(remote[table].map(row => [row.id, row]));
    for (const row of local[table]) {
      const cloud = combined.get(row.id);
      if (row.dirty && cloud && Number(cloud._remoteRevision) > Number(row._remoteRevision ?? -1)) {
        combined.delete(row.id); ++conflicts; continue;
      }
      if (row.dirty || (!cloud && row._remoteRevision == null)) combined.set(row.id, row);
    }
    result[table] = [...combined.values()].filter(row => !row.deleted);
  }
  return { ...result, notice: conflicts ? 'Some Work records have sync conflicts and were omitted. Resolve those in Work before matching them.' : '' };
}
