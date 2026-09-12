// Expenses tab: the list is the main view; adding, editing, sheets and trips open in dialogs.
// Local-first (IndexedDB), backed up to the PC by localbackup.js, synced to Supabase when signed in.
// No alert/confirm pop-ups (the Claude browser pane hides them).
import { db, save, softDelete, live, uuid, TABLES, atomicBatchSave } from './db.js';
import { Supabase } from './supabase.js';
import { sync, receiptBlob, receiptErrors } from './sync.js';
import { buildExpenseExport, numberReceipts, referenceText, totalsByCurrency, fmtMoney, lineOrder, linesFromIfsRecords, rateKey, rateFor } from './expense-ifs.js';
import { parseCopyObjects } from './ifs.js';
import { loadSettings, saveSettings } from './store.js';
import { el, $, confirmButton, openDialog, toast, download, field } from './dom.js';
import { readReceipt } from './ocr.js';
import { currentScope, scopedKey, assertScopeCurrent, scopeIsCurrent } from './scope.js';
import { initExpenseTools, openExpenseTools, openInbox, openReimbursements } from './expense-tools.js';
import { expenseReviewQueue } from './review-queue.js';
import { openExpenseReviewDialog } from './review-ui.js';
import { reimbursementSummary, validateExpenseChange, minorAmount } from './expense-workflows.js';
import { snapshot, restoreSnapshot, assertBackupScope } from './localbackup.js';

let ctx = null;            // { settings(), saveSettings(s) }
let client = null;
const state = { sheetId: null, filter: 'all', search: '', month: '', sort: 'order' };   // sort: order | bizFirst | persFirst
try { state.sort = localStorage.getItem(scopedKey('ifsbridge.expSort')) || 'order'; } catch {}
let data = { sheets: [], lines: [], trips: [] };
let rateCache = { field: '', byKey: {} };   // "USD|2026-08-29" -> { rate, usedDate, source }
const rateFailed = new Set();
let ratePending = new Map();
let syncTimer = null;
let built = false;
let personalChange = null;
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

// ---------- setup / sync ----------
export function initExpenses(context) {
  ctx = context;
  initExpenseTools({ settings, today: todayIso, currentSheet, refresh, scheduleSync, downscale, client: supabaseClient, newExpense: openNewExpense, openExpense, review: openExpenseReview });
  client = new Supabase(ctx.settings().supabase);
  window.addEventListener('online', () => {
    if (!scopeIsCurrent()) return;
    scheduleSync(0);
    resetRateFailures();
    paint(['summary']);
  });
}

export function supabaseClient() {
  assertScopeCurrent();
  const s = ctx.settings().supabase;
  if (!client || client.url !== (s.url || '').replace(/\/+$/, '') || client.anonKey !== s.anonKey) client = new Supabase(s);
  return client;
}

export function scheduleSync(delay = 1500) {
  clearTimeout(syncTimer);
  if (!ctx || !scopeIsCurrent()) return;
  syncTimer = setTimeout(async () => {
    syncTimer = null;
    if (!scopeIsCurrent()) return;
    const st = $('#exp-sync');
    const status = text => { if (scopeIsCurrent() && st?.isConnected && text) st.textContent = text; };
    try {
      const c = supabaseClient();
      if (!c.configured) { status('On this device only'); return; }
      if (!c.signedIn) { status('Not signed in'); return; }
      if (!navigator.onLine) { status('Offline, will sync later'); return; }
      const r = await sync(c, status);
      if (!scopeIsCurrent()) return;
      status(r.errors?.length ? `Sync problem: ${r.errors[0]}` : `Synced ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`);
      if (r.pulled) await refresh();
    } catch (error) {
      // Sign-out cancels pending work; it must not repaint or reject a timer.
      status(`Sync problem: ${error.message}`);
    }
  }, delay);
}

// ---------- data ----------
const settings = () => ctx.settings();
const personalSpace = () => currentScope().workspace === 'personal';
const todayIso = () => new Intl.DateTimeFormat('en-CA', { timeZone: settings().timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const shiftIso = (iso, days) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10); };
const monthTitle = iso => new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
const monthLabel = ym => new Date(ym + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
const fmtDate = iso => iso ? new Date(iso + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }) : '';
const fmtWhen = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const codeOf = code => (settings().expenseCodes || []).find(c => String(c.code) === String(code));
const currentSheet = () => data.sheets.find(s => s.id === state.sheetId);
const sheetLines = () => data.lines.filter(l => l.sheetId === state.sheetId);
const photoIdsOf = l => Array.isArray(l.receiptIds) ? l.receiptIds : (l.receiptId ? [l.receiptId] : []);
const homeCur = () => (settings().homeCurrency || 'TRY').toUpperCase();

async function load() {
  data.sheets = (await live('sheets')).sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''));
  assertScopeCurrent();
  if (!data.sheets.length) data.sheets = [await save('sheets', { title: monthTitle(todayIso()), expenseId: '', status: 'open', autoCreated: true, created_at: new Date().toISOString() })];
  data.lines = await live('expenses');
  data.trips = (await live('trips')).sort((a, b) => (b.start || '').localeCompare(a.start || ''));
  if (!state.sheetId) state.sheetId = await db.meta('currentSheet');
  if (!data.sheets.some(s => s.id === state.sheetId)) state.sheetId = data.sheets[0].id;
  if (!rateCache.field) { const saved = await db.meta('rateCache'); if (saved && saved.byKey) rateCache = saved; }
  alignRateField();
  assertScopeCurrent();
}

// The Personal dashboard uses the dialogs without mounting the Work sheet page.
// Loading never invokes onChange, so a dashboard refresh can prepare safely.
export async function preparePersonalExpenses({ onChange } = {}) {
  assertScopeCurrent();
  if (!personalSpace()) throw Error('Open the Personal space to prepare spending tools.');
  if (onChange !== undefined) personalChange = onChange;
  await load();
  return currentSheet();
}

export async function openNewExpense(prefill = {}) {
  await load(); assertScopeCurrent();
  return openLineDialog(null, prefill);
}

async function setSheet(id) { state.sheetId = id; await db.setMeta('currentSheet', id); paintAll(); }

// Rates for the line's date (TCMB), cached per device. On the PC the local server fetches
// them live; anywhere else the app reads the daily JSON files published with it
// (rates/YYYY-MM-DD.json, updated every day by the site's GitHub Action).
const dayFiles = new Map();
const failedDays = new Set();
function alignRateField() {
  const field = settings().tcmbField || 'ForexBuying';
  if (rateCache.field !== field) {
    rateCache = { field, byKey: {} };
    rateFailed.clear();
    // Requests already running keep their old cache; they cannot replace this column.
    ratePending = new Map();
  }
}
function resetRateFailures() {
  rateFailed.clear();
  // Retry unavailable files too, including a file that was not published earlier.
  for (const date of failedDays) dayFiles.delete(date);
  failedDays.clear();
}
async function staticDay(date) {
  if (!dayFiles.has(date)) dayFiles.set(date, fetch(`./rates/${date}.json`, { cache: 'no-cache' })
    .then(r => r.ok ? r.json() : null).catch(() => null)
    .then(day => {
      if (!day || (!day.none && !day.rates)) { failedDays.add(date); return null; }
      return day;
    }));
  return dayFiles.get(date);
}
async function staticRate(cur, date, field) {
  for (let back = 0; back < 10; back++) {
    const d = shiftIso(date, -back);
    const day = await staticDay(d);
    if (!day) { if (back === 0) continue; else return null; }   // missing file: today not published yet, or before the archive
    if (day.none) continue;
    const e = day.rates?.[cur];
    if (!e || !(Number(e[field]) > 0)) return null;
    return { rate: e[field], usedDate: d, source: 'tcmb' };
  }
  return null;
}
async function ensureRates(lines) {
  const s = settings();
  if (s.rateSource === 'manual') return false;
  alignRateField();
  const cache = rateCache, pending = ratePending;
  const wanted = foreignRateKeys(lines)
    .filter(k => !rateCache.byKey[k] && !rateFailed.has(k));
  if (!wanted.length) return false;
  const hits = await Promise.all(wanted.map(k => {
    if (pending.has(k)) return pending.get(k);
    const [cur, date] = k.split('|');
    const request = (async () => {
      let hit = null;
      if (LOCAL) {
        // A plain preview server has no API and may return an HTML error page.
        // An unavailable local API must still allow the published JSON fallback.
        try {
          const r = await fetch(`/api/rate?cur=${encodeURIComponent(cur)}&date=${date}&field=${encodeURIComponent(cache.field)}`, { cache: 'no-store' });
          if (r.ok) {
            const j = await r.json();
            if (Number(j?.rate) > 0) hit = { rate: j.rate, usedDate: j.usedDate, source: j.source };
          }
        } catch { /* Fall back to the daily files below. */ }
      }
      if (!hit) hit = await staticRate(cur, date, cache.field);
      if (cache !== rateCache || cache.field !== (settings().tcmbField || 'ForexBuying')) return false;
      if (hit) { cache.byKey[k] = hit; rateFailed.delete(k); return true; }
      rateFailed.add(k);
      return false;
    })().catch(() => {
      if (cache === rateCache && cache.field === (settings().tcmbField || 'ForexBuying')) rateFailed.add(k);
      return false;
    }).finally(() => pending.delete(k));
    pending.set(k, request);
    return request;
  }));
  const got = hits.some(Boolean) && cache === rateCache;
  if (got) {
    try { await db.setMeta('rateCache', cache); }
    catch { /* Rates remain usable in this session if the device cache cannot save. */ }
  }
  return got;
}
function foreignRateKeys(lines) {
  const home = homeCur();
  return [...new Set(lines.filter(l => l.business && l.currency && l.currency.toUpperCase() !== home && l.date).map(l => rateKey(l.currency, l.date)))];
}
async function retryRates() {
  resetRateFailures();
  const request = ensureRates(sheetLines());
  paint(['summary']);
  await request;
  paint(['summary']);
}

// ---------- render ----------
export async function render() {
  const root = $('#tab-expenses');
  if (!root) return;
  await load();
  if (!built || !root.querySelector('#exp-list')) {
    root.replaceChildren(
      el('div', { id: 'exp-help' }),
      el('div', { id: 'exp-head', class: 'exp-head' }),
      el('div', { id: 'exp-summary', class: 'exp-summary' }),
      el('div', { id: 'exp-tools', class: 'exp-tools' }),
      el('div', { id: 'exp-list', class: 'exp-list' }),
      el('div', { id: 'exp-trips', class: 'exp-trips' }),
      el('button', { class: 'fab', type: 'button', 'aria-label': 'Add expense', onclick: () => openLineDialog(null) }, '+'));
    built = true;
  }
  paintAll();
}

async function refresh(parts = ['head', 'summary', 'list', 'trips'], change) {
  await load();
  if (personalSpace() && personalChange) await personalChange(change);
  else paint(parts);
}
function paintAll() { paint(['help', 'head', 'summary', 'tools', 'list', 'trips']); }
function paint(parts) {
  if (!built || !$('#exp-list')) return;   // Expenses tab not opened yet in this session: nothing to repaint
  for (const p of parts) ({ help: paintHelp, head: paintHead, summary: paintSummary, tools: paintTools, list: paintList, trips: paintTrips })[p]();
}

function paintHelp(forceOpen = false) {
  const host = $('#exp-help');
  const open = forceOpen || !!host.querySelector('details')?.open;
  let dismissed = false;
  try { dismissed = localStorage.getItem(scopedKey('ifsbridge.expHelp')) === 'off'; } catch {}
  host.replaceChildren();
  if (dismissed) return;
  if (personalSpace()) {
    host.append(el('details', { class: 'help-box exp-help-fold', open }, el('summary', {}, 'How personal spending works'), el('p', {}, 'Record purchases and refunds, keep receipts, and review budgets. Use a negative amount for a refund. Tools includes receipt review, recurring drafts, CSV import and an optional Pocket link.')));
    return;
  }
  host.append(el('details', { class: 'help-box exp-help-fold', open },
    el('summary', {}, 'How expenses work here'),
    el('ol', {},
      el('li', {}, 'Add every expense as it happens, on the phone or the PC. ', el('strong', {}, 'Business'), ' lines go to IFS, ', el('strong', {}, 'Personal'), ' lines stay in the app so you keep one record of everything.'),
      el('li', {}, 'A sheet here is one IFS expense sheet. Create the sheet in IFS, then type its Expense ID and project short name under “Sheets…”. Rates come from the Central Bank for each line’s date.'),
      el('li', {}, 'At month end follow the “Month close” list: press ', el('strong', {}, 'Copy for IFS'), ', paste into the Expense Details grid (right-click → Edit → Paste Object), save in IFS, then press “Mark as entered”. Lines added later are exported on their own with “Copy new lines”.'),
      el('li', {}, 'A trip creates the per diem line on the sheet and shows what you spent against it.')),
    el('button', { class: 'link', onclick: () => { try { localStorage.setItem(scopedKey('ifsbridge.expHelp'), 'off'); } catch {} paintHelp(); } }, 'Got it, hide this')));
}

function paintHead() {
  const host = $('#exp-head');
  const sheet = currentSheet();
  const sel = el('select', { class: 'sheet-select', 'aria-label': personalSpace() ? 'Collection' : 'Sheet', onchange: e => setSheet(e.target.value) },
    data.sheets.map(s => el('option', { value: s.id, selected: s.id === sheet.id }, personalSpace() ? s.title || 'Collection' : `${s.title || 'Sheet'}${s.expenseId ? ` · IFS ${s.expenseId}` : ' · no IFS ID yet'}${s.status === 'entered' ? ' ✓' : ''}`)));
  const c = supabaseClient();
  host.replaceChildren(
    sel,
    personalSpace() ? null : el('button', { type: 'button', class: 'review-entrypoint primary', id: 'exp-review', onclick: () => openExpenseReview() }, `Review ${expenseReviewQueue({ lines: data.lines, sheets: data.sheets, settings: settings(), rates: rateCache.byKey }).count}`),
    el('button', { onclick: personalSpace() ? openPersonalSheetsDialog : openSheetsDialog }, personalSpace() ? 'Collections…' : 'Sheets…'),
    el('button', { type: 'button', onclick: () => openExpenseTools() }, 'Tools'),
    el('button', { class: 'icon', title: 'Show the explanation again', 'aria-label': 'Help with expenses', onclick: () => { try { localStorage.removeItem(scopedKey('ifsbridge.expHelp')); } catch {} paintHelp(true); $('#exp-help summary')?.focus(); } }, '?'),
    el('span', { id: 'exp-sync', class: 'sync-state' }, !c.configured ? 'On this device only' : c.signedIn ? 'Sync on' : 'Not signed in'));
}

async function markEntered(sheet, lines) {
  const now = new Date().toISOString();
  let n = 0;
  for (const l of lines.filter(l => l.business && !l.entered)) { await save('expenses', { ...l, entered: true, enteredAt: now }); n++; }
  await save('sheets', { ...sheet, status: 'entered', enteredAt: now });
  toast(n ? `Marked as entered in IFS: ${n} line${n === 1 ? '' : 's'}` : 'Sheet marked as entered in IFS');
  await refresh(['head', 'summary', 'list']);
  scheduleSync();
}

function paintSummary() {
  const host = $('#exp-summary');
  const sheet = currentSheet();
  const lines = sheetLines();
  const s = settings();
  if (personalSpace()) {
    const money = Object.entries(totalsByCurrency(lines)).map(([cur, n]) => fmtMoney(n, cur)).join(' + ') || '0.00';
    host.replaceChildren(el('div', { class: 'sum-item' }, el('span', { class: 'k' }, 'Net spending'), el('b', {}, money), el('small', {}, `${lines.length} expenses and refunds · currencies kept separate`)));
    return;
  }
  alignRateField();
  const biz = lines.filter(l => l.business), pers = lines.filter(l => !l.business);
  const enteredCount = biz.filter(l => l.entered).length, newCount = biz.length - enteredCount;
  const money = ls => Object.entries(totalsByCurrency(ls)).map(([cur, n]) => fmtMoney(n, cur)).join(' + ') || '0.00';
  const expAll = buildExpenseExport(sheet, lines, s, rateCache.byKey);
  const expNew = buildExpenseExport(sheet, lines, s, rateCache.byKey, { onlyNew: true });

  // Try each missing currency/date once. A failed request waits for Retry or online.
  const keys = foreignRateKeys(lines);
  if (expAll.unrated.length && s.rateSource !== 'manual' && keys.some(k => !rateCache.byKey[k] && !rateFailed.has(k) && !ratePending.has(k))) {
    ensureRates(lines).then(() => paint(['summary']));
  }
  const loadingRates = s.rateSource !== 'manual' && keys.some(k => ratePending.has(k));
  const failedRates = s.rateSource === 'manual' ? [] : keys.filter(k => rateFailed.has(k));

  const copy = async exp => {
    try { await navigator.clipboard.writeText(exp.text); toast(`Copied ${exp.count} line${exp.count === 1 ? '' : 's'}. Paste into the IFS Expense Details grid.`); if (sheet.status === 'open') { await save('sheets', { ...sheet, status: 'exported' }); refresh(['head', 'summary']); scheduleSync(); } }
    catch { openIfsTextDialog(exp); }
  };
  const partial = enteredCount > 0 && newCount > 0;
  const copyBtn = el('button', { class: 'primary', disabled: !!expAll.error || !(partial ? expNew.count : expAll.count), onclick: () => copy(partial ? expNew : expAll) }, partial ? `Copy new lines (${expNew.count})` : 'Copy for IFS');
  const copyAllBtn = partial ? el('button', { onclick: () => copy(expAll) }, `Copy all (${expAll.count})`) : null;
  const viewBtn = el('button', { class: 'link', disabled: !expAll.count, onclick: () => openIfsTextDialog(partial ? expNew : expAll) }, 'view text');
  const enteredBtn = newCount > 0 ? el('button', { onclick: () => markEntered(sheet, lines) }, enteredCount ? `Mark new lines as entered (${newCount})` : 'Mark as entered in IFS') : null;

  // rates summary
  const home = homeCur();
  const foreign = [...new Set(biz.map(l => (l.currency || '').toUpperCase()).filter(c => c && c !== home))];
  const rateText = foreign.length === 0 ? `${home} only` : s.rateSource === 'manual'
    ? (foreign.map(c => sheet.rates?.[c] ? `${c} ${sheet.rates[c]}` : `${c} missing`).join(', '))
    : `${expAll.rates.filter(r => r.source === 'tcmb').length} of ${expAll.rates.filter(r => r.cur !== home).length} lines rated by date (TCMB ${rateCache.field || s.tcmbField})${expAll.unrated.length ? `, ${expAll.unrated.length} missing` : ''}`;

  // month close checklist
  const items = [
    [!!sheet.expenseId, 'IFS Expense ID', sheet.expenseId ? sheet.expenseId : 'set it under Sheets…'],
    [!!sheet.shortName, 'Project short name', sheet.shortName || 'set it under Sheets…'],
    [expAll.unrated.length === 0, 'Currency rates', expAll.unrated.length ? `${expAll.unrated.length} line${expAll.unrated.length === 1 ? '' : 's'} without a rate` : foreign.length ? 'every foreign line has a rate' : 'no foreign currency'],
    [true, 'Receipts', `${biz.filter(l => l.receipt).length} with receipt, ${biz.filter(l => !l.receipt).length} without`],
    [sheet.status !== 'open', 'Copied to IFS', sheet.status === 'open' ? 'not yet' : 'done'],
    [sheet.status === 'entered', 'Saved in IFS', sheet.status === 'entered' ? `marked entered ${fmtWhen(sheet.enteredAt)}` : 'press “Mark as entered” after saving in IFS'],
    [newCount === 0 || enteredCount === 0, 'New lines since the paste', enteredCount ? (newCount ? `${newCount} line${newCount === 1 ? '' : 's'} to export with “Copy new lines”` : 'none') : 'first export not done yet'],
  ];
  const allDone = items.every(i => i[0]) && sheet.status === 'entered';
  let closeOpen = false;
  try { closeOpen = localStorage.getItem('ifsbridge.closeOpen') === 'open'; } catch {}
  const checklist = el('details', { class: 'close-box', open: closeOpen, ontoggle: ev => { try { localStorage.setItem('ifsbridge.closeOpen', ev.target.open ? 'open' : 'closed'); } catch {} } },
    el('summary', {}, `Month close ${allDone ? '✓ complete' : `· ${items.filter(i => !i[0]).length} open`}`),
    el('ul', { class: 'checklist' }, items.map(([ok, label, note]) => el('li', {}, el('span', { class: 'mark ' + (ok ? 'ok' : 'todo') }, ok ? '✓' : '○'), el('span', {}, el('b', {}, label), ' ', el('small', {}, note))))));

  const ratesOk = foreign.length === 0 || expAll.unrated.length === 0;
  const stateText = expAll.error ? expAll.error : sheet.status === 'entered' ? `In IFS ${fmtWhen(sheet.enteredAt)}${newCount ? ` · ${newCount} new line${newCount === 1 ? '' : 's'} not in IFS yet` : ''}` : sheet.status === 'exported' ? 'Copied; after saving in IFS press Mark as entered' : '';
  host.replaceChildren(
    el('div', { class: 'sum-item' }, el('span', { class: 'k' }, 'To IFS'), el('b', {}, money(biz)), el('small', {}, `${biz.length} line${biz.length === 1 ? '' : 's'} · ${biz.filter(l => l.receipt).length} with receipt${enteredCount ? ` · ${enteredCount} in IFS` : ''}`)),
    el('div', { class: 'sum-item' }, el('span', { class: 'k' }, 'Personal'), el('b', {}, money(pers)), el('small', {}, `${pers.length} line${pers.length === 1 ? '' : 's'}, stays here`)),
    el('div', { class: 'sum-line' },
      sheet.shortName ? el('code', {}, sheet.shortName) : el('span', { class: 'warn-text' }, 'project short name not set'),
      el('span', { id: 'exp-rate-status', role: 'status', 'aria-live': 'polite', class: ratesOk ? 'muted' : 'warn-text', title: rateText }, loadingRates ? 'Fetching exchange rates…' : ratesOk ? 'rates ✓' : failedRates.length ? `Could not load ${failedRates.length} date rate${failedRates.length === 1 ? '' : 's'}` : `${expAll.unrated.length} line${expAll.unrated.length === 1 ? '' : 's'} without a rate`),
      failedRates.length ? el('button', { type: 'button', class: 'link', disabled: loadingRates, title: `Retry ${failedRates.map(k => k.replace('|', ' ')).join(', ')}`, onclick: retryRates }, 'Retry rates') : null,
      el('button', { class: 'link', onclick: openSheetsDialog }, 'change'),
      stateText ? el('span', { class: expAll.error ? 'warn-text' : 'muted' }, stateText) : null),
    el('div', { class: 'sum-actions' }, copyBtn, copyAllBtn, enteredBtn, viewBtn,
      ...expAll.warnings.filter(w => !/without a rate/.test(w) || !ratesOk).map(w => el('small', { class: 'help warn-text' }, w))),
    checklist);
}

function paintTools() {
  const host = $('#exp-tools');
  const search = el('input', { id: 'exp-search', type: 'search', 'aria-label': personalSpace() ? 'Search expenses in this collection' : 'Search expenses in this sheet', 'aria-controls': 'exp-list', placeholder: 'Search description, vendor, date…', value: state.search, oninput: e => { state.search = e.target.value; paintList(); } });
  const chips = el('div', { class: 'chips', role: 'group', 'aria-label': 'Expense type' }, (personalSpace() ? [['all', 'All']] : [['all', 'All'], ['business', 'Business'], ['personal', 'Personal']]).map(([k, l]) =>
    el('button', { type: 'button', class: 'chip' + (state.filter === k ? ' on' : ''), 'data-filter': k, 'aria-pressed': String(state.filter === k), onclick: () => { state.filter = k; paintList(); } }, l)));
  const months = [...new Set(sheetLines().map(l => (l.date || '').slice(0, 7)).filter(Boolean))].sort().reverse();
  if (state.month && !months.includes(state.month)) state.month = '';
  const monthChips = el('div', { class: 'chips months', role: 'group', 'aria-label': 'Expense month' }, el('span', { class: 'chips-label' }, 'Month'), [['', 'All'], ...months.map(m => [m, monthLabel(m)])].map(([k, l]) =>
    el('button', { type: 'button', class: 'chip' + (state.month === k ? ' on' : ''), 'data-month': k, 'aria-pressed': String(state.month === k), onclick: () => { state.month = k; paintList(); } }, l)));
  const sortSel = el('select', { class: 'sort-select', 'aria-label': 'Order within a day', onchange: e => { state.sort = e.target.value; try { localStorage.setItem(scopedKey('ifsbridge.expSort'), state.sort); } catch {} paintList(); } },
    (personalSpace() ? [['order', 'In receipt order']] : [['order', 'In receipt order'], ['bizFirst', 'Business first, then personal'], ['persFirst', 'Personal first, then business']]).map(([v, l]) => el('option', { value: v, selected: state.sort === v }, l)));
  const results = el('div', { class: 'exp-results' },
    el('span', { id: 'exp-results-count', class: 'exp-results-count muted', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' }),
    el('button', { id: 'exp-clear-filters', type: 'button', class: 'link', onclick: () => {
      state.filter = 'all'; state.month = ''; state.search = '';
      search.value = '';
      paintList();
      search.focus();
    } }, 'Clear filters'));
  host.replaceChildren(...[el('button', { class: 'primary add-desktop', onclick: () => openLineDialog(null) }, '+ Add expense'), personalSpace() ? null : chips, search, personalSpace() ? null : sortSel, months.length > 1 ? monthChips : null, results].filter(Boolean));
}

// Move a line one place up or down among the lines of the same date (receipt order).
async function moveLine(line, dir) {
  const day = sheetLines().filter(l => l.date === line.date).sort(lineOrder);
  const i = day.findIndex(l => l.id === line.id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= day.length) return;
  [day[i], day[j]] = [day[j], day[i]];
  for (let k = 0; k < day.length; k++) if ((day[k].seq ?? 0) !== (k + 1) * 10) await save('expenses', { ...day[k], seq: (k + 1) * 10 });
  await refresh(['summary', 'list']);
  scheduleSync();
}

function paintList() {
  const host = $('#exp-list');
  const all = sheetLines();
  const anyEntered = all.some(l => l.entered);
  const query = state.search.trim().toLowerCase();
  const lines = all.filter(l => state.filter === 'all' || (state.filter === 'business') === !!l.business)
    .filter(l => !state.month || (l.date || '').startsWith(state.month))
    .filter(l => !query || [l.written, l.vendor, l.costObject, l.date, l.currency, l.code, codeOf(l.code)?.short, String(l.amount)].join(' ').toLowerCase().includes(query))
    .sort(lineOrder);
  // Update controls in place so typing and keyboard focus survive each filter change.
  for (const button of $('#exp-tools').querySelectorAll('[data-filter], [data-month]')) {
    const selected = button.hasAttribute('data-filter') ? button.dataset.filter === state.filter : button.dataset.month === state.month;
    button.classList.toggle('on', selected);
    button.setAttribute('aria-pressed', String(selected));
  }
  const filtered = state.filter !== 'all' || !!state.month || !!query;
  const count = $('#exp-results-count');
  if (count) count.textContent = filtered ? `Showing ${lines.length} of ${all.length} expenses in this ${personalSpace() ? 'collection' : 'sheet'}` : `${all.length} expense${all.length === 1 ? '' : 's'} in this ${personalSpace() ? 'collection' : 'sheet'}`;
  const clear = $('#exp-clear-filters');
  if (clear) clear.disabled = !filtered && !state.search;
  const refs = numberReceipts(all);
  host.replaceChildren();
  if (!lines.length) {
    host.append(el('div', { class: 'empty expense-empty' },
      el('h3', {}, all.length ? 'No expenses match your filters' : 'Add your first expense'),
      el('p', {}, all.length ? personalSpace() ? 'Try another search or clear the filters to see this collection’s expenses.' : 'Try another search, choose All, or use Clear filters above to see this sheet’s expenses.' : personalSpace() ? 'Add a purchase or a refund. Receipt photos, imports and budgets are available under Tools.' : 'Add an amount now and include a receipt when you have it.'),
      !all.length ? el('button', { type: 'button', class: 'primary', onclick: () => openLineDialog(null) }, '+ Add expense') : null));
    return;
  }
  if (state.month) {
    const biz = lines.filter(l => l.business), pers = lines.filter(l => !l.business);
    const money = ls => Object.entries(totalsByCurrency(ls)).map(([c, n]) => fmtMoney(n, c)).join(' + ') || '0.00';
    host.append(el('div', { class: 'month-total' }, el('b', {}, monthLabel(state.month)), personalSpace() ? el('span', {}, `Net spending ${money(lines)}`) : el('span', {}, `To IFS ${money(biz)}`), personalSpace() ? null : el('span', {}, `Personal ${money(pers)}`), el('span', { class: 'muted' }, `${lines.length} line${lines.length === 1 ? '' : 's'}`)));
  }
  const byDate = new Map();
  for (const l of lines) { if (!byDate.has(l.date)) byDate.set(l.date, []); byDate.get(l.date).push(l); }
  const money = ls => Object.entries(totalsByCurrency(ls)).map(([c, n]) => fmtMoney(n, c)).join(' + ');
  for (const date of [...byDate.keys()].sort().reverse()) {   // newest day first; inside a day the latest receipt on top
    let ls = byDate.get(date).sort(lineOrder).reverse();
    if (state.sort === 'bizFirst') ls = [...ls.filter(l => l.business), ...ls.filter(l => !l.business)];
    if (state.sort === 'persFirst') ls = [...ls.filter(l => !l.business), ...ls.filter(l => l.business)];
    const dayAll = all.filter(l => l.date === date).sort(lineOrder);
    const dayBiz = ls.filter(l => l.business), dayPers = ls.filter(l => !l.business);
    host.append(el('div', { class: 'day-group' },
      el('div', { class: 'day-head' }, el('span', { class: 'day-name' }, fmtDate(date)),
        el('span', { class: 'day-totals' },
          dayBiz.length ? el('span', {}, el('i', {}, 'Business'), el('span', { class: 'amt' }, money(dayBiz))) : null,
          dayPers.length ? el('span', {}, el('i', {}, 'Personal'), el('span', { class: 'amt' }, money(dayPers))) : null,
          dayBiz.length && dayPers.length ? el('span', { class: 'day-sum' }, el('i', {}, 'Total'), el('span', { class: 'amt' }, money(ls))) : null)),
      ls.map(l => {
        const idx = dayAll.findIndex(x => x.id === l.id);
        const photos = photoIdsOf(l).length;
        const cls = 'line' + (l.business ? '' : ' personal') + (l.business && l.entered ? ' entered' : '') + (l.business && !l.entered && anyEntered ? ' new' : '');
        const open = () => openLineDialog(l);
        return el('div', { class: cls, role: 'button', tabindex: '0', onclick: open, onkeydown: ev => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(); } } },
          el('span', { class: 'l-main' }, el('b', {}, l.written || codeOf(l.code)?.short || 'Expense'), el('small', {}, [l.vendor, codeOf(l.code)?.short, l.costObject].filter(Boolean).join(' · '))),
          el('span', { class: 'l-side' }, el('b', { class: 'amt' }, fmtMoney(l.amount, l.currency)),
            el('span', { class: 'tags' },
              l.business ? el('span', { class: 'pill ' + (l.receipt ? 'rec' : 'norec') }, l.receipt ? `Receipt #${refs.get(l.id)}` : 'No receipt') : el('span', { class: 'pill pers' }, 'Personal'),
              l.business && l.entered ? el('span', { class: 'pill inifs', title: `Entered in IFS ${fmtWhen(l.enteredAt)}` }, 'In IFS') : null,
              l.business && !l.entered && anyEntered ? el('span', { class: 'pill newline' }, 'New') : null,
              reimbursementSummary(l).eligible && (l.reimbursement?.stage || l.reimbursement?.payments?.length) ? el('span', { class: 'pill reimbursement' }, { awaiting: 'Awaiting payment', partial: 'Partly paid', paid: 'Paid' }[reimbursementSummary(l).status]) : null,
              Number(l.amount) < 0 ? el('span', { class: 'pill' }, 'Refund') : null,
              l.perdiem ? el('span', { class: 'pill pd' }, 'Per diem') : null,
              photos ? el('span', { class: 'pill photo', title: `${photos} photo${photos === 1 ? '' : 's'}` }, `📷${photos > 1 ? ' ' + photos : ''}`) : null)),
          el('span', { class: 'move' + (dayAll.length > 1 && state.sort === 'order' ? '' : ' none'), onclick: ev => ev.stopPropagation(), onkeydown: ev => ev.stopPropagation() },
            el('button', { type: 'button', class: 'icon small', title: 'Move up (later receipt number)', 'aria-label': 'Move up', disabled: idx >= dayAll.length - 1, onclick: () => moveLine(l, 1) }, '▲'),
            el('button', { type: 'button', class: 'icon small', title: 'Move down (earlier receipt number)', 'aria-label': 'Move down', disabled: idx <= 0, onclick: () => moveLine(l, -1) }, '▼')));
      })));
  }
}

function paintTrips() {
  const host = $('#exp-trips');
  if (personalSpace()) {
    host.replaceChildren(el('details', { class: 'trips-fold' }, el('summary', {}, `Trips (${data.trips.length})`), el('button', { onclick: () => openPersonalTripDialog() }, '+ Add trip'),
      el('div', { class: 'trip-list' }, data.trips.map(tr => el('button', { class: 'trip', onclick: () => openPersonalTripDialog(tr) }, el('b', {}, tr.name), el('small', {}, `${tr.start} → ${tr.end}`))))));
    return;
  }
  const fmt = ls => Object.entries(totalsByCurrency(ls)).map(([c, n]) => fmtMoney(n, c)).join(' + ') || '—';
  const cards = data.trips.map(tr => {
    const ls = data.lines.filter(l => l.tripId === tr.id);
    const income = ls.filter(l => l.perdiem), pocket = ls.filter(l => !l.perdiem && !l.business), reimb = ls.filter(l => !l.perdiem && l.business);
    const net = {};
    for (const l of income) net[l.currency] = (net[l.currency] || 0) + Number(l.amount);
    for (const l of pocket) net[l.currency] = (net[l.currency] || 0) - Number(l.amount);
    return el('button', { type: 'button', class: 'trip', onclick: () => openTripDialog(tr) },
      el('b', {}, tr.name), el('small', {}, `${tr.start} → ${tr.end} · ${tr.days} day${tr.days === 1 ? '' : 's'} × ${fmtMoney(tr.rate, tr.currency)}${tr.country ? ' · ' + tr.country : ''}`),
      el('div', { class: 'trip-nums' },
        el('span', {}, el('i', {}, 'Per diem'), fmt(income)), el('span', {}, el('i', {}, 'Out of pocket'), fmt(pocket)),
        el('span', {}, el('i', {}, 'Reimbursed'), fmt(reimb)), el('span', { class: 'net' }, el('i', {}, 'Net'), Object.entries(net).map(([c, n]) => fmtMoney(Math.round(n * 100) / 100, c)).join(' + ') || '—')));
  });
  let open = false;
  try { open = localStorage.getItem(scopedKey('ifsbridge.tripsOpen')) === 'open'; } catch {}
  host.replaceChildren(el('details', { class: 'trips-fold', open, ontoggle: ev => { try { localStorage.setItem(scopedKey('ifsbridge.tripsOpen'), ev.target.open ? 'open' : 'closed'); } catch {} } },
    el('summary', {}, `Trips and per diem (${data.trips.length})`),
    el('div', { class: 'row' }, el('button', { onclick: () => openTripDialog(null) }, '+ Add trip'), el('span', { class: 'help' }, 'A trip creates the per diem line on its sheet; its personal lines count as out of pocket, business lines as reimbursed.')),
    cards.length ? el('div', { class: 'trip-list' }, cards) : el('p', { class: 'empty' }, 'No trips yet.')));
}

// ---------- dialogs ----------
export function resetExpenseView() {
  state.sheetId = null; state.filter = 'all'; state.month = ''; state.search = ''; built = false;
  data = { sheets: [], lines: [], trips: [] }; rateCache = { field: '', byKey: {} }; ratePending = new Map(); rateFailed.clear();
}
export async function openExpense(id) {
  if (personalSpace()) await load(); else await render();
  assertScopeCurrent();
  const row = data.lines.find(l => l.id === id);
  if (!row) { toast('This expense is no longer available in this space.'); return; }
  if (personalSpace()) { state.sheetId = data.sheets.some(s => s.id === row.sheetId) ? row.sheetId : state.sheetId; return openLineDialog(row); }
  await setSheet(row.sheetId); state.filter = 'all'; state.month = ''; state.search = ''; paintAll(); openLineDialog(row);
}
export async function showExpenseAttention(kind) {
  if (!personalSpace()) return openExpenseReview(kind);
  if (personalSpace()) await load(); else await render();
  assertScopeCurrent();
  if (kind === 'inbox') return openInbox();
  const rows = data.lines.filter(l => !l.perdiem && (kind === 'receipts' ? !l.receipt && !photoIdsOf(l).length : kind === 'rates' ? l.business && !l.entered && !rateFor(l, data.sheets.find(s => s.id === l.sheetId), settings(), rateCache.byKey).rate : true));
  const host = el('div', { class: 'workflow-list' });
  const dialog = openDialog(kind === 'receipts' ? 'Expenses missing receipts' : kind === 'rates' ? 'Expenses missing currency rates' : 'Expenses needing attention', host);
  for (const row of rows) host.append(el('button', { class: 'workflow-menu-item', onclick: () => { dialog.close(); openExpense(row.id); } }, el('b', {}, row.written || 'Expense'), el('small', {}, `${row.date} · ${fmtMoney(row.amount, row.currency)} · ${personalSpace() ? row.merchant || row.vendor || '' : data.sheets.find(s => s.id === row.sheetId)?.title || 'Sheet'}`)));
  if (!rows.length) host.append(el('p', { class: 'empty' }, 'Nothing needs attention here.'));
}

export function openExpenseReview(kind = 'all') {
  assertScopeCurrent();
  if (personalSpace()) return showExpenseAttention(kind);
  if (kind === 'inbox') return openInbox();
  return openExpenseReviewDialog({
    isCurrent: () => scopeIsCurrent() && !personalSpace(),
    read: async () => {
      const [lines, sheets, cached] = await Promise.all([live('expenses'), live('sheets'), db.meta('rateCache')]);
      assertScopeCurrent();
      const s = settings(), field = s.tcmbField || 'ForexBuying';
      // A rate is still usable if its persistent device-cache write failed.
      const rates = { ...(cached?.field === field ? cached.byKey : {}), ...(rateCache.field === field ? rateCache.byKey : {}) };
      return { lines, sheets, settings: s, rates };
    },
    expense: openExpense,
    sheet: async (id, mode) => {
      await render(); assertScopeCurrent();
      if (!data.sheets.some(sheet => sheet.id === id)) throw Error('This sheet is no longer available. Reopen Review.');
      await setSheet(id);
      if (mode === 'ready') $('#exp-summary')?.scrollIntoView({ block: 'start' }); else openSheetsDialog();
    },
    retryRates: async lines => { assertScopeCurrent(); resetRateFailures(); await ensureRates(lines); assertScopeCurrent(); paint(['head', 'summary']); },
    reimbursements: ids => openReimbursements({ ids }),
    inbox: openInbox,
    settings: ctx.openSettings ? () => ctx.openSettings('expenses', 'expense-template') : null,
    onError: error => { if (scopeIsCurrent()) toast(error.message); },
  }, kind);
}

function openPersonalSheetsDialog() {
  const sheet = currentSheet(), title = el('input', { value: sheet.title }), newTitle = el('input', { value: '', placeholder: 'Collection name' }), status = el('p', { class: 'help', role: 'status' });
  const d = openDialog('Collections', el('div', { class: 'form' }, field('Current collection', title),
    el('button', { onclick: async () => { try { assertScopeCurrent(); if (!title.value.trim()) throw Error('Enter a collection name.'); await atomicBatchSave([{ table: 'sheets', record: { ...sheet, title: title.value.trim(), autoCreated: false }, expectedUpdatedAt: sheet.updated_at ?? null }], { label: 'Rename expense collection' }); await refresh(); scheduleSync(); d.close(); } catch (error) { status.textContent = error.message; } } }, 'Rename'),
    field('New collection', newTitle), el('button', { onclick: async () => { try { assertScopeCurrent(); if (!newTitle.value.trim()) throw Error('Enter a collection name.'); const added = await save('sheets', { title: newTitle.value.trim(), status: 'open', created_at: new Date().toISOString() }); await load(); await setSheet(added.id); scheduleSync(); d.close(); } catch (error) { status.textContent = error.message; } } }, 'Create collection'),
    el('div', { class: 'workflow-list' }, data.sheets.filter(s => s.id !== sheet.id).map(s => el('button', { onclick: async () => { await setSheet(s.id); d.close(); } }, s.title))), status));
}

function openPersonalTripDialog(existing = null) {
  const name = el('input', { value: existing?.name || '' }), start = el('input', { type: 'date', value: existing?.start || todayIso() }), end = el('input', { type: 'date', value: existing?.end || todayIso() }), status = el('p', { class: 'help', role: 'status' });
  const d = openDialog(existing ? 'Edit trip' : 'New trip', el('div', { class: 'form' }, field('Trip name', name), field('Start date', start), field('End date', end),
    el('button', { class: 'primary', onclick: async () => { try { assertScopeCurrent(); if (!name.value.trim() || !start.value || !end.value || end.value < start.value) throw Error('Enter a trip name and a valid date range.'); await atomicBatchSave([{ table: 'trips', record: { ...existing, name: name.value.trim(), start: start.value, end: end.value, days: Math.round((Date.parse(end.value) - Date.parse(start.value)) / 86400000) + 1, sheetId: state.sheetId, created_at: existing?.created_at || new Date().toISOString() }, expectedUpdatedAt: existing?.updated_at ?? null }], { label: 'Save personal trip' }); await refresh(); scheduleSync(); d.close(); } catch (error) { status.textContent = error.message; } } }, 'Save trip'), status));
}

function recent(key, limit = 8, extra = []) {
  const seen = new Set(extra.filter(Boolean));
  const out = [...extra.filter(Boolean)];
  for (const l of [...data.lines].sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))) {
    const v = (l[key] || '').trim();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
    if (out.length >= limit) break;
  }
  return out;
}

function shortNameSuggestions() {
  const s = settings();
  const out = new Set();
  for (const sh of data.sheets) if (sh.shortName) out.add(sh.shortName);
  for (const l of data.lines) if (l.shortName) out.add(l.shortName);
  for (const v of s.knownShortNames || []) out.add(v);
  for (const m of s.mapping || []) if (m.kind === 'project' && m.projectId && s.expenseActivitySuffix) out.add(`${m.projectId}.${s.expenseActivitySuffix}`);
  return [...out];
}

function chipRow(values, input, { label = 'Recent' } = {}) {
  if (!values.length) return null;
  return el('div', { class: 'chips small' }, el('span', { class: 'chips-label' }, label), values.map(v => el('button', { type: 'button', class: 'chip', onclick: () => { input.value = v; input.dispatchEvent(new Event('input')); input.focus(); } }, v)));
}

// Lines anywhere with the same date, amount and currency as the draft.
function duplicatesOf(draft) {
  const amt = Math.abs(Number(draft.amount));
  return data.lines.filter(l => l.id !== draft.id && l.date === draft.date && (l.currency || '').toUpperCase() === (draft.currency || '').toUpperCase() && Math.abs(Math.abs(Number(l.amount)) - amt) < 0.005);
}

function openLineDialog(line, prefill = null) {
  const s = settings();
  const sheet = currentSheet();
  const isNew = !line;
  const e = line ? { ...line } : { sheetId: sheet.id, date: todayIso(), amount: '', currency: s.defaultCurrency, code: personalSpace() ? s.expenseCodes[0]?.code : 7301, written: '', vendor: '', business: !personalSpace(), receipt: !personalSpace(), costObject: personalSpace() ? '' : s.costObjects[0] || '', tripId: '', ...(prefill || {}) };
  if (personalSpace()) { e.business = false; e.vendor = e.merchant ?? e.vendor ?? ''; e.written = e.note ?? e.written ?? ''; }
  let business = !!e.business, receipt = !!e.receipt, dupAccepted = false;
  const photos = photoIdsOf(e).map(id => ({ id, blob: null, isNew: false }));

  const amount = el('input', { type: 'number', 'aria-label': 'Amount', step: '0.01', inputmode: 'decimal', placeholder: '0.00', value: personalSpace() && e.amount !== '' ? Math.abs(Number(e.amount)) : e.amount, min: personalSpace() ? '0.01' : undefined, class: 'big', autofocus: true });
  const cur = el('select', { class: 'cur', 'aria-label': 'Currency' }, (personalSpace() ? [...new Set([...s.currencies, e.currency].filter(Boolean))] : s.currencies).map(c => el('option', { value: c, selected: c === e.currency }, c)));
  const direction = el('select', { 'aria-label': 'Transaction kind' }, [['purchase', 'Purchase'], ['refund', 'Refund']].map(([value, label]) => el('option', { value, selected: value === (isNew && e.kind === 'refund' || Number(e.amount) < 0 ? 'refund' : 'purchase') }, label)));
  const signedAmount = () => Number(String(amount.value).replace(',', '.')) * (personalSpace() && direction.value === 'refund' ? -1 : 1);
  const date = el('input', { type: 'date', value: e.date });
  const dateChips = el('div', { class: 'chips small' }, [['Today', todayIso()], ['Yesterday', shiftIso(todayIso(), -1)]].map(([l, v]) => el('button', { type: 'button', class: 'chip', onclick: () => { date.value = v; updateRef(); checkDup(); } }, l)));
  const code = el('select', {}, s.expenseCodes.map(c => el('option', { value: c.code, selected: String(c.code) === String(e.code) }, personalSpace() ? c.short : `${c.short}  (${c.code})`)));
  const categoryName = e.personalCategory || e.category || codeOf(e.code)?.short || s.expenseCodes[0]?.short || 'Other';
  const category = el('select', {}, [...new Set([...s.expenseCodes.map(c => c.short), ...data.lines.map(l => l.personalCategory).filter(Boolean), categoryName])].map(name => el('option', { value: name, selected: name === categoryName }, name)));
  const written = el('input', { type: 'text', value: e.written, placeholder: 'e.g. Gas, Dinner, Coffee', autocapitalize: 'sentences' });
  const vendor = el('input', { type: 'text', value: e.vendor, placeholder: 'e.g. Shell, Starbucks, hotel name' });
  const costObj = el('input', { type: 'text', value: e.costObject, placeholder: '/Personal 1' });
  const shortIn = el('input', { type: 'text', value: e.shortName || '', placeholder: sheet.shortName ? `same as the sheet: ${sheet.shortName}` : 'e.g. 210701.0105.0105-A', spellcheck: 'false', autocapitalize: 'off' });
  const shortField = field('Project short name', el('div', {}, shortIn, chipRow(shortNameSuggestions(), shortIn, { label: 'Choose' })), sheet.shortName ? 'Leave empty to use the sheet’s project. Fill it only when this line belongs to another project.' : 'The sheet has no project short name yet; set it under Sheets… or here for this line.');
  const trip = el('select', {}, el('option', { value: '' }, 'No trip'), data.trips.map(t => el('option', { value: t.id, selected: t.id === e.tripId }, t.name)));
  const sheetSel = el('select', {}, data.sheets.map(sh => el('option', { value: sh.id, selected: sh.id === e.sheetId }, `${sh.title}${sh.expenseId ? ' · IFS ' + sh.expenseId : ''}`)));
  const recChk = el('input', { type: 'checkbox', checked: receipt, onchange: ev => { receipt = ev.target.checked; updateRef(); } });
  const bizBtn = el('button', { type: 'button', class: 'seg' + (business ? ' on' : ''), onclick: () => setBiz(true) }, 'Business → IFS');
  const persBtn = el('button', { type: 'button', class: 'seg' + (!business ? ' on' : ''), onclick: () => setBiz(false) }, 'Personal');
  const bizHelp = el('small', { class: 'help' });
  const receiptRow = el('div', { class: 'row receipt-row' });
  const refLine = el('div', { class: 'ref-preview' });
  const dupBox = el('div', { class: 'dup-warn', hidden: true });
  const gallery = el('div', { class: 'gallery' });
  const ocrBox = el('div', { class: 'ocr-box', hidden: true });
  // Read amount, date and currency off a new photo and offer them; nothing is applied by itself.
  async function readPhoto(blob) {
    ocrBox.hidden = false;
    ocrBox.replaceChildren(el('span', { class: 'k' }, 'Reading the photo…'), el('span', { class: 'muted' }, 'first time downloads the text reader, a few MB'));
    try {
      const r = await readReceipt(blob, { onProgress: p => { const s = ocrBox.querySelector('.muted'); if (s) s.textContent = `${p}%`; } });
      const found = [];
      if (r.amount) found.push(el('button', { type: 'button', class: 'chip', onclick: () => { amount.value = r.amount; if (r.currency) cur.value = r.currency; checkDup(); } }, `Amount ${r.amount}${r.currency ? ' ' + r.currency : ''}`));
      if (r.date) found.push(el('button', { type: 'button', class: 'chip', onclick: () => { date.value = r.date; updateRef(); checkDup(); } }, `Date ${fmtDate(r.date)}`));
      for (const v of r.candidates.filter(v => v !== r.amount).slice(0, 3)) found.push(el('button', { type: 'button', class: 'chip', onclick: () => { amount.value = v; checkDup(); } }, String(v)));
      ocrBox.replaceChildren(el('span', { class: 'k' }, found.length ? 'From the photo, tap to use' : 'Nothing readable in the photo'), ...found, el('button', { type: 'button', class: 'link', onclick: () => { ocrBox.hidden = true; } }, 'hide'));
      if (found.length && r.amount && r.date && !Number(amount.value)) { amount.value = r.amount; if (r.currency) cur.value = r.currency; date.value = r.date; updateRef(); checkDup(); ocrBox.querySelector('.k').textContent = 'Filled from the photo, check it'; }
    } catch (e) { ocrBox.replaceChildren(el('span', { class: 'k' }, 'Could not read the photo'), el('span', { class: 'muted' }, e.message), el('button', { type: 'button', class: 'link', onclick: () => { ocrBox.hidden = true; } }, 'hide')); }
  }
  const photoIn = el('input', { type: 'file', accept: 'image/*', capture: 'environment', multiple: true, hidden: true, onchange: async ev => {
    const added = [];
    for (const f of ev.target.files) { const p = { id: uuid(), blob: await downscale(f), isNew: true }; photos.push(p); added.push(p); }
    ev.target.value = '';
    paintGallery();
    if (!receipt && photos.length) { receipt = true; recChk.checked = true; updateRef(); }
    if (added.length && (isNew || !Number(amount.value))) readPhoto(added[0].blob);
  } });
  const photoBtn = el('button', { type: 'button', onclick: () => photoIn.click() }, '📷 Add photo');
  const status = el('span', { class: 'help status' });
  const saveBtn = el('button', { class: 'primary', onclick: () => saveLine(false) }, isNew ? 'Add expense' : 'Save');

  function paintGallery() {
    gallery.replaceChildren(...photos.map(p => {
      const img = el('img', { alt: 'Receipt', hidden: !p.blob, onclick: () => { if (p.blob) openPhotoDialog(p.blob); } });
      const missing = el('span', { class: 'thumb-missing', hidden: !!p.blob }, el('b', {}, 'Photo not on this device'), el('small', {}, 'Looking for it…'), el('button', { type: 'button', class: 'link', onclick: () => { missing.querySelector('small').textContent = 'Looking for it…'; fetchIt(); } }, 'Retry'));
      const fetchIt = () => receiptBlob(supabaseClient(), p.id).then(b => {
        if (b) { p.blob = b; img.src = URL.createObjectURL(b); img.hidden = false; missing.hidden = true; }
        else missing.querySelector('small').textContent = receiptErrors.get(p.id) || 'Could not find it.';
      });
      if (p.blob) img.src = URL.createObjectURL(p.blob); else fetchIt();
      return el('span', { class: 'thumb' }, img, missing, el('button', { type: 'button', class: 'thumb-x', title: 'Remove photo', 'aria-label': 'Remove photo', onclick: () => { photos.splice(photos.indexOf(p), 1); paintGallery(); } }, '×'));
    }));
  }
  function setBiz(b) { business = personalSpace() ? false : b; b = business; bizBtn.classList.toggle('on', b); persBtn.classList.toggle('on', !b); bizHelp.textContent = b ? 'Exported to IFS with the reference shown below.' : 'Personal spending. Use a negative amount for a refund.'; receiptRow.hidden = false; recChk.closest('label').hidden = !b; shortField.hidden = !b; updateRef(); }
  function updateRef() {
    if (!business) { refLine.textContent = ''; refLine.hidden = true; return; }
    const draft = { ...e, id: e.id || '__draft', date: date.value, business: true, receipt, written: written.value.trim(), costObject: costObj.value.trim(), created_at: e.created_at || '9999' };
    const others = sheetLines().filter(l => l.id !== draft.id);
    const ref = numberReceipts([...others, draft]).get(draft.id);
    const project = shortIn.value.trim() || sheet.shortName || '';
    refLine.hidden = false;
    refLine.replaceChildren(el('span', { class: 'k' }, 'IFS reference: '), el('code', {}, referenceText(draft, ref)), el('span', { class: 'k' }, ' · project: '), project ? el('code', {}, project) : el('span', { class: 'warn-text' }, 'not set'));
  }
  function checkDup(resetAcceptance = true) {
    const amt = signedAmount();
    const dups = amt ? duplicatesOf({ id: e.id, date: date.value, amount: amt, currency: cur.value }) : [];
    if (resetAcceptance) { dupAccepted = false; saveBtn.textContent = isNew ? 'Add expense' : 'Save'; }
    if (!dups.length) { dupBox.hidden = true; return []; }
    dupBox.hidden = false;
    dupBox.replaceChildren(el('b', {}, 'Possible duplicate: '), dups.map(d => { const sh = data.sheets.find(x => x.id === d.sheetId); return `${d.written || codeOf(d.code)?.short || 'expense'} ${fmtMoney(d.amount, d.currency)} on ${fmtDate(d.date)}${!personalSpace() && sh && sh.id !== sheet.id ? ` (${sh.title})` : ''}`; }).join('; '), '. Press the button again to keep both.');
    return dups;
  }
  for (const i of [written, costObj, shortIn]) i.addEventListener('input', updateRef);
  date.addEventListener('change', () => { updateRef(); checkDup(); });
  amount.addEventListener('input', checkDup);
  cur.addEventListener('change', checkDup);
  direction.addEventListener('change', checkDup);
  receiptRow.append(el('label', { class: 'inline check' }, recChk, ' I have the receipt'), photoBtn, photoIn);
  paintGallery();

  let savingLine = false;
  const saveLine = async (andAnother = false) => {
    if (savingLine) return;
    let amt = signedAmount();
    if (personalSpace()) {
      try {
        const minor = minorAmount(amount.value);
        if (minor <= 0) throw Error('Enter a positive amount and choose Purchase or Refund.');
        amt = minor / 100 * (direction.value === 'refund' ? -1 : 1);
      } catch (error) { status.textContent = error.message; amount.focus(); return; }
    }
    if (!date.value) { status.textContent = 'Pick a date.'; return; }
    if (!amt) { status.textContent = 'Enter the amount (negative for a refund).'; amount.focus(); return; }
    if (checkDup(false).length && !dupAccepted) { dupAccepted = true; saveBtn.textContent = isNew ? 'Add anyway' : 'Save anyway'; status.textContent = 'Looks like a duplicate. Press again if it is a separate expense.'; return; }
    savingLine = true; saveBtn.disabled = true;
    try {
    assertScopeCurrent();
    const row = { ...e, sheetId: sheetSel.value || e.sheetId, date: date.value, amount: Math.round(amt * 100) / 100, currency: cur.value, code: Number(code.value), written: written.value.trim(), vendor: vendor.value.trim(), business, receipt: business ? receipt : false, costObject: costObj.value.trim(), shortName: business ? shortIn.value.trim() : '', tripId: trip.value || '', created_at: e.created_at || new Date().toISOString() };
    if (personalSpace()) {
      // Keep the signed amount as the shared calculation format; these fields preserve spending detail.
      row.personalCategory = category.value; row.code = Number(s.expenseCodes.find(c => c.short === category.value)?.code || e.code || s.expenseCodes[0]?.code);
      row.merchant = row.vendor; row.note = row.written; row.kind = row.amount < 0 ? 'refund' : 'purchase';
      row.costObject = ''; row.shortName = ''; row.tripId = ''; row.perdiem = false;
    }
    if (!business) { row.entered = false; row.enteredAt = ''; }
    validateExpenseChange(e, row);
    row.receiptIds = photos.map(p => p.id);
    delete row.receiptId;
    if (row.shortName && !(s.knownShortNames || []).includes(row.shortName)) { s.knownShortNames = [...(s.knownShortNames || []), row.shortName]; ctx.saveSettings(s); }
    if (row.costObject && !s.costObjects.includes(row.costObject)) { s.costObjects.push(row.costObject); ctx.saveSettings(s); }
    await atomicBatchSave([...photos.filter(p => p.isNew && p.blob).map(p => ({ table: 'receipts', record: { id: p.id, blob: p.blob, dirty: true }, expectedUpdatedAt: null })), { table: 'expenses', record: row, expectedUpdatedAt: isNew ? null : (e.updated_at ?? null) }], { label: isNew ? 'Add expense' : 'Edit expense' });
    d.close();
    toast(isNew ? 'Expense added' : 'Saved');
    await refresh(undefined, { entry: row });
    scheduleSync();
    if (andAnother) openLineDialog(null, { date: row.date, currency: row.currency, costObject: row.costObject, tripId: row.tripId, business: row.business, ...(personalSpace() ? { personalCategory: row.personalCategory, kind: row.kind } : {}) });
    } catch (error) { status.textContent = error.message; }
    finally { savingLine = false; if (saveBtn.isConnected) saveBtn.disabled = false; }
  };

  const noteField = field(personalSpace() ? 'Note' : 'Written expense', el('div', {}, written, chipRow(recent('written', 8, [codeOf(e.code)?.short]), written)), personalSpace() ? 'Optional details about this purchase or refund.' : 'Short text that goes to IFS inside the reference.');
  const merchantField = field(personalSpace() ? 'Merchant' : 'Explanation', el('div', {}, vendor, chipRow(recent('vendor'), vendor)), personalSpace() ? '' : 'Vendor or details for yourself. Stays in the app, never sent to IFS.');
  const body = el('div', { class: 'form' },
    el('span', { class: 'lbl' }, 'Amount'),
    el('div', { class: 'amount-row' }, amount, cur),
    personalSpace() ? field('Kind', direction, 'Enter the amount above as a positive number.') : el('small', { class: 'help' }, 'Positive for a purchase; negative for a refund.'),
    ocrBox,
    dupBox,
    field('Date', el('div', {}, date, dateChips)),
    field(personalSpace() ? 'Category' : 'Type', personalSpace() ? category : code, personalSpace() ? 'Used in spending reports and budgets.' : 'The IFS expense type. The number is the IFS expense code.'),
    personalSpace() ? null : el('div', { class: 'field' }, el('span', { class: 'lbl' }, 'Who pays'), el('div', { class: 'segs' }, bizBtn, persBtn), bizHelp),
    receiptRow,
    gallery,
    personalSpace() ? [merchantField, noteField] : [noteField, merchantField],
    personalSpace() ? null : el('details', { class: 'more-opts', open: !!(e.shortName || e.tripId || (e.costObject && e.costObject !== (s.costObjects[0] || ''))) },
      el('summary', {}, personalSpace() ? 'More: trip and collection' : 'More: cost object, project, trip' + (isNew ? '' : ', sheet')),
      personalSpace() ? null : field('Cost object', el('div', {}, costObj, chipRow([...new Set([...s.costObjects, ...recent('costObject')])], costObj, { label: 'Choose' })), 'The “Person” column of the workbook (/Personal 1, /16 QP 16). Part of the IFS reference.'),
      shortField,
      data.trips.length ? field('Trip', trip, 'Link the line to a trip to compare it with the per diem.') : null,
      isNew ? null : field(personalSpace() ? 'Collection' : 'Sheet', sheetSel, 'Change it to move this expense.')),
    refLine,
    e.entered && !personalSpace() ? el('p', { class: 'help' }, `This line is marked as entered in IFS (${fmtWhen(e.enteredAt)}). Changes here do not change IFS.`) : null,
    el('div', { class: 'actions' },
      saveBtn,
      isNew ? el('button', { onclick: () => saveLine(true) }, 'Add and next') : el('button', { onclick: () => { d.close(); openLineDialog(null, { ...e, id: undefined, receiptId: undefined, receiptIds: undefined, seq: undefined, created_at: undefined, perdiem: false, entered: false, enteredAt: '', reimbursement: undefined, recurringOccurrence: undefined, importKey: undefined, splitFrom: undefined }); } }, 'Add similar'),
      isNew ? null : el('button', { onclick: () => {
        const changedFields = signedAmount() !== Number(e.amount) || (personalSpace() && category.value !== categoryName) || cur.value !== e.currency || date.value !== e.date || written.value !== (e.written || '') || vendor.value !== (e.vendor || '') || costObj.value !== (e.costObject || '') || shortIn.value !== (e.shortName || '') || trip.value !== (e.tripId || '') || sheetSel.value !== e.sheetId || business !== !!e.business || receipt !== !!e.receipt || JSON.stringify(photos.map(p => p.id)) !== JSON.stringify(photoIdsOf(e));
        if (changedFields) { status.textContent = 'Save your edits before opening more actions.'; return; }
        d.close(); openExpenseTools(line);
      } }, 'More actions'),
      el('button', { onclick: () => d.close() }, 'Cancel'),
      isNew ? null : confirmButton('Delete', async () => { await softDelete('expenses', e.id); d.close(); toast('Deleted'); await refresh(); scheduleSync(); }),
      status));
  const d = openDialog(personalSpace() ? (isNew ? 'Add spending' : 'Edit spending') : (isNew ? 'New expense' : 'Edit expense'), body);
  setBiz(business);
  setTimeout(() => amount.focus(), 50);
}

function openIfsTextDialog(exp) {
  const pre = el('pre', {}, exp.text);
  const copy = el('button', { class: 'primary', onclick: async () => { try { await navigator.clipboard.writeText(exp.text); toast('Copied'); } catch { pre.focus(); const r = document.createRange(); r.selectNodeContents(pre); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); toast('Select all and copy by hand'); } } }, 'Copy');
  const home = homeCur();
  const rateRows = (exp.rates || []).filter(r => r.cur !== home);
  const rateTable = rateRows.length ? el('div', { class: 'tbl' }, el('table', { class: 'rates-tbl' }, el('thead', {}, el('tr', {}, ['Date', 'Currency', 'Rate', 'Source'].map(h => el('th', {}, h)))),
    el('tbody', {}, rateRows.map(r => el('tr', {}, el('td', {}, r.date), el('td', {}, r.cur), el('td', { class: 'num' }, r.rate ? String(r.rate) : '—'), el('td', {}, r.source === 'tcmb' ? `TCMB${r.usedDate && r.usedDate !== r.date ? ` (${r.usedDate})` : ''}` : r.source === 'manual' ? 'typed on the sheet' : r.source === 'fixed' ? 'fixed 1' : 'missing')))))) : null;
  openDialog('IFS text', el('div', {}, el('p', { class: 'help' }, `${exp.count} record${exp.count === 1 ? '' : 's'}. In IFS open the expense sheet, right-click inside the Expense Details grid → Edit → Paste Object, check the rows, then save.`), el('div', { class: 'actions' }, copy), pre, rateTable ? el('h4', {}, 'Rates used') : null, rateTable), { wide: true });
}

function openPhotoDialog(blob) {
  openDialog('Receipt', el('img', { class: 'photo-full', src: URL.createObjectURL(blob), alt: 'Receipt' }), { wide: true });
}

function openSheetsDialog() {
  const s = settings();
  const sheet = currentSheet();
  const lines = sheetLines();
  const home = homeCur();
  const title = el('input', { type: 'text', value: sheet.title, placeholder: 'September 2026' });
  const expId = el('input', { type: 'text', inputmode: 'numeric', value: sheet.expenseId, placeholder: 'e.g. 2345' });
  const statusSel = el('select', {}, [['open', 'Open – collecting expenses'], ['exported', 'Exported – copied to the clipboard'], ['entered', 'Entered – saved in IFS']].map(([v, l]) => el('option', { value: v, selected: sheet.status === v }, l)));
  const shortIn = el('input', { type: 'text', value: sheet.shortName || '', placeholder: '210701.0105.0105-A', spellcheck: 'false', autocapitalize: 'off' });

  const rates = { ...(sheet.rates || {}) };
  const rateCurrencies = [...new Set([...lines.filter(l => l.business).map(l => (l.currency || '').toUpperCase()), ...Object.keys(rates)])].filter(c => c && c !== home).sort();
  const rateHost = el('div', { class: 'rates' });
  const paintRates = () => rateHost.replaceChildren(...rateCurrencies.map(c => el('label', { class: 'rate' }, el('span', {}, `1 ${c} =`), el('input', { type: 'number', step: '0.000001', inputmode: 'decimal', value: rates[c] ?? '', placeholder: 'rate', oninput: e => { rates[c] = e.target.value.trim(); } }), el('span', {}, home))));
  paintRates();
  const addCur = el('select', {}, el('option', { value: '' }, 'Add a currency…'), s.currencies.filter(c => c !== home && !rateCurrencies.includes(c)).map(c => el('option', { value: c }, c)));
  addCur.addEventListener('change', () => { if (addCur.value) { rateCurrencies.push(addCur.value); rateCurrencies.sort(); paintRates(); addCur.value = ''; } });

  const saveBtn = el('button', { class: 'primary', onclick: async () => {
    const shortName = shortIn.value.trim();
    const cleanRates = {};
    for (const [c, v] of Object.entries(rates)) if (Number(v) > 0) cleanRates[c] = Number(v);
    const patch = { ...sheet, title: title.value.trim() || sheet.title, expenseId: expId.value.trim(), status: statusSel.value, shortName, rates: cleanRates };
    if (statusSel.value === 'entered' && !sheet.enteredAt) patch.enteredAt = new Date().toISOString();
    await save('sheets', patch);
    if (shortName && !(s.knownShortNames || []).includes(shortName)) { s.knownShortNames = [...(s.knownShortNames || []), shortName]; ctx.saveSettings(s); }
    d.close(); toast('Sheet saved'); await refresh(); scheduleSync();
  } }, 'Save');
  const delBtn = confirmButton(lines.length ? `Delete sheet and its ${lines.length} line${lines.length === 1 ? '' : 's'}` : 'Delete sheet', async () => {
    for (const l of lines) await softDelete('expenses', l.id);
    await softDelete('sheets', sheet.id);
    state.sheetId = null; d.close(); toast('Sheet deleted'); await refresh(); paintAll(); scheduleSync();
  });

  const importArea = el('textarea', { rows: 4, placeholder: 'Select the rows in the IFS Expense Details grid, right-click → Edit → Copy Object, paste here…', spellcheck: 'false' });
  const importStatus = el('span', { class: 'help status' });
  const importBtn = el('button', { onclick: async () => {
    const recs = parseCopyObjects(importArea.value);
    const { lines: found, expenseId, shortName } = linesFromIfsRecords(recs);
    if (!found.length) { importStatus.textContent = recs.length ? `No Expense Details rows found (${recs.length} record${recs.length === 1 ? '' : 's'} of another type).` : 'That does not look like an IFS Copy Object text.'; return; }
    let added = 0, skipped = 0;
    const existing = sheetLines();
    const dup = n => existing.some(l => l.date === n.date && Math.abs(Number(l.amount) - n.amount) < 0.005 && (l.currency || '').toUpperCase() === n.currency.toUpperCase() && (l.written || '').trim().toLowerCase() === n.written.toLowerCase());
    const base = Date.now();
    for (const n of found) {
      if (dup(n)) { skipped++; continue; }
      const { ifsReceiptNo, ...row } = n;
      await save('expenses', { ...row, sheetId: sheet.id, tripId: '', shortName: row.shortName && row.shortName !== (shortIn.value.trim() || sheet.shortName) ? row.shortName : '', costObject: row.costObject || (s.costObjects[0] || ''), created_at: new Date(base + added * 1000).toISOString() });
      added++;
    }
    const patch = {};
    if (!expId.value.trim() && expenseId) { expId.value = expenseId; patch.expenseId = expenseId; }
    if (!shortIn.value.trim() && shortName) { shortIn.value = shortName; patch.shortName = shortName; }
    if (Object.keys(patch).length) await save('sheets', { ...sheet, ...patch });
    importStatus.textContent = `Imported ${added} line${added === 1 ? '' : 's'} as entered in IFS${skipped ? `, skipped ${skipped} already on the sheet` : ''}.`;
    importArea.value = '';
    await refresh(); scheduleSync();
  } }, 'Import lines');

  const others = data.sheets.filter(x => x.id !== sheet.id).map(x => {
    const n = data.lines.filter(l => l.sheetId === x.id).length;
    return el('div', { class: 'sheet-row' }, el('span', {}, el('b', {}, x.title), el('small', {}, `${x.expenseId ? 'IFS ' + x.expenseId : 'no IFS ID'} · ${x.status} · ${n} line${n === 1 ? '' : 's'}`)), el('button', { onclick: async () => { d.close(); await setSheet(x.id); } }, 'Open'));
  });
  const newBtn = el('button', { onclick: async () => { const t = monthTitle(todayIso()); const sh = await save('sheets', { title: data.sheets.some(x => x.title === t) ? t + ' (2)' : t, expenseId: '', status: 'open', created_at: new Date().toISOString() }); d.close(); await load(); await setSheet(sh.id); openSheetsDialog(); } }, '+ New sheet');
  const rateHelp = s.rateSource === 'manual'
    ? 'Manual mode: type the rate IFS uses for each currency; every exported line of that currency carries it.'
    : 'Rates are normally fetched per line date from the Central Bank (TCMB) through the PC server. A rate typed here is used only for dates that could not be fetched.';
  const d = openDialog('Sheets', el('div', { class: 'form' },
    el('p', { class: 'help' }, 'One sheet here is one expense sheet in IFS. Usually one per month.'),
    field('Current sheet', title),
    field('IFS Expense ID', expId, 'The number IFS gave the sheet. It goes into every exported row, so set it before Copy for IFS.'),
    field('Project short name', el('div', {}, shortIn, chipRow(shortNameSuggestions(), shortIn, { label: 'Choose' })), 'PROJECT.SUBPROJECT.ACTIVITY of the project’s expense activity, e.g. 210701.0105.0105-A. Written into every exported row so you no longer type it in IFS.'),
    field('Status', statusSel, 'Open → Exported when you copy → Entered when it is saved in IFS.'),
    el('details', { class: 'more-opts', open: Object.keys(sheet.rates || {}).length > 0 }, el('summary', {}, `Fallback currency rates (${home} per 1 unit)`),
      rateHost, el('div', { class: 'row' }, addCur), el('small', { class: 'help' }, rateHelp)),
    el('div', { class: 'actions' }, saveBtn, el('button', { onclick: () => d.close() }, 'Cancel'), delBtn),
    el('details', { class: 'more-opts' }, el('summary', {}, 'Import lines from IFS'),
      el('p', { class: 'help' }, 'Brings rows that already exist in IFS into this sheet as business lines marked “In IFS”: date, type, written text, cost object, currency, amount and receipt order. Lines already here (same date, amount, currency and text) are skipped.'),
      importArea, el('div', { class: 'row' }, importBtn, importStatus)),
    el('div', { class: 'section-head' }, el('h4', {}, 'Other sheets'), newBtn),
    others.length ? el('div', { class: 'sheet-list' }, others) : el('p', { class: 'empty' }, 'No other sheets.')), { wide: true });
}

function openTripDialog(trip) {
  const s = settings();
  const sheet = currentSheet();
  const isNew = !trip;
  const defaults = s.perDiemDefaults || [];
  const t = trip ? { ...trip } : { name: '', country: '', start: todayIso(), end: todayIso(), rate: '', currency: 'USD', days: '', sheetId: sheet.id };
  const name = el('input', { type: 'text', value: t.name, placeholder: 'e.g. Amrize September' });
  const countries = [...new Set([...defaults.map(d => d.country), ...data.trips.map(x => x.country)].filter(Boolean))];
  const country = el('input', { type: 'text', value: t.country, placeholder: 'USA', list: 'dl-countries' });
  const rate = el('input', { type: 'number', step: '0.01', inputmode: 'decimal', value: t.rate, placeholder: '0.00' });
  const cur = el('select', { class: 'cur' }, s.currencies.map(c => el('option', { value: c, selected: c === t.currency }, c)));
  const rateHint = el('small', { class: 'help' }, 'Creates the per diem line (code 3351) on the sheet: days × rate.');
  const applyDefault = () => {
    const d = defaults.find(x => x.country.toLowerCase() === country.value.trim().toLowerCase());
    if (d && (!Number(rate.value) || isNew)) { rate.value = d.rate; cur.value = d.currency; rateHint.textContent = `Filled from your default for ${d.country}: ${d.rate} ${d.currency} per day. Change it here if this trip differs.`; }
  };
  country.addEventListener('change', applyDefault);
  country.addEventListener('input', () => { if (defaults.some(x => x.country.toLowerCase() === country.value.trim().toLowerCase())) applyDefault(); });
  const start = el('input', { type: 'date', value: t.start });
  const end = el('input', { type: 'date', value: t.end });
  const days = el('input', { type: 'number', step: '0.5', value: t.days, placeholder: 'from the dates' });
  const sheetSel = el('select', {}, data.sheets.map(sh => el('option', { value: sh.id, selected: sh.id === t.sheetId }, sh.title)));
  const status = el('span', { class: 'help status' });
  const calcDays = () => (start.value && end.value) ? Math.max(0, Math.round((new Date(end.value) - new Date(start.value)) / 86400000) + 1) : 0;
  const saveBtn = el('button', { class: 'primary', onclick: async () => {
    if (!name.value.trim()) { status.textContent = 'Give the trip a name.'; return; }
    const dcount = Number(days.value) || calcDays();
    const row = await save('trips', { ...t, name: name.value.trim(), country: country.value.trim(), start: start.value, end: end.value, rate: Number(rate.value) || 0, currency: cur.value, days: dcount, sheetId: sheetSel.value, created_at: t.created_at || new Date().toISOString() });
    // remember the rate for this country
    if (row.country && row.rate > 0) {
      const i = defaults.findIndex(x => x.country.toLowerCase() === row.country.toLowerCase());
      const entry = { country: row.country, rate: row.rate, currency: row.currency };
      if (i >= 0) defaults[i] = entry; else defaults.push(entry);
      s.perDiemDefaults = defaults; ctx.saveSettings(s);
    }
    const existing = data.lines.find(l => l.tripId === row.id && l.perdiem);
    const amount = Math.round(dcount * (row.rate || 0) * 100) / 100;
    if (amount > 0) await save('expenses', { ...(existing || { created_at: new Date().toISOString() }), sheetId: row.sheetId, date: row.end || row.start, amount, currency: row.currency, code: s.perDiemCode, written: 'Per diem', vendor: `${row.name}: ${dcount} days × ${row.rate}`, business: true, receipt: false, costObject: existing?.costObject || (s.costObjects[0] || ''), tripId: row.id, perdiem: true });
    else if (existing) await softDelete('expenses', existing.id);
    d.close(); toast(isNew ? 'Trip added' : 'Trip saved'); await refresh(); scheduleSync();
  } }, isNew ? 'Add trip' : 'Save');
  const d = openDialog(isNew ? 'New trip' : 'Edit trip', el('div', { class: 'form' },
    field('Name', name),
    el('div', { class: 'grid2' }, field('Country', el('div', {}, country, chipRow(countries, country, { label: 'Known' })), defaults.length ? `Defaults: ${defaults.map(x => `${x.country} ${x.rate} ${x.currency}`).join(', ')}` : 'The rate you type is remembered for this country.'), field('Sheet', sheetSel, 'Where the per diem line is created.')),
    el('div', { class: 'grid2' }, field('From', start), field('To', end)),
    el('div', { class: 'grid2' }, el('label', { class: 'field' }, el('span', { class: 'lbl' }, 'Daily per diem'), el('div', { class: 'amount-row' }, rate, cur), rateHint), field('Days', days, 'Leave empty to count the dates.')),
    el('datalist', { id: 'dl-countries' }, countries.map(c => el('option', { value: c }))),
    el('div', { class: 'actions' }, saveBtn, el('button', { onclick: () => d.close() }, 'Cancel'),
      isNew ? null : confirmButton('Delete trip', async () => { const pd = data.lines.find(l => l.tripId === t.id && l.perdiem); if (pd) await softDelete('expenses', pd.id); await softDelete('trips', t.id); d.close(); toast('Trip deleted. Its other lines stay.'); await refresh(); scheduleSync(); }),
      status)));
  if (isNew) applyDefault();
}

// ---------- backup / export (used from Settings) ----------
export async function exportCsv() {
  await load();
  const sheetOf = id => data.sheets.find(s => s.id === id);
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Sheet', 'IFS Expense ID', 'Project short name', 'Receipt no', 'Date', 'Type', 'Code', 'Written', 'Explanation', 'Cost object', 'Currency', 'Amount', 'Business', 'Receipt', 'In IFS', 'Photos', 'Trip', 'Per diem']];
  const refsBySheet = new Map(data.sheets.map(s => [s.id, numberReceipts(data.lines.filter(l => l.sheetId === s.id))]));
  for (const l of [...data.lines].sort(lineOrder)) {
    const sh = sheetOf(l.sheetId), tr = data.trips.find(t => t.id === l.tripId);
    const ref = refsBySheet.get(l.sheetId)?.get(l.id);
    rows.push([sh?.title, sh?.expenseId, l.shortName || sh?.shortName, l.business && l.receipt ? ref : '', l.date, codeOf(l.code)?.short, l.code, l.written, l.vendor, l.costObject, l.currency, l.amount, l.business ? 'yes' : 'no', l.receipt ? 'yes' : 'no', l.entered ? (l.enteredAt || 'yes') : 'no', photoIdsOf(l).length, tr?.name, l.perdiem ? 'yes' : 'no']);
  }
  download(`expenses-${todayIso()}.csv`, '﻿' + rows.map(r => r.map(esc).join(';')).join('\r\n'), 'text/csv');
}

// Full backup: settings (with the Clockify and Supabase keys) and every table.
export async function backupJson() {
  const all = await snapshot();
  all.receipts = await db.all('receipts');
  // JSON cannot store Blobs. Encode photos, including snapshots in undo history,
  // so a downloaded backup does not silently lose them.
  const encoded = await encodeBackupValue(all); assertScopeCurrent();
  download(`ifs-bridge-${currentScope().workspace}-backup-${todayIso()}.json`, JSON.stringify(encoded, null, 1), 'application/json');
}

export async function restoreJson(text) {
  const obj = JSON.parse(text);
  assertBackupScope(obj); assertScopeCurrent();
  const decoded = decodeBackupValue(obj);
  let n = await restoreSnapshot(decoded);
  for (const receipt of decoded.receipts || []) {
    assertScopeCurrent();
    if (!receipt?.id || !(receipt.blob instanceof Blob)) continue;
    const current = await db.get('receipts', receipt.id); assertScopeCurrent();
    if (current?.blob && Date.parse(current.updated_at || 0) > Date.parse(receipt.updated_at || 0)) continue;
    await db.put('receipts', { ...receipt, dirty: true, pc: false, pcScope: '' }); n++;
  }
  await refresh();
  scheduleSync();
  return n;
}

async function encodeBackupValue(value) {
  if (value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer()); let binary = '';
    for (let i = 0; i < bytes.length; i += 32768) binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
    return { __ifsBlob: btoa(binary), type: value.type || 'application/octet-stream' };
  }
  if (Array.isArray(value)) return Promise.all(value.map(encodeBackupValue));
  if (value && typeof value === 'object') { const pairs = await Promise.all(Object.entries(value).map(async ([key, v]) => [key, await encodeBackupValue(v)])); return Object.fromEntries(pairs); }
  return value;
}
function decodeBackupValue(value) {
  if (value && typeof value === 'object' && typeof value.__ifsBlob === 'string') {
    const binary = atob(value.__ifsBlob), bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
    return new Blob([bytes], { type: typeof value.type === 'string' ? value.type : 'application/octet-stream' });
  }
  if (Array.isArray(value)) return value.map(decodeBackupValue);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, decodeBackupValue(v)]));
  return value;
}

// ---------- helpers ----------
async function downscale(file, max = 1600, quality = 0.82) {
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale); canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return await new Promise(res => canvas.toBlob(res, 'image/jpeg', quality));
  } catch { return file; }
}
