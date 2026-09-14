// Pure statement-cycle metadata. Files establish membership; purchase dates do
// not prove a statement closing date or the amount the bank says is due.
import { stableId, validDate } from './expense-workflows.js';
import { parseBankDate } from './bank-import.js';

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
  const drafts = [];
  for (const [fileIndex, file] of (files || []).entries()) {
    if (!['garanti-statement', 'garanti-in-month'].includes(file?.sourceType)) continue;
    const headers = explicitHeaders(workbooks[fileIndex], file.rows), status = file.sourceType === 'garanti-statement' ? 'closed' : 'open';
    const manual = clean(closingDates[fileIndex]), month = typeof cycleMonth === 'string' ? cycleMonth : cycleMonth?.[fileIndex];
    let end = '', start = '', dateBasis = 'unknown';
    if (manual) { end = checkedDate(manual); dateBasis = 'manual'; }
    else if (headers.end) { end = checkedDate(headers.end); start = headers.start; dateBasis = 'bank'; }
    else if (rule && month) { end = closingDateForMonth(month, rule); dateBasis = 'schedule'; }
    if (end && !start && rule) start = shifted(closingDateForMonth(adjacentMonth(end.slice(0, 7), -1), rule), 1);
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
      const sourceId = identity('bank-period-source', sourceHash, accountId, currency, status);
      drafts.push({ id: identity('bank-period', accountId, currency, end || sourceId), sourceId, fileIndex, accountId, card, currency, status,
        start, end, dateBasis, sourceFile, sourceHash, expectedCount: rows.length,
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
  const accepted = new Set(plan.filter(item => selected.has(item.id) && ['new', 'possible-match', 'enrichment'].includes(item.status) &&
    !item.row?.deleted && (!expensesById.get(item.id)?.deleted || item.personalResetReimport === true)).map(item => item.id));
  const previous = new Map(existing.map(period => [period.id, period])), registry = new Map(existing.map(period => [period.id, copy(period)]));
  for (const incoming of drafts) {
    const known = !incoming.end && [...registry.values()].find(period => period.end && (period.sources || []).some(source => source.id === incoming.sourceId));
    const draft = known ? { ...incoming, id: known.id, start: known.start, end: known.end, dateBasis: known.dateBasis, ...(known.dueDate ? { dueDate: known.dueDate } : {}) } : incoming;
    const membership = resolvedSources(draft, plan, selected, expensesById, accepted);
    const source = { id: draft.sourceId, sourceFile: draft.sourceFile, sourceHash: draft.sourceHash, status: draft.status,
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
