import { currentScope, scopedKey, scopeIsCurrent, assertScopeCurrent } from './scope.js';
import { initWorkspaceUI, openAccount, connectionStatusPanel, initAuthGate, revealPrivateApp } from './workspace-ui.js';
import { Clockify } from './clockify.js';
import { buildWeek, mondayOf, fetchWindow, DAYS, localToUtc, utcToLocalInput } from './rules.js';
import { timeCodeInfo } from './time-codes.js';
import { parseCopyObject, buildRecord, joinRecords, ifsDate, ifsNumber } from './ifs.js';
import { loadSettings, saveSettings, defaultsForScope } from './store.js';
import { createSettingsPage } from './settings-ui.js';
import { initExpenses, render as renderExpenses, supabaseClient, scheduleSync, exportCsv, backupJson, restoreJson, openExpenseReview } from './expenses.js';
import { el, $, confirmButton, toast, openDialog, download, field as dlgField } from './dom.js';
import { initLocalBackup, backupAvailable, pushBackup } from './localbackup.js';
import { sync, checkSetup } from './sync.js';
import { allWeeks, weekRecord, markWeekEntered, unmarkWeek, diffRows, recentMondays, shiftIso } from './week-status.js';
import { initReport, render as renderOverview } from './report.js';
import { initPersonal, renderPersonal, reviewPersonal } from './personal.js';
import { initShell, updateShell } from './shell.js';

let settings = scopeIsCurrent() ? loadSettings() : null;
let week = null;          // result of buildWeek
let exportText = '';
let weekLoadId = 0;       // Only the newest request may update the selected week.
let clockifyProjects = null;
let weekEntries = [];      // raw Clockify entries of the loaded week (for the editor)
let clockifyMeta = null;   // { projects, tags } for the entry dialog
let clockifyConnectId = 0;
let settingsPage = null;
let clockifyTags = null;

function invalidateClockifyView({ keepMetadata = false } = {}) {
  // An in-flight request or cached editor must not bring the previous account back.
  ++weekLoadId;
  week = null; weekEntries = []; exportText = '';
  if (!keepMetadata) { clockifyProjects = null; clockifyMeta = null; clockifyTags = null; }
  $('#week-result')?.replaceChildren();
  $('#week-result')?.removeAttribute('aria-busy');
  if ($('#week-status')) $('#week-status').textContent = '';
  if ($('#btn-load')) $('#btn-load').disabled = false;
}

function changeClockifyKey(value) {
  const next = value.trim();
  if (next === settings.clockify.apiKey) return false;
  ++clockifyConnectId;
  settings.clockify = { ...settings.clockify, apiKey: next, userId: '', workspaceId: '', userName: '' };
  invalidateClockifyView();
  return true;
}

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
  // Ignore a stale saved tab name instead of hiding every screen.
  if (!['week', 'expenses', 'overview', 'study', 'settings'].includes(name)) name = 'week';
  const personal = currentScope().workspace === 'personal';
  if ((personal && name === 'week') || (!personal && name === 'study')) name = 'overview';
  if (!scopeIsCurrent()) return;
  const previous = document.querySelector('.tabs button.active')?.dataset.tab;
  if (previous && previous !== name) window.scrollTo({ top: 0, behavior: 'instant' });
  updateShell(name);
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === name);
  for (const s of document.querySelectorAll('.tab')) s.hidden = s.id !== `tab-${name}`;
  try { localStorage.setItem(scopedKey('ifsbridge.tab'), name); } catch {}
  if (name === 'settings') renderSettings();
  if (name === 'expenses') { personal ? renderPersonal($('#tab-expenses'), 'transactions') : renderExpenses(); scheduleSync(500); }
  if (name === 'overview') { personal ? renderPersonal($('#tab-overview'), 'overview') : renderOverview(); if (personal) scheduleSync(500); }
  if (name === 'study' && personal) { renderPersonal($('#tab-study'), 'study'); scheduleSync(500); }
  if (name === 'week' && !week && settings.clockify.apiKey) loadWeek();   // no need to press Load the first time
  if (name === 'week' && !settings.clockify.apiKey) {
    $('#week-result').replaceChildren(el('div', { class: 'empty expense-empty' },
      el('h3', {}, 'Bring your week into focus'),
      el('p', {}, 'Connect Clockify to review your hours, check the IFS activity mapping and prepare your weekly timesheet.'),
      el('div', { class: 'actions', style: 'justify-content:center' },
        el('button', { class: 'primary', onclick: () => openSettings('connections') }, 'Connect Clockify'),
        el('button', { onclick: () => showTab('expenses') }, 'Open expenses'))));
  }
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
  assertScopeCurrent();
  if (currentScope().workspace === 'personal') return;
  const requestId = ++weekLoadId;
  const status = $('#week-status');
  const host = $('#week-result');
  const monday = mondayOf($('#week-monday').value || todayIso());
  $('#week-monday').value = monday;
  // A different date must never leave the previous week's copy/edit actions available.
  week = null;
  weekEntries = [];
  exportText = '';
  host.replaceChildren();
  if (!settings.clockify.apiKey) {
    $('#btn-load').disabled = false;
    host.removeAttribute('aria-busy');
    status.textContent = 'Add your Clockify API key in Settings first.';
    openSettings('connections');
    return;
  }
  status.textContent = `Loading week of ${monday}…`;
  host.setAttribute('aria-busy', 'true');
  host.append(el('p', { class: 'empty', role: 'status' }, 'Loading hours from Clockify…'));
  $('#btn-load').disabled = true;
  try {
    const c = new Clockify(settings.clockify.apiKey);
    if (!settings.clockify.userId) {
      const u = await c.user();
      if (!scopeIsCurrent() || requestId !== weekLoadId) return;
      settings.clockify.userId = u.id; settings.clockify.workspaceId = u.activeWorkspace; settings.clockify.userName = u.name;
      if (u.settings?.timeZone) settings.timeZone = u.settings.timeZone;
      saveSettings(settings);
    }
    const win = fetchWindow(monday, settings.timeZone);
    const entries = await c.entries(settings.clockify.workspaceId, settings.clockify.userId, win.start, win.end);
    if (!scopeIsCurrent() || requestId !== weekLoadId) return;
    weekEntries = entries;
    week = buildWeek(entries, monday, settings, settings.mapping);
    exportText = week.canExport ? makeExport(week) : '';
    renderWeek();
    status.textContent = '';
  } catch (e) {
    if (!scopeIsCurrent() || requestId !== weekLoadId) return;
    week = null; weekEntries = []; exportText = '';
    status.textContent = `Week of ${monday} could not be loaded.`;
    host.replaceChildren(el('div', { class: 'empty', role: 'alert' },
      el('p', {}, e.message || 'Check your connection and try again.'),
      el('button', { type: 'button', onclick: loadWeek }, 'Try again')));
  } finally {
    if (scopeIsCurrent() && requestId === weekLoadId) {
      $('#btn-load').disabled = false;
      host.removeAttribute('aria-busy');
      renderWeekStrip();
    }
  }
}

function makeExport(w) {
  if (w.canExport === false) return '';
  const template = parseCopyObject(settings.template);
  if (!template) return '';
  const id = settings.identity;
  // The review keeps direct-code pay separate, while IFS expects a single row
  // for each activity/code even when two confirmed tags contribute to it.
  const exportRows = new Map();
  for (const row of w.rows) {
    const m = row.mapping, key = [m.shortName, m.projectId, m.subProjectId, m.activityNo, m.activitySeq, row.code].join('|');
    const prior = exportRows.get(key);
    if (!prior) exportRows.set(key, { ...row, hours: [...row.hours] });
    else {
      prior.hours = prior.hours.map((hours, day) => Math.round((hours + row.hours[day]) * 100) / 100);
      prior.total = Math.round((prior.total + row.total) * 100) / 100;
      prior.description ||= row.description;
    }
  }
  const records = [...exportRows.values()].map(r => {
    const m = r.mapping;
    const o = {
      RESOURCE_SEQ: id.resourceSeq, RESOURCE_ID: id.resourceId, 'RESOURCE_API.GET_DESCRIPTION(RESOURCE_SEQ)': id.resourceName,
      COMPANY_ID: id.companyId, EMP_NO: id.empNo,
      ACCOUNT_DATE: ifsDate(w.mondayIso),
      SHORT_NAME: m.shortName, PROJECT_ID: m.projectId, 'PROJECT_API.GET_NAME(PROJECT_ID)': m.projectName,
      SUB_PROJECT_ID: m.subProjectId, 'SUB_PROJECT_API.GET_DESCRIPTION(PROJECT_ID,SUB_PROJECT_ID)': m.subProjectDesc,
      ACTIVITY_NO: m.activityNo, ACTIVITY_SEQ: m.activitySeq, 'ACTIVITY_API.GET_DESCRIPTION(ACTIVITY_SEQ)': m.activityDesc,
      REPORT_COST_CODE: r.code,
      'REPORT_COST_API.GET_DESCRIPTION_NEW_DATES(COMPANY_ID,REPORT_COST_CODE, ACCOUNT_DATE)': r.description || settings.codeDescriptions[r.code] || '',
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

  // problems stay visible; the notes on how hours were split fold away
  const problems = w.warnings.filter(x => x.level !== 'info'), notes = w.warnings.filter(x => x.level === 'info');
  if (problems.length) host.append(el('ul', { class: 'warnings' }, problems.map(x => el('li', { class: x.level }, x.text))));

  // table
  const head = el('tr', {}, el('th', {}, 'IFS activity'), el('th', {}, 'Code'), w.dates.map((d, i) => el('th', { class: 'num' }, el('span', {}, DAYS[i]), el('small', {}, d.slice(5)))), el('th', { class: 'num' }, 'Total'));
  const body = w.rows.map(r => el('tr', { class: r.code === settings.codes.ot2 ? 'ot2' : r.code === settings.codes.ot15 ? 'ot15' : '' },
    el('td', {}, el('b', {}, r.mapping.shortName || r.mapping.clockifyProjectName), el('small', {}, r.mapping.activityDesc || r.mapping.projectName || '')),
    el('td', {}, el('span', { class: 'code' }, r.code), r.directCode ? el('small', {}, r.description || 'Confirmed tag') : null),
    r.hours.map(h => el('td', { class: 'num' }, fmtH(h))),
    el('td', { class: 'num total' }, fmtH(r.total))));
  const foot = el('tr', { class: 'totals' }, el('td', { colspan: 2 }, 'Day total'), w.dayTotals.map(h => el('td', { class: 'num' }, fmtH(h))), el('td', { class: 'num total' }, fmtH(w.weekTotal)));
  host.append(el('div', { class: 'tbl' }, el('table', {}, el('thead', {}, head), el('tbody', {}, body.length ? body : el('tr', {}, el('td', { colspan: 10, class: 'empty' }, 'No hours for this week.'))), el('tfoot', {}, foot))));
  // The total already lives in the table. Keep the remaining details small and below the hours.
  const workedDays = w.dayTotals.filter(h => h > 0).length;
  host.append(el('p', { class: 'week-meta muted' }, `${workedDays} day${workedDays === 1 ? '' : 's'} with hours · ${w.rows.length} IFS row${w.rows.length === 1 ? '' : 's'}`));

  // one action row: copy, view, entered status
  const copyBtn = el('button', { class: 'primary', disabled: w.canExport ? null : 'disabled', onclick: copyExport }, 'Copy for IFS');
  const viewBtn = el('button', { class: 'link', disabled: exportText ? null : 'disabled', onclick: () => openDialog('IFS text', el('div', {}, el('p', { class: 'help' }, 'In IFS open Proje Zaman Kaydı for this week, right-click the grid → Edit → Paste Object, then save.'), el('pre', {}, exportText)), { wide: true }) }, 'view text');
  const statusInline = el('span', { id: 'week-status-inline', class: 'week-state' });
  host.append(el('div', { class: 'actions week-actions' }, copyBtn, viewBtn, statusInline, el('span', { id: 'copy-status', class: 'muted' }, w.canExport ? '' : 'Fix the problems above to enable the export.')));
  const changesBox = el('div', { id: 'week-changes' });
  host.append(changesBox);
  if (notes.length) host.append(el('details', { class: 'notes' }, el('summary', {}, `${notes.length} note${notes.length === 1 ? '' : 's'} on how the hours were split`), el('ul', { class: 'warnings' }, notes.map(x => el('li', { class: 'info' }, x.text)))));
  renderWeekStatus(w, statusInline, changesBox);

  // the Clockify entries behind the numbers, editable
  host.append(renderEntriesEditor(w));
}

// ---------- week status (entered in IFS) ----------
const fmtWhen = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

async function renderWeekStatus(w, inline, changesBox) {
  const rec = await weekRecord(w.mondayIso);
  if (week !== w || !inline.isConnected) return;
  inline.replaceChildren();
  changesBox.replaceChildren();
  if (!rec) {
    inline.append(el('span', { class: 'pill norec' }, 'Not in IFS yet'),
      el('button', { disabled: !w.canExport, title: 'Press once the paste is saved in IFS; the rows are remembered so a later Clockify change is flagged', onclick: () => markEntered(w) }, 'Mark as entered'));
    return;
  }
  const changes = diffRows(rec.rows, w);
  const undo = confirmButton('undo', async () => { await unmarkWeek(w.mondayIso); toast('Week is no longer marked as entered'); if (week === w) renderWeek(); renderWeekStrip(); scheduleSync(); }, { armedLabel: 'undo? tap again', className: 'link' });
  inline.append(...[
    el('span', { class: 'pill ' + (changes.length ? 'norec' : 'rec'), title: `entered ${fmtWhen(rec.enteredAt)} with ${rec.total} h` }, changes.length ? 'Changed since entered' : `In IFS · ${fmtWhen(rec.enteredAt)}`),
    changes.length ? el('button', { onclick: () => markEntered(w) }, 'Mark again') : null,
    undo].filter(Boolean));
  if (changes.length) changesBox.append(el('ul', { class: 'warnings' }, el('li', { class: 'warn' }, 'Clockify differs from what was entered in IFS. Correct IFS (or Clockify), then mark the week again.'), changes.map(c => el('li', { class: 'info' }, c))));
}

async function markEntered(w) {
  await markWeekEntered(w);
  toast('Week marked as entered in IFS');
  if (week === w) renderWeek();
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
  if (!settings.clockify.apiKey) { toast('Add the Clockify API key in Settings first.'); openSettings('connections'); return; }
  const thisMonday = mondayOf(todayIso());
  const from = el('input', { type: 'date', value: shiftIso(thisMonday, -28) });
  const to = el('input', { type: 'date', value: shiftIso(thisMonday, -7) });
  const list = el('div');
  const status = el('span', { class: 'help status' });
  let loaded = [], busy = false;
  const copyBtn = el('button', { class: 'primary', disabled: true, onclick: async () => {
    if (busy) return;
    const ok = loaded.filter(x => x.w.canExport);
    if (!ok.length) return;
    const text = ok.map(x => makeExport(x.w)).join('\n\n');
    setBusy(true);
    try { await navigator.clipboard.writeText(text); toast(`Copied ${ok.length} week${ok.length === 1 ? '' : 's'}, ${ok.reduce((n, x) => n + x.w.rows.length, 0)} rows`); }
    catch { status.textContent = 'Clipboard blocked; open the weeks one by one instead.'; }
    finally { setBusy(false); }
  } }, 'Copy all');
  const markBtn = el('button', { disabled: true, onclick: async () => {
    if (busy || !loaded.some(x => x.w.canExport)) return;
    setBusy(true);
    let n = 0;
    try {
      for (const x of loaded) if (x.w.canExport) { x.rec = await markWeekEntered(x.w); n++; }
      paintLoaded();
      status.textContent = `${n} week${n === 1 ? '' : 's'} marked as entered.`;
      toast(status.textContent);
    } catch (e) {
      paintLoaded();
      status.textContent = `${n} week${n === 1 ? '' : 's'} marked; could not finish: ${e.message}`;
    } finally {
      setBusy(false);
      renderWeekStrip();
      if (n) scheduleSync();
    }
  } }, 'Mark all as entered');
  const loadBtn = el('button', { onclick: async () => {
    if (busy) return;
    invalidate();
    if (!from.value || !to.value) { status.textContent = 'Pick both a from-week and a to-week.'; return; }
    const a = mondayOf(from.value), b = mondayOf(to.value);
    if (a > b) { status.textContent = 'Pick a from-week that is not after the to-week.'; return; }
    const mondays = []; for (let m = a; m <= b; m = shiftIso(m, 7)) mondays.push(m);
    if (mondays.length > 26) { status.textContent = 'Up to 26 weeks at a time.'; return; }
    setBusy(true);
    status.textContent = `Loading ${mondays.length} week${mondays.length === 1 ? '' : 's'}…`;
    try {
      // Keep partial results private until the complete range is ready to review.
      const next = [];
      for (const m of mondays) next.push({ monday: m, w: await fetchWeek(m), rec: await weekRecord(m) });
      loaded = next;
      paintLoaded();
      const ok = loaded.filter(x => x.w.canExport);
      status.textContent = ok.length ? `${ok.length} week${ok.length === 1 ? '' : 's'} ready, ${loaded.length - ok.length} skipped.` : 'Nothing to export in this range.';
    } catch (e) {
      status.textContent = `Could not load the full range. ${e.message} Press Load weeks to try again.`;
    } finally { setBusy(false); }
  } }, 'Load weeks');

  function setBusy(value) {
    busy = value;
    loadBtn.disabled = from.disabled = to.disabled = value;
    copyBtn.disabled = markBtn.disabled = value || !loaded.some(x => x.w.canExport);
    list.setAttribute('aria-busy', String(value));
  }
  function invalidate() {
    loaded = [];
    list.replaceChildren();
    copyBtn.disabled = markBtn.disabled = true;
    status.textContent = 'Load this range to review its weeks.';
  }
  function paintLoaded() {
    list.replaceChildren(el('div', { class: 'tbl' }, el('table', { class: 'bulk-table' },
      el('thead', {}, el('tr', {}, ['Week of', 'Hours', 'Rows', 'Problems', 'Status'].map(h => el('th', {}, h)))),
      el('tbody', {}, loaded.map(x => {
        const errors = x.w.warnings.filter(z => z.level === 'error');
        const changes = x.rec ? diffRows(x.rec.rows, x.w) : [];
        return el('tr', {}, el('td', {}, x.monday), el('td', { class: 'num' }, String(x.w.weekTotal)), el('td', { class: 'num' }, String(x.w.rows.length)),
          el('td', {}, errors.length ? el('span', { class: 'warn-text' }, errors.map(z => z.text).join(' ')) : x.w.rows.length ? '—' : el('span', { class: 'muted' }, 'no hours')),
          el('td', {}, x.rec ? el('span', { class: 'pill ' + (changes.length ? 'norec' : 'rec') }, changes.length ? 'changed since entered' : `entered ${fmtWhen(x.rec.enteredAt)}`) : el('span', { class: 'pill' }, 'not entered')));
      })))));
  }
  from.addEventListener('change', invalidate);
  to.addEventListener('change', invalidate);
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
  let open = false;
  try { open = localStorage.getItem('ifsbridge.weekEntriesOpen') === 'open'; } catch {}
  const det = el('details', { class: 'detail', open, ontoggle: ev => { try { localStorage.setItem('ifsbridge.weekEntriesOpen', ev.target.open ? 'open' : 'closed'); } catch {} } },
    el('summary', {}, `Clockify entries (${weekEntries.length}) · edit, add or copy a day`), el('div', { class: 'days' }, days));
  return det;
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
    el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Tags'), el('div', { class: 'row' }, tagBoxes), el('small', { class: 'help' }, 'Tag meanings are configured together in Settings → Timesheets. Leave and holiday codes use General.')),
    dlgField('Description', desc, 'Free text. A line “Short Name: 210701.010101.010101-B” sends the entry to that IFS activity.'),
    el('div', { class: 'actions' }, saveBtn, el('button', { onclick: () => d.close() }, 'Cancel'),
      isNew ? null : confirmButton('Delete in Clockify', async () => { try { await c.deleteEntry(ws, entry.id); d.close(); toast('Deleted in Clockify'); await loadWeek(); } catch (e) { status.textContent = e.message; } }),
      status)));
}

async function copyExport() {
  const s = $('#copy-status');
  if (!scopeIsCurrent() || !week?.canExport || !exportText) return;
  try { await navigator.clipboard.writeText(exportText); s.textContent = 'Copied. Now paste into the IFS grid (right-click → Edit → Paste Object).'; }
  catch { s.textContent = 'Clipboard blocked. Open "Show the IFS text" and copy it by hand.'; }
}

// ---------- settings ----------
function renderSettings(group, focus) {
  if (!scopeIsCurrent() || !settings) return;
  if (!settingsPage) settingsPage = createSettingsPage({
    // Read persisted preferences when merging: another open tab may have saved
    // changes since this tab created its draft.
    workspace: currentScope().workspace, getSaved: loadSettings, isCurrent: scopeIsCurrent,
    onSave: async next => {
      assertScopeCurrent();
      saveSettings(next, { strict: true });
      settings = next;
      ++clockifyConnectId;
      invalidateClockifyView();
      toast('Settings saved');
    },
    openAccount, connectionStatusPanel: () => connectionStatusPanel({ showAccountLink: false }),
    getTheme: currentTheme, setTheme: applyTheme, defaults: defaultsForScope,
    exportRecords: exportCsv, backupRecords: backupJson,
    restoreRecords: async text => { const n = await restoreJson(text); assertScopeCurrent(); settings = loadSettings(); invalidateClockifyView(); toast(`Restored ${n} records`); },
    backupAvailable, pushBackup
  });
  if (!$('#tab-settings').childElementCount) settingsPage.mount($('#tab-settings'), group, focus);
  else if (group) settingsPage.navigate(group, focus);
}
function openSettings(group = 'time', focus) {
  if (group === 'expenses') group = 'spending';
  showTab('settings'); renderSettings(group, focus);
}

// ---------- boot ----------
async function boot() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  const admitted = await initAuthGate({ onLock: () => { invalidateClockifyView(); ++clockifyConnectId; settingsPage?.dispose(); settingsPage = null; settings = null; } });
  if (!admitted) return;
  settings = loadSettings();
  const navigation = document.querySelector('.top');
  navigation.inert = true;
  const main = document.querySelector('#main-content');
  main.inert = true;
  try {
  initShell();
  initWorkspaceUI({
    settings: () => settings,
    sync: () => scheduleSync(0),
    refresh: () => showTab(document.querySelector('.tabs button.active')?.dataset.tab || 'overview'),
    openSettings,
    reviewExpenses: kind => { showTab('expenses'); openExpenseReview(kind); },
    reviewPersonal: kind => { showTab('expenses'); reviewPersonal(kind); },
    reviewWeek: monday => { $('#week-monday').value = monday; week = null; showTab('week'); }
  });
  const personal = currentScope().workspace === 'personal';
  document.querySelector('.tabs button[data-tab="week"]').hidden = personal;
  document.querySelector('.tabs button[data-tab="study"]').hidden = !personal;
  initExpenses({ settings: () => settings, saveSettings: s => saveSettings(s), scope: currentScope, el, $, openSettings });
  initReport({ settings: () => settings, saveSettings: s => saveSettings(s) });
  initPersonal({ settings: () => settings, navigateView: view => showTab(view === 'transactions' ? 'expenses' : view) });
  $('#tab-week .toolbar').after(el('div', { id: 'week-strip', class: 'week-strip' }));
  $('#btn-bulk').addEventListener('click', openBulkDialog);
  if (!personal && settings.clockify.apiKey) renderWeekStrip();
  await initLocalBackup({ onRestored: () => { settingsPage?.dispose(); settingsPage = null; settings = loadSettings(); invalidateClockifyView(); } });
  assertScopeCurrent();
  for (const b of document.querySelectorAll('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  $('#week-monday').value = mondayOf(shiftMonday(todayIso(), -7));
  $('#btn-load').addEventListener('click', loadWeek);
  $('#btn-current').addEventListener('click', () => { $('#week-monday').value = mondayOf(todayIso()); loadWeek(); });
  $('#btn-prev').addEventListener('click', () => { $('#week-monday').value = shiftMonday(mondayOf($('#week-monday').value), -7); loadWeek(); });
  $('#btn-next').addEventListener('click', () => { $('#week-monday').value = shiftMonday(mondayOf($('#week-monday').value), 7); loadWeek(); });
  $('#week-monday').addEventListener('change', loadWeek);
  let tab = personal ? 'overview' : 'week';
  try { tab = localStorage.getItem(scopedKey('ifsbridge.tab')) || tab; } catch {}
  showTab(tab);
  } catch (error) {
    if (!scopeIsCurrent()) return;
    $('#main-content').replaceChildren(el('div', { class: 'empty' }, el('h3', {}, 'Could not open this space'), el('p', {}, error.message), el('button', { onclick: () => location.reload() }, 'Reload')));
  } finally { if (scopeIsCurrent()) revealPrivateApp(); }
}
boot();

