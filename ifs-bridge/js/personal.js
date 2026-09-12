// A continuous personal ledger. Months and filters are views, never separate projects.
import { live, db } from './db.js';
import { currentScope, scopeIsCurrent } from './scope.js';
import { el, download, toast } from './dom.js';
import { preparePersonalExpenses, openNewExpense, openExpense, supabaseClient, scheduleSync } from './expenses.js';
import { openExpenseTools, openInbox, openBudgets } from './expense-tools.js';
import { openActivity } from './workspace-ui.js';
import { analyzePersonalMonth, exportPersonalMonthCsv } from './personal-analytics.js';
import { renderPersonalStudy } from './personal-study.js';
import { openBankImport, openBankTransaction } from './bank-ui.js';
import { openWorkExpenseReview } from './work-match-ui.js';

let ctx, preparation, host, view = 'overview', requestId = 0;
let records = [], budgets = [], inboxCount = 0, conflictCount = 0;
const state = { month: '', currency: '', filters: {}, page: 1 };
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
  return async () => { try { if (!scopeIsCurrent()) return; await run(); } catch (error) { toast(error.message || 'Could not finish. Please try again.', 5000); } };
}
export function initPersonal(context) {
  ctx = context;
  state.month = today().slice(0, 7);
  state.currency = ctx.settings().defaultCurrency || 'TRY';
}
export function refreshPersonal(change) {
  // Keep a saved purchase visible when its date/currency moves outside this view.
  if (change?.entry && validMonth(String(change.entry.date || '').slice(0, 7)) && /^[A-Z]{3}$/.test(change.entry.currency || '')) {
    state.month = change.entry.date.slice(0, 7); state.currency = change.entry.currency;
    state.filters = {}; state.page = 1;
  }
  if (host?.isConnected && !host.hidden && currentScope().workspace === 'personal') return renderPersonal(host, view);
}
function analysis() {
  // Keep the full bank ledger available in Transactions and Study. The Summary
  // removes only explicitly classified bank Work charges, not legacy flags.
  const rows = view === 'overview' ? records.filter(row => !(row.bankTransaction && row.spendingPurpose === 'business')) : records;
  return analyzePersonalMonth(rows, { month: state.month, today: today(), currency: state.currency, categories: ctx.settings().expenseCodes, filters: state.filters, complete: true });
}
function navigateTransactions(filters = {}) {
  state.filters = filters; state.page = 1;
  if (ctx.navigateTransactions) ctx.navigateTransactions();
  else renderPersonal(host, 'transactions');
}
function setMonth(value) {
  if (!validMonth(value)) return false;
  state.month = value; state.filters = {}; state.page = 1;
  renderPersonal(host, view);
}
function shiftMonth(offset) {
  const [year, month] = state.month.split('-').map(Number);
  setMonth(new Date(Date.UTC(year, month - 1 + offset, 1)).toISOString().slice(0, 7));
}
function setCurrency(currency) {
  state.currency = currency; state.filters = {}; state.page = 1;
  renderPersonal(host, view);
}
function newEntry() {
  const date = state.month === today().slice(0, 7) ? today() : state.month + '-01';
  return openNewExpense({ date, currency: state.currency });
}
async function importBank() {
  const sheet = await preparation;
  return openBankImport({ settings: ctx.settings, sheet, onChange: refreshPersonal, sync: scheduleSync });
}
function reviewBank() { return openWorkExpenseReview({ month: state.month, onChange: refreshPersonal, sync: scheduleSync }); }
function editEntry(entry) {
  const row = entry.source || entry;
  return row.bankTransaction ? openBankTransaction(row.id, { settings: ctx.settings, onChange: refreshPersonal, sync: scheduleSync }) : openExpense(row.id);
}
function exportMonth() {
  const csv = exportPersonalMonthCsv(records, { month: state.month, categories: ctx.settings().expenseCodes });
  download(`personal-spending-${state.month}.csv`, csv, 'text/csv;charset=utf-8');
  toast('Exported this month in all recorded currencies and purposes, including Work.');
}

export async function renderPersonal(root, nextView = 'overview') {
  if (currentScope().workspace !== 'personal' || !scopeIsCurrent()) return;
  if (host && host !== root) host.replaceChildren();
  host = root; view = nextView;
  const ticket = ++requestId;
  root.classList.add('personal-page'); root.setAttribute('aria-busy', 'true');
  root.replaceChildren(el('p', { class: 'empty', role: 'status' }, 'Loading monthly spending…'));
  try {
    // Prepare the shared editor without painting its work-oriented page.
    preparation ||= preparePersonalExpenses({ onChange: refreshPersonal }).catch(error => { preparation = null; throw error; });
    await preparation;
    const loaded = await Promise.all([live('expenses'), live('inbox'), db.all('conflicts'), live('budgets')]);
    if (ticket !== requestId || !scopeIsCurrent()) return;
    records = loaded[0];
    budgets = loaded[3];
    inboxCount = loaded[1].filter(item => !['created', 'matched', 'done', 'imported'].includes(item.status)).length;
    conflictCount = loaded[2].length;
    const model = analysis();
    state.currency = model.currency;
    root.replaceChildren(toolbar(model));
    if (model.warnings?.length) root.append(el('div', { class: 'personal-warning', role: 'alert' }, ...model.warnings.map(text => el('p', {}, text))));
    if (view === 'study') root.append(renderPersonalStudy({ rows: records, month: state.month, currency: state.currency,
      categories: ctx.settings().expenseCodes, budgets, onOpenEntry: entry => act(() => editEntry(entry))(), onOpenBudgets: act(openBudgets) }));
    else if (view === 'transactions') root.append(transactionPanel(model));
    else root.append(...overview(model));
    root.append(el('p', { class: 'personal-footnote' }, 'Based on recorded transactions. Refunds reduce spending in the month received. Currencies stay separate.', view === 'overview' ? ' Work-classified bank charges are excluded here and remain in Transactions and Study. Needs review is still included until you classify it.' : ' Transactions and month export include all purposes, including Work.'));
  } catch (error) {
    if (ticket !== requestId || !scopeIsCurrent()) return;
    root.replaceChildren(el('div', { class: 'empty', role: 'alert' }, el('h3', {}, 'Spending could not be loaded'), el('p', {}, error.message), button('Try again', () => renderPersonal(root, nextView))));
  } finally { if (ticket === requestId) root.removeAttribute('aria-busy'); }
}

function toolbar(model) {
  const month = el('input', { type: 'month', value: state.month, min: '1000-01', max: '9999-12', 'aria-label': 'Spending month', onchange: () => { if (setMonth(month.value) === false) month.value = state.month; } });
  const currencyCodes = [...new Set([...(ctx.settings().currencies || []), ...model.currencyTotals.map(item => item.currency), ...records.filter(row => !row.deleted && /^[A-Z]{3}$/.test(row.currency || '')).map(row => row.currency), state.currency])];
  const c = supabaseClient();
  const syncText = !navigator.onLine ? 'Offline · saved on this device' : c.signedIn ? 'Account connected' : 'Saved on this device';
  return el('div', { class: 'personal-toolbar' },
    el('div', { class: 'personal-toolbar-main' },
      el('div', { class: 'personal-month' }, button('‹', () => shiftMonth(-1), { 'aria-label': 'Previous month', disabled: state.month === '1000-01' }), month, button('›', () => shiftMonth(1), { 'aria-label': 'Next month', disabled: state.month === '9999-12' })),
      button('This month', () => setMonth(today().slice(0, 7)), { class: 'personal-this-month', disabled: state.month === today().slice(0, 7) }),
      choice('Spending currency', currencyCodes.map(code => [code, code]), state.currency, setCurrency),
      el('div', { class: 'personal-toolbar-actions' }, button('Import bank files', act(importBank), { class: 'primary' }), button('Review card spending', act(reviewBank)), button('+ Add expense', act(newEntry)), button('Tools', act(openExpenseTools)), button('History', act(openActivity), { class: 'link' }))),
    el('div', { class: 'personal-views', 'aria-label': 'Spending view' },
      ...[['overview', 'Summary'], ['study', 'Study month'], ['transactions', 'Transactions']].map(([key, label]) => button(label, () => renderPersonal(host, key), { 'aria-pressed': String(view === key) }))),
    el('div', { class: 'personal-status' }, el('span', { id: 'exp-sync', role: 'status', 'aria-live': 'polite' }, syncText),
      inboxCount ? button(`${inboxCount} receipt${inboxCount === 1 ? '' : 's'} to review`, act(openInbox), { class: 'link' }) : null,
      conflictCount ? button(`${conflictCount} sync conflict${conflictCount === 1 ? '' : 's'}`, act(openActivity), { class: 'link' }) : null));
}
function metricCard(label, value, detail, run, primary = false) {
  const card = button('', run, { class: 'personal-metric' + (primary ? ' primary-metric' : '') });
  card.append(el('span', { class: 'personal-metric-label' }, label), el('strong', {}, value), el('small', {}, detail));
  return card;
}
function overview(model) {
  const t = model.selectedTotals;
  const summary = el('div', { class: 'personal-metrics' },
    metricCard('Net spending', cash(t.netMinor), `${t.count} transaction${t.count === 1 ? '' : 's'} · ${monthLabel(state.month)}`, () => navigateTransactions(), true),
    metricCard('Purchases', cash(t.purchasesMinor), 'Before refunds', () => navigateTransactions({ kind: 'purchase' })),
    metricCard('Refunds', cash(t.refundsMinor), 'Money returned this month', () => navigateTransactions({ kind: 'refund' })));
  const comparison = comparisonPanel(model);
  const others = el('div', { class: 'personal-other-currencies' }, ...model.currencyTotals.filter(item => item.currency !== state.currency && item.count).map(item => button(`${item.currency}: ${cash(item.netMinor, item.currency)}`, () => setCurrency(item.currency), { class: 'link' })));
  if (model.coverage.monthEntryCount && !model.entries.length) return [summary, others, el('section', { class: 'personal-panel personal-empty' }, el('h3', {}, `No ${state.currency} transactions this month`), el('p', {}, 'Choose a recorded currency above to see its spending.'))];
  if (!model.entries.length) return [summary, others, el('section', { class: 'personal-panel personal-empty' },
    el('h3', {}, 'Your month starts with one entry'), el('p', {}, `Add a purchase or import your spending for ${monthLabel(state.month)}. Categories, merchants and daily patterns will appear here.`),
    el('div', { class: 'actions' }, button('+ Add expense', act(newEntry), { class: 'primary' }), button('Import spending', act(openExpenseTools))))];
  return [summary, others, comparison,
    dailyPanel(model),
    el('div', { class: 'personal-breakdowns' }, breakdown('Where it went', model.categories, 'category'), breakdown('Top merchants', model.merchants, 'merchant')),
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
  const row = button('', act(() => editEntry(entry)), { class: 'personal-entry', 'aria-label': `Edit ${entry.merchant || entry.category}, ${dateLabel(entry.date)}, ${cash(entry.signedMinor, entry.currency)}` });
  row.append(el('span', { class: 'personal-entry-date' }, dateLabel(entry.date)),
    el('span', { class: 'personal-entry-description' }, el('strong', {}, entry.merchant || entry.category), el('small', {}, `${entry.category}${entry.kind === 'refund' ? ' · Refund' : ''}${entry.source?.bankTransaction ? ' · ' + ({ business: 'Work', personal: 'Personal', review: 'Needs review' }[entry.source.spendingPurpose] || 'Needs review') : ''}`), entry.note ? el('span', { class: 'personal-entry-note' }, entry.note) : null),
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
  const chips = el('div', { class: 'personal-filter-state' });
  const filters = el('div', { class: 'personal-filters' });
  const change = (key, value) => { state.filters[key] = value; state.page = 1; paint(); };
  const search = el('input', { type: 'search', value: state.filters.search || '', placeholder: 'Search merchant, category or note', 'aria-label': 'Search spending', oninput: () => change('search', search.value) });
  const category = choice('Filter category', [['', 'All categories'], ...initialModel.categories.map(group => [group.key, group.label])], state.filters.category || '', value => change('category', value));
  const merchant = choice('Filter merchant', [['', 'All merchants'], ...initialModel.merchants.map(group => [group.key, group.label])], state.filters.merchant || '', value => change('merchant', value));
  const kind = choice('Entry type', [['', 'Purchases & refunds'], ['purchase', 'Purchases'], ['refund', 'Refunds']], state.filters.kind || '', value => change('kind', value));
  filters.append(search, category, merchant, kind);
  function clear() { state.filters = {}; state.page = 1; search.value = ''; category.value = ''; merchant.value = ''; kind.value = ''; paint(); }
  function paint() {
    const model = analysis(), count = model.filteredEntries.length, pages = Math.max(1, Math.ceil(count / PAGE_SIZE));
    state.page = Math.max(1, Math.min(state.page, pages));
    const active = Object.values(state.filters).some(Boolean);
    chips.replaceChildren(el('span', {}, `${count} of ${model.entries.length} transactions · net ${cash(model.filteredTotals.netMinor)}`),
      state.filters.date ? button(`${dateLabel(state.filters.date)} ×`, () => change('date', ''), { class: 'personal-filter-chip', 'aria-label': 'Clear day filter' }) : null,
      button('Clear filters', clear, { class: 'link', disabled: !active }));
    const rows = model.filteredEntries.slice((state.page - 1) * PAGE_SIZE, state.page * PAGE_SIZE);
    result.replaceChildren(...rows.map(entryRow));
    if (!count) result.append(el('div', { class: 'personal-empty' }, el('h3', {}, active ? 'No matching transactions' : 'No transactions this month'),
      el('p', {}, active ? 'Clear a filter or try another search.' : 'Add an expense or import a statement to get started.'), active ? button('Show this month', clear) : button('+ Add expense', act(newEntry), { class: 'primary' })));
    if (pages > 1) result.append(el('div', { class: 'personal-pagination' },
      button('Previous', () => { state.page--; paint(); }, { disabled: state.page <= 1 }), el('span', {}, `Page ${state.page} of ${pages}`), button('Next', () => { state.page++; paint(); }, { disabled: state.page >= pages })));
  }
  panel.append(el('div', { class: 'personal-panel-head' }, el('h3', {}, 'Transactions'), button('Export month · all currencies', act(exportMonth), { disabled: !initialModel.currencyTotals.some(item => item.count) })), filters, chips, result);
  paint();
  return panel;
}



