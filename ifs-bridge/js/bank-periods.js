// Pure statement-cycle metadata. Source files establish membership. Their last
// posted activity can estimate a close, but never a payment deadline or balance.
import { stableId, validDate } from './expense-workflows.js';
import { parseBankDate, bankAccountId, deriveBankCardAliases } from './bank-import.js';

const DAY = 86400000;
const clean = value => String(value ?? '').trim();
const fold = value => clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').toLowerCase();
const unique = values => [...new Set(values)].sort();
const copy = value => JSON.parse(JSON.stringify(value));
const identity = (prefix, ...parts) => stableId(prefix, JSON.stringify(parts));
const iso = milliseconds => new Date(milliseconds).toISOString().slice(0, 10);
const shifted = (date, days) => iso(Date.parse(`${date}T00:00:00Z`) + days * DAY);
function checkedDate(date) {
  if (!validDate(date) || Number(date.slice(0, 4)) < 1901 || Number(date.slice(0, 4)) > 9998) throw Error('Choose a valid bank date between 1901 and 9998.');
  return date;
}
function checkedMonth(month) { checkedDate(`${month}-01`); return month; }
// A period keeps its original ID/account fields. Its retained source filenames
// or member rows can establish the corrected identity for matching and display.
export function bankPeriodAccountId(period, { expenses = [], cardAliases = {} } = {}) {
  const options = { cardAliases }, evidence = [];
  const members = new Set(period.memberIds || []);
  const memberRows = expenses.filter(row => members.has(row.id) && row.accountId === period.accountId);
  for (const row of memberRows) evidence.push(bankAccountId(row, options));
  for (const source of period.sources || []) if (source.sourceFile && (memberRows.length || source.bankAccountSource))
    evidence.push(bankAccountId({ ...period, sourceFile: source.sourceFile, bankAccountSource: source.bankAccountSource || period.bankAccountSource }, options));
  if (period.sourceFile && (memberRows.length || period.bankAccountSource)) evidence.push(bankAccountId(period, options));
  return evidence.length && new Set(evidence).size === 1 ? evidence[0] : bankAccountId({ accountId: period.accountId, card: period.card }, options);
}
function adjacentMonth(month, offset) {
  checkedMonth(month);
  const [year, number] = month.split('-').map(Number);
  return iso(Date.UTC(year, number - 1 + offset, 1)).slice(0, 7);
}
function checkedRule(rule) {
  if (!rule || ![1, 2, 3, 4, -1].includes(rule.nth) || !Number.isInteger(rule.weekday) || rule.weekday < 0 || rule.weekday > 6) throw Error('Choose a weekday and first, second, third, fourth or last occurrence.');
  return rule;
}

export function closingDateForMonth(month, rule) {
  checkedMonth(month); checkedRule(rule);
  const [year, number] = month.split('-').map(Number);
  const first = new Date(Date.UTC(year, number - 1, 1));
  if (rule.nth === -1) {
    const last = new Date(Date.UTC(year, number, 0));
    return iso(last.getTime() - ((last.getUTCDay() - rule.weekday + 7) % 7) * DAY);
  }
  return iso(first.getTime() + (((rule.weekday - first.getUTCDay() + 7) % 7) + (rule.nth - 1) * 7) * DAY);
}

export function periodForDate(date, rule) {
  checkedDate(date); checkedRule(rule);
  let month = date.slice(0, 7), end = closingDateForMonth(month, rule);
  if (date > end) { month = adjacentMonth(month, 1); end = closingDateForMonth(month, rule); }
  return { start: shifted(closingDateForMonth(adjacentMonth(month, -1), rule), 1), end };
}

function explicitHeaders(workbook, transactionRows = []) {
  const values = { start: [], end: [], dueDate: [] };
  const readDate = value => { try { return parseBankDate(value); } catch { return ''; } };
  const location = (sheet, row) => JSON.stringify([fold(sheet).replace(/\s+/g, ' '), row]);
  const transactions = new Set(transactionRows.map(row => location(row.sourceSheet, row.sourceRow)));
  for (const sheet of workbook?.sheets || []) for (const [index, cells] of (sheet.rows || []).entries()) {
    if (transactions.has(location(sheet.name, index + 1)) || readDate(cells[0])) continue;
    // Exact financial labels only. Transaction rows and total-spending rows
    // cannot establish a billing period, balance or payment deadline.
    for (let i = 0; i < cells.length; i++) {
      const label = fold(cells[i]), tail = cells.slice(i + 1, i + 4);
      const embedded = clean(cells[i]).match(/\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{4}/g) || [];
      const dates = [...embedded, ...tail].map(readDate).filter(Boolean);
      const joinedDates = clean(tail[0]).match(/\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{4}/g) || [];
      if (/^(?:ekstre donemi|statement period)\s*(?::|$)/.test(label)) {
        const pair = [...embedded, ...joinedDates].map(readDate).filter(Boolean);
        if (pair.length === 2 && pair[0] <= pair[1]) { values.start.push(pair[0]); values.end.push(pair[1]); }
        else if (dates.length === 2 && dates[0] <= dates[1]) { values.start.push(dates[0]); values.end.push(dates[1]); }
      } else if (/^(?:hesap kesim tarihi|ekstre kesim tarihi|statement closing date|closing date)\s*(?::|$)/.test(label) && dates[0]) values.end.push(dates[0]);
      else if (/^(?:son odeme tarihi|payment due date|due date)\s*(?::|$)/.test(label) && dates[0]) values.dueDate.push(dates[0]);
    }
  }
  // Conflicting card-specific headers require an explicit choice, never the
  // first date found in a multi-card export.
  return Object.fromEntries(Object.entries(values).map(([key, dates]) => [key, unique(dates).length === 1 ? dates[0] : '']));
}

export function buildBankPeriodDrafts(files, workbooks = [], { rule, closingDates = {}, cycleMonth = '' } = {}) {
  if (rule) checkedRule(rule);
  const drafts = [], periods = [];
  for (const [fileIndex, file] of (files || []).entries()) {
    if (!['garanti-statement', 'garanti-in-month'].includes(file?.sourceType)) continue;
    const headers = explicitHeaders(workbooks[fileIndex], file.rows), status = file.sourceType === 'garanti-statement' ? 'closed' : 'open';
    const manual = clean(closingDates[fileIndex]), month = typeof cycleMonth === 'string' ? cycleMonth : cycleMonth?.[fileIndex];
    // Payments and transfers are posted bank activity too. Pending holds and
    // invalid rows cannot move a statement's estimated closing date forward.
    const posted = (file.rows || []).filter(row => !row.error && validDate(row.date) && (row.bankKind || row.kind) !== 'pending');
    const dates = posted.map(row => row.date).sort(), observedStart = dates[0] || '', observedEnd = dates.at(-1) || '';
    let end = '', start = '', dateBasis = 'unknown', startDateBasis = 'unknown', estimateReason = '', estimateMethod = '';
    if (manual) { end = checkedDate(manual); dateBasis = 'manual'; }
    else if (headers.end) { end = checkedDate(headers.end); start = headers.start; dateBasis = 'bank'; if (start) startDateBasis = 'bank'; }
    else if (rule && month) { end = closingDateForMonth(month, rule); dateBasis = 'schedule'; }
    else if (rule && observedEnd) { ({ start, end } = periodForDate(observedEnd, rule)); dateBasis = 'schedule'; startDateBasis = 'schedule'; }
    else if (status === 'closed' && observedEnd) { end = observedEnd; dateBasis = 'estimated'; estimateMethod = 'latest-activity'; estimateReason = 'Estimated from the last posted bank transaction, including payments and transfers.'; }
    if (end && !start && rule) { start = shifted(closingDateForMonth(adjacentMonth(end.slice(0, 7), -1), rule), 1); startDateBasis = 'schedule'; }
    periods.push({ file, fileIndex, status, headers, start, end, dateBasis, startDateBasis, estimateReason, estimateMethod, startEstimateMethod: '', observedStart, observedEnd,
      accounts: unique(posted.map(row => row.accountId || 'unknown')), currencies: unique(posted.map(row => row.currency).filter(Boolean)) });
  }
  const tryAnchors = periods.filter(period => period.status === 'closed' && period.end && period.currencies.length === 1 && period.currencies[0] === 'TRY');
  for (const period of periods.filter(item => item.status === 'closed' && item.dateBasis === 'estimated' && !item.currencies.includes('TRY'))) {
    // A sparse currency export can end much earlier than its TRY statement.
    // Align only when its entire observed range and all known cards identify
    // exactly one TRY file; filenames and their numbering are not evidence.
    const candidates = tryAnchors.filter(anchor => period.observedStart >= anchor.observedStart && period.observedEnd <= anchor.observedEnd &&
      period.accounts.length && !period.accounts.includes('unknown') && period.accounts.every(account => anchor.accounts.includes(account)));
    if (candidates.length === 1) {
      period.anchor = candidates[0]; period.end = period.anchor.end; period.estimateMethod = 'matched-try';
      period.estimateReason = 'Estimated using the TRY statement covering these transaction dates and the same cards.';
    }
  }
  for (const period of periods) {
    if (period.status !== 'closed' || !period.end || period.start) continue;
    const basis = period.anchor || period;
    const earlier = periods.filter(other => other !== basis && other.status === 'closed' && other.end && other.end < basis.end &&
      other.currencies.some(currency => basis.currencies.includes(currency)) && other.accounts.some(account => account !== 'unknown' && basis.accounts.includes(account))).sort((a, b) => a.end.localeCompare(b.end));
    period.start = earlier.length ? shifted(earlier.at(-1).end, 1) : basis.observedStart;
    period.startDateBasis = period.start ? 'estimated' : 'unknown';
    period.startEstimateMethod = period.start ? earlier.length ? 'previous-close' : 'observed-first' : '';
  }
  for (const period of periods) {
    const { file, fileIndex, status, headers, start, end, dateBasis, startDateBasis, estimateReason, estimateMethod, startEstimateMethod, observedStart, observedEnd } = period;
    const groups = new Map();
    for (const row of file.rows || []) {
      const key = JSON.stringify([row.accountId || 'unknown', row.currency || '']);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    const sourceFile = clean(file.metadata?.fileName || workbooks[fileIndex]?.name || 'Bank export');
    const sourceHash = clean(file.metadata?.fileHash || workbooks[fileIndex]?.fileHash) || identity('bank-period-file', sourceFile, file.rows || []);
    for (const rows of groups.values()) {
      const { accountId = 'unknown', card = 'Unspecified card', currency = '' } = rows[0];
      const origins = unique(rows.map(row => row.bankAccountSource).filter(Boolean));
      const sourceId = identity('bank-period-source', sourceHash, accountId, currency, status);
      drafts.push({ id: identity('bank-period', accountId, currency, end || sourceId), sourceId, fileIndex, accountId, card, currency, status,
        ...(origins.length === 1 ? { bankAccountSource: origins[0] } : {}),
        start, end, dateBasis, startDateBasis, estimateReason, estimateMethod, startEstimateMethod, observedStart, observedEnd, sourceFile, sourceHash, expectedCount: rows.length,
        expectedSpendingCount: rows.filter(row => row.include && !row.error).length, errorCount: rows.filter(row => row.error).length,
        sourceRows: rows.map(row => ({ sheet: row.sourceSheet, row: row.sourceRow })), ...(headers.dueDate ? { dueDate: headers.dueDate } : {}) });
    }
  }
  return drafts;
}

function resolvedSources(draft, plan, selected, expensesById, accepted) {
  const memberIds = [], spendingMemberIds = [];
  const locations = new Set((draft.sourceRows || []).map(row => JSON.stringify([row.sheet, row.row])));
  for (const item of plan || []) {
    if (item.fileIndex !== draft.fileIndex || item.row?.accountId !== draft.accountId || item.row?.currency !== draft.currency) continue;
    if (locations.size && !locations.has(JSON.stringify([item.row.sourceSheet, item.row.sourceRow]))) continue;
    let id = '';
    if (['new', 'possible-match', 'enrichment'].includes(item.status) && selected.has(item.id) && accepted.has(item.id)) id = item.id;
    else if (item.status === 'duplicate' && item.matchingExistingId && (accepted.has(item.matchingExistingId) || (expensesById.has(item.matchingExistingId) && !expensesById.get(item.matchingExistingId).deleted))) id = item.matchingExistingId;
    // A possible match is not a confirmed relationship. Nor may a deleted
    // duplicate become an imported member merely because it appears in a file.
    if (!id) continue;
    memberIds.push(id); if (item.row.include && !item.row.error) spendingMemberIds.push(id);
  }
  return { memberIds: unique(memberIds), spendingMemberIds: unique(spendingMemberIds) };
}

function refreshSummary(period) {
  const source = period.sources.find(item => item.id === period.authoritativeSourceId) || period.sources.find(item => item.status === 'closed') || period.sources.at(-1);
  period.authoritativeSourceId = source.id; period.status = source.status;
  Object.assign(period, { memberIds: [...source.memberIds], spendingMemberIds: [...source.spendingMemberIds], expectedCount: source.expectedCount,
    expectedSpendingCount: source.expectedSpendingCount, errorCount: source.errorCount, importedSpendingCount: source.spendingMemberIds.length });
  period.coverageComplete = !period.errorCount && period.importedSpendingCount === period.expectedSpendingCount;
  period.complete = period.status === 'closed' && period.coverageComplete;
}

export function mergeBankPeriods(existing = [], drafts = [], plan = [], { selectedIds = [], expenses = [], at } = {}) {
  const selected = new Set(selectedIds), expensesById = new Map(expenses.map(row => [row.id, row]));
  const cardAliases = deriveBankCardAliases(expenses).cardAliases;
  const accountFor = period => bankPeriodAccountId(period, { expenses, cardAliases });
  const accepted = new Set(plan.filter(item => selected.has(item.id) && ['new', 'possible-match', 'enrichment'].includes(item.status) &&
    !item.row?.deleted && (!expensesById.get(item.id)?.deleted || item.personalResetReimport === true)).map(item => item.id));
  const previous = new Map(existing.map(period => [period.id, period])), registry = new Map(existing.map(period => [period.id, copy(period)]));
  const datePriority = basis => ({ manual: 3, bank: 2, schedule: 1, estimated: 0, unknown: -1 }[basis] ?? -1);
  const estimatePriority = method => method === 'matched-try' ? 2 : method === 'latest-activity' ? 1 : 0;
  const startPriority = method => method === 'previous-close' ? 2 : method === 'observed-first' ? 1 : 0;
  for (const incoming of drafts) {
    const incomingAccount = accountFor(incoming);
    const matchingSource = (period, source) => source.id === incoming.sourceId ||
      (incoming.sourceHash && source.sourceHash === incoming.sourceHash && source.status === incoming.status &&
        period.currency === incoming.currency && accountFor(period) === incomingAccount);
    const sameSource = [...registry.values()].find(period => (period.sources || []).some(source => matchingSource(period, source)));
    const equivalentCycle = incoming.end && [...registry.values()].find(period => period.end === incoming.end && period.currency === incoming.currency && accountFor(period) === incomingAccount);
    const datesSource = sameSource || equivalentCycle;
    const known = datesSource?.end && (!incoming.end || datePriority(datesSource.dateBasis) > datePriority(incoming.dateBasis) ||
      (datesSource.dateBasis === 'estimated' && incoming.dateBasis === 'estimated' && estimatePriority(datesSource.estimateMethod) > estimatePriority(incoming.estimateMethod))) ? datesSource : null;
    const draft = known ? { ...incoming, id: known.id, start: known.start, end: known.end, dateBasis: known.dateBasis,
      startDateBasis: known.startDateBasis || 'unknown', estimateReason: known.estimateReason || '', estimateMethod: known.estimateMethod || '',
      startEstimateMethod: known.startEstimateMethod || '', ...(known.dueDate ? { dueDate: known.dueDate } : {}) } : { ...incoming };
    draft.accountId = incomingAccount;
    const oldSource = sameSource?.sources.find(source => matchingSource(sameSource, source));
    if (oldSource) draft.sourceId = oldSource.id;
    const sameCycle = draft.end && [...registry.values()].find(period => period.end === draft.end && period.currency === draft.currency && accountFor(period) === incomingAccount);
    if (sameCycle) draft.id = sameCycle.id;
    // Reimporting only one file is less context, not a reason to discard a
    // previously matched close or the start established by the prior statement.
    const startSource = sameSource?.end === draft.end ? sameSource : equivalentCycle;
    const strongerStart = startSource && (datePriority(startSource.startDateBasis) > datePriority(draft.startDateBasis) ||
      (datePriority(startSource.startDateBasis) === datePriority(draft.startDateBasis) && startPriority(startSource.startEstimateMethod) > startPriority(draft.startEstimateMethod)));
    if (startSource?.start && startSource.start <= draft.end && strongerStart) {
      draft.start = startSource.start; draft.startDateBasis = startSource.startDateBasis; draft.startEstimateMethod = startSource.startEstimateMethod || '';
    }
    const membership = resolvedSources(draft, plan, selected, expensesById, accepted);
    const source = { id: draft.sourceId, sourceFile: draft.sourceFile, sourceHash: draft.sourceHash, status: draft.status,
      ...(draft.bankAccountSource ? { bankAccountSource: draft.bankAccountSource } : {}),
      expectedCount: draft.expectedCount, expectedSpendingCount: draft.expectedSpendingCount, errorCount: draft.errorCount || 0, ...membership };
    // Choosing or correcting a file's closing date moves that source snapshot,
    // not its transactions. One file cannot establish two different cycles.
    if (draft.end) for (const [id, oldPeriod] of registry) if (id !== draft.id && (oldPeriod.sources || []).some(item => item.id === source.id)) {
      oldPeriod.sources = oldPeriod.sources.filter(item => item.id !== source.id);
      if (!oldPeriod.sources.length) registry.delete(id); else refreshSummary(oldPeriod);
    }
    const period = registry.get(draft.id) || { id: draft.id, accountId: draft.accountId, card: draft.card, currency: draft.currency, sources: [] };
    const sources = new Map((period.sources || []).map(item => [item.id, item]));
    sources.set(source.id, source); period.sources = [...sources.values()].sort((a, b) => a.id.localeCompare(b.id));
    const wasClosed = period.status === 'closed';
    if (!wasClosed || draft.status === 'closed') {
      period.status = draft.status; period.start = draft.start; period.end = draft.end; period.dateBasis = draft.dateBasis;
      for (const field of ['startDateBasis', 'estimateReason', 'estimateMethod', 'startEstimateMethod', 'observedStart', 'observedEnd']) period[field] = draft[field] || '';
      period.authoritativeSourceId = source.id;
      if (draft.dueDate) period.dueDate = draft.dueDate;
    }
    // A later ongoing download cannot add purchases to the bank's closed list.
    // Each closed file is a complete source snapshot, even if some rows were
    // deliberately skipped during import (which then remains incomplete).
    refreshSummary(period);
    registry.set(period.id, period);
  }
  // Compare final content once: repeated multi-file imports must not churn
  // timestamps because of intermediate processing order.
  return [...registry.values()].map(period => {
    const old = previous.get(period.id), withoutTime = value => { const result = { ...value }; delete result.createdAt; delete result.updatedAt; return result; };
    if (old && JSON.stringify(withoutTime(old)) === JSON.stringify(withoutTime(period))) return copy(old);
    if (at) { period.createdAt ||= at; period.updatedAt = at; }
    return period;
  }).sort((a, b) => `${a.end}|${a.accountId}|${a.currency}|${a.id}`.localeCompare(`${b.end}|${b.accountId}|${b.currency}|${b.id}`));
}

export function bankPeriodView(period, expenses = []) {
  const active = new Map(expenses.filter(row => row && !row.deleted).map(row => [row.id, row]));
  const memberIds = (period.memberIds || []).filter(id => active.has(id));
  const spendingMemberIds = (period.spendingMemberIds || []).filter(id => active.has(id));
  const coverageComplete = !period.errorCount && spendingMemberIds.length === period.expectedSpendingCount;
  return { ...copy(period), memberIds, spendingMemberIds, entries: memberIds.map(id => active.get(id)), importedSpendingCount: spendingMemberIds.length,
    coverageComplete, complete: period.status === 'closed' && coverageComplete };
}
