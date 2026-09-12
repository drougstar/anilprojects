// Read-only review model. One expense can need several actions; the headline
// counts its ID once instead of adding overlapping stage counts together.
import { rateFor } from './expense-ifs.js';
import { parseCopyObject } from './ifs.js';
import { reimbursementSummary, isSpendingRecord, spendingPurpose, validDate } from './expense-workflows.js';
import { effectiveTimeCodeMappings, completeGeneralActivity, timeCodeInfo } from './time-codes.js';

export const EXPENSE_REVIEW_STAGES = Object.freeze([
  { kind: 'setup', label: 'IFS setup', severity: 'blocking', help: 'An expense needs its sheet or row setup before it can be prepared for IFS.' },
  { kind: 'receipts', label: 'Missing receipts', severity: 'followup', help: 'Add a receipt if one is available. Expenses can still be exported as No Rec; per diem is excluded.' },
  { kind: 'rates', label: 'Missing rates', severity: 'followup', help: 'Retry date rates or type a fallback on the sheet. IFS export keeps your configured empty/omitted rate behavior.' },
  { kind: 'ready', label: 'Ready for IFS', severity: 'next', help: 'These new lines have their sheet, project and rate ready. Open their sheet to copy and review the IFS text.' },
  { kind: 'reimbursements', label: 'Awaiting payment', severity: 'followup', help: 'Record only money you have received. Payment records and the In IFS marker are independent.' },
]);

const text = value => String(value ?? '').trim();
const activeUnique = rows => [...new Map((rows || []).filter(row => row && !row.deleted && row.id).map(row => [row.id, row])).values()];
export function uniqueReviewCount(items) { return new Set(items.flatMap(item => item.keys || item.ids?.map(id => `expense:${id}`) || [])).size; }

export function expenseReviewQueue({ lines = [], sheets = [], settings = {}, rates = {} } = {}) {
  const sheetMap = new Map(activeUnique(sheets).map(sheet => [sheet.id, sheet]));
  const templateValid = !!parseCopyObject(settings.expenseTemplate || '');
  const records = [];
  for (const row of activeUnique(lines).filter(row => row.business)) {
    const sheet = sheetMap.get(row.sheetId), pending = !row.entered;
    const reasons = [], kinds = [];
    if (pending) {
      if (!sheet) reasons.push('Sheet is missing');
      else if (!text(sheet.expenseId)) reasons.push('IFS Expense ID is missing');
      if (!templateValid) reasons.push('IFS expense template is missing or invalid');
      if (!validDate(row.date) || !Number.isFinite(Number(row.amount)) || !Number(row.amount) || !text(row.currency) || !text(row.code)) reasons.push('Check date, amount, currency and expense code');
      if (reasons.length) kinds.push('setup');
      if (!row.perdiem && !row.receipt && !row.receiptId && !row.receiptIds?.length) kinds.push('receipts');
      if (!rateFor(row, sheet, settings, rates).rate) kinds.push('rates');
      // A missing short name is an IFS prompt rather than an export blocker.
      // Keep it visible without claiming the line is ready to paste unchanged.
      if (!text(row.shortName || sheet?.shortName)) { kinds.push('setup'); reasons.push('Project short name is missing (IFS will ask after paste)'); }
      if (!kinds.includes('setup') && !kinds.includes('rates')) kinds.push('ready');
    }
    let payment;
    try { payment = reimbursementSummary(row); }
    catch { reasons.push('Review the saved payment amounts'); kinds.push('setup'); }
    if (payment?.eligible && payment.remaining > 0) kinds.push('reimbursements');
    if (kinds.length) records.push({ id: row.id, row, sheet, kinds: [...new Set(kinds)], reasons, payment,
      blocking: pending && (!sheet || !text(sheet.expenseId) || !templateValid || reasons.some(reason => reason.startsWith('Check date'))),
      key: `expense:${row.id}` });
  }
  const stages = EXPENSE_REVIEW_STAGES.map(stage => {
    const matching = records.filter(item => item.kinds.includes(stage.kind));
    return { ...stage, count: matching.length, ids: matching.map(item => item.id), keys: matching.map(item => item.key) };
  });
  return { records, stages, count: records.length, blockingCount: records.filter(item => item.blocking).length };
}

export function setupReviewItems(settings = {}) {
  const mappings = effectiveTimeCodeMappings(settings);
  const unresolved = mappings.map((mapping, index) => ({ mapping, index })).filter(({ mapping }) => !mapping.confirmed || !['code', 'label'].includes(mapping.mode) || !text(mapping.tagName) || (mapping.mode === 'code' && !timeCodeInfo(mapping.code)));
  const items = [];
  if (unresolved.length) items.push({ kind: 'time', label: 'Tag meanings to confirm', severity: 'blocking', section: 'time', focus: 'time-code-rows', count: unresolved.length, keys: unresolved.map(({ index }) => `time-mapping:${index}`) });
  const projects = Object.entries(settings.mapping || {});
  const incomplete = projects.filter(([, row]) => row?.kind !== 'ignore' && (!row || !['projectId', 'subProjectId', 'activityNo', 'activitySeq', 'shortName'].every(key => text(row[key])) || text(row.shortName) !== `${text(row.projectId)}.${text(row.subProjectId)}.${text(row.activityNo)}`));
  const generalNeeded = mappings.some(mapping => mapping.mode === 'code' && timeCodeInfo(mapping.code)?.scope === 'general-only');
  const generalInvalid = generalNeeded && projects.filter(([, row]) => completeGeneralActivity(row)).length !== 1;
  const keys = incomplete.map(([id]) => `project:${id}`);
  // A General setup issue uses its existing project key where possible.
  if (generalInvalid) {
    const general = projects.filter(([, row]) => row?.kind === 'general');
    if (general.length) keys.push(...general.map(([id]) => `project:${id}`)); else keys.push('project:general-destination');
  }
  if (keys.length) items.push({ kind: 'projects', label: 'Project setup to complete', severity: 'blocking', section: 'projects', focus: 'project-mapping', count: new Set(keys).size, keys: [...new Set(keys)] });
  return items;
}

export function personalReviewItems(lines = []) {
  const rows = activeUnique(lines).filter(row => isSpendingRecord(row) && spendingPurpose(row) === 'review');
  return rows.length ? [{ kind: 'bank', label: 'Card spending to classify', severity: 'followup', count: rows.length, ids: rows.map(row => row.id), keys: rows.map(row => `expense:${row.id}`) }] : [];
}
