// Timesheet weeks marked as entered in IFS, with a snapshot of the rows that were pasted,
// so a later Clockify change can be shown as a difference.
import { save, live } from './db.js';

export function snapshotRows(w) {
  return w.rows.map(r => ({
    shortName: r.mapping.shortName || r.mapping.clockifyProjectName || '',
    code: r.code,
    hours: r.hours.map(h => Math.round(h * 100) / 100),
    total: Math.round(r.total * 100) / 100,
  })).sort((a, b) => `${a.shortName}|${a.code}`.localeCompare(`${b.shortName}|${b.code}`));
}

export async function allWeeks() {
  return (await live('weeks')).sort((a, b) => (b.monday || '').localeCompare(a.monday || ''));
}

export async function weekRecord(monday) {
  return (await live('weeks')).find(x => x.monday === monday) || null;
}

export async function markWeekEntered(w) {
  const cur = await weekRecord(w.mondayIso);
  return save('weeks', { ...(cur || { created_at: new Date().toISOString() }), monday: w.mondayIso, enteredAt: new Date().toISOString(), rows: snapshotRows(w), total: Math.round(w.weekTotal * 100) / 100 });
}

// Human-readable differences between what was entered and what Clockify gives now.
export function diffRows(savedRows, w) {
  const cur = snapshotRows(w);
  const key = r => `${r.shortName}|${r.code}`;
  const was = new Map((savedRows || []).map(r => [key(r), r]));
  const now = new Map(cur.map(r => [key(r), r]));
  const out = [];
  for (const [k, r] of now) {
    const s = was.get(k);
    if (!s) out.push(`new row ${r.shortName} ${r.code}: ${r.total} h`);
    else if (s.hours.join(',') !== r.hours.join(',')) out.push(`${r.shortName} ${r.code}: ${s.hours.map(h => h || '·').join(' ')} → ${r.hours.map(h => h || '·').join(' ')}`);
  }
  for (const [k, s] of was) if (!now.has(k)) out.push(`row gone ${s.shortName} ${s.code}: was ${s.total} h`);
  return out;
}

export function shiftIso(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

// Mondays of the last n weeks, newest first, starting from the week of `mondayIso`.
export function recentMondays(mondayIso, n = 10) {
  return Array.from({ length: n }, (_, i) => shiftIso(mondayIso, -7 * i));
}
