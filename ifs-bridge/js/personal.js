// A continuous personal ledger. Months and filters are views, never separate projects.
import { live, db } from './db.js';
import { currentScope, scopeIsCurrent } from './scope.js';
import { el, download, toast, openDialog } from './dom.js';
import { preparePersonalExpenses, openNewExpense, openExpense, supabaseClient, scheduleSync } from './expenses.js';
import { openExpenseTools, openInbox, openBudgets } from './expense-tools.js';
import { openActivity } from './workspace-ui.js';
import { analyzePersonalMonth, exportPersonalMonthCsv } from './personal-analytics.js';
import { renderPersonalStudy, analyzePersonalStudy } from './personal-study.js';
import { filterPersonalViewRows, hasPersonalFilters, effectiveSpendingPurpose } from './personal-filters.js';
import { openBankImport, openBankTransaction } from './bank-ui.js';
import { openWorkExpenseReview } from './work-match-ui.js';
import { createWorkReconciler, matchImportedWorkPurchases } from './work-reconcile.js';
import { readOnlyWorkContext } from './work-context.js';
import { combineSpendingRows } from './spending-ledger.js';

let ctx, preparation, host, view = 'overview', requestId = 0;
let personalSession = 0, workReconciler, matching = false, matchStatus = null;
let records = [], budgets = [], inboxCount = 0, conflictCount = 0;
let workSnapshot = null, ledger = { warnings: [], possibleDuplicates: [] }, workCoverage = null, importReceipt = null;
let dataSnapshot = null, dataLoaded = false, paintedSession = 0;
const filterLabels = new Map();
const state = { month: '', currency: '', filters: {}, page: 1, excludeCompany: false, excludeTrips: false };
const PAGE_SIZE = 25;
const validMonth = month => /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && Number(month.slice(0, 4)) >= 1000;
const today = () => ctx.today?.() || new Intl.DateTimeFormat('en-CA', { timeZone: ctx.settings().timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const monthLabel = month => new Date(month + '-01T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', month: 'long', year: 'numeric' });
const dateLabel = date => new Date(date + 'T12:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', day: 'numeric', month: 'short' });
const cash = (minor, currency = state.currency) => new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(minor / 100);
const button = (text, run, attrs = {}) => el('button', { type: 'button', onclick: run, ...attrs }, text);
function choice(label, values, value, run) {
  const input = el('select', { 'aria-label': label, onchange: () => run(input.value) }, values.map(([key, text]) => el('option', { value: key, selected: key === value }, text)));
  return input;
}
function act(run) {
  return async () => {
    const session = personalSession;
    try { if (!scopeIsCurrent()) return; await run(); }
    catch (error) { if (session === personalSession && scopeIsCurrent()) toast(error.message || 'Could not finish. Please try again.', 5000); }
  };
}
export function initPersonal(context) {
  ++requestId;
  ++personalSession;
  workReconciler?.dispose();
  matching = false; matchStatus = null; workSnapshot = null; workCoverage = null; importReceipt = null;
  ledger = { warnings: [], possibleDuplicates: [] };
  dataSnapshot = null; dataLoaded = false; paintedSession = 0; filterLabels.clear();
  ctx = context;
  preparation = null; records = []; budgets = []; state.filters = {}; state.page = 1;
  state.excludeCompany = false; state.excludeTrips = false;
  state.month = today().slice(0, 7);
  state.currency = ctx.settings().defaultCurrency || 'TRY';
  const session = personalSession;
  workReconciler = createWorkReconciler({ onStatus: status => {
    if (session !== personalSession || !scopeIsCurrent()) return;
    matchStatus = status; paintMatchStatus();
  } });
}
// The navigation controller keeps these choices in memory, never records or credentials.
export function capturePersonalView() {
  return { month: state.month, currency: state.currency, filters: { ...state.filters }, page: state.page,
    excludeCompany: state.excludeCompany, excludeTrips: state.excludeTrips };
}
export function restorePersonalView(snapshot) {
  if (!scopeIsCurrent() || currentScope().workspace !== 'personal' || !snapshot || typeof snapshot !== 'object') return false;
  if (!validMonth(snapshot.month) || !/^[A-Z]{3}$/.test(snapshot.currency || '')) return false;
  const filters = {};
  for (const key of ['category', 'merchant', 'kind', 'purpose', 'card', 'search', 'date']) {
    const value = snapshot.filters?.[key];
    if (typeof value !== 'string' || value.length > 500) continue;
    if (key === 'kind' && !['', 'purchase', 'refund'].includes(value)) continue;
    if (key === 'purpose' && !['', 'all', 'personal', 'business', 'review'].includes(value)) continue;
    if (key === 'date' && value) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.slice(0, 7) !== snapshot.month) continue;
      const [year, month, day] = value.split('-').map(Number);
      if (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate()) continue;
    }
    filters[key] = value;
  }
  Object.assign(state, { month: snapshot.month, currency: snapshot.currency, filters,
    page: Number.isSafeInteger(snapshot.page) && snapshot.page > 0 ? Math.min(snapshot.page, 100000) : 1,
    excludeCompany: snapshot.excludeCompany === true, excludeTrips: snapshot.excludeTrips === true });
  return true;
}
function changedView() { ctx.onViewChange?.(capturePersonalView()); }
function resetFilters() {
  if (!scopeIsCurrent()) return;
  state.filters = {}; state.excludeCompany = false; state.excludeTrips = false; state.page = 1;
  changedView(); return renderPersonal(host, view);
}
export function refreshPersonal(change) {
  if (!scopeIsCurrent() || currentScope().workspace !== 'personal') return;
  // Refreshes reload Work once; changing a view or filter reuses the same snapshot.
  workSnapshot = null;
  dataSnapshot = null; dataLoaded = false;
  // Keep a saved purchase visible when its date/currency moves outside this view.
  if (change?.entry && validMonth(String(change.entry.date || '').slice(0, 7)) && /^[A-Z]{3}$/.test(change.entry.currency || '')) {
    state.month = change.entry.date.slice(0, 7); state.currency = change.entry.currency;
    state.filters = {}; state.page = 1;
  }
  if (host?.isConnected && !host.hidden && currentScope().workspace === 'personal') return renderPersonal(host, view);
}
function includedRows() {
  return records.filter(row => !(state.excludeCompany && row.ledgerWork) && !(state.excludeTrips && row.ledgerTrip));
}
function loadWorkSnapshot() {
  workSnapshot ||= Promise.resolve().then(() => readOnlyWorkContext()).catch(() => ({
    expenses: [], sheets: [], trips: [], source: 'unavailable',
    notice: 'Work could not be loaded. Your Personal records are still shown; the combined total is incomplete. Use Refresh all spending to try again.',
  }));
  return workSnapshot;
}
function analysis() {
  const rows = includedRows();
  const complete = workCoverage?.source === 'cloud' && !workCoverage.notice;
  // Possible overlap is different from a failed load. Keep totals provisional
  // without incorrectly telling the user that their records are missing.
  const comparisonBlockedReason = ledger.possibleDuplicates?.length ? 'Comparisons are paused while possible duplicate spending remains unresolved.' : '';
  const options = { month: state.month, today: today(), currency: state.currency, categories: ctx.settings().expenseCodes, complete, comparisonBlockedReason };
  const full = analyzePersonalMonth(rows, options);
  const chosen = analyzePersonalMonth(filterPersonalViewRows(rows, state.filters, options.categories), options);
  return { ...chosen, totalEntryCount: full.entries.length, filterOptions: full, currencyTotals: full.currencyTotals,
    comparison: hasPersonalFilters(state.filters) ? { available: false, reason: 'Clear filters to compare the full recorded months.' } : chosen.comparison };
}
function navigateTransactions(filters = {}) {
  if (!scopeIsCurrent()) return;
  state.filters = { ...state.filters, ...filters }; state.page = 1;
  if (ctx.navigateView) ctx.navigateView('transactions');
  else if (ctx.navigateTransactions) ctx.navigateTransactions();
  else renderPersonal(host, 'transactions');
}
function setMonth(value) {
  if (!scopeIsCurrent() || !validMonth(value)) return false;
  // A selected chart day follows the same day number; short months use their last day.
  if (/^\d{4}-\d{2}-\d{2}$/.test(state.filters.date || '')) {
    const [year, month] = value.split('-').map(Number);
    const day = Math.min(Number(state.filters.date.slice(-2)), new Date(Date.UTC(year, month, 0)).getUTCDate());
    state.filters.date = `${value}-${String(day).padStart(2, '0')}`;
  }
  state.month = value; state.page = 1; changedView();
  renderPersonal(host, view);
}
function shiftMonth(offset) {
  const [year, month] = state.month.split('-').map(Number);
  setMonth(new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 7));
}
function setCurrency(currency) {
  if (!scopeIsCurrent() || !/^[A-Z]{3}$/.test(currency || '')) return;
  state.currency = currency; state.page = 1; changedView();
  renderPersonal(host, view);
}
function newEntry() {
  const date = state.month === today().slice(0, 7) ? today() : state.month + '-01';
  return openNewExpense({ date, currency: state.currency });
}
async function importBank() {
  const session = personalSession, settings = ctx.settings;
  const isCurrent = () => session === personalSession && scopeIsCurrent();
  const sheet = await preparation;
  if (!isCurrent()) return;
  return openBankImport({ settings, sheet,
    matchWork: request => {
      const importIsCurrent = () => isCurrent() && (typeof request.isCurrent !== 'function' || request.isCurrent());
      if (!importIsCurrent()) throw Error('This bank import is no longer active. Open bank import again.');
      return matchImportedWorkPurchases({ ...request, isCurrent: importIsCurrent });
    },
    onChange: change => {
      if (!isCurrent()) return;
      if (change?.matchMessage) matchStatus = { state: change.matched ? 'matched' : 'complete', message: change.matchMessage, matched: change.matched || 0 };
      if (change?.importSummary) {
        importReceipt = { ...change.importSummary };
        const months = (importReceipt.months || []).filter(validMonth).sort();
        const latest = months.at(-1);
        const refreshed = { ...change };
        if (latest && (!change.entry || latest !== String(change.entry.date || '').slice(0, 7))) {
          refreshed.entry = { date: latest + '-01', currency: change.entry?.currency || state.currency };
        }
        // Finishing import brings the answers into view, even when it began in Transactions.
        workSnapshot = null; dataSnapshot = null; dataLoaded = false; state.filters = {}; state.page = 1;
        if (refreshed.entry && validMonth(String(refreshed.entry.date || '').slice(0, 7))) state.month = refreshed.entry.date.slice(0, 7);
        if (/^[A-Z]{3}$/.test(refreshed.entry?.currency || '')) state.currency = refreshed.entry.currency;
        return ctx.navigateView ? ctx.navigateView('overview') : renderPersonal(host, 'overview');
      }
      return refreshPersonal(change);
    },
    sync: () => { if (isCurrent()) scheduleSync(); },
  });
}
function reviewBank() {
  const session = personalSession;
  const isCurrent = () => session === personalSession && scopeIsCurrent();
  return openWorkExpenseReview({ month: state.month, onChange: change => { if (isCurrent()) return refreshPersonal(change); }, sync: () => { if (isCurrent()) scheduleSync(); } });
}
function paintMatchStatus() {
  if (!host?.isConnected || !scopeIsCurrent()) return;
  const status = host.querySelector('[data-work-match-status]');
  if (status) { status.textContent = matchStatus?.message || ''; status.hidden = !matchStatus?.message; }
  const action = host.querySelector('[data-match-with-work]');
  if (action) { action.disabled = matching; action.textContent = matching ? 'Checking Work…' : 'Match with Work'; }
}
async function matchWithWork() {
  if (matching || !scopeIsCurrent()) return;
  const session = personalSession, reconciler = workReconciler;
  const isCurrent = () => session === personalSession && scopeIsCurrent();
  matching = true;
  matchStatus = { state: 'checking', message: 'Checking this month’s card purchases against your Work expenses…' };
  paintMatchStatus();
  try {
    const result = await reconciler.run({ month: state.month });
    if (!isCurrent()) return;
    matchStatus = result;
    if (result.matched > 0) { scheduleSync(); await refreshPersonal(); }
  } catch (error) {
    if (isCurrent()) matchStatus = { state: 'error', message: error.message || 'Work matching could not finish. Try again.' };
  } finally {
    if (isCurrent()) { matching = false; paintMatchStatus(); }
  }
}
export function reviewPersonal(kind = 'bank') { if (currentScope().workspace === 'personal') return act(kind === 'inbox' ? openInbox : reviewBank)(); }
function editEntry(entry) {
  const row = entry.source || entry;
  if (row.ledgerReadOnly || row.sourceWorkspace === 'work') {
    if (!scopeIsCurrent()) return;
    if (ctx.openWorkExpense) return ctx.openWorkExpense(row.workSourceId);
    const amount = Number(row.amount), currency = /^[A-Z]{3}$/.test(row.currency || '') ? row.currency : state.currency;
    const minor = Number.isSafeInteger(entry.signedMinor) ? entry.signedMinor : Number.isSafeInteger(row.amountMinor)
      ? (row.kind === 'refund' ? -Math.abs(row.amountMinor) : row.amountMinor) : Number.isFinite(amount) ? Math.round(amount * 100) : null;
    return openDialog('Recorded in Work', el('div', {},
      el('p', {}, row.merchant || row.vendor || row.written || 'Work expense'),
      el('p', {}, `${row.date || ''} · ${minor == null ? 'Amount unavailable' : cash(minor, currency)}`),
      row.ledgerTripName ? el('p', {}, 'Trip: ' + row.ledgerTripName) : null,
      el('p', {}, 'This is the original Work expense shown in your spending. Edit it in Work; it has not been copied into Personal.')));
  }
  return row.bankTransaction ? openBankTransaction(row.id, { settings: ctx.settings, onChange: refreshPersonal, sync: scheduleSync }) : openExpense(row.id);
}
function exportMonth() {
  const csv = exportPersonalMonthCsv(includedRows(), { month: state.month, categories: ctx.settings().expenseCodes });
  download(`personal-spending-${state.month}.csv`, csv, 'text/csv;charset=utf-8');
  toast('Exported this month in all currencies, using the company and trip exclusions above. Other filters do not change the month export.');
}

export async function renderPersonal(root, nextView = 'overview') {
  if (currentScope().workspace !== 'personal' || !scopeIsCurrent()) return;
  if (host && host !== root) host.replaceChildren();
  host = root; view = ['overview', 'transactions', 'study'].includes(nextView) ? nextView : 'overview';
  const ticket = ++requestId;
  const focused = root.contains(document.activeElement) ? document.activeElement : null;
  const focusLabel = focused?.getAttribute('aria-label');
  const selection = focused?.tagName === 'INPUT' && focused.type === 'search' ? [focused.selectionStart, focused.selectionEnd] : null;
  root.classList.add('personal-page'); root.setAttribute('aria-busy', 'true');
  if (paintedSession !== personalSession) root.replaceChildren(el('p', { class: 'empty', role: 'status' }, 'Loading monthly spending…'));
  try {
    // Prepare the shared editor without painting its work-oriented page.
    const session = personalSession;
    preparation ||= preparePersonalExpenses({ onChange: change => { if (session === personalSession && scopeIsCurrent()) return refreshPersonal(change); } }).catch(error => { if (session === personalSession) preparation = null; throw error; });
    if (!dataLoaded) {
      // Month, currency and filter changes are local views of one loaded ledger.
      // A save, import or explicit refresh invalidates it and reads fresh records.
      if (!dataSnapshot) {
        const pending = preparation.then(() => {
          if (session !== personalSession || !scopeIsCurrent()) return null;
          return Promise.all([live('expenses'), live('inbox'), db.all('conflicts'), live('budgets'), loadWorkSnapshot()]);
        });
        dataSnapshot = pending;
        pending.catch(() => { if (dataSnapshot === pending) dataSnapshot = null; });
      }
      const loaded = await dataSnapshot;
      if (!loaded || ticket !== requestId || session !== personalSession || !scopeIsCurrent()) return;
      workCoverage = loaded[4];
      try { ledger = combineSpendingRows(loaded[0], workCoverage); }
      catch {
        // Invalid Work data must not take the usable Personal ledger away.
        ledger = combineSpendingRows(loaded[0], { expenses: [], trips: [], sheets: [] });
        workCoverage = { source: 'unavailable', notice: 'Work records could not be combined. Your Personal records are shown; the combined total is incomplete. Use Refresh all spending to try again.' };
      }
      records = ledger.rows;
      budgets = loaded[3];
      inboxCount = loaded[1].filter(item => !['created', 'matched', 'done', 'imported'].includes(item.status)).length;
      conflictCount = loaded[2].length;
      dataLoaded = true;
    }
    const model = analysis();
    state.currency = model.currency;
    root.replaceChildren(toolbar(model), spendingScope(), sharedFilters(model));
    if (importReceipt) root.append(importSummaryPanel());
    const coverageWarnings = [...(ledger.warnings || [])];
    if (workCoverage?.source !== 'cloud') coverageWarnings.unshift(workCoverage?.notice || 'Work is available only from this device. The combined view may be incomplete.');
    else if (workCoverage.notice) coverageWarnings.unshift(workCoverage.notice);
    if (coverageWarnings.length) root.append(el('div', { class: 'personal-warning', role: 'status', 'data-spending-coverage': '' }, ...[...new Set(coverageWarnings)].map(text => el('p', {}, text))));
    if (model.warnings?.length) root.append(el('div', { class: 'personal-warning', role: 'alert' }, ...model.warnings.map(text => el('p', {}, text))));
    if (view === 'study') root.append(renderPersonalStudy({ rows: includedRows(), month: state.month, currency: state.currency,
      categories: ctx.settings().expenseCodes, budgets, filters: state.filters, sharedFilters: true,
      onFiltersChange: change => { if (scopeIsCurrent()) { state.filters = { ...state.filters, ...change }; state.page = 1; changedView(); renderPersonal(host, view); } },
      onOpenEntry: entry => act(() => editEntry(entry))(), onOpenBudgets: act(openBudgets) }));
    else if (view === 'transactions') root.append(transactionPanel(model));
    else root.append(...overview(model));
    root.append(el('p', { class: 'personal-footnote' }, 'Personal and Work records are shown together. Clear matches count once. Currencies stay separate. Refunds reduce spending in the month received.'));
    paintedSession = personalSession;
    if (focusLabel) {
      const target = [...root.querySelectorAll('[aria-label]')].find(node => node.getAttribute('aria-label') === focusLabel);
      target?.focus({ preventScroll: true });
      if (selection && target?.type === 'search') target.setSelectionRange(...selection);
    }
  } catch (error) {
    if (ticket !== requestId || !scopeIsCurrent()) return;
    root.replaceChildren(el('div', { class: 'empty', role: 'alert' }, el('h3', {}, 'Spending could not be loaded'), el('p', {}, error.message), button('Try again', () => renderPersonal(root, nextView))));
  } finally { if (ticket === requestId) root.removeAttribute('aria-busy'); }
}

function spendingScope() {
  const toggle = (label, key) => {
    const input = el('input', { type: 'checkbox', 'aria-label': label, checked: state[key], onchange: () => {
      if (!scopeIsCurrent()) return; state[key] = input.checked; state.page = 1; changedView(); renderPersonal(host, view);
    } });
    return el('label', {}, input, el('span', {}, label));
  };
  const scopeText = state.excludeCompany || state.excludeTrips
    ? [state.excludeCompany ? 'Company costs excluded' : 'Company costs included', state.excludeTrips ? 'Trip costs excluded' : 'Trip costs included'].join(' · ')
    : 'All spending, including company and trip costs';
  return el('section', { class: 'personal-spending-scope', 'aria-label': 'Spending included' },
    el('div', { class: 'personal-scope-options' }, toggle('Exclude company costs', 'excludeCompany'), toggle('Exclude trip costs', 'excludeTrips')),
    el('small', { 'data-spending-scope': '' }, scopeText + '. Applies to Spending, Transactions, Study and month export.'));
}
function importSummaryPanel() {
  const summary = importReceipt, months = (summary.months || []).filter(validMonth).sort();
  const number = value => Number.isSafeInteger(value) && value > 0 ? value : 0;
  const rows = value => `${number(value)} row${number(value) === 1 ? '' : 's'}`;
  const parts = [`${number(summary.count)} added`];
  if (number(summary.updated)) parts.push(`${summary.updated} updated`);
  if (number(summary.duplicates)) parts.push(`${summary.duplicates} already imported`);
  if (number(summary.referenceCount)) parts.push(`${summary.referenceCount} payments or other bank movements kept outside spending`);
  if (number(summary.workCount)) parts.push(`${summary.workCount} Work charges identified`);
  const problems = number(summary.skippedReview) + number(summary.unread);
  return el('section', { class: 'personal-import-receipt', 'data-import-receipt': '', role: 'status' },
    el('div', { class: 'personal-panel-head' }, el('h3', {}, problems ? 'Import saved · some rows still need attention' : 'Import saved · your spending is ready to explore'),
      button('Dismiss', () => { importReceipt = null; host.querySelector('[data-import-receipt]')?.remove(); }, { class: 'link' })),
    el('p', {}, parts.join(' · ')),
    problems ? el('p', {}, `${rows(summary.skippedReview)} ${number(summary.skippedReview) === 1 ? 'needs' : 'need'} review · ${rows(summary.unread)} could not be imported. These are not included in your total.`) : null,
    el('div', { class: 'personal-import-months' }, ...months.map(month => button(monthLabel(month), () => setMonth(month), { class: 'link', 'aria-current': month === state.month ? 'date' : null })),
      button('History / Undo import', act(openActivity), { class: 'link' })));
}
function toolbar(model) {
  const month = el('input', { type: 'month', value: state.month, min: '1000-01', max: '9999-12', 'aria-label': 'Spending month', onchange: () => { if (setMonth(month.value) === false) month.value = state.month; } });
  const currencyCodes = [...new Set([...(ctx.settings().currencies || []), ...model.currencyTotals.map(item => item.currency), ...records.filter(row => !row.deleted && /^[A-Z]{3}$/.test(row.currency || '')).map(row => row.currency), state.currency])];
  const c = supabaseClient();
  const syncText = !navigator.onLine ? 'Offline · saved on this device' : c.signedIn ? 'Account connected' : 'Saved on this device';
  const more = el('details', { class: 'personal-more' }, el('summary', {}, 'More'));
  // Less-used actions stay available without competing with the monthly view.
  const item = (label, run, attrs = {}) => button(label, act(async () => { more.open = false; await run(); }), attrs);
  more.append(el('div', { class: 'personal-more-actions' },
    item('+ Add expense', newEntry),
    item(matching ? 'Checking Work…' : 'Match with Work', matchWithWork, { 'data-match-with-work': '', disabled: matching }),
    item('Review exceptions', reviewBank),
    item('Refresh all spending', () => refreshPersonal()),
    item('Export month · all currencies', exportMonth, { disabled: !model.currencyTotals.some(entry => entry.count) }),
    item('History', openActivity), item('Other tools', openExpenseTools),
    item('This month', () => setMonth(today().slice(0, 7)), { disabled: state.month === today().slice(0, 7) }),
    el('span', { id: 'exp-sync', class: 'personal-connection', role: 'status', 'aria-live': 'polite' }, syncText)));
  more.addEventListener('keydown', event => { if (event.key === 'Escape') { more.open = false; more.querySelector('summary').focus(); } });
  return el('div', { class: 'personal-toolbar' },
    el('div', { class: 'personal-toolbar-main' },
      el('div', { class: 'personal-month' }, button('‹', () => shiftMonth(-1), { 'aria-label': 'Previous month', disabled: state.month === '1000-01' }), month, button('›', () => shiftMonth(1), { 'aria-label': 'Next month', disabled: state.month === '9999-12' })),
      choice('Spending currency', currencyCodes.map(code => [code, code]), state.currency, setCurrency),
      el('div', { class: 'personal-toolbar-actions' }, button('Import statement', act(importBank), { class: 'primary' }), more)),
    el('p', { class: 'muted', role: 'status', 'aria-live': 'polite', 'data-work-match-status': '', hidden: !matchStatus?.message }, matchStatus?.message || ''),
    el('div', { class: 'personal-status', hidden: !inboxCount && !conflictCount },
      inboxCount ? button(`${inboxCount} receipt${inboxCount === 1 ? '' : 's'} to review`, act(openInbox), { class: 'link' }) : null,
      conflictCount ? button(`${conflictCount} sync conflict${conflictCount === 1 ? '' : 's'}`, act(openActivity), { class: 'link' }) : null));
}
function sharedFilters(model) {
  const full = model.filterOptions;
  const study = analyzePersonalStudy(includedRows(), { month: state.month, currency: state.currency, categories: ctx.settings().expenseCodes });
  const update = (key, value) => { if (!scopeIsCurrent()) return; state.filters[key] = value; state.page = 1; changedView(); renderPersonal(host, view); };
  // Keep a selected value visible even if it has no matches on this page.
  const options = (items, selected, field) => {
    for (const [key, label] of items) filterLabels.set(`${field}:${key}`, label);
    return selected && !items.some(([key]) => key === selected)
      ? [...items, [selected, `${filterLabels.get(`${field}:${selected}`) || selected} · no matches in this view`]] : items;
  };
  const filter = (label, values, key) => el('label', { class: 'personal-filter' }, el('span', {}, label), choice(label, options(values, state.filters[key], key), state.filters[key] || '', value => update(key, value)));
  const search = el('input', { type: 'search', value: state.filters.search || '', placeholder: 'Merchant, category or note', 'aria-label': 'Search spending' });
  // Search commits on change/Enter so repainting cannot steal focus mid-word.
  search.addEventListener('change', () => update('search', search.value));
  search.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); update('search', search.value); } });
  const chips = Object.entries(state.filters).filter(([key, value]) => value && !(key === 'purpose' && value === 'all')).map(([key, value]) => {
    const label = key === 'date' ? dateLabel(value) : key === 'purpose' ? ({ business: 'Work', personal: 'Personal', review: 'Needs review' }[value] || value) : filterLabels.get(`${key}:${value}`) || value;
    return button(`${key}: ${label} ×`, () => update(key, ''), { class: 'personal-filter-chip', 'aria-label': key === 'date' ? 'Clear day filter' : `Clear ${key} filter` });
  });
  const filters = el('details', { class: 'personal-filter-panel', open: hasPersonalFilters(state.filters) },
    el('summary', {}, hasPersonalFilters(state.filters) ? `Filters · ${chips.length}` : 'Filters'),
    el('div', { class: 'personal-filters' }, el('label', { class: 'personal-filter' }, el('span', {}, 'Search spending'), search),
      filter('Filter category', [['', 'All categories'], ...full.categories.map(group => [group.key, group.label])], 'category'),
      filter('Filter merchant', [['', 'All merchants'], ...full.merchants.map(group => [group.key, group.label])], 'merchant'),
      filter('Entry type', [['', 'Purchases & refunds'], ['purchase', 'Purchases'], ['refund', 'Refunds']], 'kind'),
      filter('Purpose', [['', 'All purposes'], ['personal', 'Personal'], ['business', 'Work'], ['review', 'Needs review']], 'purpose'),
      filter('Card', [['', 'All cards'], ...study.availableCards.map(item => [item.key, item.label])], 'card')));
  const active = hasPersonalFilters(state.filters) || state.excludeCompany || state.excludeTrips;
  return el('div', { class: 'personal-shared-filters' },
    el('div', { class: 'personal-filter-controls' }, filters, button('Reset filters', resetFilters, { class: 'link', disabled: !active, 'aria-label': 'Reset filters', title: 'Clear filters and exclusions. Keep the selected month and currency.' })),
    el('div', { class: 'personal-filter-state', 'aria-live': 'polite', hidden: !active },
      el('span', {}, `${model.entries.length} of ${model.totalEntryCount} transactions · ${cash(model.selectedTotals.netMinor)}`),
      ...chips));
}
function metricCard(label, value, detail, run, primary = false) {
  const card = button('', run, { class: 'personal-metric' + (primary ? ' primary-metric' : '') });
  card.append(el('span', { class: 'personal-metric-label' }, label), el('strong', {}, value), el('small', {}, detail));
  return card;
}
function overview(model) {
  const t = model.selectedTotals;
  const summary = el('div', { class: 'personal-metrics' },
    metricCard('Spent this month', cash(t.netMinor), `${t.count} transaction${t.count === 1 ? '' : 's'} · after refunds`, () => navigateTransactions(), true),
    metricCard('Purchases', cash(t.purchasesMinor), 'Before refunds', () => navigateTransactions({ kind: 'purchase' })),
    metricCard('Refunds', cash(t.refundsMinor), 'Money returned this month', () => navigateTransactions({ kind: 'refund' })));
  const others = el('div', { class: 'personal-other-currencies' }, ...model.currencyTotals.filter(item => item.currency !== state.currency && item.count).map(item => button(`${item.currency}: ${cash(item.netMinor, item.currency)} · full month`, () => setCurrency(item.currency), { class: 'link' })));
  if (!model.entries.length && (hasPersonalFilters(state.filters) || state.excludeCompany || state.excludeTrips)) return [summary, others, el('section', { class: 'personal-panel personal-empty' }, el('h3', {}, 'No matching transactions'), el('p', {}, 'Your filters stay selected when the month or currency changes. Adjust them or use Reset filters to see all spending.'))];
  if (model.coverage.monthEntryCount && !model.entries.length) return [summary, others, el('section', { class: 'personal-panel personal-empty' }, el('h3', {}, `No ${state.currency} transactions this month`), el('p', {}, 'Choose a recorded currency above to see its spending.'))];
  if (!model.entries.length) return [summary, others, el('section', { class: 'personal-panel personal-empty' },
    el('h3', {}, 'No spending yet'), el('p', {}, 'Use Import statement above to add your bank file.'))];
  return [summary, others, comparisonPanel(model), dailyPanel(model),
    el('div', { class: 'personal-breakdowns' }, breakdown('By category', model.categories, 'category'), breakdown('Top merchants', model.merchants, 'merchant')),
    recentPanel(model)];
}
function comparisonPanel(model) {
  const c = model.comparison;
  const box = el('section', { class: 'personal-comparison' }, el('strong', {}, 'Compared with last month'));
  if (!c?.available) { box.append(el('span', {}, c?.reason || 'Add records for both months to compare recorded spending.')); return box; }
  const change = c.netDeltaMinor;
  box.append(el('span', {}, change === 0 ? 'The same net spending recorded' : `${cash(Math.abs(change))} ${change < 0 ? 'less' : 'more'} recorded${c.netDeltaPercent == null ? '' : ` (${Math.abs(c.netDeltaPercent).toFixed(1)}%)`}`),
    el('small', {}, c.label || 'Same elapsed days in each month. Based on recorded entries.'));
  return box;
}
function dailyPanel(model) {
  const peak = Math.max(1, ...model.daily.map(day => Math.max(day.purchasesMinor, day.refundsMinor)));
  const graph = el('div', { class: 'personal-daily-chart', 'aria-label': 'Daily purchases and refunds' });
  for (const day of model.daily) {
    const entry = button('', () => navigateTransactions({ date: day.date }), { class: 'personal-day' + (day.isFuture ? ' future' : ''), 'aria-label': `${dateLabel(day.date)}: purchases ${cash(day.purchasesMinor)}, refunds ${cash(day.refundsMinor)}, ${day.count} transactions`, title: `${dateLabel(day.date)} · Purchases ${cash(day.purchasesMinor)} · Refunds ${cash(day.refundsMinor)}` });
    entry.append(el('span', { class: 'personal-day-bars', 'aria-hidden': 'true' },
      el('span', { class: 'purchase-bar', style: `height:${day.purchasesMinor / peak * 100}%` }),
      el('span', { class: 'refund-bar', style: `height:${day.refundsMinor / peak * 100}%` })), el('span', { class: 'personal-day-label' }, day.day));
    graph.append(entry);
  }
  return el('section', { class: 'personal-panel' }, el('div', { class: 'personal-panel-head' }, el('h3', {}, 'Daily spending'), el('span', { class: 'personal-legend' }, el('span', { class: 'legend-purchases' }, 'Purchases'), el('span', { class: 'legend-refunds' }, 'Refunds'))),
    el('div', { class: 'personal-chart-scroll' }, graph), el('small', {}, 'Select a day to see its transactions.'));
}
function breakdown(title, groups, field) {
  const body = el('div', { class: 'personal-group-list' });
  for (const group of groups.slice(0, 8)) {
    const row = button('', () => navigateTransactions({ [field]: group.key }), { class: 'personal-group', 'aria-label': `${group.label}: ${cash(group.netMinor)}, ${group.count} transactions` });
    row.append(el('span', { class: 'personal-group-line' }, el('strong', {}, group.label), el('b', { class: 'amt' }, cash(group.netMinor))),
      el('span', { class: 'personal-group-track', 'aria-hidden': 'true' }, el('i', { style: `width:${Math.max(0, Math.min(100, group.purchaseSharePercent))}%` })),
      el('small', {}, `${group.purchaseSharePercent.toFixed(1)}% of purchases · ${group.count} transaction${group.count === 1 ? '' : 's'}`));
    body.append(row);
  }
  if (!groups.length) body.append(el('p', { class: 'muted' }, 'No transactions in this currency.'));
  return el('section', { class: 'personal-panel' }, el('div', { class: 'personal-panel-head' }, el('h3', {}, title), groups.length > 8 ? button(`View all ${groups.length}`, () => navigateTransactions(), { class: 'link' }) : null),
    el('small', {}, 'Amounts after refunds; bars show share of purchases.'), body);
}
function entryRow(entry) {
  const row = button('', act(() => editEntry(entry)), { class: 'personal-entry', 'aria-label': `${entry.source?.ledgerReadOnly ? 'View' : 'Edit'} ${entry.merchant || entry.category}, ${dateLabel(entry.date)}, ${cash(entry.signedMinor, entry.currency)}` });
  const link = entry.source?.workExpenseLink;
  const effectivePurpose = effectiveSpendingPurpose(entry.source || entry);
  const purpose = effectivePurpose === 'business' && (entry.source?.ledgerMatch || link?.method === 'automatic' && link.workspace === 'work' && link.expenseId)
    ? 'Matched with Work' : ({ business: 'Work', personal: 'Personal', review: 'Needs review' }[effectivePurpose] || 'Needs review');
  row.append(el('span', { class: 'personal-entry-date' }, dateLabel(entry.date)),
    el('span', { class: 'personal-entry-description' }, el('strong', {}, entry.merchant || entry.category), el('small', {}, `${entry.category}${entry.kind === 'refund' ? ' · Refund' : ''}${entry.source?.ledgerReadOnly ? ' · Recorded in Work' : entry.source?.bankTransaction ? ' · ' + purpose : ''}${entry.source?.ledgerTripName ? ' · ' + entry.source.ledgerTripName : ''}`), entry.note ? el('span', { class: 'personal-entry-note' }, entry.note) : null),
    el('strong', { class: 'amt' + (entry.kind === 'refund' ? ' personal-refund' : '') }, cash(entry.signedMinor, entry.currency)), el('span', { class: 'personal-edit-hint', 'aria-hidden': 'true' }, '›'));
  return row;
}
function recentPanel(model) {
  return el('section', { class: 'personal-panel' }, el('div', { class: 'personal-panel-head' }, el('h3', {}, 'Recent transactions'), button('View all transactions', () => navigateTransactions(), { class: 'link' })),
    ...model.entries.slice(0, 5).map(entryRow));
}
function transactionPanel(initialModel) {
  const panel = el('section', { class: 'personal-panel personal-transactions' });
  const result = el('div', { id: 'personal-results', 'aria-live': 'polite' });
  function paint() {
    if (!scopeIsCurrent()) return;
    const model = analysis(), count = model.filteredEntries.length, pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    state.page = Math.max(1, Math.min(state.page, pages));
    const active = hasPersonalFilters(state.filters) || state.excludeCompany || state.excludeTrips;
    const rows = model.filteredEntries.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    result.replaceChildren(...rows.map(entryRow));
    if (!count) result.append(el('div', { class: 'personal-empty' }, el('h3', {}, active ? 'No matching transactions' : 'No transactions this month'),
      el('p', {}, active ? 'Your filters are still selected. Adjust them or use Reset filters above.' : 'Add an expense or import a statement to get started.'), active ? null : button('+ Add expense', act(newEntry), { class: 'primary' })));
    if (pages > 1) result.append(el('div', { class: 'personal-pagination' },
      button('Previous', () => { state.page--; changedView(); paint(); }, { disabled: state.page <= 1 }), el('span', {}, `Page ${state.page} of ${pages}`), button('Next', () => { state.page++; changedView(); paint(); }, { disabled: state.page >= pages })));
  }
  panel.append(el('div', { class: 'personal-panel-head' }, el('h3', {}, 'Transactions')), result);
  paint();
  return panel;
}



