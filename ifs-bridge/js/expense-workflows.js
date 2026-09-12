// Pure expense rules. Amount arithmetic uses integer hundredths, matching the
// existing expense store, so splitting and payments never lose a cent.
export function minorAmount(value) {
  const text = String(value ?? '').trim();
  if (!/^-?\d+(?:[.,]\d{1,2})?$/.test(text)) throw Error('Enter an amount with at most two decimal places.');
  const negative = text.startsWith('-'), [whole, fraction = ''] = text.replace('-', '').replace(',', '.').split('.');
  const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (!Number.isSafeInteger(result)) throw Error('Amount is too large.');
  return negative ? -result : result;
}
export const fromMinor = value => value / 100;
export const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value || '') && Number.isFinite(Date.parse(value)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const photoIds = row => [...new Set(row.receiptIds || (row.receiptId ? [row.receiptId] : []))];
export const paymentTotal = row => (row.reimbursement?.payments || []).reduce((sum, p) => sum + minorAmount(p.amount), 0);
export function reimbursementSummary(row) {
  const total = minorAmount(row.amount || 0), paid = paymentTotal(row);
  const eligible = !!row.business && isSpendingRecord(row) && total > 0;
  const remaining = Math.max(0, total - paid);
  // Payment status comes from recorded amounts. Earlier submission/approval
  // stages remain in the record, but no longer need manual updates in the UI.
  return { eligible, total, paid, remaining, status: paid >= total && total > 0 ? 'paid' : paid > 0 ? 'partial' : 'awaiting', stage: eligible && !remaining ? 'paid' : row.reimbursement?.stage || 'recorded' };
}
export function setReimbursementStage(row, stage) {
  const summary = reimbursementSummary(row);
  if (!summary.eligible) throw Error('Reimbursement tracking is for positive business expenses.');
  if (!['recorded', 'submitted', 'approved', 'paid'].includes(stage)) throw Error('Choose a reimbursement stage.');
  if (stage === 'paid' && summary.remaining) throw Error('Record the payment amount before marking this fully paid.');
  return { ...row, reimbursement: { ...row.reimbursement, stage: summary.remaining ? stage : 'paid', payments: row.reimbursement?.payments || [] } };
}
export function addPayment(row, payment) {
  const summary = reimbursementSummary(row), amount = minorAmount(payment.amount);
  if (!summary.eligible) throw Error('Reimbursement tracking is for positive business expenses.');
  if (!validDate(payment.date)) throw Error('Choose a valid payment date.');
  if (String(payment.currency).toUpperCase() !== String(row.currency).toUpperCase()) throw Error('Use the expense currency for this payment.');
  if (amount <= 0 || amount > summary.remaining) throw Error(`Payment must be positive and no more than ${(summary.remaining / 100).toFixed(2)} ${row.currency}.`);
  const payments = [...(row.reimbursement?.payments || []), { ...payment, amount: fromMinor(amount), currency: row.currency }];
  return { ...row, reimbursement: { ...row.reimbursement, stage: amount === summary.remaining ? 'paid' : (summary.stage === 'recorded' ? 'submitted' : summary.stage), payments } };
}
export function settleReimbursements(rows, { date, note = '', paymentIds }) {
  if (!rows.length) throw Error('Select at least one expense awaiting payment.');
  if (new Set(rows.map(row => row.id)).size !== rows.length) throw Error('An expense was selected more than once.');
  if (!Array.isArray(paymentIds) || paymentIds.length !== rows.length || paymentIds.some(id => !id) || new Set(paymentIds).size !== paymentIds.length) throw Error('Each payment needs a separate identifier.');
  // Prepare the entire batch before writing anything. Each balance keeps its
  // own currency, and an existing partial payment is preserved exactly.
  return rows.map((row, index) => addPayment(row, { id: paymentIds[index], amount: fromMinor(reimbursementSummary(row).remaining), date, currency: row.currency, note: String(note).trim() }));
}
export function validateExpenseChange(old, next) {
  const paid = paymentTotal(old);
  if (paid && (!next.business || next.currency !== old.currency || minorAmount(next.amount) < paid)) throw Error('Remove or correct the recorded payments before changing currency, switching to personal, or reducing the amount below what was paid.');
  return next;
}
export function splitExpense(original, parts, { groupId, ids, at }) {
  if (original.entered) throw Error('This expense is already entered in IFS. Reconcile that entry before splitting it.');
  if (paymentTotal(original)) throw Error('Correct the recorded reimbursement payments before splitting this expense.');
  if (original.perdiem) throw Error('Edit the trip to change a per diem.');
  if (parts.length < 2 || parts.length > 20 || ids.length !== parts.length) throw Error('Use between 2 and 20 parts.');
  const total = minorAmount(original.amount), amounts = parts.map(p => minorAmount(p.amount));
  if (amounts.some(n => !n || Math.sign(n) !== Math.sign(total))) throw Error('Each part must have the same sign as the original amount and cannot be zero.');
  if (amounts.reduce((sum, n) => sum + n, 0) !== total) throw Error('The parts must add up exactly to the original receipt total.');
  if (new Set(ids).size !== ids.length || ids.includes(original.id)) throw Error('Split parts need separate identifiers.');
  const children = parts.map((p, i) => {
    const child = { ...original, ...p, id: ids[i], amount: fromMinor(amounts[i]), currency: original.currency, sheetId: original.sheetId, date: original.date, receiptIds: photoIds(original), business: !!p.business, receipt: !!p.business && !!original.receipt, shortName: p.business ? (p.shortName || original.shortName || '') : '', splitFrom: original.id, splitGroupId: groupId, created_at: at, seq: Number(original.seq || 0) + i / 100, entered: false, enteredAt: '', deleted: false, reimbursement: { stage: 'recorded', payments: [] } };
    delete child.receiptId; delete child.importKey; delete child.recurringOccurrence;
    return child;
  });
  return { parent: { ...original, deleted: true, splitGroupId: groupId, splitChildren: ids }, children };
}
export function templateFromExpense(row, { id, name, recurrence = '', day = 1, startMonth = '' }) {
  if (!name.trim()) throw Error('Give this template a name.');
  if (!minorAmount(row.amount)) throw Error('A template needs a non-zero amount.');
  if (recurrence && recurrence !== 'monthly') throw Error('Choose monthly recurrence or no recurrence.');
  if (recurrence && (!Number.isInteger(Number(day)) || Number(day) < 1 || Number(day) > 31 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(startMonth))) throw Error('Choose the monthly day (1–31) and first month.');
  const defaults = {};
  for (const key of ['amount', 'currency', 'code', 'written', 'vendor', 'business', 'costObject', 'shortName', 'tripId', 'personalCategory', 'merchant', 'note', 'kind']) defaults[key] = row[key];
  return { id, name: name.trim(), defaults, recurrence, day: Number(day), startMonth, active: true };
}
export function occurrenceDate(template, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw Error('Choose a valid month.');
  const [y, m] = month.split('-').map(Number), last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(Math.min(template.day || 1, last)).padStart(2, '0')}`;
}
// Deterministic IDs keep confirming the same recurring month/import from creating
// extra records; the database also checks that the ID does not already exist.
export function stableId(prefix, text) {
  let a = 2166136261, b = 2246822519, c = 3266489917, d = 668265263;
  for (const ch of `${prefix}|${text}`) { const n = ch.charCodeAt(0); a = Math.imul(a ^ n, 16777619); b = Math.imul(b ^ n, 3266489917); c = Math.imul(c ^ n, 2246822519); d = Math.imul(d ^ n, 668265263); }
  const hex = n => (n >>> 0).toString(16).padStart(8, '0');
  const h = hex(a) + hex(b) + hex(c) + hex(d);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20)}`;
}
export function recurringDraft(template, month, existing = []) {
  if (!template.active || template.recurrence !== 'monthly' || month < template.startMonth) return null;
  const occurrence = `${template.id}|${month}`;
  if (existing.some(row => row.recurringOccurrence === occurrence)) return null;
  return { ...template.defaults, id: stableId('recurring', occurrence), date: occurrenceDate(template, month), recurringOccurrence: occurrence, templateId: template.id, receipt: false, receiptIds: [], entered: false, reimbursement: { stage: 'recorded', payments: [] } };
}
export function isSpendingRecord(row) {
  return !row?.deleted && !row?.perdiem && !row?.excludeFromSpending && !['payment', 'transfer', 'financing', 'pending', 'reward', 'unknown'].includes(row?.bankKind);
}
export function spendingPurpose(row) {
  if (['personal', 'business', 'review'].includes(row?.spendingPurpose)) return row.spendingPurpose;
  if (row?.business === true) return 'business';
  const bank = row?.bankTransaction || row?.bankImport || row?.transactionKey || ['garanti-statement', 'garanti-in-month', 'spending-workbook'].includes(row?.sourceType);
  return bank ? 'review' : 'personal';
}
export function budgetSummary(budget, lines) {
  const limit = minorAmount(budget.amount);
  if (limit <= 0) throw Error('The budget must be positive.');
  const selected = lines.filter(l => isSpendingRecord(l) && l.currency === budget.currency && (budget.kind === 'trip' ? l.tripId === budget.tripId : l.date?.slice(0, 7) === budget.month) && (['personal', 'business', 'review'].includes(budget.audience) ? spendingPurpose(l) === budget.audience : true) && (budget.personalCategory ? (l.personalCategory ? l.personalCategory === budget.personalCategory : !!budget.code && String(l.code) === String(budget.code)) : !budget.code || String(l.code) === String(budget.code)));
  const spent = selected.reduce((sum, l) => sum + minorAmount(l.amount), 0);
  return { limit, spent, remaining: limit - spent, percent: Math.max(0, Math.round(spent / limit * 100)), count: selected.length };
}
export function expenseFingerprint(row) {
  const clean = value => String(value || '').trim().toLowerCase().replace(/\s+/g, ' ');
  return [row.date, String(row.currency).toUpperCase(), minorAmount(row.amount), clean(row.written), clean(row.vendor)].join('|');
}
export function parseCsv(text, delimiter = '') {
  text = String(text || '').replace(/^\uFEFF/, '');
  if (text.length > 5_000_000) throw Error('Use a CSV file smaller than 5 MB.');
  if (!delimiter) {
    const first = text.split(/\r?\n/, 1)[0], counts = [',', ';', '\t'].map(d => [d, first.split(d).length]);
    delimiter = counts.sort((a, b) => b[1] - a[1])[0][0];
  }
  const all = [], row = []; let cell = '', quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else if (!cell || quoted) quoted = !quoted; else cell += c; }
    else if (c === delimiter && !quoted) { row.push(cell); cell = ''; }
    else if ((c === '\n' || c === '\r') && !quoted) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(v => v.trim())) all.push([...row]); row.length = 0; cell = ''; }
    else cell += c;
  }
  if (quoted) throw Error('A quoted CSV field is not closed.');
  row.push(cell); if (row.some(v => v.trim())) all.push(row);
  if (all.length < 2) throw Error('The CSV needs a header and at least one transaction.');
  if (all.length > 5001) throw Error('Import at most 5,000 rows at a time.');
  const headers = all.shift().map((h, i) => h.trim() || `Column ${i + 1}`);
  return { headers, rows: all, delimiter };
}
export function mapCsvRows(parsed, mapping, options = {}, existing = []) {
  const seen = new Set(existing.filter(l => !l.deleted).map(expenseFingerprint)), keys = new Set(existing.map(l => l.importKey).filter(Boolean));
  const get = (cells, key) => mapping[key] == null || mapping[key] === '' ? '' : String(cells[Number(mapping[key])] ?? '').trim();
  return parsed.rows.map((cells, index) => {
    try {
      if (cells.length !== parsed.headers.length) throw Error('Column count does not match the header.');
      let date = get(cells, 'date');
      if (options.dateFormat && options.dateFormat !== 'iso') {
        const match = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(date);
        if (!match) throw Error('Date does not match the selected format.');
        const day = options.dateFormat === 'dmy' ? match[1] : match[2], month = options.dateFormat === 'dmy' ? match[2] : match[1];
        date = `${match[3]}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
      } else date = date.slice(0, 10);
      if (!validDate(date)) throw Error('Invalid transaction date.');
      let rawAmount = get(cells, 'amount').replace(/\s/g, '');
      if (options.decimal === 'comma') {
        if (!/^-?(?:\d+|\d{1,3}(?:\.\d{3})+)(?:,\d{1,2})?$/.test(rawAmount)) throw Error('Amount does not match the selected decimal-comma format.');
        rawAmount = rawAmount.replace(/\./g, '').replace(',', '.');
      } else {
        if (!/^-?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(rawAmount)) throw Error('Amount does not match the selected decimal-dot format.');
        rawAmount = rawAmount.replace(/,/g, '');
      }
      let minor = options.amountUnits === 'minor' ? Number(rawAmount) : minorAmount(rawAmount);
      if (!Number.isSafeInteger(minor) || !minor) throw Error('Amount must be non-zero and have at most two decimals.');
      const kind = get(cells, 'kind').toLowerCase();
      if (['refund', 'credit'].includes(kind)) minor = -Math.abs(minor);
      if (options.personal && kind) {
        if (!['purchase', 'expense', 'debit', 'refund', 'credit'].includes(kind)) throw Error('Choose purchase/expense or refund as the transaction type.');
        if (['purchase', 'expense', 'debit'].includes(kind)) minor = Math.abs(minor);
      }
      const currency = (get(cells, 'currency') || options.currency || '').toUpperCase();
      if (!/^[A-Z]{3}$/.test(currency)) throw Error('Choose a three-letter currency.');
      if (options.currencies && !options.currencies.includes(currency)) throw Error(`Add ${currency} to the supported currency list first.`);
      const codeText = get(cells, 'code');
      if (codeText && !/^\d+$/.test(codeText)) throw Error('The expense-code column must contain numeric codes.');
      const row = { date, amount: fromMinor(minor), currency, written: (get(cells, 'written') || 'Imported expense').replace(/[\r\n\t]+/g, ' '), vendor: get(cells, 'vendor'), code: Number(codeText) || Number(options.code) || 7301, business: !!options.business, receipt: false, receiptIds: [], entered: false };
      if (options.personal) {
        row.personalCategory = get(cells, 'category') || options.category || options.categories?.find(c => Number(c.code) === row.code)?.short || 'Other';
        row.code = Number(options.categories?.find(c => c.short.toLowerCase() === row.personalCategory.toLowerCase())?.code || row.code);
        row.merchant = get(cells, 'merchant') || get(cells, 'vendor'); row.vendor = row.merchant;
        row.note = get(cells, 'note');
        row.written = (row.note || get(cells, 'written') || row.merchant || 'Imported spending').replace(/[\r\n\t]+/g, ' ');
        row.kind = minor < 0 ? 'refund' : 'purchase'; row.business = false;
      }
      if (options.codes && !options.codes.includes(row.code)) throw Error('Unknown expense code. Choose a supported category.');
      const fingerprint = expenseFingerprint(row), sourceId = get(cells, 'id'), source = options.source || 'CSV';
      row.importKey = sourceId ? `${source}|${sourceId}` : `${source}|${fingerprint}`;
      row.id = stableId('import', row.importKey);
      const duplicate = keys.has(row.importKey) || seen.has(fingerprint);
      seen.add(fingerprint); keys.add(row.importKey);
      return { index, row, duplicate, error: '' };
    } catch (error) { return { index, row: null, duplicate: false, error: error.message }; }
  });
}
export function validatePocketUrl(value) {
  if (!String(value || '').trim()) return '';
  let url; try { url = new URL(value); } catch { throw Error('Enter the full Pocket website address.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw Error('Use an HTTPS address without credentials.');
  return url.href;
}
