// Local IndexedDB store: works offline, syncs to Supabase when signed in (sync.js).
// Every row: { id, ..., updated_at (ISO), deleted (bool), dirty (bool, local only) }.
const NAME = 'ifsbridge';
const VERSION = 1;
export const TABLES = ['sheets', 'trips', 'expenses'];
let opening = null;

function open() {
  opening ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(NAME, VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      for (const s of [...TABLES, 'receipts']) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return opening;
}

async function run(store, mode, fn) {
  const d = await open();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const db = {
  get: (store, id) => run(store, 'readonly', o => o.get(id)),
  all: store => run(store, 'readonly', o => o.getAll()),
  put: (store, value) => run(store, 'readwrite', o => o.put(value)),
  remove: (store, id) => run(store, 'readwrite', o => o.delete(id)),
  meta: async key => (await run('meta', 'readonly', o => o.get(key)))?.value,
  setMeta: (key, value) => run('meta', 'readwrite', o => o.put({ key, value })),
};

export const now = () => new Date().toISOString();
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => { const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16); }));

// Save a row locally and mark it for sync.
export async function save(store, row) {
  const full = { ...row, updated_at: now(), dirty: true, deleted: !!row.deleted };
  if (!full.id) full.id = uuid();
  await db.put(store, full);
  document.dispatchEvent(new CustomEvent('ifsbridge:changed', { detail: { store, id: full.id } }));
  return full;
}

export async function softDelete(store, id) {
  const row = await db.get(store, id);
  if (row) await save(store, { ...row, deleted: true });
}

export async function live(store) {
  return (await db.all(store)).filter(r => !r.deleted);
}
