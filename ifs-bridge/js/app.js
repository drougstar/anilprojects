import { Clockify } from './clockify.js';
import { buildWeek, mondayOf, fetchWindow, DAYS, localToUtc, utcToLocalInput } from './rules.js';
import { parseCopyObject, buildRecord, joinRecords, ifsDate, ifsNumber, activityFromRecord, identityFromRecord } from './ifs.js';
import { loadSettings, saveSettings, DEFAULTS } from './store.js';
import { initExpenses, render as renderExpenses, supabaseClient, scheduleSync, exportCsv, backupJson, restoreJson } from './expenses.js';
import { el, $, confirmButton, toast, openDialog, field as dlgField } from './dom.js';
import { initLocalBackup, backupAvailable, backupMeta, pushBackup } from './localbackup.js';
import { sync, checkSetup } from './sync.js';
import { allWeeks, weekRecord, markWeekEntered, diffRows, recentMondays, shiftIso } from './week-status.js';
import { initReport, render as renderOverview } from './report.js';

let settings = loadSettings();
let week = null;          // result of buildWeek
let exportText = '';
let clockifyProjects = null;
let weekEntries = [];      // raw Clockify entries of the loaded week (for the editor)
let clockifyMeta = null;   // { projects, tags } for the entry dialog

// Theme: 'auto' follows the system, 'light' / 'dark' force one.
export function applyTheme(mode) {
  const root = document.documentElement;
  if (mode === 'light' || mode === 'dark') root.dataset.theme = mode; else delete root.dataset.theme;
  try { mode === 'auto' ? localStorage.removeItem('ifsbridge.theme') : localStorage.setItem('ifsbridge.theme', mode); } catch {}
}
function currentTheme() { try { return localStorage.getItem('ifsbridge.theme') || 'auto'; } catch { return 'auto'; } }
const fmtH = h => (h === 0 ? '' : (Math.round(h * 100) / 100).toString());

// ---------- tabs ----------
function showTab(name) {
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${name}`;
  try { localStorage.setItem('ifsbridge.tab', name); } catch {}
  if (name === 'settings') renderSettings();
  if (name === 'expenses') { renderExpenses(); scheduleSync(500); }
  if (name === 'overview') renderOverview();
}

// ---------- week ----------
function todayIso() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: settings.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  return p; // en-CA gives yyyy-mm-dd
}

function shiftMonday(iso, days) {
  const [y, m, d] = iso.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

async function loadWeek() {
  const status = $('#week-status');
  const monday = mondayOf($('#week-monday').value || todayIso());
  $('#week-monday').value = monday;
  if (!settings.clockify.apiKey) { status.textContent = 'Add your Clockify API key in Settings first.'; showTab('settings'); return; }
  status.textContent = 'Loading from Clockify…';
  $('#btn-load').disabled = true;
  try {
    const c = new Clockify(settings.clockify.apiKey);
    if (!settings.clockify.userId) {
      const u = await c.user();
      settings.clockify.userId = u.id; settings.clockify.workspaceId = u.activeWorkspace; settings.clockify.userName = u.name;
      if (u.settings?.timeZone) settings.timeZone = u.settings.timeZone;
      saveSettings(settings);
    }
    const win = fetchWindow(monday, settings.timeZone);
    const entries = await c.entries(settings.clockify.workspaceId, settings.clockify.userId, win.start, win.end);
    weekEntries = entries;
    week = buildWeek(entries, monday, settings, settings.mapping);
    exportText = week.canExport ? makeExport(week) : '';
    renderWeek();
    status.textContent = `${entries.length} Clockify entries read for ${settings.clockify.userName || 'you'}.`;
  } catch (e) {
    status.textContent = e.message;
  } finally { $('#btn-load').disabled = false; renderWeekStrip(); }
}

function makeExport(w) {
  const template = parseCopyObject(settings.template);
  if (!template) return '';
  const id = settings.identity;
  const records = w.rows.map(r => {
    const m = r.mapping;
    const o = {
      RESOURCE_SEQ: id.resourceSeq, RESOURCE_ID: id.resourceId, 'RESOURCE_API.GET_DESCRIPTION(RESOURCE_SEQ)': id.resourceName,
      COMPANY_ID: id.companyId, EMP_NO: id.empNo,
      ACCOUNT_DATE: ifsDate(w.mondayIso),
      SHORT_NAME: m.shortName, PROJECT_ID: m.projectId, 'PROJECT_API.GET_NAME(PROJECT_ID)': m.projectName,
      SUB_PROJECT_ID: m.subProjectId, 'SUB_PROJECT_API.GET_DESCRIPTION(PROJECT_ID,SUB_PROJECT_ID)': m.subProjectDesc,
      ACTIVITY_NO: m.activityNo, ACTIVITY_SEQ: m.activitySeq, 'ACTIVITY_API.GET_DESCRIPTION(ACTIVITY_SEQ)': m.activityDesc,
      REPORT_COST_CODE: r.code,
      'REPORT_COST_API.GET_DESCRIPTION_NEW_DATES(COMPANY_ID,REPORT_COST_CODE, ACCOUNT_DATE)': settings.codeDescriptions[r.code] || '',
      $15: ifsNumber(r.total),
    };
    ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].forEach((d, i) => { o[`${d}_INTERNAL_QUANTITY`] = r.hours[i] > 0 ? ifsNumber(r.hours[i]) : ''; });
    return buildRecord(template, o);
  });
  return joinRecords(records);
}

function renderWeek() {
  const host = $('#week-result');
  host.replaceChildren();
  if (!week) return;
  const w = week;

  // warnings
  if (w.warnings.length) host.append(el('ul', { class: 'warnings' }, w.warnings.map(x => el('li', { class: x.level }, x.text))));

  // table
  const head = el('tr', {}, el('th', {}, 'IFS activity'), el('th', {}, 'Code'), w.dates.map((d, i) => el('th', { class: 'num' }, el('span', {}, DAYS[i]), el('small', {}, d.slice(5)))), el('th', { class: 'num' }, 'Total'));
  const body = w.rows.map(r => el('tr', { class: r.code === settings.codes.ot2 ? 'ot2' : r.code === settings.codes.ot15 ? 'ot15' : '' },
    el('td', {}, el('b', {}, r.mapping.shortName || r.mapping.clockifyProjectName), el('small', {}, r.mapping.activityDesc || r.mapping.projectName || '')),
    el('td', {}, el('span', { class: 'code' }, r.code)),
    r.hours.map(h => el('td', { class: 'num' }, fmtH(h))),
    el('td', { class: 'num total' }, fmtH(r.total))));
  const foot = el('tr', { class: 'totals' }, el('td', { colspan: 2 }, 'Day total'), w.dayTotals.map(h => el('td', { class: 'num' }, fmtH(h))), el('td', { class: 'num total' }, fmtH(w.weekTotal)));
  host.append(el('div', { class: 'tbl' }, el('table', {}, el('thead', {}, head), el('tbody', {}, body.length ? body : el('tr', {}, el('td', { colspan: 10, class: 'empty' }, 'No hours for this week.'))), el('tfoot', {}, foot))));

  // export
  const actions = el('div', { class: 'actions' });
  const copyBtn = el('button', { class: 'primary', disabled: w.canExport ? null : 'disabled', onclick: copyExport }, 'Copy for IFS');
  actions.append(copyBtn, el('span', { id: 'copy-status', class: 'muted' }, w.canExport ? `${w.rows.length} row${w.rows.length === 1 ? '' : 's'} ready. Paste into Proje Zaman Kaydı with right-click → Edit → Paste Object.` : 'Fix the errors above to enable export.'));
  host.append(actions);
  if (exportText) {
    const det = el('details', {}, el('summary', {}, 'Show the IFS text'), el('pre', {}, exportText));
    host.append(det);
  }

  // entered-in-IFS status of this week, with differences since the paste
  const statusBox = el('div', { id: 'week-status-box' });
  host.append(statusBox);
  renderWeekStatus(w, statusBox);

  // the Clockify entries behind the numbers, editable
  host.append(renderEntriesEditor(w));
}

// ---------- week status (entered in IFS) ----------
const fmtWhen = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

async function renderWeekStatus(w, box) {
  const rec = await weekRecord(w.mondayIso);
  box.replaceChildren();
  if (!rec) {
    box.append(el('div', { class: 'week-state' }, el('span', { class: 'pill norec' }, 'Not entered in IFS'),
      el('button', { disabled: !w.canExport, onclick: () => markEntered(w) }, 'Mark week as entered in IFS'),
      el('small', { class: 'help' }, 'Press it once the paste is saved in IFS. The rows are remembered, so a later change in Clockify is flagged here.')));
    return;
  }
  const changes = diffRows(rec.rows, w);
  box.append(el('div', { class: 'week-state' },
    el('span', { class: 'pill ' + (changes.length ? 'norec' : 'rec') }, changes.length ? 'Changed since entered' : 'Entered in IFS'),
    el('small', { class: 'muted' }, `entered ${fmtWhen(rec.enteredAt)} with ${rec.total} h`),
    changes.length ? el('button', { onclick: () => markEntered(w) }, 'Mark as entered again') : null),
    changes.length ? el('ul', { class: 'warnings' }, el('li', { class: 'warn' }, 'Clockify differs from what was entered in IFS. Correct IFS (or Clockify), then mark the week again.'), changes.map(c => el('li', { class: 'info' }, c))) : null);
}

async function markEntered(w) {
  await markWeekEntered(w);
  toast('Week marked as entered in IFS');
  renderWeek();
  renderWeekStrip();
  scheduleSync();
}

async function renderWeekStrip() {
  const host = $('#week-strip');
  if (!host) return;
  const byMonday = new Map((await allWeeks()).map(x => [x.monday, x]));
  const current = mondayOf($('#week-monday').value || todayIso());
  host.replaceChildren(el('span', { class: 'chips-label' }, 'Weeks'), ...recentMondays(mondayOf(todayIso()), 10).map(m => {
    const rec = byMonday.get(m);
    return el('button', { type: 'button', class: 'chip week-chip' + (m === current ? ' on' : '') + (rec ? ' done' : ''), title: rec ? `Entered ${fmtWhen(rec.enteredAt)}, ${rec.total} h` : 'Not entered in IFS yet', onclick: () => { $('#week-monday').value = m; loadWeek(); } },
      `${rec ? '✓' : '○'} ${new Date(m + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}`);
  }));
}

// ---------- bulk copy: several weeks in one IFS text ----------
async function fetchWeek(monday) {
  const c = new Clockify(settings.clockify.apiKey);
  const win = fetchWindow(monday, settings.timeZone);
  const entries = await c.entries(settings.clockify.workspaceId, settings.clockify.userId, win.start, win.end);
  return buildWeek(entries, monday, settings, settings.mapping);
}

function openBulkDialog() {
  if (!settings.clockify.apiKey) { toast('Add the Clockify API key in Settings first.'); showTab('settings'); return; }
  const thisMonday = mondayOf(todayIso());
  const from = el('input', { type: 'date', value: shiftIso(thisMonday, -28) });
  const to = el('input', { type: 'date', value: shiftIso(thisMonday, -7) });
  const list = el('div');
  const status = el('span', { class: 'help status' });
  let loaded = [];
  const copyBtn = el('button', { class: 'primary', disabled: true, onclick: async () => {
    const ok = loaded.filter(x => x.w.canExport);
    const text = ok.map(x => makeExport(x.w)).join('\n\n');
    try { await navigator.clipboard.writeText(text); toast(`Copied ${ok.length} week${ok.length === 1 ? '' : 's'}, ${ok.reduce((n, x) => n + x.w.rows.length, 0)} rows`); }
    catch { status.textContent = 'Clipboard blocked; open the weeks one by one instead.'; }
  } }, 'Copy all');
  const markBtn = el('button', { disabled: true, onclick: async () => { let n = 0; for (const x of loaded) if (x.w.canExport) { await markWeekEntered(x.w); n++; } toast(`${n} week${n === 1 ? '' : 's'} marked as entered`); loadBtn.click(); renderWeekStrip(); scheduleSync(); } }, 'Mark all as entered');
  const loadBtn = el('button', { onclick: async () => {
    const a = mondayOf(from.value), b = mondayOf(to.value);
    if (!from.value || !to.value || a > b) { status.textContent = 'Pick a from-week that is not after the to-week.'; return; }
    const mondays = []; for (let m = a; m <= b; m = shiftIso(m, 7)) mondays.push(m);
    if (mondays.length > 26) { status.textContent = 'Up to 26 weeks at a time.'; return; }
    loadBtn.disabled = true; loaded = []; status.textContent = `Loading ${mondays.length} week${mondays.length === 1 ? '' : 's'}…`;
    try {
      for (const m of mondays) loaded.push({ monday: m, w: await fetchWeek(m), rec: await weekRecord(m) });
    } catch (e) { status.textContent = e.message; loadBtn.disabled = false; return; }
    list.replaceChildren(el('div', { class: 'tbl' }, el('table', { class: 'bulk-table' },
      el('thead', {}, el('tr', {}, ['Week of', 'Hours', 'Rows', 'Problems', 'Status'].map(h => el('th', {}, h)))),
      el('tbody', {}, loaded.map(x => {
        const errors = x.w.warnings.filter(z => z.level === 'error');
        const changes = x.rec ? diffRows(x.rec.rows, x.w) : [];
        return el('tr', {}, el('td', {}, x.monday), el('td', { class: 'num' }, String(x.w.weekTotal)), el('td', { class: 'num' }, String(x.w.rows.length)),
          el('td', {}, errors.length ? el('span', { class: 'warn-text' }, errors.map(z => z.text).join(' ')) : x.w.rows.length ? '—' : el('span', { class: 'muted' }, 'no hours')),
          el('td', {}, x.rec ? el('span', { class: 'pill ' + (changes.length ? 'norec' : 'rec') }, changes.length ? 'changed since entered' : `entered ${fmtWhen(x.rec.enteredAt)}`) : el('span', { class: 'pill' }, 'not entered')));
      })))));
    const ok = loaded.filter(x => x.w.canExport);
    copyBtn.disabled = markBtn.disabled = !ok.length;
    status.textContent = ok.length ? `${ok.length} week${ok.length === 1 ? '' : 's'} ready, ${loaded.length - ok.length} skipped.` : 'Nothing to export in this range.';
    loadBtn.disabled = false;
  } }, 'Load weeks');
  openDialog('Bulk copy weeks', el('div', { class: 'form' },
    el('p', { class: 'help' }, 'Loads every week in the range from Clockify, builds the IFS rows and puts them all in one text. Each row carries its own week date, so one Paste Object in Proje Zaman Kaydı creates all of them. Weeks with a problem (unmapped project) are skipped.'),
    el('div', { class: 'grid2' }, dlgField('From (week of)', from), dlgField('To (week of)', to)),
    el('div', { class: 'actions' }, loadBtn, copyBtn, markBtn, status),
    list), { wide: true });
}

// ---------- copy a day's Clockify entries to another day ----------
function openCopyDayDialog(targetDay) {
  const w = week;
  if (!w) return;
  const byDay = new Map(w.dates.map(d => [d, []]));
  for (const e of weekEntries) { const d = entryLocalDay(e); if (byDay.has(d) && e.timeInterval.end) byDay.get(d).push(e); }
  const sources = w.dates.filter(d => byDay.get(d).length && d !== targetDay);
  if (!sources.length) { toast('No other day in this week has entries to copy.'); return; }
  const defaultSrc = [...sources].reverse().find(d => d < targetDay) || sources[sources.length - 1];
  const src = el('select', {}, sources.map(d => el('option', { value: d, selected: d === defaultSrc }, `${DAYS[w.dates.indexOf(d)]} ${d} · ${byDay.get(d).length} entr${byDay.get(d).length === 1 ? 'y' : 'ies'}, ${byDay.get(d).reduce((n, e) => n + entryHours(e), 0)} h`)));
  const alsoEmpty = el('input', { type: 'checkbox' });
  const preview = el('ul', { class: 'copy-preview' });
  const status = el('span', { class: 'help status' });
  const tz = settings.timeZone;
  const shifted = (e, day) => {   // same local times on another day; keeps an overnight end on the following day
    const s = utcToLocalInput(e.timeInterval.start, tz), en = utcToLocalInput(e.timeInterval.end, tz);
    const endDay = en.slice(0, 10) > s.slice(0, 10) ? shiftIso(day, 1) : day;
    return { start: localToUtc(`${day}T${s.slice(11)}`, tz), end: localToUtc(`${endDay}T${en.slice(11)}`, tz) };
  };
  const targets = () => { const t = [targetDay]; if (alsoEmpty.checked) for (const d of w.dates) if (d !== targetDay && !byDay.get(d).length && w.dates.indexOf(d) < 5 && d > src.value) t.push(d); return [...new Set(t)]; };
  const paint = () => { preview.replaceChildren(...byDay.get(src.value).map(e => el('li', {}, el('b', {}, fmtRange(e)), el('span', {}, e.project?.name || '(no project)'), (e.tags || []).map(t => el('span', { class: 'tag' }, t.name)), el('small', {}, (e.description || '').split(/\r?\n/)[0]))), el('li', { class: 'muted' }, `→ ${targets().map(d => `${DAYS[w.dates.indexOf(d)]} ${d}`).join(', ')}`)); };
  src.addEventListener('change', paint); alsoEmpty.addEventListener('change', paint); paint();
  const go = el('button', { class: 'primary', onclick: async () => {
    go.disabled = true; status.textContent = 'Creating in Clockify…';
    const c = new Clockify(settings.clockify.apiKey);
    let n = 0;
    try {
      for (const day of targets()) for (const e of byDay.get(src.value)) {
        await c.createEntry(settings.clockify.workspaceId, { ...shifted(e, day), description: e.description || '', projectId: e.projectId || e.project?.id || null, tagIds: (e.tags || []).map(t => t.id), billable: !!e.billable });
        n++;
      }
      d.close(); toast(`${n} entr${n === 1 ? 'y' : 'ies'} created in Clockify`); await loadWeek();
    } catch (e) { status.textContent = e.message; go.disabled = false; }
  } }, 'Create in Clockify');
  const d = openDialog(`Copy entries to ${DAYS[w.dates.indexOf(targetDay)]} ${targetDay}`, el('div', { class: 'form' },
    dlgField('Copy from', src, 'The entries of that day are created again with the same times, project, tags and description.'),
    el('label', { class: 'inline check' }, alsoEmpty, ' Also fill the other empty weekdays after the source day'),
    preview,
    el('div', { class: 'actions' }, go, el('button', { onclick: () => d.close() }, 'Cancel'), status)));
}

// ---------- Clockify entries editor (writes back to Clockify) ----------
const entryLocalDay = e => utcToLocalInput(e.timeInterval.start, settings.timeZone).slice(0, 10);
const entryHours = e => e.timeInterval.end ? Math.round((new Date(e.timeInterval.end) - new Date(e.timeInterval.start)) / 36000) / 100 : 0;
function fmtRange(e) {
  const a = utcToLocalInput(e.timeInterval.start, settings.timeZone), b = e.timeInterval.end ? utcToLocalInput(e.timeInterval.end, settings.timeZone) : '';
  return `${a.slice(11)} – ${b ? b.slice(11) : 'running'}${b && b.slice(0, 10) !== a.slice(0, 10) ? ' (+1 day)' : ''}`;
}

function renderEntriesEditor(w) {
  const byDay = new Map(w.dates.map(d => [d, []]));
  for (const e of weekEntries) { const d = entryLocalDay(e); if (byDay.has(d)) byDay.get(d).push(e); }
  const days = w.dates.map((d, i) => {
    const es = byDay.get(d).sort((a, b) => a.timeInterval.start.localeCompare(b.timeInterval.start));
    return el('div', { class: 'day' },
      el('div', { class: 'day-title' }, el('h4', {}, `${DAYS[i]} ${d}`), el('span', {}, el('button', { class: 'link', onclick: () => openCopyDayDialog(d) }, 'copy from…'), el('button', { class: 'link', onclick: () => openEntryDialog(null, d) }, '+ add'))),
      es.length ? el('ul', {}, es.map(e => el('li', {}, el('button', { type: 'button', class: 'entry', onclick: () => openEntryDialog(e, d) },
        el('b', {}, `${entryHours(e)} h`), el('span', { class: 'entry-range' }, fmtRange(e)), el('span', { class: 'entry-project' }, e.project?.name || '(no project)'),
        (e.tags || []).map(t => el('span', { class: 'tag' }, t.name)),
        el('small', {}, (e.description || '').split(/\r?\n/)[0]))))) : el('p', { class: 'muted' }, 'No entries.'));
  });
  return el('details', { class: 'detail', open: true }, el('summary', {}, `Clockify entries (${weekEntries.length}) — tap one to change it in Clockify`), el('div', { class: 'days' }, days));
}

async function clockifyMetaLoad() {
  if (clockifyMeta) return clockifyMeta;
  const c = new Clockify(settings.clockify.apiKey);
  const [projects, tags] = await Promise.all([c.projects(settings.clockify.workspaceId), c.tags(settings.clockify.workspaceId)]);
  clockifyMeta = { projects, tags };
  return clockifyMeta;
}

async function openEntryDialog(entry, dayIso) {
  let meta;
  try { meta = await clockifyMetaLoad(); } catch (e) { toast(e.message); return; }
  const isNew = !entry;
  const tz = settings.timeZone;
  const project = el('select', {}, el('option', { value: '' }, '(no project)'), meta.projects.map(p => el('option', { value: p.id, selected: p.id === (entry?.projectId || entry?.project?.id) ? 'selected' : null }, p.name)));
  // 24-hour times as plain text (the browser's own picker follows the OS clock format, often AM/PM).
  const startLocal = entry ? utcToLocalInput(entry.timeInterval.start, tz) : `${dayIso}T08:00`;
  const endLocal = entry?.timeInterval?.end ? utcToLocalInput(entry.timeInterval.end, tz) : `${dayIso}T17:00`;
  const date = el('input', { type: 'date', value: startLocal.slice(0, 10) });
  const start = el('input', { type: 'text', value: startLocal.slice(11), placeholder: '08:30', inputmode: 'numeric', class: 'time24', autocomplete: 'off' });
  const end = el('input', { type: 'text', value: endLocal.slice(11), placeholder: '17:00', inputmode: 'numeric', class: 'time24', autocomplete: 'off' });
  const normTime = v => { const m = /^\s*(\d{1,2})[:.hH]?(\d{2})\s*$/.exec(v || ''); if (!m) return null; const H = Number(m[1]), M = Number(m[2]); if (H > 23 || M > 59) return null; return `${String(H).padStart(2, '0')}:${String(M).padStart(2, '0')}`; };
  const selectedTagIds = new Set((entry?.tags || []).map(t => t.id));
  const tagBoxes = meta.tags.map(t => el('label', { class: 'inline check' }, el('input', { type: 'checkbox', checked: selectedTagIds.has(t.id) ? 'checked' : null, onchange: ev => { if (ev.target.checked) selectedTagIds.add(t.id); else selectedTagIds.delete(t.id); } }), ' ', t.name));
  const desc = el('textarea', { rows: 3 }, entry?.description || '');
  const hours = el('span', {});
  const utc = v => localToUtc(v, tz);
  // Start and end as UTC instants; an end time at or before the start means the next day (overnight travel).
  const instants = () => {
    const s = normTime(start.value), e = normTime(end.value);
    if (!date.value || !s || !e) return null;
    const startIso = utc(`${date.value}T${s}`);
    let endDate = date.value;
    if (e <= s) { const [y, m, d0] = date.value.split('-').map(Number); endDate = new Date(Date.UTC(y, m - 1, d0 + 1)).toISOString().slice(0, 10); }
    return { start: startIso, end: utc(`${endDate}T${e}`), nextDay: endDate !== date.value };
  };
  const calc = () => { const i = instants(); if (!i) { hours.textContent = 'Type times as HH:MM, 24-hour.'; return; } const h = (new Date(i.end) - new Date(i.start)) / 3600000; hours.textContent = `${Math.round(h * 100) / 100} h${i.nextDay ? ', ends the next day' : ''}`; };
  for (const i of [date, start, end]) i.addEventListener('input', calc);
  for (const i of [start, end]) i.addEventListener('blur', () => { const n = normTime(i.value); if (n) i.value = n; calc(); });
  calc();
  const status = el('span', { class: 'help status' });
  const c = new Clockify(settings.clockify.apiKey);
  const ws = settings.clockify.workspaceId;
  const body = () => { const i = instants(); return { start: i.start, end: i.end, description: desc.value, projectId: project.value || null, tagIds: [...selectedTagIds], billable: entry?.billable ?? false }; };
  const saveBtn = el('button', { class: 'primary', onclick: async () => {
    if (!instants()) { status.textContent = 'Check the date and the times (HH:MM, 24-hour).'; return; }
    saveBtn.disabled = true;
    try { if (isNew) await c.createEntry(ws, body()); else await c.updateEntry(ws, entry.id, body()); d.close(); toast(isNew ? 'Added in Clockify' : 'Saved in Clockify'); await loadWeek(); }
    catch (e) { status.textContent = e.message; saveBtn.disabled = false; }
  } }, isNew ? 'Add to Clockify' : 'Save to Clockify');
  const d = openDialog(isNew ? 'New Clockify entry' : 'Edit Clockify entry', el('div', { class: 'form' },
    dlgField('Project', project, 'The Clockify project. The mapping in Settings turns it into the IFS activity.'),
    el('div', { class: 'grid3' }, dlgField('Date', date, `Local, ${tz}.`), dlgField('Start', start, '24-hour, e.g. 08:30'), dlgField('End', end, hours)),
    el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Tags'), el('div', { class: 'row' }, tagBoxes), el('small', { class: 'help' }, 'Overtime, Overtime x2, Travel and Travel OT decide the report code.')),
    dlgField('Description', desc, 'Free text. A line “Short Name: 210701.010101.010101-B” sends the entry to that IFS activity.'),
    el('div', { class: 'actions' }, saveBtn, el('button', { onclick: () => d.close() }, 'Cancel'),
      isNew ? null : confirmButton('Delete in Clockify', async () => { try { await c.deleteEntry(ws, entry.id); d.close(); toast('Deleted in Clockify'); await loadWeek(); } catch (e) { status.textContent = e.message; } }),
      status)));
}

async function copyExport() {
  const s = $('#copy-status');
  try { await navigator.clipboard.writeText(exportText); s.textContent = 'Copied. Now paste into the IFS grid (right-click → Edit → Paste Object).'; }
  catch { s.textContent = 'Clipboard blocked. Open "Show the IFS text" and copy it by hand.'; }
}

// ---------- settings ----------
function renderSettings() {
  const root = $('#tab-settings');
  root.replaceChildren();
  const s = settings;

  const field = (label, input, hint) => el('label', { class: 'field' }, el('span', {}, label), input, hint ? el('small', {}, hint) : null);
  const txt = (value, attrs = {}) => el('input', { type: 'text', value: value ?? '', ...attrs });

  // Appearance
  const themeBtns = ['auto', 'light', 'dark'].map(m => el('button', { class: 'chip' + (currentTheme() === m ? ' on' : ''), onclick: e => { applyTheme(m); for (const b of themeBtns) b.classList.toggle('on', b === e.currentTarget); } }, m === 'auto' ? 'Follow system' : m === 'light' ? 'Light' : 'Dark'));
  root.append(el('section', {}, el('h3', {}, 'Appearance'), el('div', { class: 'theme-pick' }, themeBtns), el('small', { class: 'help' }, 'Applies on this device only.')));

  // Clockify
  const key = txt(s.clockify.apiKey, { type: 'password', autocomplete: 'off', spellcheck: 'false', id: 'set-key' });
  const testBtn = el('button', { onclick: async () => {
    settings.clockify.apiKey = key.value.trim();
    const st = $('#key-status'); st.textContent = 'Checking…';
    try { const u = await new Clockify(settings.clockify.apiKey).user();
      settings.clockify.userId = u.id; settings.clockify.workspaceId = u.activeWorkspace; settings.clockify.userName = u.name;
      if (u.settings?.timeZone) settings.timeZone = u.settings.timeZone;
      saveSettings(settings); st.textContent = `Connected as ${u.name} (${settings.timeZone}).`; renderSettings(); }
    catch (e) { st.textContent = e.message; }
  } }, 'Connect');
  root.append(el('section', {}, el('h3', {}, 'Clockify'),
    field('API key', key, 'Clockify → Profile settings → API. Stored only in this browser.'),
    el('div', { class: 'row' }, testBtn, el('span', { id: 'key-status', class: 'muted' }, s.clockify.userName ? `Connected as ${s.clockify.userName} (${s.timeZone}).` : 'Not connected.'))));

  // Rules
  const reg = txt(s.regularHours, { type: 'number', step: '0.5', min: '0' });
  const trAfter = txt(s.travelAfterHours, { type: 'number', step: '0.5', min: '0' });
  const step = txt(s.roundStep, { type: 'number', step: '0.25', min: '0.25' });
  const mode = el('select', {}, [['nearest', 'nearest'], ['down', 'down'], ['up', 'up']].map(([v, l]) => el('option', { value: v, selected: s.roundMode === v ? 'selected' : null }, l)));
  const t15 = txt(s.tags.x15), t2 = txt(s.tags.x2), tTr = txt(s.tags.travel), tTrOT = txt(s.tags.travelOT), kw = txt(s.travelKeyword);
  const cReg = txt(s.codes.regular), c15 = txt(s.codes.ot15), c2 = txt(s.codes.ot2), cTr = txt(s.codes.travel), cTrR = txt(s.codes.travelRegular);
  const dReg = txt(s.codeDescriptions[s.codes.regular] || ''), d15 = txt(s.codeDescriptions[s.codes.ot15] || ''), d2 = txt(s.codeDescriptions[s.codes.ot2] || ''), dTr = txt(s.codeDescriptions[s.codes.travel] || ''), dTrR = txt(s.codeDescriptions[s.codes.travelRegular] || '');
  const hol = el('textarea', { rows: 2, placeholder: '2026-10-29, 2026-01-01', spellcheck: 'false' }, (s.holidays || []).join(', '));
  const topUp = el('input', { type: 'checkbox', checked: s.topUpMinimum !== false ? 'checked' : null });
  root.append(el('section', {}, el('h3', {}, 'Rules'),
    el('div', { class: 'grid3' },
      field('Regular hours per weekday', reg, 'Default. A project can override it below (US projects: 8). General/break counts inside it.'),
      field('Travel overtime after (h)', trAfter, 'Weekday travel beyond this many hours of work + travel is travel overtime ×1.'),
      field('Round each day/project to (h)', step)),
    el('div', { class: 'grid3' }, field('Rounding', mode), field('Holidays (dates, comma separated)', hol, 'Counted like Sunday: work ×2, travel ×1.'),
      el('label', { class: 'field check' }, el('span', {}, 'Minimum day'), el('span', { class: 'row' }, topUp, 'Book at least the regular hours on a worked weekday'), el('small', {}, 'IFS expects 8 h abroad and 9 h in Turkey even if less was logged.'))),
    el('div', { class: 'grid3' }, field('Regular code', cReg), field('Overtime ×1.5 code', c15), field('Overtime ×2 code', c2), field('Travel regular code', cTrR), field('Travel overtime ×1 code', cTr)),
    el('div', { class: 'grid3' }, field('Regular description', dReg, 'As IFS shows it, optional.'), field('×1.5 description', d15), field('×2 description', d2), field('Travel regular description', dTrR), field('Travel overtime description', dTr)),
    el('div', { class: 'grid3' }, field('Clockify tag for ×1.5', t15), field('Clockify tag for ×2', t2), field('Clockify tag for travel', tTr), field('Clockify tag for travel overtime', tTrOT, 'Forces the whole entry to travel overtime ×1.'), field('Or description starting with', kw, 'So "Travel" entries count as normal travel without a tag.'))));

  // Mapping
  const mapHost = el('div', { class: 'tbl' });
  const renderMap = () => {
    mapHost.replaceChildren(el('table', { class: 'map' },
      el('thead', {}, el('tr', {}, ['Clockify project', 'Kind', 'Reg h', 'Project', 'Sub', 'Activity', 'Activity seq', 'Short name', 'Travel activity (no · seq · short name)', ''].map(h => el('th', {}, h)))),
      el('tbody', {}, s.mapping.map((m, i) => {
        const tr = m.travel || (m.travel = { activityNo: '', activitySeq: '', activityDesc: 'TRAVEL', shortName: '' });
        return el('tr', {},
        el('td', {}, el('b', {}, m.clockifyProjectName || m.clockifyProjectId)),
        el('td', {}, el('select', { onchange: e => { m.kind = e.target.value; } }, ['project', 'general', 'ignore'].map(k => el('option', { value: k, selected: m.kind === k ? 'selected' : null }, k)))),
        el('td', {}, txt(m.regularHours ?? '', { size: 3, placeholder: String(s.regularHours), oninput: e => { m.regularHours = e.target.value.trim(); } })),
        el('td', {}, txt(m.projectId, { size: 7, oninput: e => { m.projectId = e.target.value.trim(); } })),
        el('td', {}, txt(m.subProjectId, { size: 6, oninput: e => { m.subProjectId = e.target.value.trim(); } })),
        el('td', {}, txt(m.activityNo, { size: 8, oninput: e => { m.activityNo = e.target.value.trim(); } })),
        el('td', {}, txt(m.activitySeq, { size: 10, oninput: e => { m.activitySeq = e.target.value.trim(); } })),
        el('td', {}, txt(m.shortName, { size: 20, oninput: e => { m.shortName = e.target.value.trim(); } })),
        el('td', { class: 'travel-cell' },
          txt(tr.activityNo, { size: 8, placeholder: 'activity', oninput: e => { tr.activityNo = e.target.value.trim(); } }),
          txt(tr.activitySeq, { size: 10, placeholder: 'seq', oninput: e => { tr.activitySeq = e.target.value.trim(); } }),
          txt(tr.shortName, { size: 20, placeholder: 'short name', oninput: e => { tr.shortName = e.target.value.trim(); } })),
        el('td', {}, el('button', { class: 'link', onclick: () => { s.mapping.splice(i, 1); renderMap(); } }, 'remove')));
      }))));
  };
  renderMap();
  const addFromClockify = el('button', { onclick: async () => {
    try {
      const c = new Clockify(settings.clockify.apiKey);
      clockifyProjects = await c.projects(settings.clockify.workspaceId);
      let added = 0;
      for (const p of clockifyProjects) if (!s.mapping.some(m => m.clockifyProjectId === p.id)) { s.mapping.push({ clockifyProjectId: p.id, clockifyProjectName: p.name, kind: 'project', regularHours: '', projectId: '', subProjectId: '', activityNo: '', activitySeq: '', shortName: '', projectName: '', subProjectDesc: '', activityDesc: '', travel: { activityNo: '', activitySeq: '', activityDesc: 'TRAVEL', shortName: '' } }); added++; }
      renderMap(); $('#map-status').textContent = added ? `${added} new Clockify project${added > 1 ? 's' : ''} added; fill in the IFS columns.` : 'All Clockify projects are already listed.';
    } catch (e) { $('#map-status').textContent = e.message; }
  } }, 'Add missing Clockify projects');

  const importArea = el('textarea', { rows: 6, placeholder: 'Paste one row copied from Proje Zaman Kaydı (right-click → Edit → Copy Object)…', spellcheck: 'false' });
  const importSel = el('select', {}, el('option', { value: '' }, 'Apply activity to Clockify project…'), s.mapping.map(m => el('option', { value: m.clockifyProjectId }, m.clockifyProjectName)));
  const importBtn = el('button', { onclick: () => {
    const rec = parseCopyObject(importArea.value);
    const st = $('#import-status');
    if (!rec) { st.textContent = 'That does not look like an IFS Copy Object row.'; return; }
    if (rec.lu !== 'ProjectTransWeek') { st.textContent = `This row is from ${rec.lu}, not the weekly project time grid.`; return; }
    const act = activityFromRecord(rec), idn = identityFromRecord(rec);
    const notes = [];
    if (idn.empNo) { s.identity = { ...s.identity, ...idn }; notes.push(`employee ${idn.empNo}`); }
    const codeField = rec.fields.find(f => f.name === 'REPORT_COST_CODE')?.value || '';
    const isTravelRow = codeField === s.codes.travel || /travel/i.test(act.activityDesc || '');
    if (importSel.value) {
      const m = s.mapping.find(x => x.clockifyProjectId === importSel.value);
      if (isTravelRow) {
        m.travel = { activityNo: act.activityNo, activitySeq: act.activitySeq, activityDesc: act.activityDesc, shortName: act.shortName };
        if (!m.projectId) { m.projectId = act.projectId; m.projectName = act.projectName; m.subProjectId = act.subProjectId; m.subProjectDesc = act.subProjectDesc; }
        notes.push(`${m.clockifyProjectName} travel → ${act.shortName}`);
      } else { const keepTravel = m.travel; Object.assign(m, act); if (keepTravel) m.travel = keepTravel; notes.push(`${m.clockifyProjectName} → ${act.shortName}`); }
      if (m.kind === 'ignore') m.kind = 'project';
      renderMap();
    }
    // refresh template but keep quantities/dates empty
    const blank = ['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map(d => `${d}_INTERNAL_QUANTITY`);
    for (const f of rec.fields) if (blank.includes(f.name) || f.n === 15 || f.name === 'ACCOUNT_DATE' || (f.name === 'COST_ACCOUNTING' && f.n === 4)) f.value = '';
    s.template = rebuildTemplate(rec);
    templateArea.value = s.template;
    const desc = rec.fields.find(f => f.name.startsWith('REPORT_COST_API.GET_DESCRIPTION'));
    const code = rec.fields.find(f => f.name === 'REPORT_COST_CODE');
    if (code?.value && desc?.value) { s.codeDescriptions[code.value] = desc.value; notes.push(`${code.value} = ${desc.value}`); }
    st.textContent = `Imported: ${notes.join(', ') || 'template only'}. Save to keep it.`;
  } }, 'Import row');
  const templateArea = el('textarea', { rows: 8, spellcheck: 'false' }, s.template);
  templateArea.addEventListener('input', () => { s.template = templateArea.value; });

  root.append(el('section', {}, el('h3', {}, 'Clockify project → IFS activity'), mapHost,
    el('div', { class: 'row' }, addFromClockify, el('span', { id: 'map-status', class: 'muted' })),
    el('h4', {}, 'Import from a copied IFS row'), el('p', { class: 'muted' }, 'The fastest way to fill a mapping: in IFS select one row of that activity, Copy Object, paste it here and choose the Clockify project. It also captures your employee fields and the row template.'),
    importArea, el('div', { class: 'row' }, importSel, importBtn, el('span', { id: 'import-status', class: 'muted' })),
    el('details', {}, el('summary', {}, 'Row template used for export'), templateArea)));

  // Supabase sync
  const sb = s.supabase;
  const sbUrl = txt(sb.url, { placeholder: 'https://xxxx.supabase.co', spellcheck: 'false', oninput: e => { sb.url = e.target.value.trim(); } });
  const sbKey = txt(sb.anonKey, { type: 'password', autocomplete: 'off', placeholder: 'anon public key', oninput: e => { sb.anonKey = e.target.value.trim(); } });
  const email = txt('', { type: 'email', placeholder: 'you@example.com', autocomplete: 'username' });
  const pw = txt('', { type: 'password', placeholder: 'password', autocomplete: 'current-password' });
  const sbStatus = el('span', { id: 'sb-status', class: 'muted' });
  const refreshSb = () => { const c = supabaseClient(); sbStatus.textContent = !c.configured ? 'Enter the project URL and anon key, then Save.' : c.signedIn ? `Signed in as ${c.email}.` : 'Not signed in.'; };
  // After sign-in: check the tables exist, then push and pull everything once.
  const runSync = async () => {
    const c = supabaseClient();
    const check = await checkSetup(c);
    if (!check.startsWith('ok')) { sbStatus.textContent = check; return; }
    const hint = check === 'ok' ? '' : ' ' + check.slice(3).trim();
    sbStatus.textContent = 'Syncing…';
    const r = await sync(c, t => { if (t) sbStatus.textContent = t; });
    const problems = (r.errors || []).filter(e => !/is missing in Supabase/.test(e));
    sbStatus.textContent = problems.length ? `Sync problem: ${problems[0]}` : `Synced as ${c.email}: ${r.pushed} sent, ${r.pulled} received${r.receipts ? `, ${r.receipts} photo${r.receipts === 1 ? '' : 's'} uploaded` : ''}.${hint}`;
    if (r.pulled) renderExpenses();
  };
  const signIn = el('button', { class: 'primary', onclick: async () => { saveSettings(settings); try { await supabaseClient().signIn(email.value.trim(), pw.value); refreshSb(); await runSync(); } catch (e) { sbStatus.textContent = e.message; } } }, 'Sign in');
  const signUp = el('button', { onclick: async () => { saveSettings(settings); try { const r = await supabaseClient().signUp(email.value.trim(), pw.value); sbStatus.textContent = r === 'confirm-email' ? 'Account created. Open the confirmation e-mail Supabase sent you, then sign in here.' : 'Account created and signed in.'; if (r !== 'confirm-email') await runSync(); } catch (e) { sbStatus.textContent = e.message; } } }, 'Create account');
  const syncNow = el('button', { onclick: runSync }, 'Sync now');
  const signOut = el('button', { class: 'link', onclick: () => { supabaseClient().signOut(); refreshSb(); } }, 'Sign out');
  root.append(el('section', {}, el('h3', {}, 'Sync between phone and PC (Supabase)'),
    el('ol', { class: 'muted setup-steps' },
      el('li', {}, 'Create a free project at supabase.com (any name, region Europe).'),
      el('li', {}, 'In the project open SQL Editor, paste the contents of supabase/schema.sql from the project folder, press Run.'),
      el('li', {}, 'Project Settings → API: copy the Project URL and the anon public key into the fields below, then Save settings.'),
      el('li', {}, 'Create your account with an e-mail and password, confirm the e-mail, sign in. The first sign-in sends everything on this device to the cloud.'),
      el('li', {}, 'Run supabase/deploy_app.py once to publish the app to the project; open the printed address on the phone, add it to the home screen and sign in there with the same account.')),
    el('div', { class: 'grid2' }, field('Project URL', sbUrl, 'Looks like https://abcdefgh.supabase.co'), field('Anon key', sbKey, 'The long “anon public” key. It is safe on a phone; the service_role key is never entered here.')),
    el('div', { class: 'grid2' }, field('E-mail', email), field('Password', pw)),
    el('div', { class: 'row' }, signIn, signUp, syncNow, signOut, sbStatus)));
  setTimeout(refreshSb, 0);

  // Expense defaults
  const defCur = el('select', { onchange: e => { s.defaultCurrency = e.target.value; } }, s.currencies.map(c => el('option', { value: c, selected: c === s.defaultCurrency ? 'selected' : null }, c)));
  const costList = txt((s.costObjects || []).join(', '), { oninput: e => { s.costObjects = e.target.value.split(',').map(x => x.trim()).filter(Boolean); } });
  const expTemplate = el('textarea', { rows: 8, spellcheck: 'false' }, s.expenseTemplate);
  expTemplate.addEventListener('input', () => { s.expenseTemplate = expTemplate.value; });
  const expImport = el('textarea', { rows: 4, placeholder: 'Paste one row copied from the IFS Expense Details grid to refresh the template…', spellcheck: 'false' });
  const expImportBtn = el('button', { onclick: () => {
    const rec = parseCopyObject(expImport.value); const st = $('#exp-import-status');
    if (!rec) { st.textContent = 'That does not look like an IFS Copy Object row.'; return; }
    if (rec.lu !== 'ExpenseDetail') { st.textContent = `This row is from ${rec.lu}, not Expense Details.`; return; }
    const seen = rec.fields.find(f => f.name === 'SHORT_NAME')?.value?.trim();
    if (seen && !(s.knownShortNames || []).includes(seen)) s.knownShortNames = [...(s.knownShortNames || []), seen];
    for (const f of rec.fields) if (['EXPENSE_ID', 'ACCOUNT_DATE', 'EXPENSE_CODE', 'DESCRIPTION', 'REFERENCE', 'CURRENCY_CODE', 'GROSS_CURR_AMOUNT', 'SEQ_NO', 'SHORT_NAME', 'C_SHORT_NAME'].includes(f.name)) f.value = '';
    s.expenseTemplate = rebuildTemplate(rec); expTemplate.value = s.expenseTemplate; st.textContent = `Template updated${seen ? `, project short name ${seen} remembered` : ''}. Save to keep it.`;
  } }, 'Import row');
  root.append(el('section', {}, el('h3', {}, 'Expenses'),
    el('div', { class: 'grid2' }, field('Default currency', defCur), field('Cost objects (comma separated)', costList, 'The "Person" column of the workbook: /Personal 1, /16 QP 16 …')),
    el('div', { class: 'grid3' },
      field('Home currency', el('select', { onchange: e => { s.homeCurrency = e.target.value; } }, s.currencies.map(c => el('option', { value: c, selected: c === (s.homeCurrency || 'TRY') ? 'selected' : null }, c))), 'Lines in this currency are exported with currency rate 1.'),
      field('Rate for other currencies', el('select', { onchange: e => { s.rateSource = e.target.value; } }, [['tcmb', 'Central Bank (TCMB) rate for each line’s date, via the PC server'], ['manual', 'Rate typed per sheet under Sheets…']].map(([v, l]) => el('option', { value: v, selected: v === (s.rateSource || 'tcmb') ? 'selected' : null }, l))), 'IFS does not look rates up on pasted rows, so the export carries one per line. TCMB is what Turkish IFS rate tables are normally loaded from.'),
      field('TCMB column IFS uses', el('select', { onchange: e => { s.tcmbField = e.target.value; } }, [['ForexBuying', 'Döviz alış (forex buying)'], ['ForexSelling', 'Döviz satış (forex selling)'], ['BanknoteBuying', 'Efektif alış (banknote buying)'], ['BanknoteSelling', 'Efektif satış (banknote selling)']].map(([v, l]) => el('option', { value: v, selected: v === (s.tcmbField || 'ForexBuying') ? 'selected' : null }, l))), 'Check once against a line IFS has already rated and pick the column that matches.')),
    el('div', { class: 'grid2' },
      field('When no rate is known', el('select', { onchange: e => { s.currRateMode = e.target.value; } }, [['blank', 'Send the field empty'], ['omit', 'Leave the field out of the pasted row'], ['one', 'Always 1 (old workbook behaviour)']].map(([v, l]) => el('option', { value: v, selected: v === (s.currRateMode || 'blank') ? 'selected' : null }, l))), 'Only matters for lines whose rate could not be fetched or typed.'),
      field('Per diem defaults', txt((s.perDiemDefaults || []).map(d => `${d.country}=${d.rate} ${d.currency}`).join(', '), { spellcheck: 'false', placeholder: 'USA=70 USD, Germany=50 EUR', oninput: e => { s.perDiemDefaults = e.target.value.split(',').map(x => x.trim()).filter(Boolean).map(x => { const m = /^(.+?)\s*=\s*([\d.,]+)\s*([A-Za-z]{3})?$/.exec(x); return m ? { country: m[1].trim(), rate: Number(m[2].replace(',', '.')), currency: (m[3] || s.defaultCurrency || 'USD').toUpperCase() } : null; }).filter(Boolean); } }), 'Prefills a new trip by country. Saving a trip with a rate updates the default for its country.')),
    el('div', { class: 'grid2' },
      field('Expense activity suffix', txt(s.expenseActivitySuffix, { spellcheck: 'false', oninput: e => { s.expenseActivitySuffix = e.target.value.trim(); } }), 'Suggests PROJECT.<suffix> as the project short name for every mapped project, e.g. 210701.0105.0105-A.'),
      field('Known project short names', txt((s.knownShortNames || []).join(', '), { spellcheck: 'false', oninput: e => { s.knownShortNames = e.target.value.split(',').map(x => x.trim()).filter(Boolean); } }), 'Offered as chips on sheets and lines.')),
    expImport, el('div', { class: 'row' }, expImportBtn, el('span', { id: 'exp-import-status', class: 'muted' })),
    el('details', {}, el('summary', {}, 'Expense row template used for export'), expTemplate),
    el('h4', {}, 'Backup and export'),
    el('p', { class: 'muted' }, backupAvailable()
      ? 'Every change is also saved to the data folder next to the app on this PC (OneDrive), and restored automatically if the browser store is ever empty. Supabase sync adds the phone on top.'
      : 'Your expenses live in this browser (and in Supabase once sync is on). Keep a copy now and then.'),
    backupAvailable() ? el('div', { class: 'row' }, el('span', { id: 'pc-backup-state', class: 'muted' }, 'Checking the PC backup…'), el('button', { onclick: async () => { const r = await pushBackup(); $('#pc-backup-state').textContent = r?.error ? `Backup failed: ${r.error}` : `Backed up ${new Date(r.at).toLocaleString()}`; } }, 'Back up now')) : null,
    el('div', { class: 'row' },
      el('button', { onclick: () => exportCsv().then(() => toast('CSV downloaded')) }, 'Export all expenses (CSV)'),
      el('button', { onclick: () => backupJson().then(() => toast('Backup downloaded (includes settings and keys)')) }, 'Backup (JSON, with settings and keys)'),
      el('label', { class: 'inline' }, el('span', { class: 'link' }, 'Restore from backup…'), el('input', { type: 'file', accept: 'application/json', hidden: true, onchange: async e => { const f = e.target.files[0]; if (!f) return; try { const n = await restoreJson(await f.text()); settings = loadSettings(); toast(`Restored ${n} records`); renderSettings(); } catch (err) { toast(`Restore failed: ${err.message}`); } } })))));

  // Identity
  const idn = s.identity;
  root.append(el('section', {}, el('h3', {}, 'IFS identity'),
    el('div', { class: 'grid3' },
      field('Company', txt(idn.companyId, { oninput: e => { idn.companyId = e.target.value.trim(); } })),
      field('Employee no', txt(idn.empNo, { oninput: e => { idn.empNo = e.target.value.trim(); } })),
      field('Resource seq', txt(idn.resourceSeq, { oninput: e => { idn.resourceSeq = e.target.value.trim(); } })),
      field('Resource id', txt(idn.resourceId, { oninput: e => { idn.resourceId = e.target.value.trim(); } })),
      field('Name', txt(idn.resourceName, { oninput: e => { idn.resourceName = e.target.value; } })),
      field('Time zone', txt(s.timeZone, { oninput: e => { s.timeZone = e.target.value.trim(); } })))));

  const saveBtn = el('button', { class: 'primary', onclick: () => {
    settings.clockify.apiKey = key.value.trim();
    settings.regularHours = Number(reg.value) || 9; settings.travelAfterHours = Number(trAfter.value) || settings.regularHours;
    settings.roundStep = Number(step.value) || 0.5; settings.roundMode = mode.value; settings.topUpMinimum = topUp.checked;
    settings.holidays = hol.value.split(/[\s,;]+/).map(x => x.trim()).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x));
    settings.tags = { x15: t15.value.trim(), x2: t2.value.trim(), travel: tTr.value.trim(), travelOT: tTrOT.value.trim() }; settings.travelKeyword = kw.value.trim();
    settings.codes = { regular: cReg.value.trim(), ot15: c15.value.trim(), ot2: c2.value.trim(), travel: cTr.value.trim(), travelRegular: cTrR.value.trim() };
    settings.codeDescriptions = { ...settings.codeDescriptions, [settings.codes.regular]: dReg.value, [settings.codes.ot15]: d15.value, [settings.codes.ot2]: d2.value, [settings.codes.travel]: dTr.value, [settings.codes.travelRegular]: dTrR.value };
    saveSettings(settings); $('#save-status').textContent = 'Saved.'; setTimeout(() => { $('#save-status').textContent = ''; }, 2000);
  } }, 'Save settings');
  const resetBtn = confirmButton('Reset rules and mapping to defaults', () => { const keep = { clockify: settings.clockify, supabase: settings.supabase }; settings = { ...structuredClone(DEFAULTS), ...keep }; saveSettings(settings); renderSettings(); toast('Defaults restored. Keys kept.'); }, { armedLabel: 'Reset? Tap again to confirm', className: 'link' });
  root.append(el('div', { class: 'actions' }, saveBtn, resetBtn, el('span', { id: 'save-status', class: 'muted' })));
  if (backupAvailable()) backupMeta().then(m => { const e = $('#pc-backup-state'); if (e) e.textContent = m?.savedAt ? `Last PC backup ${new Date(m.savedAt).toLocaleString()} (${Math.max(1, Math.round(m.bytes / 1024))} KB) in ${m.path}` : 'No PC backup yet.'; });
}

function rebuildTemplate(rec) {
  return ['!IFS.COPYOBJECT', `$LU=${rec.lu}`, `$VIEW=${rec.view}`, '$RECORD=!', ...rec.fields.map(f => `-$${f.n}:${f.name}=${f.value}`), '-'].join('\n');
}

// ---------- boot ----------
function boot() {
  initExpenses({ settings: () => settings, saveSettings: s => saveSettings(s), el, $ });
  initReport({ settings: () => settings, saveSettings: s => saveSettings(s) });
  $('#tab-week .toolbar').after(el('div', { id: 'week-strip', class: 'week-strip' }));
  $('#btn-bulk').addEventListener('click', openBulkDialog);
  if (settings.clockify.apiKey) renderWeekStrip();
  initLocalBackup({ onRestored: () => { settings = loadSettings(); const t = document.querySelector('.tabs button.active')?.dataset.tab || 'expenses'; showTab(t); } });
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  $('#week-monday').value = mondayOf(shiftMonday(todayIso(), -7));
  $('#btn-load').addEventListener('click', loadWeek);
  $('#btn-prev').addEventListener('click', () => { $('#week-monday').value = shiftMonday(mondayOf($('#week-monday').value), -7); loadWeek(); });
  $('#btn-next').addEventListener('click', () => { $('#week-monday').value = shiftMonday(mondayOf($('#week-monday').value), 7); loadWeek(); });
  $('#week-monday').addEventListener('change', () => { $('#week-monday').value = mondayOf($('#week-monday').value); });
  let tab = 'week';
  try { tab = localStorage.getItem('ifsbridge.tab') || 'week'; } catch {}
  if (!settings.clockify.apiKey) tab = 'settings';
  showTab(tab);
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
}
boot();
