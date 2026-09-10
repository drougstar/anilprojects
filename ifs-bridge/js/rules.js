// Turns Clockify time entries for one week into IFS project-time rows.
//
// Rules:
//  - every day/project bucket is rounded to the configured step (0.5 h)
//  - Mon-Fri: N regular hours per day (9 for Turkish projects, 8 for US ones;
//    set per mapping, default in settings) and general/break time counts inside it;
//    regular project hours = N - general, the rest is overtime x1.5 (F_02)
//  - entries tagged x2, every hour on Sunday and on a configured holiday: x2 (F_10)
//  - Saturday work: overtime x1.5 (F_02)
//  - general/break goes to the general project with F_03
//  - travel (tag "Travel" or description starting with "travel"): goes to the
//    project's TRAVEL activity. On Sat/Sun/holiday all of it is F_12 (x1).
//    On a weekday, travel beyond the day's threshold (work + travel > 9 h) is F_12;
//    travel inside the threshold is travel regular time (F_01). Tag "Travel OT" forces F_12.

export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---- local time helpers ----

function localParts(date, tz) {
  const f = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz, hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const p = {};
  for (const part of f.formatToParts(date)) p[part.type] = part.value;
  return { y: +p.year, m: +p.month, d: +p.day, H: +p.hour, M: +p.minute, S: +p.second };
}

function tzOffsetMs(date, tz) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.y, p.m - 1, p.d, p.H, p.M, p.S);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

export function localMidnight(y, m, d, tz) {
  let guess = Date.UTC(y, m - 1, d);
  for (let i = 0; i < 2; i++) guess = Date.UTC(y, m - 1, d) - tzOffsetMs(new Date(guess), tz);
  return new Date(guess);
}

export function isoDate(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function addDays(y, m, d, n) {
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
}

export function mondayOf(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const dow = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;
  const r = addDays(y, m, d, -dow);
  return isoDate(r.y, r.m, r.d);
}

export function weekDates(mondayIso) {
  const [y, m, d] = mondayIso.split('-').map(Number);
  return Array.from({ length: 7 }, (_, i) => { const r = addDays(y, m, d, i); return isoDate(r.y, r.m, r.d); });
}

export function fetchWindow(mondayIso, tz) {
  const [y, m, d] = mondayIso.split('-').map(Number);
  const a = addDays(y, m, d, -1), b = addDays(y, m, d, 8);
  return { start: localMidnight(a.y, a.m, a.d, tz).toISOString(), end: localMidnight(b.y, b.m, b.d, tz).toISOString() };
}

export function splitEntry(entry, tz) {
  const ti = entry.timeInterval || {};
  if (!ti.start || !ti.end) return [];
  const segs = [];
  let cur = new Date(ti.start);
  const end = new Date(ti.end);
  let guard = 0;
  while (cur < end && guard++ < 14) {
    const p = localParts(cur, tz);
    const next = addDays(p.y, p.m, p.d, 1);
    const boundary = localMidnight(next.y, next.m, next.d, tz);
    const segEnd = boundary < end ? boundary : end;
    segs.push({ date: isoDate(p.y, p.m, p.d), start: cur, minutes: (segEnd - cur) / 60000 });
    cur = segEnd;
  }
  return segs;
}

// "2026-08-24T08:30" in tz -> ISO UTC instant, and back (for datetime-local inputs).
export function localToUtc(localInput, tz) {
  const [d, t] = localInput.split('T');
  const [y, m, day] = d.split('-').map(Number);
  const [H, M] = (t || '00:00').split(':').map(Number);
  const naive = Date.UTC(y, m - 1, day, H, M);
  let guess = naive;
  for (let i = 0; i < 2; i++) guess = naive - tzOffsetMs(new Date(guess), tz);
  return new Date(guess).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function utcToLocalInput(iso, tz) {
  if (!iso) return '';
  const p = localParts(new Date(iso), tz);
  return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}T${String(p.H).padStart(2, '0')}:${String(p.M).padStart(2, '0')}`;
}

export function roundTo(hours, step, mode = 'nearest') {
  const q = hours / step;
  const n = mode === 'down' ? Math.floor(q + 1e-9) : mode === 'up' ? Math.ceil(q - 1e-9) : Math.round(q);
  return Math.round(n * step * 100) / 100;
}

function otClassOf(entry, tags) {
  const names = (entry.tags || []).map(t => t.name);
  if (tags.x2 && names.includes(tags.x2)) return 'x2';
  if (tags.x15 && names.includes(tags.x15)) return 'x15';
  return 'none';
}

// 'none' | 'travel' (normal travel) | 'travelOT' (tag forces travel overtime x1)
function travelClassOf(entry, settings) {
  const names = (entry.tags || []).map(t => t.name);
  if (settings.tags.travelOT && names.includes(settings.tags.travelOT)) return 'travelOT';
  if (settings.tags.travel && names.includes(settings.tags.travel)) return 'travel';
  if (settings.travelKeyword && new RegExp(`^\\s*${settings.travelKeyword}\\b`, 'i').test(entry.description || '')) return 'travel';
  return 'none';
}

// ---- main ----
//
// A Clockify description may carry "Short Name: 210701.010101.010101-I" to send
// that entry to a specific IFS activity (PROJECT.SUBPROJECT.ACTIVITY_NO).
const SHORT_NAME_RE = /short\s*name\s*:\s*([0-9A-Za-z]+\.[0-9A-Za-z]+\.[0-9A-Za-z-]+)/i;

export function buildWeek(entries, mondayIso, settings, mapping) {
  const tz = settings.timeZone;
  const dates = weekDates(mondayIso);
  const dayIndex = new Map(dates.map((d, i) => [d, i]));
  const holidays = new Set(settings.holidays || []);
  const warnings = [];
  const byKey = new Map();

  for (const e of entries) {
    if (!e.timeInterval || !e.timeInterval.end) { warnings.push({ level: 'warn', text: `Running timer ignored: "${e.description || ''}" (${e.project?.name || 'no project'})` }); continue; }
    const segs = splitEntry(e, tz);
    const title = (e.description || '').split(/\r?\n/)[0];
    if (segs.length > 1) warnings.push({ level: 'info', text: `Entry "${title}" crosses midnight; split into ${segs.map(s => `${s.date} ${(s.minutes / 60).toFixed(2)} h`).join(' + ')}` });
    const travelClass = travelClassOf(e, settings);
    const travel = travelClass !== 'none';
    const shortName = (SHORT_NAME_RE.exec(e.description || '') || [])[1] || '';
    for (const s of segs) {
      if (!dayIndex.has(s.date)) continue;
      const pid = e.projectId || '';
      const ot = otClassOf(e, settings.tags);
      const k = `${s.date}|${pid}|${ot}|${travelClass}|${shortName}`;
      const b = byKey.get(k) || { date: s.date, day: dayIndex.get(s.date), projectId: pid, projectName: e.project?.name || '(no project)', ot, travel, travelClass, shortName, minutes: 0, first: s.start, entries: [] };
      b.minutes += s.minutes;
      if (s.start < b.first) b.first = s.start;
      b.entries.push({ description: title, minutes: s.minutes, start: s.start });
      byKey.set(k, b);
    }
  }

  const buckets = [...byKey.values()].map(b => ({ ...b, hours: roundTo(b.minutes / 60, settings.roundStep, settings.roundMode) }));
  const mapById = new Map(mapping.map(m => [m.clockifyProjectId, m]));
  const codes = settings.codes;
  const rows = new Map();
  const ignored = new Map();
  const unmapped = new Map();

  const rowFor = (target, code) => {
    const key = `${target.shortName || target.clockifyProjectId}|${code}`;
    let r = rows.get(key);
    if (!r) { r = { mapping: target, code, hours: [0, 0, 0, 0, 0, 0, 0], total: 0 }; rows.set(key, r); }
    return r;
  };
  const put = (target, code, day, h) => { if (h <= 0) return; const r = rowFor(target, code); r.hours[day] = round2(r.hours[day] + h); r.total = round2(r.total + h); };
  const travelTarget = m => {
    if (m.travel && m.travel.shortName) return { ...m, ...m.travel, clockifyProjectName: `${m.clockifyProjectName} (travel)` };
    warnings.push({ level: 'warn', text: `${m.clockifyProjectName}: no TRAVEL activity configured; travel hours were put on the main activity. Add it in Settings.` });
    return m;
  };

  // Resolve a bucket to { m: IFS target, travel: boolean, base: the Clockify project mapping }.
  const resolve = b => {
    const base = mapById.get(b.projectId);
    if (!base || base.kind === 'ignore') return { base };
    if (base.kind === 'general') return { base, m: base, general: true };
    if (b.shortName) {
      const hit = mapping.find(x => x.shortName === b.shortName);
      if (hit) return { base, m: hit, travel: b.travel };
      const th = mapping.find(x => x.travel?.shortName === b.shortName);
      if (th) return { base, m: travelTarget(th), travel: true };
      const [p, sp, a] = b.shortName.split('.');
      warnings.push({ level: 'warn', text: `Short Name ${b.shortName} is not in the mapping; exported without ACTIVITY_SEQ and descriptions. Paste one IFS row of it in Settings.` });
      const isTravelAct = b.travel || /travel/i.test(a || '');
      return { base, m: { ...base, projectId: p, subProjectId: sp, activityNo: a, activitySeq: '', activityDesc: '', shortName: b.shortName }, travel: isTravelAct };
    }
    return { base, m: b.travel ? travelTarget(base) : base, travel: b.travel };
  };

  for (let day = 0; day < 7; day++) {
    const todays = buckets.filter(b => b.day === day && b.hours > 0).sort((a, b) => a.first - b.first);
    if (!todays.length) continue;
    const dayType = day === 6 || holidays.has(dates[day]) ? 'sun' : day === 5 ? 'sat' : 'weekday';
    if (holidays.has(dates[day]) && day < 6) warnings.push({ level: 'info', text: `${dates[day]} is a holiday: all hours counted ×2.` });

    let generalHours = 0;
    const work = [], travel = [];
    for (const b of todays) {
      const r = resolve(b);
      if (!r.m) { const bag = r.base ? ignored : unmapped; bag.set(b.projectName, (bag.get(b.projectName) || 0) + b.hours); continue; }
      if (r.general) {
        generalHours += b.hours;
        const code = dayType === 'sun' ? codes.ot2 : dayType === 'sat' ? codes.ot15 : b.ot === 'x2' ? codes.ot2 : codes.regular;
        put(r.m, code, day, b.hours);
      } else (r.travel ? travel : work).push({ b, m: r.m, base: r.base });
    }

    // Regular cap / minimum for the day comes from the first project worked that day.
    const lead = work[0] || travel[0];
    const cap = Number(lead?.base?.regularHours) || settings.regularHours;
    const travelAfter = Number(lead?.base?.travelAfterHours) || settings.travelAfterHours || cap;
    let regularLeft = dayType === 'weekday' ? Math.max(0, cap - generalHours) : 0;
    let workedToday = generalHours;
    for (const { b, m } of work) {
      workedToday = round2(workedToday + b.hours);
      if (dayType === 'sun' || b.ot === 'x2') { put(m, codes.ot2, day, b.hours); continue; }
      if (dayType === 'sat' || b.ot === 'x15') { put(m, codes.ot15, day, b.hours); continue; }
      const reg = Math.min(b.hours, regularLeft);
      regularLeft = round2(regularLeft - reg);
      put(m, codes.regular, day, reg);
      put(m, codes.ot15, day, round2(b.hours - reg));
    }
    let travelInside = 0;
    for (const { b, m } of travel) {
      // Weekend/holiday travel and anything tagged "Travel OT" is travel overtime x1 (F_12).
      if (dayType !== 'weekday' || b.travelClass === 'travelOT') { workedToday = round2(workedToday + b.hours); put(m, codes.travel, day, b.hours); continue; }
      const room = Math.max(0, round2(travelAfter - workedToday));
      const inside = Math.min(b.hours, room);
      workedToday = round2(workedToday + b.hours);
      travelInside = round2(travelInside + inside);
      if (inside > 0) put(m, codes.travelRegular, day, inside);
      if (b.hours - inside > 0) warnings.push({ level: 'info', text: `${dates[day]}: travel split ${inside} h ${codes.travelRegular} (inside the ${travelAfter} h day) + ${round2(b.hours - inside)} h ${codes.travel}. Tag it "${settings.tags.travelOT}" to force all of it to ${codes.travel}.` });
      put(m, codes.travel, day, round2(b.hours - inside));
    }
    // Minimum day: IFS expects at least the regular hours on a worked weekday (8 abroad, 9 in TR).
    if (settings.topUpMinimum !== false && dayType === 'weekday' && lead) {
      const booked = round2(cap - regularLeft + travelInside);
      if (booked < cap) {
        const topUp = round2(cap - booked);
        put(lead.m, codes.regular, day, topUp);
        warnings.push({ level: 'info', text: `${dates[day]}: ${booked} h regular logged, topped up to the ${cap} h minimum on ${lead.m.shortName || lead.m.clockifyProjectName}.` });
      }
    }
  }

  for (const [name, h] of unmapped) warnings.push({ level: 'error', text: `Clockify project "${name}" is not mapped to an IFS activity (${h} h). Map it in Settings before exporting.` });
  for (const [name, h] of ignored) warnings.push({ level: 'info', text: `"${name}" ignored (${h} h), as configured.` });

  const rowList = [...rows.values()].sort((a, b) => (a.mapping.shortName || '').localeCompare(b.mapping.shortName || '') || a.code.localeCompare(b.code));
  const dayTotals = [0, 0, 0, 0, 0, 0, 0];
  for (const r of rowList) r.hours.forEach((h, i) => { dayTotals[i] = round2(dayTotals[i] + h); });
  for (const r of rowList) if (!r.mapping.activitySeq) warnings.push({ level: 'warn', text: `${r.mapping.shortName || r.mapping.clockifyProjectName}: ACTIVITY_SEQ unknown. Paste one IFS row of this activity in Settings so the export carries it.` });

  return { mondayIso, dates, rows: rowList, dayTotals, weekTotal: round2(dayTotals.reduce((a, b) => a + b, 0)), warnings: dedupe(warnings), buckets, canExport: unmapped.size === 0 && rowList.length > 0 };
}

const round2 = n => Math.round(n * 100) / 100;

function dedupe(ws) {
  const seen = new Set();
  return ws.filter(w => { const k = w.level + w.text; if (seen.has(k)) return false; seen.add(k); return true; });
}
