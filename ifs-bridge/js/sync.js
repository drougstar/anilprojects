// Push dirty local rows, pull remote changes, last write wins by updated_at.
// Server rows are { id, user_id, updated_at, deleted, data } where data holds the whole
// app record, so the app can add fields without touching the database.
import { db, TABLES } from './db.js';

let running = false;

function toServer(row, userId) {
  const { dirty: _d, ...data } = row;
  return { id: row.id, user_id: userId, updated_at: row.updated_at, deleted: !!row.deleted, data };
}

function fromServer(r) {
  return { ...(r.data || {}), id: r.id, updated_at: r.updated_at, deleted: !!r.deleted, dirty: false };
}

export async function sync(client, onStatus = () => {}) {
  if (!client.configured || !client.signedIn) return { skipped: true };
  if (running) return { skipped: true };
  running = true;
  const result = { pushed: 0, pulled: 0, receipts: 0, errors: [] };
  try {
    for (const table of TABLES) {
      onStatus(`Syncing ${table}…`);
      const local = await db.all(table);
      const dirty = local.filter(r => r.dirty);
      if (dirty.length) {
        await client.upsert(table, dirty.map(r => toServer(r, client.userId)));
        for (const r of dirty) await db.put(table, { ...r, dirty: false });
        result.pushed += dirty.length;
      }
      const since = await db.meta(`lastSync.${table}`);
      const remote = await client.pull(table, since);
      let newest = since || '';
      for (const raw of remote) {
        const r = fromServer(raw);
        const l = await db.get(table, r.id);
        if (!l || l.updated_at < r.updated_at) { await db.put(table, r); result.pulled++; }
        if (r.updated_at > newest) newest = r.updated_at;
      }
      if (newest) await db.setMeta(`lastSync.${table}`, newest);
    }
    const receipts = await db.all('receipts');
    for (const rc of receipts.filter(r => r.dirty && r.blob)) {
      onStatus('Uploading receipt…');
      try { await client.uploadReceipt(rc.id, rc.blob); await db.put('receipts', { ...rc, dirty: false }); result.receipts++; }
      catch (e) { result.errors.push(e.message); }
    }
    await db.setMeta('lastSyncAt', new Date().toISOString());
    onStatus('');
  } catch (e) {
    result.errors.push(e.message);
    onStatus(e.message);
  } finally { running = false; }
  return result;
}

// Quick check that the project is reachable and the tables exist (run after sign-in).
export async function checkSetup(client) {
  if (!client.configured) return 'Enter the project URL and anon key first.';
  if (!client.signedIn) return 'Sign in first.';
  try {
    for (const t of TABLES) await client.rest(`${t}?select=id&limit=1`);
    return 'ok';
  } catch (e) {
    if (/42P01|does not exist|404/.test(e.message)) return 'Tables missing: run supabase/schema.sql in the SQL editor of your project, then try again.';
    return e.message;
  }
}

// Fetch a receipt photo, from local store first, else from Supabase (and cache it).
export async function receiptBlob(client, id) {
  const local = await db.get('receipts', id);
  if (local?.blob) return local.blob;
  if (!client.signedIn) return null;
  const blob = await client.downloadReceipt(id);
  if (blob) await db.put('receipts', { id, blob, dirty: false });
  return blob;
}
