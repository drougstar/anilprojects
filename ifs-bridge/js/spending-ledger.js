// A read-only view of the active account's Personal and Work records. The caller
// supplies the already-authorized Work context. No record is saved or classified.
import { minorAmount, validDate, isSpendingRecord, spendingPurpose } from './expense-workflows.js';
import { merchantEvidence } from './work-match.js';

const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const currency = row => clean(row.currency).toUpperCase();
const references = new Set(['payment', 'transfer', 'financing', 'pending', 'reward', 'unknown']);
const live = row => row && !row.deleted && !row.perdiem;
const bankRow = row => !!(row.bankTransaction || row.bankImport || row.transactionKey || row.sourceType);
const linkId = row => row.workExpenseLink?.workspace === 'work' ? clean(row.workExpenseLink.expenseId) : '';
const gap = (left, right) => Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86400000;

function signedAmount(row) {
  try {
    const kind = clean(row.kind).toLowerCase();
    if (Object.hasOwn(row, 'amountMinor')) {
      if (!Number.isSafeInteger(row.amountMinor) || row.amountMinor <= 0 || !['purchase', 'expense', 'refund'].includes(kind)) return null;
      return kind === 'refund' ? -row.amountMinor : row.amountMinor;
    }
    const value = minorAmount(row.amount);
    if (kind === 'refund') return -Math.abs(value);
    if (kind && !['purchase', 'expense', 'fee'].includes(kind) || value < 0 && ['purchase', 'expense', 'fee'].includes(kind)) return null;
    return value || null;
  } catch { return null; }
}
const matchable = row => live(row) && isSpendingRecord(row) && !references.has(row.kind) &&
  validDate(row.date) && /^[A-Z]{3}$/.test(currency(row)) && signedAmount(row) !== null;
const sameMoney = (left, right) => signedAmount(left) === signedAmount(right) && currency(left) === currency(right);
const ownCompany = row => row.spendingPurpose === 'business' || row.business === true;
const explicitPersonal = row => row.spendingPurpose === 'personal' || row.usage === 'personal' ||
  !bankRow(row) && row.business === false && row.spendingPurpose !== 'business';

function validRows(value, name) {
  if (!Array.isArray(value)) throw Error(`${name} records could not be read.`);
  const seen = new Set();
  for (const row of value) {
    if (!row || typeof row !== 'object' || !clean(row.id) || seen.has(String(row.id))) throw Error(`${name} contains an invalid or duplicate record identifier. Reload the records before analysing them.`);
    seen.add(String(row.id));
  }
  return value.filter(live);
}

function tripInfo(row, workspace, trips) {
  const suggestion = row.workTripSuggestion?.workspace === 'work' ? row.workTripSuggestion : null;
  const id = clean(row.tripId || suggestion?.tripId);
  if (!id) return null;
  const source = row.tripId ? workspace : 'work';
  const trip = source === 'work' ? trips.get(id) : null;
  return { id, workspace: source, name: clean(trip?.name || trip?.title || row.tripName) || 'Trip' };
}
function tripFields(info) {
  return { ledgerTrip: !!info, ledgerTripId: info?.id || '', ledgerTripName: info?.name || '', ledgerTripWorkspace: info?.workspace || '' };
}

// Only display fields cross into the projected row. Receipts, reimbursement
// payments, account metadata and the editable Work object are not duplicated.
const workDisplayFields = ['date', 'amount', 'amountMinor', 'currency', 'code', 'kind', 'merchant', 'vendor', 'written', 'description', 'note', 'personalCategory', 'category', 'business', 'spendingPurpose', 'usage', 'bankKind', 'excludeFromSpending', 'tripId', 'sheetId', 'created_at', 'updated_at'];
function projectWork(row, trips) {
  const result = Object.fromEntries(workDisplayFields.filter(key => Object.hasOwn(row, key)).map(key => [key, row[key]]));
  const amount = signedAmount(row);
  const bankKind = row.bankKind || (references.has(row.kind) || row.kind === 'fee' ? row.kind : '');
  result.id = `work:${row.id}`;
  result.sourceWorkspace = 'work'; result.workSourceId = String(row.id);
  result.ledgerReadOnly = true; result.ledgerMatch = ''; result.ledgerWork = row.business === true;
  result.ledgerPurpose = result.ledgerWork ? 'business' : 'personal';
  result.merchant = clean(row.merchant || row.vendor || row.written || row.description);
  result.note = String(row.note ?? row.written ?? '').trim();
  result.personalCategory = clean(row.personalCategory || row.category || row.categoryName) || (row.business ? 'Company expense' : 'Other spending');
  result.category = result.personalCategory;
  if (!row.kind || row.kind === 'fee' || references.has(row.kind)) result.kind = amount != null && amount < 0 ? 'refund' : 'purchase';
  if (bankKind) result.bankKind = bankKind;
  if (references.has(bankKind)) result.excludeFromSpending = true;
  return { ...result, ...tripFields(tripInfo(row, 'work', trips)) };
}

/**
 * Returns display rows with sourceWorkspace, workSourceId, ledgerMatch,
 * ledgerReadOnly, ledgerWork, ledgerPurpose, and ledgerTrip/Id/Name/Workspace fields.
 * Explicit links win when money still agrees. Otherwise only unique exact
 * merchant + signed amount + currency matches within three days are combined.
 * Ambiguous pairs stay visible and counted separately, with a warning that the
 * totals may contain duplicates. Purpose choices on saved records never change.
 */
export function combineSpendingRows(personalRows, workContext = {}) {
  const personal = validRows(personalRows, 'Personal');
  const work = validRows(workContext.expenses || [], 'Work');
  const trips = new Map((workContext.trips || []).filter(row => row && !row.deleted).map(row => [String(row.id), row]));
  const workById = new Map(work.map(row => [String(row.id), row]));
  const personalById = new Map(personal.map(row => [String(row.id), row]));
  const eligiblePersonal = personal.filter(matchable), eligibleWork = work.filter(matchable);
  const pairs = new Map(), consumed = new Set(), possible = new Map(), warnings = [];
  const count = { missing: 0, changed: 0, conflict: 0 };
  const notePair = (row, expense, reason) => {
    const key = JSON.stringify([String(row.id), String(expense.id)]);
    if (!possible.has(key)) possible.set(key, { personalId: String(row.id), workId: String(expense.id), reason });
  };
  const pair = (row, expense, method) => {
    pairs.set(String(row.id), { expense, method }); consumed.add(String(expense.id));
  };

  const linked = new Map();
  for (const row of eligiblePersonal) if (linkId(row)) {
    const id = linkId(row), list = linked.get(id) || []; list.push(row); linked.set(id, list);
  }
  for (const [id, rows] of linked) {
    const expense = workById.get(id);
    if (!expense || !matchable(expense)) { count.missing += rows.length; continue; }
    if (rows.length > 1) { rows.forEach(row => notePair(row, expense, 'Several Personal records link to the same Work expense.')); continue; }
    if (!sameMoney(rows[0], expense)) {
      count.changed++; notePair(rows[0], expense, 'The linked Work amount or currency has changed. Both records remain visible.'); continue;
    }
    pair(rows[0], expense, 'linked');
  }

  // The entire loaded ledger participates before any month or purpose filter.
  // A filter must not turn two competing purchases into one apparent match.
  const candidates = new Map(), exactUses = new Map();
  for (const row of eligiblePersonal) {
    const list = eligibleWork.filter(expense => sameMoney(row, expense) && gap(row.date, expense.date) <= 3).map(expense => ({ expense, exact: merchantEvidence(row, expense).level === 'merchant' }));
    candidates.set(String(row.id), list);
    for (const candidate of list.filter(item => item.exact)) {
      const key = String(candidate.expense.id), uses = exactUses.get(key) || []; uses.push(row); exactUses.set(key, uses);
    }
  }
  for (const row of eligiblePersonal) {
    if (pairs.has(String(row.id)) || linkId(row)) continue;
    const exact = (candidates.get(String(row.id)) || []).filter(item => item.exact);
    if (exact.length === 1 && exactUses.get(String(exact[0].expense.id))?.length === 1 && !consumed.has(String(exact[0].expense.id))) pair(row, exact[0].expense, 'exact');
  }
  for (const row of eligiblePersonal) {
    const paired = pairs.get(String(row.id));
    if (paired) continue;
    for (const candidate of candidates.get(String(row.id)) || []) {
      if (linkId(row) && linkId(row) !== String(candidate.expense.id)) continue;
      if (candidate.exact) notePair(row, candidate.expense, 'More than one record may describe this purchase. No automatic combination was made.');
      else if (!consumed.has(String(candidate.expense.id))) notePair(row, candidate.expense, 'The amount and date fit, but the merchant does not establish a unique match.');
    }
  }

  const rows = personal.map(row => {
    const match = pairs.get(String(row.id)), expense = match?.expense;
    const personalChoice = explicitPersonal(row);
    if (personalChoice && expense?.business === true) count.conflict++;
    const ledgerWork = !personalChoice && (ownCompany(row) || expense?.business === true);
    const trip = tripInfo(row, 'personal', trips) || (expense ? tripInfo(expense, 'work', trips) : null);
    const reference = references.has(row.bankKind || row.kind);
    return { ...row, ...(reference ? { bankKind: row.bankKind || row.kind, excludeFromSpending: true } : {}), sourceWorkspace: 'personal', workSourceId: expense ? String(expense.id) : linkId(row), ledgerReadOnly: false,
      ledgerMatch: match?.method || '', ledgerWork,
      ledgerPurpose: personalChoice ? 'personal' : ledgerWork ? 'business' : spendingPurpose(row), ...tripFields(trip) };
  });
  for (const expense of work) if (!consumed.has(String(expense.id))) {
    const projected = projectWork(expense, trips);
    if (personalById.has(projected.id)) throw Error('Personal and Work display identifiers conflict. Reload the records before analysing them.');
    rows.push(projected);
  }
  if (possible.size) warnings.push(`${possible.size} possible duplicate pair${possible.size === 1 ? '' : 's'} remain counted separately. Totals may include duplicate spending.`);
  if (count.missing) warnings.push(`${count.missing} linked Work record${count.missing === 1 ? ' is' : 's are'} unavailable. The Personal transaction${count.missing === 1 ? ' remains' : 's remain'} visible.`);
  if (count.changed) warnings.push(`${count.changed} linked Work amount${count.changed === 1 ? ' has' : 's have'} changed. Both versions remain visible until resolved.`);
  if (count.conflict) warnings.push(`${count.conflict} Personal choice${count.conflict === 1 ? ' differs' : 's differ'} from a company claim in Work. Your Personal choice is kept in this view.`);
  return { rows, matchedCount: pairs.size, workOnlyCount: work.length - consumed.size, possibleDuplicates: [...possible.values()], warnings };
}
