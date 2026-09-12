// Monthly Personal analysis. The caller supplies records from the active Personal
// database; this module never reads Work data, storage, an account, or the network.
// Pocket concepts retained: separate purchases/refunds, merchant/category/note,
// refunds in their recorded month, and full-month CSV independent of list filters.
import { minorAmount, validDate, isSpendingRecord } from './expense-workflows.js';

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;
const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const keyOf = value => clean(value).normalize('NFKC').toLowerCase().replace(/\u0307/g, '');
const safeAdd = (a, b) => { const sum = a + b; if (!Number.isSafeInteger(sum)) throw Error('The recorded total is too large to calculate precisely.'); return sum; };
const dateSort = (a, b) => b.date.localeCompare(a.date) || String(a.id).localeCompare(String(b.id));

export function personalMonthBounds(month) {
  if (!MONTH.test(month || '')) throw Error('Choose a valid month (YYYY-MM).');
  const [year, number] = month.split('-').map(Number);
  // The saved journal uses four-digit years. Avoid Date.UTC's 0–99 year coercion.
  if (year < 1000 || year > 9999) throw Error('Choose a year between 1000 and 9999.');
  const days = new Date(Date.UTC(year, number, 0)).getUTCDate();
  return { month, first: `${month}-01`, last: `${month}-${String(days).padStart(2, '0')}`, days };
}
export function shiftPersonalMonth(month, offset) {
  personalMonthBounds(month);
  if (!Number.isInteger(offset)) throw Error('The month offset must be an integer.');
  const [y, m] = month.split('-').map(Number), date = new Date(Date.UTC(y, m - 1 + offset, 1));
  const result = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
  personalMonthBounds(result); return result;
}

function categoryMap(categories) {
  const map = new Map();
  for (const item of categories || []) {
    if (typeof item === 'string') map.set(item, item);
    else if (item && typeof item === 'object') {
      const id = item.code ?? item.id ?? item.key ?? item.value;
      const label = item.short ?? item.label ?? item.name ?? item.category ?? item.desc;
      if (id != null && label) map.set(String(id), clean(label));
    }
  }
  return map;
}

// Supports current IFS Bridge signed decimal amounts and Pocket's positive
// integer amountMinor + kind. Ambiguous/conflicting signs become visible issues,
// rather than silently producing a different spending total.
export function normalizePersonalEntries(rows, { categories = [] } = {}) {
  if (!Array.isArray(rows)) throw Error('Personal entries must be an array.');
  const labels = categoryMap(categories), entries = [], issues = [];
  let excludedCount = 0;
  const ids = new Set();
  rows.forEach((source, index) => {
    if (!source || typeof source !== 'object') { issues.push({ index, id: '', date: '', reason: 'Invalid entry.' }); return; }
    if (!isSpendingRecord(source)) { excludedCount++; return; }
    try {
      const date = String(source.date || '');
      if (!validDate(date)) throw Error('Invalid entry date.');
      const currency = clean(source.currency).toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw Error('Invalid currency code.');
      let signedMinor;
      const rawKind = keyOf(source.kind || '');
      if (Object.hasOwn(source, 'amountMinor')) {
        const amount = source.amountMinor;
        if (!Number.isSafeInteger(amount) || amount <= 0) throw Error('amountMinor must be a positive integer.');
        if (!['expense', 'purchase', 'refund'].includes(rawKind)) throw Error('An integer-amount entry needs a purchase or refund type.');
        signedMinor = rawKind === 'refund' ? -amount : amount;
      } else {
        signedMinor = minorAmount(source.amount);
        if (!signedMinor) throw Error('The entry amount cannot be zero.');
        // Signed amounts are the existing Personal store format. A positive
        // decimal with explicit refund kind is also accepted for reviewed imports.
        if (rawKind === 'refund') signedMinor = -Math.abs(signedMinor);
        else if (rawKind && !['expense', 'purchase'].includes(rawKind)) throw Error('Unsupported entry type.');
        else if (rawKind && signedMinor < 0) throw Error('A purchase cannot have a negative amount.');
      }
      const id = source.id == null || source.id === '' ? `row-${index}` : String(source.id);
      if (ids.has(id)) throw Error('Duplicate entry identifier; refresh the loaded records.');
      ids.add(id);
      const category = clean(source.personalCategory || source.category) || labels.get(String(source.code)) || 'Uncategorized';
      const merchant = clean(source.merchant || source.vendor || '');
      const note = String(source.note ?? source.written ?? '').trim();
      const description = String(source.written ?? source.description ?? '').trim();
      entries.push({ id, date, currency, amountMinor: Math.abs(signedMinor), signedMinor, kind: signedMinor < 0 ? 'refund' : 'purchase', category, categoryKey: keyOf(category), code: source.code, merchant, merchantKey: keyOf(merchant), note, description, source });
    } catch (error) { issues.push({ index, id: source.id == null ? '' : String(source.id), date: String(source.date || ''), reason: error.message }); }
  });
  entries.sort(dateSort);
  return { entries, issues, excludedCount, inputCount: rows.length };
}

function totals(entries, currency) {
  let purchasesMinor = 0, refundsMinor = 0;
  for (const entry of entries) {
    if (entry.currency !== currency) throw Error('A spending total cannot combine currencies.');
    if (entry.kind === 'refund') refundsMinor = safeAdd(refundsMinor, entry.amountMinor);
    else purchasesMinor = safeAdd(purchasesMinor, entry.amountMinor);
  }
  return { currency, purchasesMinor, refundsMinor, netMinor: safeAdd(purchasesMinor, -refundsMinor), count: entries.length, daysRecorded: new Set(entries.map(e => e.date)).size };
}

function groups(entries, dimension, summary) {
  const map = new Map();
  for (const entry of entries) {
    const key = dimension === 'category' ? entry.categoryKey : entry.merchantKey;
    const label = dimension === 'category' ? entry.category : entry.merchant || 'No merchant recorded';
    const item = map.get(key) || { key, label, currency: summary.currency, purchasesMinor: 0, refundsMinor: 0, netMinor: 0, count: 0, purchaseSharePercent: 0, entryIds: [] };
    item.count++; item.entryIds.push(entry.id);
    if (entry.kind === 'refund') item.refundsMinor = safeAdd(item.refundsMinor, entry.amountMinor);
    else item.purchasesMinor = safeAdd(item.purchasesMinor, entry.amountMinor);
    item.netMinor = safeAdd(item.purchasesMinor, -item.refundsMinor);
    map.set(key, item);
  }
  for (const item of map.values()) item.purchaseSharePercent = summary.purchasesMinor ? Math.round(item.purchasesMinor / summary.purchasesMinor * 1000) / 10 : 0;
  return [...map.values()].sort((a, b) => b.purchasesMinor - a.purchasesMinor || b.refundsMinor - a.refundsMinor || a.label.localeCompare(b.label));
}

function days(entries, month, today, limit = null) {
  const bounds = personalMonthBounds(month), count = limit == null ? bounds.days : limit;
  const byDate = new Map();
  for (const entry of entries) {
    if (!byDate.has(entry.date)) byDate.set(entry.date, []);
    byDate.get(entry.date).push(entry);
  }
  let cumulativePurchasesMinor = 0, cumulativeRefundsMinor = 0;
  return Array.from({ length: count }, (_, index) => {
    const day = index + 1, date = `${month}-${String(day).padStart(2, '0')}`, chosen = byDate.get(date) || [];
    const summary = totals(chosen, entries[0]?.currency || '');
    cumulativePurchasesMinor = safeAdd(cumulativePurchasesMinor, summary.purchasesMinor);
    cumulativeRefundsMinor = safeAdd(cumulativeRefundsMinor, summary.refundsMinor);
    return { date, day, purchasesMinor: summary.purchasesMinor, refundsMinor: summary.refundsMinor, netMinor: summary.netMinor, cumulativePurchasesMinor, cumulativeRefundsMinor, cumulativeNetMinor: safeAdd(cumulativePurchasesMinor, -cumulativeRefundsMinor), count: chosen.length, entryIds: chosen.map(e => e.id), isFuture: date > today };
  });
}

export function filterPersonalEntries(entries, filters = {}) {
  const { dateFrom = '', dateTo = '', date = '' } = filters;
  for (const value of [dateFrom, dateTo, date]) if (value && !validDate(value)) throw Error('Choose valid dates for the transaction filter.');
  if (dateFrom && dateTo && dateFrom > dateTo) throw Error('The filter start date must be before its end date.');
  const kind = filters.kind === 'expense' ? 'purchase' : filters.kind || 'all';
  if (!['all', 'purchase', 'refund'].includes(kind)) throw Error('Choose all transactions, purchases or refunds.');
  const search = keyOf(filters.search), category = keyOf(filters.category), merchant = keyOf(filters.merchant);
  return entries.filter(entry => (!date || entry.date === date) && (!dateFrom || entry.date >= dateFrom) && (!dateTo || entry.date <= dateTo) &&
    (!category || category === 'all' || entry.categoryKey === category || String(entry.code) === String(filters.category)) &&
    // '__missing__' makes the unrecorded-merchant breakdown actionable without
    // confusing an empty filter (all merchants) with an empty merchant value.
    (!merchant || merchant === 'all' || merchant === '__missing__' && !entry.merchantKey || entry.merchantKey === merchant) &&
    (kind === 'all' || entry.kind === kind) &&
    (!search || keyOf([entry.merchant, entry.note, entry.description, entry.category, entry.date, entry.currency, (entry.signedMinor / 100).toFixed(2)].join(' ')).includes(search)));
}

function sameElapsedComparison(entries, { month, today, currency, complete }) {
  const currentBounds = personalMonthBounds(month);
  const todayMonth = today.slice(0, 7), isFutureMonth = month > todayMonth;
  const elapsedDays = isFutureMonth ? 0 : month === todayMonth ? Number(today.slice(8)) : currentBounds.days;
  // The earliest valid journal month has no supported preceding month. Keep its
  // analysis usable and explicitly omit the comparison instead of throwing.
  if (month === '1000-01') return {
    available: false, reason: 'The previous month is outside the supported date range.', previousMonth: null,
    days: 0, elapsedDays, isCurrentMonth: month === todayMonth, isFutureMonth,
    currentStart: currentBounds.first, currentEnd: null, previousStart: null, previousEnd: null,
    current: totals([], currency), previous: totals([], currency), netDeltaMinor: null, purchasesDeltaMinor: null,
    refundsDeltaMinor: null, netDeltaPercent: null, purchasesDeltaPercent: null, currentDaily: [], previousDaily: [],
    label: 'Comparison unavailable', caveat: 'The selected month is valid; no earlier supported month is available for comparison.',
  };
  const previousMonth = shiftPersonalMonth(month, -1), previousBounds = personalMonthBounds(previousMonth);
  // Equal elapsed days, even when the previous month is shorter. The full-month
  // summary still includes every entry; only this comparison is shortened.
  const comparisonDays = Math.min(elapsedDays, previousBounds.days);
  const end = period => comparisonDays ? `${period}-${String(comparisonDays).padStart(2, '0')}` : null;
  const currentEnd = end(month), previousEnd = end(previousMonth);
  const currentEntries = entries.filter(e => e.currency === currency && e.date >= currentBounds.first && currentEnd && e.date <= currentEnd);
  const previousEntries = entries.filter(e => e.currency === currency && e.date >= previousBounds.first && previousEnd && e.date <= previousEnd);
  const current = totals(currentEntries, currency), previous = totals(previousEntries, currency);
  const available = !!complete && comparisonDays > 0 && current.count > 0 && previous.count > 0;
  const reason = !complete ? 'Some records could not be loaded or validated.' : !comparisonDays ? 'This month has not started yet.' : !previous.count ? 'No entries are recorded for the matching previous-month period.' : !current.count ? 'No entries are recorded for the current comparison period.' : '';
  const netDeltaMinor = available ? safeAdd(current.netMinor, -previous.netMinor) : null;
  const purchasesDeltaMinor = available ? safeAdd(current.purchasesMinor, -previous.purchasesMinor) : null;
  return { available, reason, previousMonth, days: comparisonDays, elapsedDays, isCurrentMonth: month === todayMonth, isFutureMonth,
    currentStart: currentBounds.first, currentEnd, previousStart: previousBounds.first, previousEnd,
    current, previous, netDeltaMinor, purchasesDeltaMinor, refundsDeltaMinor: available ? safeAdd(current.refundsMinor, -previous.refundsMinor) : null,
    netDeltaPercent: available && previous.netMinor > 0 ? Math.round(netDeltaMinor / previous.netMinor * 1000) / 10 : null,
    purchasesDeltaPercent: available && previous.purchasesMinor > 0 ? Math.round(purchasesDeltaMinor / previous.purchasesMinor * 1000) / 10 : null,
    currentDaily: days(currentEntries, month, today, comparisonDays), previousDaily: days(previousEntries, previousMonth, today, comparisonDays),
    label: comparisonDays ? `First ${comparisonDays} day${comparisonDays === 1 ? '' : 's'} of each month` : 'Comparison unavailable',
    caveat: 'Compares recorded entries only. Missing entries are unknown spending, not proof of zero spending or savings.' };
}

/**
 * All aggregate amounts are integer hundredths. Full-month chart totals stay
 * independent of list filters, while filteredTotals describes filteredEntries.
 * `complete` means the supplied records loaded successfully, never that every
 * real-world purchase was recorded. No bank balance or forecast is calculated.
 */
export function analyzePersonalMonth(rows, { month, today, currency = '', categories = [], filters = {}, complete = true } = {}) {
  const bounds = personalMonthBounds(month);
  if (!validDate(today)) throw Error('Supply today as a valid local calendar date.');
  const normalized = normalizePersonalEntries(rows, { categories });
  const monthEntries = normalized.entries.filter(e => e.date >= bounds.first && e.date <= bounds.last);
  const currencies = [...new Set(monthEntries.map(e => e.currency))].sort();
  currency = clean(currency).toUpperCase() || currencies[0] || 'TRY';
  if (!/^[A-Z]{3}$/.test(currency)) throw Error('Choose a three-letter currency.');
  const entries = monthEntries.filter(e => e.currency === currency), selectedTotals = totals(entries, currency);
  const filteredEntries = filterPersonalEntries(entries, filters), filteredTotals = totals(filteredEntries, currency);
  const currencyTotals = currencies.map(c => totals(monthEntries.filter(e => e.currency === c), c));
  const categoryGroups = groups(entries, 'category', selectedTotals), merchantGroups = groups(entries, 'merchant', selectedTotals).map(group => ({ ...group, key: group.key || '__missing__' }));
  // The UI carries the ordinary recorded-data explanation as a footnote. Reserve
  // warnings for conditions specific to the actual selected records.
  const warnings = [];
  const validComplete = !!complete && normalized.issues.length === 0;
  if (!complete) warnings.push('Records are incomplete. Totals describe only the entries that loaded; comparisons are unavailable.');
  if (normalized.issues.length) warnings.push(`${normalized.issues.length} invalid entr${normalized.issues.length === 1 ? 'y was' : 'ies were'} excluded. Correct them before relying on totals or exporting.`);
  const futureCount = entries.filter(e => e.date > today).length;
  if (futureCount) warnings.push(`${futureCount} entr${futureCount === 1 ? 'y is' : 'ies are'} dated after today. The month total includes them; the elapsed-day comparison does not.`);
  if (selectedTotals.netMinor < 0) warnings.push('Recorded refunds exceed purchases in this month. Refunds are counted on their recorded date.');
  const comparison = sameElapsedComparison(normalized.entries, { month, today, currency, complete: validComplete });
  const dates = entries.map(e => e.date).sort();
  return { month, currency, monthStart: bounds.first, monthEnd: bounds.last, daysInMonth: bounds.days,
    entries, filteredEntries, selectedTotals, filteredTotals, currencyTotals, currencies, categories: categoryGroups, merchants: merchantGroups,
    daily: days(entries, month, today), comparison,
    coverage: { complete: validComplete, inputCount: normalized.inputCount, excludedCount: normalized.excludedCount, invalidCount: normalized.issues.length, issues: normalized.issues, monthEntryCount: monthEntries.length, selectedCurrencyCount: entries.length, futureCount, firstRecordedDate: dates[0] || null, lastRecordedDate: dates.at(-1) || null, recordedDays: selectedTotals.daysRecorded, missingDaysAreUnknown: true },
    warnings };
}

// Compatible with Pocket's actual exported header/type conventions. This export
// always includes the whole selected month and every currency, regardless of the
// visible category/search/day/kind filters. Formula-looking text is neutralized.
export function exportPersonalMonthCsv(rows, { month, categories = [] } = {}) {
  const bounds = personalMonthBounds(month), normalized = normalizePersonalEntries(rows, { categories });
  const invalid = normalized.issues.filter(issue => !validDate(issue.date) || issue.date >= bounds.first && issue.date <= bounds.last);
  if (invalid.length) throw Error(`Cannot export this month until ${invalid.length} invalid entr${invalid.length === 1 ? 'y is' : 'ies are'} corrected.`);
  const entries = normalized.entries.filter(e => e.date >= bounds.first && e.date <= bounds.last).sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const escape = value => { let text = String(value ?? ''); if (/^[\s\uFEFF]*[=+@-]/.test(text)) text = "'" + text; return `"${text.replace(/"/g, '""')}"`; };
  const output = [['Date', 'Type', 'Amount', 'Currency', 'Category', 'Merchant', 'Note'], ...entries.map(e => [e.date, e.kind === 'refund' ? 'refund' : 'expense', (e.amountMinor / 100).toFixed(2), e.currency, e.category, e.merchant, e.note])];
  return '\uFEFF' + output.map(row => row.map(escape).join(',')).join('\r\n');
}
