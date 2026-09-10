// Expense lines <-> IFS Expense Details rows (LU ExpenseDetail), same logic as the workbook.
import { parseCopyObject, buildRecord, joinRecords, ifsDate, ifsNumber, OMIT } from './ifs.js';

// Order used for receipt numbering and export: date, then manual order (seq, set with the
// move buttons), then creation time.
export function lineOrder(a, b) {
  return (a.date || '').localeCompare(b.date || '') || ((a.seq ?? 0) - (b.seq ?? 0)) || (a.created_at || '').localeCompare(b.created_at || '');
}

// Receipt numbering like the workbook: business lines with a receipt are numbered
// 1..n in order within the sheet; the others get "No Rec".
export function numberReceipts(lines) {
  const sorted = [...lines].sort(lineOrder);
  let n = 0;
  const refs = new Map();
  for (const l of sorted) refs.set(l.id, l.business && l.receipt ? String(++n) : 'No Rec');
  return refs;
}

export function referenceText(line, ref) {
  return `${ref} - ${line.written || ''}${line.costObject ? ' ' + line.costObject : ''}`.trim();
}

export const rateKey = (cur, date) => `${(cur || '').toUpperCase()}|${date}`;

// Currency rate for a line, in this order: home currency = 1; the rate looked up for the
// line's date (TCMB through the PC server); the sheet's manually typed rate; nothing.
export function rateFor(line, sheet, settings, ratesByKey = {}) {
  const home = (settings.homeCurrency || 'TRY').toUpperCase();
  const cur = (line.currency || '').toUpperCase();
  if (cur === home) return { rate: 1, source: 'home' };
  if (settings.currRateMode === 'one') return { rate: 1, source: 'fixed' };
  const byDate = ratesByKey[rateKey(cur, line.date)];
  if (settings.rateSource !== 'manual' && byDate && Number(byDate.rate) > 0) return { rate: Number(byDate.rate), source: 'tcmb', usedDate: byDate.usedDate };
  const manual = Number(sheet?.rates?.[cur]);
  if (manual > 0) return { rate: manual, source: 'manual' };
  return { rate: null, source: 'none' };
}

function rateFields(r, settings) {
  if (r.rate) return { CURR_RATE: ifsNumber(r.rate, 6), CONV_FACTOR: '1' };
  if (settings.currRateMode === 'omit') return { CURR_RATE: OMIT, CONV_FACTOR: OMIT };
  return { CURR_RATE: '', CONV_FACTOR: '' };
}

// Only business lines go to IFS. `onlyNew` exports just the lines not yet marked as entered
// (after a first paste); SEQ_NO keeps counting across the whole sheet either way.
export function buildExpenseExport(sheet, lines, settings, ratesByKey = {}, { onlyNew = false } = {}) {
  const template = parseCopyObject(settings.expenseTemplate);
  if (!template) return { text: '', count: 0, error: 'The expense row template in Settings is not valid.', warnings: [], rates: [] };
  const refs = numberReceipts(lines);
  const allBusiness = lines.filter(l => l.business).sort(lineOrder);
  const business = onlyNew ? allBusiness.filter(l => !l.entered) : allBusiness;
  const codes = new Map((settings.expenseCodes || []).map(c => [String(c.code), c]));
  const shortNameOf = l => (l.shortName || sheet.shortName || '').trim();
  const missingShortName = business.filter(l => !shortNameOf(l)).length;
  const rates = [];   // one entry per exported line: { date, cur, rate, source }
  const records = business.map(l => {
    const r = rateFor(l, sheet, settings, ratesByKey);
    rates.push({ date: l.date, cur: (l.currency || '').toUpperCase(), ...r });
    return buildRecord(template, {
      EXPENSE_ID: sheet.expenseId || '',
      ACCOUNT_DATE: ifsDate(l.date),
      EXPENSE_CODE: l.code,
      DESCRIPTION: codes.get(String(l.code))?.desc || '',
      REFERENCE: referenceText(l, refs.get(l.id)),
      CURRENCY_CODE: l.currency,
      GROSS_CURR_AMOUNT: ifsNumber(l.amount),
      SHORT_NAME: shortNameOf(l),
      C_SHORT_NAME: shortNameOf(l),
      ...rateFields(r, settings),
      SEQ_NO: String(allBusiness.indexOf(l) + 1),
    });
  });
  const error = sheet.expenseId ? '' : 'Set the IFS Expense ID on this sheet first.';
  const warnings = [];
  if (missingShortName) warnings.push(`${missingShortName} line${missingShortName === 1 ? '' : 's'} without a project short name; IFS will ask for it after the paste.`);
  const unrated = [...new Set(rates.filter(r => r.source === 'none').map(r => `${r.cur} ${r.date}`))];
  if (unrated.length) warnings.push(`No rate for ${unrated.slice(0, 4).join(', ')}${unrated.length > 4 ? ` and ${unrated.length - 4} more` : ''}. ${settings.rateSource === 'manual' ? 'Type it under Sheets…' : 'Rates are fetched for each line date (Central Bank, published daily); a date can only be missing if it is in the future or the rate file has not been published yet. You can also type a rate under Sheets…'}`);
  return { text: joinRecords(records), count: records.length, total: allBusiness.length, error, warning: warnings.join(' '), warnings, missingShortName, unrated, rates };
}

// Turn rows copied from the IFS Expense Details grid into app lines (all business).
// REFERENCE "3 - Gas /16 QP 16" gives receipt number, written text and cost object.
export function linesFromIfsRecords(records) {
  const out = [];
  let expenseId = '', shortName = '';
  for (const rec of records) {
    if (rec.lu !== 'ExpenseDetail') continue;
    const v = k => (rec.fields.find(f => f.name === k)?.value || '').trim();
    const ref = v('REFERENCE');
    const m = /^(No\s*Rec|\d+)\s*-\s*(.*?)(?:\s+(\/.*))?$/i.exec(ref) || [];
    const amount = Number(v('GROSS_CURR_AMOUNT').replace(',', '.'));
    if (!v('ACCOUNT_DATE') || Number.isNaN(amount)) continue;
    expenseId = expenseId || v('EXPENSE_ID');
    shortName = shortName || v('SHORT_NAME');
    out.push({
      date: v('ACCOUNT_DATE').slice(0, 10),
      code: Number(v('EXPENSE_CODE')) || 0,
      written: (m[2] ?? ref).trim(),
      costObject: (m[3] || '').trim(),
      receipt: /^\d+$/.test(m[1] || ''),
      ifsReceiptNo: /^\d+$/.test(m[1] || '') ? Number(m[1]) : null,
      currency: v('CURRENCY_CODE') || 'TRY',
      amount,
      business: true,
      entered: true,
      enteredAt: new Date().toISOString(),
      shortName: v('SHORT_NAME'),
      seq: Number(v('SEQ_NO')) || 0,
      vendor: `Imported from IFS${v('EXPENSE_ID') ? ' sheet ' + v('EXPENSE_ID') : ''}`,
    });
  }
  return { lines: out, expenseId, shortName };
}

export function totalsByCurrency(lines) {
  const t = {};
  for (const l of lines) t[l.currency] = Math.round(((t[l.currency] || 0) + Number(l.amount || 0)) * 100) / 100;
  return t;
}

export function fmtMoney(n, cur) {
  return `${Number(n || 0).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${cur || ''}`.trim();
}
