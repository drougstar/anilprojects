// Read-only views over the Personal ledger. Bank movements stay available for
// review, but repayments, transfers and pending charges are not purchase totals.
import { el } from './dom.js';
import { minorAmount, validDate, spendingPurpose as purposeOf } from './expense-workflows.js';
import { normalizePersonalEntries, personalMonthBounds } from './personal-analytics.js';

const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const key = value => clean(value).normalize('NFKC').toLocaleLowerCase('tr-TR');
const add = (a, b) => { const sum = a + b; if (!Number.isSafeInteger(sum)) throw Error('The recorded total is too large to calculate precisely.'); return sum; };
const purposes = [['all', 'All purposes'], ['personal', 'Personal'], ['business', 'Business'], ['review', 'Needs review']];
const movementLabels = { payment: 'Card repayments', transfer: 'FX and transfers', financing: 'Statement financing', pending: 'Pending authorizations', reward: 'Rewards', unknown: 'Unclassified movements', excluded: 'Other excluded movements' };
function cardOf(source) {
  const label = clean(source.card || source.cardName || source.accountName);
  return { key: clean(source.accountId) || label || '__unrecorded__', label: label || (source.accountId ? 'Unnamed card' : 'No card recorded') };
}
function movementKind(source) {
  const kind = clean(source.bankKind).toLowerCase();
  if (kind === 'pending' || source.bankStatus === 'pending' || source.pending === true) return 'pending';
  if (Object.hasOwn(movementLabels, kind)) return kind;
  return source.excludeFromSpending === true ? 'excluded' : '';
}
function sumEntries(entries, currency) {
  let purchasesMinor = 0, refundsMinor = 0;
  for (const row of entries) {
    if (row.currency !== currency) throw Error('Study totals cannot combine currencies.');
    if (row.kind === 'refund') refundsMinor = add(refundsMinor, row.amountMinor);
    else purchasesMinor = add(purchasesMinor, row.amountMinor);
  }
  return { currency, purchasesMinor, refundsMinor, netMinor: add(purchasesMinor, -refundsMinor), count: entries.length };
}
function groupEntries(entries, field, currency) {
  const map = new Map(), total = sumEntries(entries, currency);
  for (const entry of entries) {
    const label = field === 'card' ? entry.cardLabel : field === 'merchant' ? entry.merchant || 'No merchant recorded' : entry.category;
    const groupKey = field === 'card' ? entry.cardKey : field === 'merchant' ? key(entry.merchant) || '__missing__' : key(entry.category);
    const group = map.get(groupKey) || { key: groupKey, label, entries: [] };
    group.entries.push(entry); map.set(groupKey, group);
  }
  return [...map.values()].map(group => ({ ...group, ...sumEntries(group.entries, currency), entryIds: group.entries.map(entry => entry.id), sharePercent: total.purchasesMinor ? Math.round(sumEntries(group.entries, currency).purchasesMinor / total.purchasesMinor * 1000) / 10 : 0 }))
    .sort((a, b) => b.purchasesMinor - a.purchasesMinor || a.label.localeCompare(b.label));
}
function budgetModels(budgets, entries, { month, currency }) {
  const results = [], issues = [];
  for (const budget of budgets || []) {
    if (!budget || budget.deleted || budget.kind === 'trip' || budget.month !== month || budget.currency !== currency) continue;
    try {
      const limitMinor = minorAmount(budget.amount);
      if (limitMinor <= 0) throw Error('The budget limit must be positive.');
      const audience = ['personal', 'business', 'review'].includes(budget.audience) ? budget.audience : 'all';
      const selected = entries.filter(entry => (audience === 'all' || entry.purpose === audience) &&
        (budget.personalCategory ? key(entry.category) === key(budget.personalCategory) : !budget.code || String(entry.code) === String(budget.code)));
      const totals = sumEntries(selected, currency);
      results.push({ id: String(budget.id || ''), name: clean(budget.name) || clean(budget.personalCategory) || 'Monthly budget', audience,
        category: clean(budget.personalCategory), currency, limitMinor, actualMinor: totals.netMinor,
        remainingMinor: add(limitMinor, -totals.netMinor), usedPercent: Math.round(totals.netMinor / limitMinor * 1000) / 10,
        entryIds: selected.map(entry => entry.id), count: selected.length });
    } catch (error) { issues.push({ id: String(budget.id || ''), reason: error.message }); }
  }
  return { results, issues };
}
function recurringCandidates(history, currentEntries, currency) {
  const currentMerchants = new Set(currentEntries.filter(entry => entry.kind === 'purchase' && entry.merchant).map(entry => key(entry.merchant)));
  const groups = new Map();
  for (const entry of history) {
    if (entry.currency !== currency || entry.kind !== 'purchase' || !currentMerchants.has(key(entry.merchant))) continue;
    const merchantKey = key(entry.merchant), item = groups.get(merchantKey) || { key: merchantKey, label: entry.merchant, entries: [] };
    item.entries.push(entry); groups.set(merchantKey, item);
  }
  const result = [];
  for (const item of groups.values()) {
    const months = [...new Set(item.entries.map(entry => entry.date.slice(0, 7)))].sort();
    const current = currentEntries.filter(entry => key(entry.merchant) === item.key && entry.kind === 'purchase');
    const categoryHint = current.some(entry => /subscription|abonelik/i.test(entry.category));
    // Repeating a merchant within one month alone does not establish a subscription.
    if (months.length < 2 && !categoryHint) continue;
    const amounts = [...new Set(item.entries.map(entry => entry.amountMinor))].sort((a, b) => a - b);
    result.push({ key: item.key, label: item.label, months, reason: categoryHint ? 'Categorized as a subscription; confirm whether it repeats.' : `Purchases recorded in ${months.length} months; this may be ordinary repeat shopping.`,
      sameAmount: amounts.length === 1, minAmountMinor: amounts[0], maxAmountMinor: amounts.at(-1),
      currentMinor: sumEntries(current, currency).purchasesMinor, entryIds: current.map(entry => entry.id), count: current.length });
  }
  return result.sort((a, b) => b.currentMinor - a.currentMinor || a.label.localeCompare(b.label));
}

export function analyzePersonalStudy(rows, { month, currency, categories = [], purpose = 'all', card = '', budgets = [] } = {}) {
  const bounds = personalMonthBounds(month);
  currency = clean(currency).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw Error('Choose a three-letter currency.');
  if (!purposes.some(([value]) => value === purpose)) throw Error('Choose a valid spending purpose.');
  if (!Array.isArray(rows)) throw Error('Study records must be an array.');
  const active = rows.filter(row => row && typeof row === 'object' && !row.deleted && !row.perdiem);
  // This local guard also protects the Study view while older imported records
  // are migrated to the shared Personal normalizer's exclusion fields.
  const normalized = normalizePersonalEntries(active.filter(row => !movementKind(row)), { categories });
  const history = normalized.entries.map(entry => ({ ...entry, purpose: purposeOf(entry.source), cardKey: cardOf(entry.source).key, cardLabel: cardOf(entry.source).label }));
  const monthEntries = history.filter(entry => entry.currency === currency && entry.date >= bounds.first && entry.date <= bounds.last);
  const entries = monthEntries.filter(entry => (purpose === 'all' || entry.purpose === purpose) && (!card || entry.cardKey === card));
  const excluded = [], movementIssues = [];
  active.forEach((source, index) => {
    const kind = movementKind(source);
    if (!kind || source.currency !== currency || !validDate(source.date) || source.date < bounds.first || source.date > bounds.last) return;
    const account = cardOf(source);
    if (card && card !== account.key) return;
    let amountMinor = null;
    try {
      if (source.amountMinor != null) {
        if (!Number.isSafeInteger(source.amountMinor)) throw Error('Invalid amount.');
        amountMinor = Math.abs(source.amountMinor);
      } else if (source.amount !== '' && source.amount != null) amountMinor = Math.abs(minorAmount(source.amount));
    } catch (error) { movementIssues.push({ id: String(source.id || ''), reason: error.message }); }
    excluded.push({ id: String(source.id || `movement-${index}`), date: source.date, currency, kind, amountMinor,
      merchant: clean(source.merchant || source.vendor || source.originalDescription || source.description) || movementLabels[kind],
      cardKey: account.key, cardLabel: account.label, purpose: purposeOf(source), source });
  });
  excluded.sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
  const movements = Object.entries(movementLabels).map(([kind, label]) => {
    const chosen = excluded.filter(entry => entry.kind === kind);
    return { kind, label, count: chosen.length, currency, amountMinor: chosen.reduce((total, entry) => entry.amountMinor == null ? total : add(total, entry.amountMinor), 0),
      unknownAmountCount: chosen.filter(entry => entry.amountMinor == null).length, entryIds: chosen.map(entry => entry.id), entries: chosen };
  }).filter(group => group.count);
  const accountMap = new Map();
  for (const entry of monthEntries) accountMap.set(entry.cardKey, entry.cardLabel);
  for (const row of active.filter(row => row.currency === currency && validDate(row.date) && row.date >= bounds.first && row.date <= bounds.last)) {
    const account = cardOf(row); accountMap.set(account.key, account.label);
  }
  const budgetData = budgetModels(budgets, monthEntries, { month, currency });
  const dates = [...monthEntries.map(entry => entry.date), ...active.filter(row => movementKind(row) && row.currency === currency && validDate(row.date) && row.date >= bounds.first && row.date <= bounds.last).map(row => row.date)].sort();
  const issues = normalized.issues.filter(issue => !validDate(issue.date) || issue.date >= bounds.first && issue.date <= bounds.last);
  const recurringHistory = history.filter(entry => entry.date <= bounds.last && (purpose === 'all' || entry.purpose === purpose) && (!card || entry.cardKey === card));
  const purposeTotals = purposes.slice(1).map(([value, label]) => ({ purpose: value, label, ...sumEntries(monthEntries.filter(entry => entry.purpose === value && (!card || entry.cardKey === card)), currency) }));
  return { month, currency, purpose, card, entries, totals: sumEntries(entries, currency), purposeTotals,
    categories: groupEntries(entries, 'category', currency), merchants: groupEntries(entries, 'merchant', currency), cards: groupEntries(entries, 'card', currency),
    availableCards: [...accountMap].map(([value, label]) => ({ key: value, label })).sort((a, b) => a.label.localeCompare(b.label)),
    largest: entries.filter(entry => entry.kind === 'purchase').sort((a, b) => b.amountMinor - a.amountMinor || b.date.localeCompare(a.date)).slice(0, 10),
    recurring: recurringCandidates(recurringHistory, entries, currency), budgets: budgetData.results, budgetIssues: budgetData.issues,
    excluded, movements, coverage: { firstRecordedDate: dates[0] || null, lastRecordedDate: dates.at(-1) || null,
      recordedDays: new Set(dates).size, calendarDays: bounds.days, completeMonthKnown: false,
      basis: 'transaction-date', explanation: 'Months use transaction dates, not statement closing dates. Recorded dates do not prove a complete month; a statement can cover parts of two months.' },
    issues: [...issues, ...movementIssues] };
}

const money = (amount, currency) => new Intl.NumberFormat('en-GB', { style: 'currency', currency, currencyDisplay: 'narrowSymbol', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(amount / 100);
const dateText = date => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const btn = (label, action, attrs = {}) => el('button', { type: 'button', onclick: action, ...attrs }, label);
const panel = (title, ...children) => el('section', { class: 'study-panel' }, el('h3', {}, title), ...children);
function select(label, options, selected, change) {
  const field = el('select', { 'aria-label': label, onchange: () => change(field.value) }, options.map(([value, text]) => el('option', { value, selected: value === selected }, text)));
  return el('label', { class: 'study-filter' }, el('span', {}, label), field);
}

export function renderPersonalStudy({ rows, month, currency, categories = [], budgets = [], onOpenEntry, onOpenBudgets, onImport }) {
  const root = el('div', { class: 'personal-study' });
  const state = { purpose: 'all', card: '', detail: null, visible: 25 };
  let model;
  function openEntry(entry) {
    if (!onOpenEntry) return;
    Promise.resolve().then(() => onOpenEntry(entry.source || entry)).catch(error => {
      const message = root.querySelector('.study-error');
      if (message) message.textContent = error.message || 'Could not open this transaction.';
    });
  }
  function showEntries(title, ids, movement = false) {
    state.detail = { title, ids, movement }; state.visible = 25; paint();
    root.querySelector('.study-detail')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
  function transaction(entry, movement = false) {
    const amount = movement ? entry.amountMinor : entry.signedMinor;
    const title = entry.merchant || entry.note || 'Transaction';
    const meta = [dateText(entry.date), entry.cardLabel, movement ? movementLabels[entry.kind] : entry.category,
      !movement ? purposes.find(([value]) => value === entry.purpose)?.[1] : '', entry.source.installment ? `Installment ${typeof entry.source.installment === 'string' ? entry.source.installment : [entry.source.installment.current, entry.source.installment.total].filter(Boolean).join('/')}` : ''].filter(Boolean).join(' · ');
    const row = btn('', () => openEntry(entry), { class: 'study-transaction', disabled: !onOpenEntry });
    row.append(el('span', {}, el('strong', {}, title), el('small', {}, meta)), el('b', { class: amount != null && amount < 0 ? 'study-amount refund' : 'study-amount' }, amount == null ? 'Amount unavailable' : money(amount, currency)));
    return row;
  }
  function breakdown(title, groups) {
    const list = el('div', { class: 'study-groups' });
    for (const group of groups) {
      const line = btn('', () => showEntries(group.label, group.entryIds), { class: 'study-group' });
      line.append(el('span', { class: 'study-group-heading' }, el('strong', {}, group.label), el('b', { class: 'study-amount' }, money(group.netMinor, currency))),
        el('span', { class: 'study-track', 'aria-hidden': 'true' }, el('i', { style: `width:${Math.max(0, Math.min(100, group.sharePercent))}%` })),
        el('small', {}, `${group.count} transaction${group.count === 1 ? '' : 's'} · ${group.sharePercent.toFixed(1)}% of purchases`));
      list.append(line);
    }
    if (!groups.length) list.append(el('p', { class: 'study-muted' }, 'No spending matches these filters.'));
    return panel(title, list);
  }
  function paint() {
    model = analyzePersonalStudy(rows, { month, currency, categories, budgets, purpose: state.purpose, card: state.card });
    const filters = el('div', { class: 'study-filters' }, select('Purpose', purposes, state.purpose, value => { state.purpose = value; state.detail = null; paint(); }),
      select('Card', [['', 'All cards'], ...model.availableCards.map(item => [item.key, item.label])], state.card, value => { state.card = value; state.detail = null; paint(); }),
      onImport ? btn('Import bank files', onImport) : null);
    const total = model.totals;
    const summary = el('div', { class: 'study-totals', 'aria-label': 'Filtered spending totals' },
      el('div', {}, el('span', {}, 'Net spending'), el('strong', {}, money(total.netMinor, currency))),
      el('div', {}, el('span', {}, 'Purchases'), el('strong', {}, money(total.purchasesMinor, currency))),
      el('div', {}, el('span', {}, 'Refunds'), el('strong', {}, money(total.refundsMinor, currency))));
    const purposeLinks = el('div', { class: 'study-purpose-totals' }, ...model.purposeTotals.map(item => btn(`${item.label}: ${money(item.netMinor, currency)} (${item.count})`, () => { state.purpose = item.purpose; state.detail = null; paint(); }, { class: 'link', 'aria-pressed': String(state.purpose === item.purpose) })));
    const coverage = model.coverage.firstRecordedDate ? `${dateText(model.coverage.firstRecordedDate)}–${dateText(model.coverage.lastRecordedDate)} recorded · ${model.coverage.recordedDays} transaction days.` : 'No dated records in this month and currency.';
    root.replaceChildren(filters, summary, purposeLinks, el('p', { class: 'study-coverage' }, coverage, ' ', model.coverage.explanation), el('p', { class: 'study-error', role: 'alert' }, model.issues.length ? `${model.issues.length} invalid record${model.issues.length === 1 ? '' : 's'} excluded. Review the source before relying on totals.` : ''));
    if (!model.entries.length && !model.excluded.length) root.append(panel('Study your spending', el('p', {}, 'Import bank statements or add transactions. Categories, cards and the largest purchases will appear here.')));
    if (state.detail) {
      const collection = state.detail.movement ? model.excluded : model.entries;
      const ids = new Set(state.detail.ids), selected = collection.filter(entry => ids.has(entry.id));
      const detail = panel(state.detail.title, btn('Close details', () => { state.detail = null; paint(); }, { class: 'link' }), ...selected.slice(0, state.visible).map(entry => transaction(entry, state.detail.movement)));
      detail.classList.add('study-detail');
      if (selected.length > state.visible) detail.append(btn(`Show more (${selected.length - state.visible} remaining)`, () => { state.visible += 25; paint(); }));
      root.append(detail);
    }
    root.append(el('div', { class: 'study-grid' }, breakdown('Categories', model.categories), breakdown('Merchants', model.merchants)),
      el('p', { class: 'study-muted' }, 'Breakdown amounts are after refunds. Bars show each share of purchases. Select a row to inspect its transactions.'),
      el('div', { class: 'study-grid' }, breakdown('Spending by card', model.cards), panel('Largest purchases', ...model.largest.map(entry => transaction(entry)), model.largest.length ? null : el('p', { class: 'study-muted' }, 'No purchases match these filters.'))));
    const recurring = panel('Recurring spending to review', el('p', { class: 'study-muted' }, 'These are candidates from recorded history, not confirmed subscriptions or future charges.'));
    for (const item of model.recurring) {
      const line = btn('', () => showEntries(item.label, item.entryIds), { class: 'study-candidate' });
      line.append(el('span', {}, el('strong', {}, item.label), el('small', {}, item.reason)), el('b', { class: 'study-amount' }, money(item.currentMinor, currency)));
      recurring.append(line);
    }
    if (!model.recurring.length) recurring.append(el('p', { class: 'study-muted' }, 'No recurring candidates yet. Import another month or categorize a subscription.'));
    const budgetPanel = panel('Budgets and recorded spending', el('p', { class: 'study-muted' }, 'Each budget follows its saved purpose and category for this month and currency, independently of the filters above.'), onOpenBudgets ? btn('Manage budgets', onOpenBudgets, { class: 'link' }) : null);
    for (const item of model.budgets) {
      const line = el('div', { class: 'study-budget' }, el('div', { class: 'study-group-heading' }, el('strong', {}, item.name), el('b', { class: 'study-amount' }, money(item.actualMinor, currency))),
        el('small', {}, `${money(item.limitMinor, currency)} limit · ${money(Math.abs(item.remainingMinor), currency)} ${item.remainingMinor < 0 ? 'over' : 'remaining'} · ${item.audience}`),
        el('progress', { value: Math.max(0, Math.min(item.limitMinor, item.actualMinor)), max: item.limitMinor, 'aria-label': `${item.name}: ${money(item.actualMinor, currency)} recorded against ${money(item.limitMinor, currency)}` }));
      budgetPanel.append(line);
    }
    if (!model.budgets.length) budgetPanel.append(el('p', { class: 'study-muted' }, 'No budgets saved for this month and currency.'));
    if (model.budgetIssues.length) budgetPanel.append(el('p', { role: 'alert' }, `${model.budgetIssues.length} invalid budget${model.budgetIssues.length === 1 ? '' : 's'} could not be calculated.`));
    root.append(el('div', { class: 'study-grid' }, recurring, budgetPanel));
    const movements = panel('Bank movements outside spending', el('p', { class: 'study-muted' }, 'These amounts are kept separate from purchases and refunds. Totals below show movement magnitudes, not a bank balance. The card filter applies; the purpose filter does not.'));
    for (const item of model.movements) {
      const row = btn('', () => showEntries(item.label, item.entryIds, true), { class: 'study-candidate' });
      row.append(el('span', {}, el('strong', {}, item.label), el('small', {}, `${item.count} record${item.count === 1 ? '' : 's'}${item.unknownAmountCount ? ` · ${item.unknownAmountCount} amount unavailable` : ''}`)), el('b', { class: 'study-amount' }, money(item.amountMinor, currency)));
      movements.append(row);
    }
    if (!model.movements.length) movements.append(el('p', { class: 'study-muted' }, 'No excluded bank movements recorded for this month and currency.'));
    root.append(movements);
  }
  paint(); return root;
}
