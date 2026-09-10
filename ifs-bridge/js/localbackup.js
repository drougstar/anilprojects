// Automatic backup to the PC when the app is served by app/server.py (localhost only).
// Every change is pushed as one JSON snapshot to /api/backup (debounced); when the
// browser store is empty at start-up, the latest snapshot is restored automatically.
// This protects against the browser profile being reset (the Claude app's browser pane
// lost everything on 9 Sep 2026) and keeps a history of the last 60 snapshots on disk.
import { db, TABLES } from './db.js';
import { loadSettings, saveSettings } from './store.js';
import { toast } from './dom.js';

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
let timer = null;
let lastResult = { at: null, error: '' };

export function backupAvailable() { return LOCAL; }
export function lastBackup() { return lastResult; }

export async function snapshot() {
  const out = { version: 1, savedAt: new Date().toISOString(), settings: loadSettings() };
  for (const t of TABLES) out[t] = await db.all(t);
  return out;
}

export async function pushBackup() {
  if (!LOCAL) return null;
  try {
    const body = JSON.stringify(await snapshot());
    const res = await fetch('/api/backup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    if (!res.ok) throw new Error(`server ${res.status}`);
    const r = await res.json();
    lastResult = { at: r.savedAt, error: '' };
  } catch (e) {
    lastResult = { at: lastResult.at, error: e.message };
  }
  document.dispatchEvent(new CustomEvent('ifsbridge:backup', { detail: lastResult }));
  return lastResult;
}

export function scheduleBackup(delay = 2000) {
  if (!LOCAL) return;
  clearTimeout(timer);
  timer = setTimeout(pushBackup, delay);
}

export async function fetchBackup() {
  const res = await fetch('/api/backup', { cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`server ${res.status}`);
  return res.json();
}

export async function backupMeta() {
  try { const r = await fetch('/api/backup/meta', { cache: 'no-store' }); return r.ok ? r.json() : null; } catch { return null; }
}

// Restore a snapshot into the browser store. Rows already present win only if newer.
export async function restoreSnapshot(snap, { replaceSettings = true } = {}) {
  let n = 0;
  for (const t of TABLES) {
    for (const r of snap[t] || []) {
      if (!r || !r.id) continue;
      const cur = await db.get(t, r.id);
      if (cur && cur.updated_at > r.updated_at) continue;
      await db.put(t, { ...r, dirty: true }); n++;
    }
  }
  // drop empty sheets that were auto-created by an empty store
  const lines = await db.all('expenses');
  for (const s of await db.all('sheets')) if (!snap.sheets?.some(x => x.id === s.id) && !lines.some(l => l.sheetId === s.id)) await db.remove('sheets', s.id);
  if (replaceSettings && snap.settings) {
    const cur = loadSettings();
    const merged = { ...snap.settings };
    // keep keys already typed on this device if the backup has none
    if (!merged.clockify?.apiKey && cur.clockify?.apiKey) merged.clockify = cur.clockify;
    if (!merged.supabase?.url && cur.supabase?.url) merged.supabase = cur.supabase;
    saveSettings(merged);
  }
  return n;
}

// Called once at start-up.
export async function initLocalBackup({ onRestored } = {}) {
  if (!LOCAL) return;
  document.addEventListener('ifsbridge:changed', () => scheduleBackup());
  try {
    const lines = await db.all('expenses'), trips = await db.all('trips');
    if (lines.length === 0 && trips.length === 0) {
      const snap = await fetchBackup();
      if (snap && ((snap.expenses || []).length || (snap.trips || []).length || (snap.sheets || []).length)) {
        const n = await restoreSnapshot(snap);
        toast(`Restored ${n} records from the PC backup (${new Date(snap.savedAt).toLocaleString()})`, 6000);
        onRestored && onRestored();
        return;
      }
    }
    scheduleBackup(500); // make sure a first snapshot exists
  } catch (e) {
    lastResult = { at: null, error: e.message };
  }
}
