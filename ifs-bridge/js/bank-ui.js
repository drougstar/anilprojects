import { db, atomicBatchSave, uuid } from './db.js';
import { assertScopeCurrent, scopeIsCurrent } from './scope.js';
import { el, field, openDialog, toast, confirmButton } from './dom.js';
import { parseBankWorkbook, planBankImport, deriveBankCardAliases } from './bank-import.js';
import { readBankFiles } from './bank-files.js';

const purposes = [['review', 'Needs review'], ['personal', 'Personal'], ['business', 'Business']];
const kinds = { purchase: 'Purchase', refund: 'Refund', fee: 'Bank charge', payment: 'Card repayment', transfer: 'FX / balance transfer', financing: 'Statement financing', pending: 'Pending authorization', reward: 'Reward points', unknown: 'Unrecognized' };
const money = row => new Intl.NumberFormat('en-GB', { style: 'currency', currency: row.currency || 'TRY', currencyDisplay: 'narrowSymbol' }).format(row.amount || 0);
const pick = (values, value, label) => el('select', { 'aria-label': label }, values.map(([key, text]) => el('option', { value: key, selected: key === value }, text)));
const spending = row => ['purchase', 'refund', 'fee'].includes(row.bankKind || row.kind);
const purposeOf = row => ['personal', 'business', 'review'].includes(row.spendingPurpose) ? row.spendingPurpose : 'review';
const ready = item => ['new', 'possible-match', 'enrichment'].includes(item.status);

export function bankExpenseRecord(item, { sheet, settings, batchId, at }) {
  const row = item.row, bankKind = row.bankKind || row.kind;
  const category = row.personalCategory || row.category || 'Uncategorized';
  const purpose = purposeOf(row);
  const record = { ...row, id: item.id, sheetId: sheet.id, bankTransaction: true,
    kind: spending(row) ? (row.amount < 0 ? 'refund' : 'purchase') : 'purchase', bankKind,
    excludeFromSpending: !spending(row), business: purpose === 'business', spendingPurpose: purpose,
    code: Number(settings.expenseCodes?.find(c => c.short === category)?.code || 90009),
    personalCategory: category, merchant: row.merchant || row.bankDescription || '', vendor: row.merchant || row.bankDescription || '',
    originalDescription: row.bankDescription || '', written: row.note || '', note: row.note || '',
    receipt: false, receiptIds: [], entered: false, created_at: at, bankImportBatch: batchId,
    importSource: row.sourceFile || 'Bank import', importKey: `bank:${item.id}` };
  // Signed decimal amounts are the existing app storage contract. Preserve the
  // bank's immutable match fields, without a second amount representation.
  for (const key of ['amountMinor', 'signedMinor', 'include', 'error', 'reason', 'reviewRequired']) delete record[key];
  return record;
}

export async function openBankImport({ settings, sheet, onChange = () => {}, sync = () => {}, readFiles = readBankFiles }) {
  assertScopeCurrent();
  const currentSettings = typeof settings === 'function' ? settings : () => settings;
  const aborter = new AbortController();
  let workbooks = [], parsed = [], plan = [], selected = new Set(), edited = new Map(), aliases = {}, existing = [], busy = false, valid = false, page = 1;
  const status = el('p', { class: 'help', role: 'status' });
  const mappingHost = el('div'), preview = el('div'), sources = el('div', { class: 'bank-source-list' });
  const files = el('input', { type: 'file', accept: '.xls,.xlsx', multiple: true, 'aria-label': 'Bank Excel files' });
  const keepReferences = el('input', { type: 'checkbox', checked: true });
  const view = pick([['new', 'Ready to import'], ['possible-match', 'Needs duplicate review'], ['enrichment', 'New workbook details'], ['duplicate', 'Duplicates'], ['excluded', 'Excluded'], ['error', 'Errors'], ['all', 'All source rows']], 'new', 'Import review filter');
  const saveButton = el('button', { type: 'button', class: 'primary', disabled: true }, 'Save reviewed transactions');
  const summary = el('div', { class: 'bank-import-summary' });
  const body = el('div', { class: 'bank-import' },
    el('p', { class: 'help' }, 'Files are read locally. Only saved transactions sync to your account.'),
    field('Excel exports', files), sources,
    el('details', {}, el('summary', {}, 'Import options and card labels'), mappingHost,
      field('Keep repayments, transfers and pending authorizations for reference', keepReferences, 'Excluded from spending. Posted charges replace matching saved pending authorizations.')),
    summary, preview, el('div', { class: 'bank-import-save' }, saveButton, status));
  const dialog = openDialog('Import bank files', body, { wide: true, onClose: () => { aborter.abort(); workbooks = []; parsed = []; plan = []; existing = []; edited.clear(); } });
  const active = () => scopeIsCurrent() && dialog.isConnected && !aborter.signal.aborted;
  const invalidate = () => { valid = false; selected.clear(); saveButton.disabled = true; preview.replaceChildren(el('p', { class: 'help' }, 'Options changed. Build the preview again before saving.')); };
  const fail = error => { if (active()) { status.textContent = error.message || 'Could not read the files.'; status.classList.add('error'); } };
  const safe = run => async () => { try { assertScopeCurrent(); await run(); } catch (error) { fail(error); } };

  files.addEventListener('change', safe(async () => {
    if (busy) return; busy = true; valid = false; saveButton.disabled = true;
    try {
      workbooks = await readFiles(files.files, { signal: aborter.signal, onProgress: (i, count, name) => { if (active()) status.textContent = `Reading ${i + 1} of ${count}: ${name}`; } });
      if (!active()) return;
      parsed = workbooks.map(book => parseBankWorkbook(book));
      existing = await db.all('expenses'); if (!active()) return;
      const savedMappings = deriveBankCardAliases(existing);
      aliases = Object.assign({}, savedMappings.cardAliases, ...parsed.map(file => file.metadata?.suggestedCardAliases || file.metadata?.cardAliases || {}));
      const fileDetails = parsed.map(file => {
        const dates = file.rows.map(row => row.date).filter(Boolean).sort();
        return el('div', {}, el('strong', {}, file.metadata.fileName), el('small', {}, `${file.rows.length} source rows${dates.length ? ` · ${dates[0]} to ${dates.at(-1)}` : ''}`));
      });
      sources.replaceChildren(el('details', {}, el('summary', {}, `${parsed.length} file${parsed.length === 1 ? '' : 's'} · ${parsed.reduce((count, file) => count + file.rows.length, 0)} source rows`), ...fileDetails));
      const accounts = [...new Map(parsed.flatMap(file => file.metadata?.accounts || []).map(account => [account.id, account])).values()];
      const cardFields = accounts.map(account => {
        const proposed = aliases[account.id] || account.alias || (account.id.startsWith('mask:') ? '' : account.label);
        const control = el('input', { value: proposed, placeholder: account.label, 'aria-label': `Card label for ${account.label}`, maxlength: 80 });
        control.addEventListener('input', () => { aliases[account.id] = control.value.trim(); invalidate(); });
        return field(account.maskedCard || account.label, control);
      });
      mappingHost.replaceChildren(el('div', { class: 'bank-card-mapping' },
        el('p', { class: 'help' }, 'Use the same card label for its statement and in-month download. Saved labels and explicit mappings in your workbook are proposed here. Different cards stay separate.'), el('div', { class: 'grid2' }, cardFields)),
        el('button', { type: 'button', onclick: safe(buildPreview) }, 'Build preview'));
      await buildPreview();
    } finally { busy = false; if (active()) updateSave(); }
  }));
  keepReferences.addEventListener('change', invalidate);
  view.addEventListener('change', () => { page = 1; paintRows(); });

  async function buildPreview() {
    if (!workbooks.length) throw Error('Choose your Excel exports first.');
    existing = await db.all('expenses'); if (!active()) return;
    parsed = workbooks.map(book => parseBankWorkbook(book, { cardAliases: aliases }));
    plan = planBankImport(parsed, existing, { cardAliases: aliases, keepReferenceRows: keepReferences.checked });
    edited = new Map(); selected = new Set(plan.filter(item => item.status === 'new').map(item => item.id));
    valid = true; page = 1; status.classList.remove('error'); status.textContent = 'Nothing saved yet.';
    const counts = Object.fromEntries(['new', 'duplicate', 'possible-match', 'enrichment', 'excluded', 'error'].map(key => [key, plan.filter(item => item.status === key).length]));
    summary.replaceChildren(el('p', {}, [[counts.new, 'new'], [counts.duplicate, 'duplicates skipped'], [counts['possible-match'], 'possible matches'], [counts.enrichment, 'workbook updates to review'], [counts.excluded, 'excluded'], [counts.error, 'errors']].filter(([count]) => count).map(([count, label]) => `${count} ${label}`).join(' · ') || 'No importable rows'),
      ...[...new Set(parsed.flatMap(file => file.warnings || []))].map(message => el('small', {}, message)));
    paintRows();
  }
  function currentRow(item) { return { ...item.row, ...edited.get(item.id) }; }
  function updateSave() {
    saveButton.disabled = !valid || !selected.size || busy;
    saveButton.textContent = selected.size ? `Save ${selected.size} reviewed transactions` : 'Save reviewed transactions';
  }
  function paintRows() {
    if (!valid || !active()) return;
    const chosen = plan.filter(item => view.value === 'all' || item.status === view.value);
    const pages = Math.max(1, Math.ceil(chosen.length / 25)); page = Math.min(page, pages);
    const heading = el('div', { class: 'bank-preview-controls' }, view, ['possible-match', 'enrichment', 'all'].includes(view.value) ? el('small', {}, 'Possible matches and workbook updates are unchecked. Select a possible match only if it is a separate transaction.') : null);
    const bulkPurpose = pick([['', 'Set purpose for selected purchases…'], ...purposes], '', 'Purpose for selected purchases');
    bulkPurpose.addEventListener('change', () => {
      if (!bulkPurpose.value) return;
      for (const item of plan.filter(item => selected.has(item.id) && ['new', 'possible-match'].includes(item.status) && spending(item.row))) {
        edited.set(item.id, { ...edited.get(item.id), spendingPurpose: bulkPurpose.value, bankReviewFields: [...new Set([...(edited.get(item.id)?.bankReviewFields || []), 'spendingPurpose'])] });
      }
      paintRows();
    });
    heading.append(bulkPurpose);
    const list = el('div', { class: 'bank-preview-rows' });
    for (const [offset, item] of chosen.slice((page - 1) * 25, page * 25).entries()) {
      const row = currentRow(item), enabled = ready(item), position = (page - 1) * 25 + offset + 1;
      const cb = el('input', { type: 'checkbox', checked: selected.has(item.id) && enabled, disabled: !enabled, 'aria-label': `Import ${row.date || 'invalid date'} ${row.merchant || 'row'} ${position}` });
      cb.addEventListener('change', () => { cb.checked ? selected.add(item.id) : selected.delete(item.id); updateSave(); });
      const entry = el('div', { class: 'bank-preview-row' }, el('div', { class: 'bank-preview-main' }, cb,
        el('span', {}, el('strong', {}, row.merchant || row.bankDescription || 'Unrecognized row'), el('small', {}, `${row.date || 'Invalid date'} · ${row.card || 'Unspecified card'} · ${kinds[row.bankKind || row.kind] || row.kind}`)),
        el('b', { class: 'amt' }, row.error ? '—' : `${money(row)} ${row.currency || ''}`)),
        el('small', { class: item.status === 'possible-match' || item.status === 'error' ? 'bank-review-needed' : 'help' }, item.reason),
        el('small', { class: 'bank-provenance' }, `${row.sourceFile || ''} · ${row.sourceSheet || ''} · row ${row.sourceRow || ''}`));
      if (item.status === 'enrichment') entry.append(el('ul', {}, ...(item.enrichmentChanges || []).map(change => el('li', {}, `${change.label}: ${change.before || '(empty)'} → ${change.after}`))));
      if (enabled && item.status !== 'enrichment' && spending(row)) {
        const category = el('input', { value: row.personalCategory || row.category || 'Uncategorized', maxlength: 80, 'aria-label': `Category for transaction ${position}` });
        const purpose = pick(purposes, purposeOf(row), `Purpose for transaction ${position}`);
        const change = field => edited.set(item.id, { ...edited.get(item.id), [field]: field === 'personalCategory' ? category.value.trim() || 'Uncategorized' : purpose.value, bankReviewFields: [...new Set([...(edited.get(item.id)?.bankReviewFields || []), field])] });
        category.addEventListener('input', () => change('personalCategory')); purpose.addEventListener('change', () => change('spendingPurpose'));
        entry.append(el('div', { class: 'bank-review-fields' }, field('Category', category), field('Purpose', purpose)));
      }
      list.append(entry);
    }
    const previous = el('button', { type: 'button', disabled: page <= 1, onclick: () => { page--; paintRows(); } }, 'Previous');
    const next = el('button', { type: 'button', disabled: page >= pages, onclick: () => { page++; paintRows(); } }, 'Next');
    preview.replaceChildren(heading, list, chosen.length ? el('div', { class: 'personal-pagination' }, previous, `Page ${page} of ${pages}`, next) : el('p', { class: 'empty' }, 'No rows in this group.'));
    updateSave();
  }
  saveButton.addEventListener('click', safe(async () => {
    if (!valid || busy || !selected.size) return;
    busy = true; saveButton.disabled = true;
    try {
      const latest = await db.all('expenses'); if (!active()) return;
      const fresh = planBankImport(parsed, latest, { cardAliases: aliases, keepReferenceRows: keepReferences.checked });
      const chosen = plan.filter(item => ready(item) && selected.has(item.id));
      for (const item of chosen) {
        const now = fresh.find(candidate => candidate.id === item.id && ready(candidate));
        if (!now || now.status !== item.status || now.matchingExistingId !== item.matchingExistingId || (item.status === 'enrichment' && (now.expectedUpdatedAt !== item.expectedUpdatedAt || JSON.stringify(now.enrichmentPatch) !== JSON.stringify(item.enrichmentPatch)))) { invalidate(); throw Error('Records changed since the preview. Build it again before importing.'); }
      }
      const batchId = uuid(), at = new Date().toISOString();
      const items = chosen.map(item => {
        if (item.status === 'enrichment') {
          const prior = latest.find(row => row.id === item.matchingExistingId);
          return { table: 'expenses', record: { ...prior, ...item.enrichmentPatch, bankCardAliases: { ...prior.bankCardAliases, ...item.row.bankCardAliases } }, expectedUpdatedAt: item.expectedUpdatedAt };
        }
        return { table: 'expenses', record: bankExpenseRecord({ ...item, row: currentRow(item) }, { sheet, settings: currentSettings(), batchId, at }), expectedUpdatedAt: null };
      });
      // A posted charge and removal of its earlier pending snapshot are one Undo.
      const pendingIds = new Set(chosen.flatMap(item => item.matchingPendingIds || []));
      for (const id of pendingIds) { const prior = latest.find(row => row.id === id); if (prior && !prior.deleted) items.push({ table: 'expenses', record: { ...prior, deleted: true }, expectedUpdatedAt: prior.updated_at }); }
      assertScopeCurrent();
      await atomicBatchSave(items, { label: `Import ${chosen.length} bank transactions / updates` });
      if (!active()) return;
      dialog.close();
      await onChange({ entry: items.find(item => !item.record.deleted)?.record });
      sync(); toast(`${chosen.length} transactions saved. The whole import has one History Undo.`);
    } finally { busy = false; if (active()) updateSave(); }
  }));
  return dialog;
}

export async function openBankTransaction(id, { settings, onChange = () => {}, sync = () => {} }) {
  assertScopeCurrent(); const row = await db.get('expenses', id); assertScopeCurrent();
  if (!row || row.deleted) throw Error('This transaction is no longer available.');
  const currentSettings = typeof settings === 'function' ? settings : () => settings;
  const merchant = el('input', { value: row.merchant || row.bankDescription || '', maxlength: 200 });
  const category = el('input', { value: row.personalCategory || 'Uncategorized', maxlength: 80 });
  const purpose = pick(purposes, purposeOf(row), 'Spending purpose');
  const note = el('textarea', { rows: 3, maxlength: 2000 }, row.note || '');
  const status = el('p', { class: 'help', role: 'status' });
  const description = el('div', { class: 'bank-original' }, el('strong', {}, `${row.date} · ${money(row)} ${row.currency}`), el('span', {}, `${row.card || 'Unspecified card'} · ${kinds[row.bankKind] || row.bankKind}`), el('p', {}, row.originalDescription || row.bankDescription || ''), el('small', {}, `${row.sourceFile || ''} · ${row.sourceSheet || ''} · row ${row.sourceRow || ''}`));
  const save = el('button', { type: 'button', class: 'primary' }, 'Save transaction');
  const d = openDialog('Bank transaction', el('div', { class: 'form' }, description,
    !spending(row) ? el('p', { class: 'help' }, 'Kept for reference and excluded from spending totals.') : null,
    row.workExpenseLink?.workspace === 'work' ? el('p', { class: 'help' }, `Linked to Work expense ${row.workExpenseLink.expenseId}. Changing its purpose to Personal or Needs review removes the link; the Work expense is unchanged.`) : row.workTripSuggestion?.workspace === 'work' ? el('p', { class: 'help' }, 'Classified as Work after your trip review. This has not created a Work expense or reimbursement.') : null,
    field('Merchant', merchant), spending(row) ? field('Category', category) : null, spending(row) ? field('Purpose', purpose) : null, field('Note', note),
    el('div', { class: 'actions' }, save, confirmButton('Delete transaction', async () => {
      try { assertScopeCurrent(); await atomicBatchSave([{ table: 'expenses', record: { ...row, deleted: true }, expectedUpdatedAt: row.updated_at }], { label: 'Delete bank transaction' }); if (!scopeIsCurrent()) return; d.close(); await onChange(); sync(); }
      catch (error) { if (scopeIsCurrent() && d.isConnected) status.textContent = error.message; }
    })), status));
  save.addEventListener('click', async () => {
    try {
      assertScopeCurrent(); save.disabled = true;
      const updated = { ...row, bankReviewFields: [...new Set([...(row.bankReviewFields || []), 'merchant', 'personalCategory', 'spendingPurpose', 'note'])], merchant: merchant.value.trim(), vendor: merchant.value.trim(), note: note.value.trim(), written: note.value.trim(), ...(spending(row) ? { personalCategory: category.value.trim() || 'Uncategorized', spendingPurpose: purpose.value, business: purpose.value === 'business', code: Number(currentSettings().expenseCodes?.find(c => c.short === category.value.trim())?.code || 90009) } : {}) };
      if (spending(row) && purpose.value !== 'business') { delete updated.workExpenseLink; delete updated.workTripSuggestion; }
      await atomicBatchSave([{ table: 'expenses', record: updated, expectedUpdatedAt: row.updated_at }], { label: 'Classify bank transaction' });
      if (!scopeIsCurrent() || !d.isConnected) return;
      d.close(); await onChange({ entry: updated }); sync();
    } catch (error) { if (scopeIsCurrent() && d.isConnected) status.textContent = error.message; }
    finally { save.disabled = false; }
  });
  return d;
}
