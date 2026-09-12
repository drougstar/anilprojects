import { db, TABLES, sameVersion, resolveStoredConflict } from './db.js';
import { currentScope, assertScopeCurrent } from './scope.js';
import { pcReceipt } from './localbackup.js';
const SCOPE = currentScope();
const MIGRATION = 'Cloud sync needs the workspace update. Run supabase/workspaces-v2.sql in your Supabase SQL editor, then try Sync now. Your local records are safe.';
let running = false;
function fromServer(r) {
  if (r.user_id !== SCOPE.userId || r.workspace_id !== SCOPE.workspace) throw Error('The cloud returned a record from another account or workspace. Sync stopped.');
  return { ...(r.data || {}), id: r.id, updated_at: r.updated_at, deleted: !!r.deleted, dirty: false, _remoteRevision: Number(r.revision) };
}
function payload(table, row) {
  const { dirty, _remoteRevision, ...data } = row;
  return { table, id: row.id, expected_revision: _remoteRevision ?? null, updated_at: row.updated_at, deleted: !!row.deleted, data };
}
const comparable = row => {
  const copy = { ...row };
  if (copy.updated_at) copy.updated_at = new Date(copy.updated_at).toISOString();
  return copy;
};
async function rememberConflict(table, local, remote, result) {
  const id = table + ':' + local.id;
  await db.put('conflicts', { id, table, recordId: local.id, at: new Date().toISOString(), scope: SCOPE.key, local, remote });
  result.conflicts.push({ id, table, recordId: local.id });
}
export async function listConflicts() { return (await db.all('conflicts')).sort((a, b) => b.at.localeCompare(a.at)); }
export const resolveConflict = (id, choice) => resolveStoredConflict(id, choice);
// Keep each current local transaction together while draining a large queue.
// Split relationships survive later edits, so their parent and parts are always
// one unit even when their newest history entries differ.
export function planSyncBatches(queue, history, blocked = new Set(), limit = 5000) {
  const key = c => c.table + ':' + c.local.id;
  const items = new Map(queue.map(c => [key(c), c])), parents = new Map([...items.keys()].map(k => [k, k]));
  const root = k => { while (parents.get(k) !== k) { parents.set(k, parents.get(parents.get(k))); k = parents.get(k); } return k; };
  const join = (a, b) => { if (items.has(a) && items.has(b)) parents.set(root(b), root(a)); };
  for (const entry of history) {
    const members = (entry.changes || []).map(c => ({ key: c.table + ':' + c.id, after: c.after }))
      .filter(c => items.has(c.key) && sameVersion(comparable(items.get(c.key).local), comparable(c.after)));
    for (let i = 1; i < members.length; i++) join(members[0].key, members[i].key);
  }
  const splitGroups = new Map();
  for (const candidate of queue.filter(c => c.table === 'expenses')) {
    const row = candidate.local, own = key(candidate);
    if (row.splitFrom) join(own, 'expenses:' + row.splitFrom);
    for (const child of row.splitChildren || []) join(own, 'expenses:' + child);
    if (row.splitGroupId) {
      if (splitGroups.has(row.splitGroupId)) join(own, splitGroups.get(row.splitGroupId));
      else splitGroups.set(row.splitGroupId, own);
    }
  }
  const groups = new Map();
  for (const c of queue) { const k = root(key(c)); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  const batches = [], oversized = []; let batch = [], blockedCount = 0;
  for (const group of groups.values()) {
    if (group.some(c => blocked.has(key(c)))) { blockedCount += group.length; continue; }
    if (group.length > limit) { oversized.push(group.length); continue; }
    if (batch.length + group.length > limit) { batches.push(batch); batch = []; }
    batch.push(...group);
  }
  if (batch.length) batches.push(batch);
  return { batches, oversized, blockedCount };
}
export async function checkSetup(client) {
  if (!client.configured) return 'Enter the project URL and anon key first.';
  if (!client.signedIn) return 'Sign in first.';
  try { client.assertScope(); return Number(await client.schemaVersion()) === 2 ? 'ok' : MIGRATION; }
  catch (e) { return /404|PGRST202|42883|does not exist|schema cache/.test(e.message) ? MIGRATION : e.message; }
}
export async function sync(client, onStatus = () => {}) {
  if (!client.configured || !client.signedIn || running) return { skipped: true };
  running = true;
  const result = { pushed: 0, pulled: 0, receipts: 0, pending: 0, errors: [], conflicts: [] };
  try {
    assertScopeCurrent(); client.assertScope();
    const setup = await checkSetup(client);
    if (setup !== 'ok') throw Error(setup);
    const candidates = [];
    for (const table of TABLES) {
      onStatus('Syncing ' + table + '…');
      const cloud = new Map((await client.pull(table)).map(raw => [raw.id, fromServer(raw)]));
      const locals = await db.all(table);
      for (const local of locals.filter(r => r.dirty)) {
        const remote = cloud.get(local.id) || null;
        if (remote && sameVersion(comparable(local), comparable(remote))) {
          await db.markSynced(table, local, remote._remoteRevision);
          await db.remove('conflicts', table + ':' + local.id);
          continue;
        }
        candidates.push({ table, local });
        if ((local._remoteRevision ?? null) !== (remote?._remoteRevision ?? null)) await rememberConflict(table, local, remote, result);
      }
      for (const remote of cloud.values()) if (await db.mergeRemote(table, remote)) result.pulled++;
    }
    if (candidates.length) {
      const plan = planSyncBatches(candidates, await db.all('history'), new Set(result.conflicts.map(c => c.id)));
      for (const size of plan.oversized) result.errors.push('A linked change contains ' + size + ' records, above the 5,000-record cloud transaction limit. It remains entirely local for review; no part of that linked change was sent.');
      for (let i = 0; i < plan.batches.length; i++) {
        const batch = plan.batches[i]; onStatus('Saving batch ' + (i + 1) + ' of ' + plan.batches.length + '…');
        // Every batch is revision-checked and atomic. Completed batches stay
        // acknowledged if a later request fails; retry sends only pending work.
        const applied = await client.applyChanges(batch.map(c => payload(c.table, c.local)));
        assertScopeCurrent();
        if (applied.applied) {
          const pending = new Map(batch.map(c => [c.table + ':' + c.local.id, c]));
          if (applied.rows?.length !== batch.length) throw Error('The cloud did not acknowledge every record. Retry sync; local edits remain available.');
          for (const item of applied.rows) {
            const remote = fromServer(item.row), k = item.table + ':' + remote.id, candidate = pending.get(k);
            if (!candidate) throw Error('Unexpected sync acknowledgement.');
            pending.delete(k);
            if (!await db.markSynced(item.table, candidate.local, remote._remoteRevision)) result.pending++;
            await db.remove('conflicts', k); result.pushed++;
          }
        } else {
          if (!applied.conflicts?.length) throw Error('The cloud did not explain why the batch was rejected. Local changes remain pending.');
          for (const item of applied.conflicts) {
            const local = await db.get(item.table, item.id);
            if (local) await rememberConflict(item.table, local, item.row ? fromServer(item.row) : null, result);
          }
        }
      }
    }
    if (result.conflicts.length) result.errors.push(result.conflicts.length + ' conflicting record(s). Both versions are kept. Review them in Account → History and conflicts.');
    if (result.pending) result.errors.push('Some entries changed while syncing. Their latest edits are safe here; press Sync now again.');
    await syncReceipts(client, result, onStatus);
    if (!result.errors.length) await db.setMeta('lastSyncAt', new Date().toISOString());
    onStatus('');
  } catch (e) { result.errors.push(e.message); onStatus(e.message); }
  finally { running = false; }
  return result;
}
async function syncReceipts(client, result, onStatus) {
  for (const rc of (await db.all('receipts')).filter(r => r.dirty && r.blob && !r.deleted)) {
    onStatus('Uploading receipt…');
    try { await client.uploadReceipt(rc.id, rc.blob); await db.markSynced('receipts', rc); result.receipts++; }
    catch (e) { result.errors.push(e.message); }
  }
}
export const receiptErrors = new Map();
export async function receiptBlob(client, id) {
  const local = await db.get('receipts', id);
  if (local?.blob) return local.blob;
  const fromPc = await pcReceipt(id);
  if (fromPc) { await db.put('receipts', { id, blob: fromPc, dirty: false, pc: true }); return fromPc; }
  if (!client.configured) { receiptErrors.set(id, 'Set up sync in Settings to fetch this photo from another device.'); return null; }
  if (!client.signedIn) { receiptErrors.set(id, 'Sign in under Settings to fetch this photo.'); return null; }
  try {
    const blob = await client.downloadReceipt(id);
    await db.put('receipts', { id, blob, dirty: false }); receiptErrors.delete(id); return blob;
  } catch (e) { receiptErrors.set(id, /404/.test(e.message) ? 'Not uploaded yet. Open the source device and press Sync now.' : 'Download failed: ' + e.message); return null; }
}
