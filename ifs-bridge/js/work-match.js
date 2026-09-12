// Suggestions are pure data. Only a separate, explicit review action creates
// Personal changes; this module never writes to the Work ledger or a service.
import { minorAmount, validDate, isSpendingRecord, spendingPurpose } from './expense-workflows.js';
import { personalMonthBounds } from './personal-analytics.js';

const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const merchantKey = value => clean(value).normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/ı/g, 'i').replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const amount = row => { try { return minorAmount(row.amount); } catch { return null; } };
const currency = row => clean(row.currency).toUpperCase();
const inMonth = (row, month) => !month || row.date?.slice(0, 7) === month;
const linkId = row => row.workExpenseLink?.workspace === 'work' ? clean(row.workExpenseLink.expenseId) : '';
const active = rows => rows.filter(row => row && !row.deleted);
const dayGap = (a, b) => Math.abs(Date.parse(a + 'T00:00:00Z') - Date.parse(b + 'T00:00:00Z')) / 86400000;
function rowsOf(value, name) {
  if (!Array.isArray(value)) throw Error(`${name} records could not be read. Reload the review.`);
  const seen = new Set();
  for (const row of value) {
    if (!row || !clean(row.id) || seen.has(String(row.id))) throw Error(`${name} contains an invalid or duplicate identifier. Resolve it before reviewing.`);
    seen.add(String(row.id));
  }
  return value;
}
function validateOptions({ month, dateWindow = 3 }) {
  if (month) personalMonthBounds(month);
  if (!Number.isInteger(dateWindow) || dateWindow < 0 || dateWindow > 7) throw Error('Choose a date window from zero to seven days.');
}
export function reviewableBankRow(row) {
  return !!row?.bankTransaction && isSpendingRecord(row) && ['purchase', 'refund', 'fee'].includes(row.bankKind || row.kind) && validDate(row.date) && /^[A-Z]{3}$/.test(currency(row)) && !!amount(row);
}
const purchase = row => reviewableBankRow(row) && (row.bankKind || row.kind) === 'purchase' && amount(row) > 0;
const workPurchase = row => isSpendingRecord(row) && row.business === true && row.kind !== 'refund' && amount(row) > 0 && validDate(row.date) && /^[A-Z]{3}$/.test(currency(row));
export function reviewVersion(row) {
  // Dirty flags and server revision acknowledgements do not change what was
  // reviewed. Everything the user can edit, including source metadata, does.
  const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().filter(key => !['dirty', '_remoteRevision'].includes(key)).map(key => [key, canonical(value[key])])) : value;
  return JSON.stringify(canonical(row));
}
export function merchantEvidence(bank, work) {
  const left = merchantKey(bank.merchant || bank.vendor || bank.bankDescription), right = merchantKey(work.vendor || work.merchant);
  if (!left || !right) return { level: 'amount-date', reason: 'Merchant missing on one side; compare the receipt.' };
  if (left === right) return { level: 'merchant', reason: 'Merchant names match.' };
  const tokens = new Set(left.split(' ').filter(token => token.length > 2));
  const shared = [...new Set(right.split(' ').filter(token => token.length > 2 && tokens.has(token)))];
  return shared.length ? { level: 'similar-merchant', reason: `Merchant text overlaps: ${shared.join(', ')}. Check the full names.` } : { level: 'amount-date', reason: 'Merchant names differ; compare the receipt before linking.' };
}
export function planWorkMatches(bankRows, context, options = {}) {
  validateOptions(options); rowsOf(bankRows, 'Personal'); rowsOf(context?.expenses, 'Work');
  const used = new Map();
  for (const row of active(bankRows)) if (linkId(row)) used.set(linkId(row), [...(used.get(linkId(row)) || []), row.id]);
  const sheets = new Map((context.sheets || []).filter(row => !row.deleted).map(row => [row.id, row]));
  const available = context.expenses.filter(row => workPurchase(row) && !used.has(row.id));
  const result = bankRows.filter(row => purchase(row) && inMonth(row, options.month) && !linkId(row)).map(bank => {
    const candidates = available.filter(work => currency(work) === currency(bank) && amount(work) === amount(bank) && dayGap(work.date, bank.date) <= (options.dateWindow ?? 3)).map(work => ({
      expenseId: work.id, expense: work, expectedVersion: reviewVersion(work), dateGap: dayGap(work.date, bank.date),
      sheetName: clean(sheets.get(work.sheetId)?.title || sheets.get(work.sheetId)?.name || sheets.get(work.sheetId)?.shortName), ...merchantEvidence(bank, work),
    })).sort((a, b) => (a.level === 'merchant' ? 0 : 1) - (b.level === 'merchant' ? 0 : 1) || a.dateGap - b.dateGap || a.expenseId.localeCompare(b.expenseId));
    return { bankId: bank.id, bank, expectedVersion: reviewVersion(bank), candidates };
  });
  const uses = new Map();
  for (const item of result) for (const candidate of item.candidates) uses.set(candidate.expenseId, (uses.get(candidate.expenseId) || 0) + 1);
  return result.map(item => ({ ...item, candidates: item.candidates.map(candidate => ({ ...candidate, contested: uses.get(candidate.expenseId) > 1 })), ambiguous: item.candidates.length > 1 || item.candidates.some(candidate => uses.get(candidate.expenseId) > 1), status: item.candidates.length ? 'suggested' : 'unmatched' }));
}
function validateSelections(choices, field = 'bankId') {
  if (!Array.isArray(choices) || !choices.length) throw Error('Select at least one transaction first.');
  const ids = choices.map(choice => choice[field]);
  if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw Error('Each transaction can only be selected once.');
}
function checkedBank(bankRows, preview, id) {
  const before = preview.find(item => item.bankId === id), bank = bankRows.find(row => row.id === id);
  if (!before || !bank || !reviewableBankRow(bank) || reviewVersion(bank) !== before.expectedVersion) throw Error('A bank transaction changed since the preview. Reload and review it again.');
  return bank;
}
function classified(bank, purpose, at) {
  const record = { ...bank, spendingPurpose: purpose, business: purpose === 'business', bankReviewFields: [...new Set([...(bank.bankReviewFields || []), 'spendingPurpose'])], purposeReviewedAt: at };
  if (purpose !== 'business') { delete record.workExpenseLink; delete record.workTripSuggestion; }
  return record;
}
export function prepareWorkMatchChanges(bankRows, context, choices, preview, { at, ...options } = {}) {
  validateSelections(choices); rowsOf(bankRows, 'Personal');
  const currentPlan = planWorkMatches(bankRows, context, options), assigned = new Set();
  return choices.map(choice => {
    const bank = checkedBank(bankRows, preview, choice.bankId);
    if (!choice.expenseId) throw Error('Choose a Work expense for every selected transaction.');
    if (assigned.has(choice.expenseId)) throw Error('Two bank charges cannot link to the same Work expense. Choose one, then review the other separately.');
    assigned.add(choice.expenseId);
    const prior = preview.find(item => item.bankId === bank.id)?.candidates.find(item => item.expenseId === choice.expenseId);
    const candidate = currentPlan.find(item => item.bankId === bank.id)?.candidates.find(item => item.expenseId === choice.expenseId);
    if (!prior || !candidate || prior.expectedVersion !== candidate.expectedVersion) throw Error('A Work expense changed or was linked since this preview. Reload and review it again.');
    const record = classified(bank, 'business', at);
    delete record.workTripSuggestion;
    record.workExpenseLink = { workspace: 'work', expenseId: candidate.expenseId, sheetId: candidate.expense.sheetId || '', reviewedAt: at, sourceUpdatedAt: candidate.expense.updated_at || '' };
    return { table: 'expenses', record, expectedUpdatedAt: bank.updated_at, expectedRecord: bank };
  });
}
export function groupBankReview(bankRows, { month, groupBy = 'merchant', purpose = 'review' } = {}) {
  validateOptions({ month }); rowsOf(bankRows, 'Personal');
  if (!['merchant', 'card'].includes(groupBy) || !['all', 'review', 'personal', 'business'].includes(purpose)) throw Error('Choose a valid review group and purpose.');
  const groups = new Map();
  for (const bank of bankRows.filter(row => reviewableBankRow(row) && inMonth(row, month) && (purpose === 'all' || spendingPurpose(row) === purpose))) {
    const label = clean(groupBy === 'card' ? bank.card || bank.cardName : bank.merchant || bank.vendor || bank.bankDescription) || (groupBy === 'card' ? 'No card recorded' : 'No merchant recorded');
    // Card IDs distinguish two cards even when their display labels coincide.
    const key = `${groupBy === 'card' ? clean(bank.accountId) || merchantKey(label) : merchantKey(label)}|${currency(bank)}`;
    const group = groups.get(key) || { key, label, currency: currency(bank), amountMinor: 0, rows: [] };
    group.amountMinor += amount(bank); if (!Number.isSafeInteger(group.amountMinor)) throw Error('A review total is too large.');
    group.rows.push({ bankId: bank.id, bank, expectedVersion: reviewVersion(bank) }); groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => b.rows.length - a.rows.length || a.label.localeCompare(b.label));
}
export function prepareBankPurposeChanges(bankRows, choices, preview, { purpose, at } = {}) {
  validateSelections(choices); rowsOf(bankRows, 'Personal');
  if (!['business', 'personal', 'review'].includes(purpose)) throw Error('Choose Work, Personal, or Needs review.');
  return choices.map(choice => { const bank = checkedBank(bankRows, preview, choice.bankId); return { table: 'expenses', record: classified(bank, purpose, at), expectedUpdatedAt: bank.updated_at, expectedRecord: bank }; });
}
export function planTripSuggestions(bankRows, context, { month, card = '', merchant = '' } = {}) {
  validateOptions({ month }); rowsOf(bankRows, 'Personal'); rowsOf(context?.trips, 'Work trip');
  const trips = context.trips.filter(trip => !trip.deleted && validDate(trip.start) && validDate(trip.end) && trip.end >= trip.start);
  return bankRows.filter(bank => purchase(bank) && inMonth(bank, month) && !linkId(bank) && spendingPurpose(bank) !== 'business' && (!card || (bank.accountId || bank.card || '') === card) && (!merchant || merchantKey(bank.merchant || bank.vendor || bank.bankDescription).includes(merchantKey(merchant)))).map(bank => ({
    bankId: bank.id, bank, expectedVersion: reviewVersion(bank), candidates: trips.filter(trip => bank.date >= trip.start && bank.date <= trip.end).map(trip => ({ tripId: trip.id, trip, expectedVersion: reviewVersion(trip), reason: `Date falls within ${clean(trip.name) || 'Work trip'} (${trip.start} to ${trip.end}). Dates alone do not establish a Work expense.` })),
  })).filter(item => item.candidates.length);
}
export function prepareTripPurposeChanges(bankRows, context, choices, preview, { at, ...options } = {}) {
  validateSelections(choices); rowsOf(bankRows, 'Personal');
  const currentPlan = planTripSuggestions(bankRows, context, options);
  return choices.map(choice => {
    const bank = checkedBank(bankRows, preview, choice.bankId);
    if (!choice.tripId) throw Error('Choose a Work trip for every selected transaction.');
    const prior = preview.find(item => item.bankId === bank.id)?.candidates.find(item => item.tripId === choice.tripId), candidate = currentPlan.find(item => item.bankId === bank.id)?.candidates.find(item => item.tripId === choice.tripId);
    if (!prior || !candidate || prior.expectedVersion !== candidate.expectedVersion) throw Error('The Work trip or bank transaction changed. Reload the suggestions before applying.');
    const record = classified(bank, 'business', at);
    record.workTripSuggestion = { workspace: 'work', tripId: candidate.tripId, reviewedAt: at };
    return { table: 'expenses', record, expectedUpdatedAt: bank.updated_at, expectedRecord: bank };
  });
}
