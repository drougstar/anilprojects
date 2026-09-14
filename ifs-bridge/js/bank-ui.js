import { db, atomicBatchSave, uuid } from './db.js';
import { assertScopeCurrent, scopeIsCurrent, currentScope } from './scope.js';
import { el, field, openDialog, toast, confirmButton } from './dom.js';
import { parseBankWorkbook, planBankImport, deriveBankCardAliases } from './bank-import.js';
import { readBankFiles } from './bank-files.js';
import { suggestImportCategories } from './import-categories.js';
import { requestImportCategorySuggestions } from './import-ai.js';

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

export async function openBankImport({ settings, sheet, onChange = () => {}, sync = () => {}, readFiles = readBankFiles, matchWork, aiClient = null }) {
  assertScopeCurrent();
  const currentSettings = typeof settings === 'function' ? settings : () => settings;
  const aborter = new AbortController();
  let workbooks = [], parsed = [], plan = [], selected = new Set(), edited = new Map(), aliases = {}, existing = [], busy = false, valid = false, page = 1;
  let categoryGroups = [], categoryDrafts = new Map(), categoryUndo = null;
  let aiBusy = false, previewRevision = 0, aiReviewed = new Set();
  const personalImport = currentScope().workspace === 'personal';
  const status = el('p', { class: 'help', role: 'status' });
  const mappingHost = el('div'), preview = el('div'), sources = el('div', { class: 'bank-source-list' }), warnings = el('div', { class: 'bank-import-notes' });
  const files = el('input', { type: 'file', accept: '.xls,.xlsx', multiple: true, 'aria-label': 'Bank Excel files' });
  const keepReferences = el('input', { type: 'checkbox', checked: true });
  const view = pick([['new', 'Ready to import'], ['possible-match', 'Needs duplicate review'], ['enrichment', 'New workbook details'], ['duplicate', 'Duplicates'], ['excluded', 'Excluded'], ['error', 'Errors'], ['all', 'All source rows']], 'new', 'Import review filter');
  const saveButton = el('button', { type: 'button', class: 'primary', disabled: true }, 'Import');
  const summary = el('div', { class: 'bank-import-summary' });
  const categoryBody = el('div', { class: 'bank-category-body' });
  const categoryTitle = el('summary', {}, 'Categories');
  const categoryPanel = el('details', { class: 'bank-category-suggestions', hidden: true }, categoryTitle, categoryBody);
  const categoryView = pick([['suggested', 'Suggested categories'], ['all', 'All merchant groups']], 'suggested', 'Category groups');
  const categorySearch = el('input', { type: 'search', placeholder: 'Find a merchant', 'aria-label': 'Find a category group' });
  const categoryFeedback = el('p', { class: 'help', role: 'status' });
  const coverage = el('p', { class: 'help bank-file-coverage', hidden: true });
  const detailChoice = el('input', { type: 'checkbox', 'aria-label': 'Add all matching workbook details' });
  const detailLabel = el('span');
  const detailsBatch = el('div', { class: 'bank-details-batch', hidden: true },
    el('label', {}, detailChoice, detailLabel), el('p', { class: 'help' }, 'Adds matching categories, notes and other details in one batch. Amounts and dates stay unchanged; your earlier edits are protected.'));
  const exceptions = el('div', { class: 'bank-import-exceptions', hidden: true });
  const bulkPurpose = pick([['', 'Leave unchanged'], ...purposes], '', 'Purpose for selected purchases');
  const review = el('details', { class: 'bank-import-review', hidden: true }, el('summary', {}, 'Review transactions'), preview);
  const options = el('details', { class: 'bank-import-options', hidden: true }, el('summary', {}, 'Import options'),
    field('Purpose for selected purchases', bulkPurpose, 'Optional. Existing choices stay unchanged unless you select a purpose here.'),
    mappingHost, field('Keep card payments and transfers', keepReferences, 'Also keeps pending authorizations for reference. These do not count as spending.'),
    el('button', { type: 'button', onclick: () => safe(buildPreview)() }, 'Apply options'),
    sources, warnings, el('p', { class: 'help' }, 'Files are read on this device. Only imported transactions sync to your account.'));
  const body = el('div', { class: 'bank-import' },
    el('p', { class: 'help' }, 'Select your bank downloads together: TL, USD, EUR, statements and in-month transactions. You can include your detailed spending workbook too. No Excel editing or CSV conversion needed.'),
    field('Add your files', files), coverage,
    matchWork ? el('p', { class: 'help bank-work-match-help' }, 'Clear Work matches are handled automatically.') : null,
    summary, personalImport ? categoryPanel : null, detailsBatch, exceptions, review, options, el('div', { class: 'bank-import-save' }, saveButton, status));
  const dialog = openDialog('Import bank files', body, { wide: true, onClose: () => { aborter.abort(); workbooks = []; parsed = []; plan = []; existing = []; edited.clear(); } });
  const active = () => scopeIsCurrent() && dialog.open && dialog.isConnected && !aborter.signal.aborted;
  const invalidate = () => { previewRevision++; valid = false; selected.clear(); saveButton.disabled = true; status.textContent = 'Options changed. Apply options to continue.'; preview.replaceChildren(el('p', { class: 'help' }, 'Apply your import options to update this list.')); };
  const fail = error => { if (active()) { status.textContent = error.message || 'Could not read the files.'; status.classList.add('error'); } };
  const safe = run => async () => { try { assertScopeCurrent(); await run(); } catch (error) { fail(error); } };

  files.addEventListener('change', safe(async () => {
    if (busy || aiBusy) return; busy = true; valid = false; saveButton.disabled = true;
    try {
      const added = await readFiles(files.files, { signal: aborter.signal, onProgress: (i, count, name) => { if (active()) status.textContent = `Reading ${i + 1} of ${count}: ${name}`; } });
      if (!active()) return;
      // Adding the detail workbook must not require choosing every bank file again.
      // In-month exports identify the card in the filename, even when their bytes match.
      const key = book => JSON.stringify([book.name, book.fileHash || book.sheets]);
      workbooks = [...new Map([...workbooks, ...added].map(book => [key(book), book])).values()];
      parsed = workbooks.map(book => parseBankWorkbook(book));
      existing = await db.all('expenses'); if (!active()) return;
      const savedMappings = deriveBankCardAliases(existing);
      aliases = Object.assign({}, savedMappings.cardAliases, ...parsed.map(file => file.metadata?.suggestedCardAliases || file.metadata?.cardAliases || {}), aliases);
      const dates = parsed.flatMap(file => file.rows.map(row => row.date).filter(Boolean)).sort();
      const currencies = [...new Set(parsed.flatMap(file => file.metadata.currencies || []))].sort();
      coverage.hidden = false;
      coverage.textContent = `${workbooks.length} file${workbooks.length === 1 ? '' : 's'} added${dates.length ? ` · Dates in files: ${dates[0]} to ${dates.at(-1)}` : ''} · ${currencies.join(', ')}. Add more files with the same chooser; overlaps are checked together.`;
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
        el('p', { class: 'help' }, 'Use the same label for each card across its downloads.'), el('div', { class: 'grid2' }, cardFields)));
      await buildPreview();
    } finally { busy = false; if (active()) { paintCategories(); updateSave(); } }
  }));
  keepReferences.addEventListener('change', invalidate);
  detailChoice.addEventListener('change', () => {
    if (!valid) return;
    for (const item of plan.filter(item => item.status === 'enrichment')) detailChoice.checked ? selected.add(item.id) : selected.delete(item.id);
    paintRows();
  });
  view.addEventListener('change', () => { page = 1; paintRows(); });
  bulkPurpose.addEventListener('change', () => {
    if (!bulkPurpose.value || !valid) return;
    for (const item of plan.filter(item => selected.has(item.id) && ['new', 'possible-match'].includes(item.status) && spending(item.row))) {
      edited.set(item.id, { ...edited.get(item.id), spendingPurpose: bulkPurpose.value, bankReviewFields: [...new Set([...(edited.get(item.id)?.bankReviewFields || []), 'spendingPurpose'])] });
    }
    bulkPurpose.value = ''; paintRows();
  });
  categoryView.addEventListener('change', paintCategories);
  categorySearch.addEventListener('input', paintCategories);

  // A category choice only edits this import preview. Import remains the single
  // record write and History Undo; bank descriptions and labels are preserved.
  function applyCategories(groups, useDrafts = true) {
    if (!personalImport || !valid || busy || aiBusy || !active()) return;
    const before = new Map(); let count = 0;
    for (const group of groups) {
      const category = String(useDrafts ? categoryDrafts.get(group.id) ?? group.category : group.category).trim();
      if (!category) continue;
      for (const id of group.itemIds) {
        const item = plan.find(candidate => candidate.id === id);
        if (!selected.has(id) || !item || !['new', 'possible-match'].includes(item.status)) continue;
        const prior = edited.get(id);
        if (prior?.bankReviewFields?.includes('personalCategory')) continue;
        before.set(id, prior ? structuredClone(prior) : null);
        edited.set(id, { ...prior, personalCategory: category, categoryProvenance: 'user correction',
          bankReviewFields: [...new Set([...(prior?.bankReviewFields || []), 'personalCategory'])] });
        count++;
      }
    }
    if (count) categoryUndo = before;
    categoryFeedback.textContent = count ? `${count} transaction${count === 1 ? '' : 's'} updated in this preview. Import when ready.` : 'No selected transactions need this change.';
    paintCategories(); paintRows();
  }
  function undoCategories() {
    if (!categoryUndo || busy || aiBusy || !active()) return;
    for (const [id, before] of categoryUndo) {
      const current = { ...edited.get(id) };
      // Keep any purpose edits made after categorizing the group.
      for (const field of ['personalCategory', 'categoryProvenance']) before && Object.hasOwn(before, field) ? current[field] = before[field] : delete current[field];
      current.bankReviewFields = (current.bankReviewFields || []).filter(field => field !== 'personalCategory');
      if (before?.bankReviewFields?.includes('personalCategory')) current.bankReviewFields.push('personalCategory');
      edited.set(id, current);
    }
    categoryUndo = null; categoryFeedback.textContent = 'Last category change undone.'; paintCategories(); paintRows();
  }
  function paintCategories() {
    if (!personalImport || !valid || !active()) return;
    const focusedSearch = document.activeElement === categorySearch;
    const selection = focusedSearch ? [categorySearch.selectionStart, categorySearch.selectionEnd] : null;
    const suggestions = categoryGroups.filter(group => group.category);
    categoryPanel.hidden = !categoryGroups.length;
    categoryTitle.textContent = suggestions.length ? `Categories · ${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}` : 'Categories · group by merchant';
    const needle = categorySearch.value.trim().toLocaleLowerCase();
    const groups = categoryGroups.filter(group => (categoryView.value === 'all' || group.category) && (!needle || group.merchant.toLocaleLowerCase().includes(needle)));
    const list = el('div', { class: 'bank-category-groups' });
    for (const [index, group] of groups.entries()) {
      const ids = group.itemIds.filter(id => selected.has(id) && !edited.get(id)?.bankReviewFields?.includes('personalCategory'));
      const input = el('input', { value: categoryDrafts.get(group.id) ?? group.category, maxlength: 80, placeholder: 'Choose a category', 'aria-label': `Group category ${index + 1}` });
      input.addEventListener('input', () => { categoryDrafts.set(group.id, input.value); });
      list.append(el('div', { class: 'bank-category-group' },
        el('div', {}, el('strong', {}, group.merchant), el('small', {}, `${group.currency} · ${group.itemIds.length} transaction${group.itemIds.length === 1 ? '' : 's'} · Bank/import label: ${group.currentCategory}`), el('p', { class: 'help' }, group.reason)),
        field('Your category', input), el('button', { type: 'button', disabled: !ids.length, onclick: () => applyCategories([group]) }, ids.length ? `Use for ${ids.length}` : 'Applied / not selected')));
    }
    if (!groups.length) list.append(el('p', { class: 'help' }, 'No suggestions here. Choose All merchant groups to set a category for several transactions together.'));
    const aiGroups = pendingAiGroups();
    categoryBody.replaceChildren(el('p', { class: 'help' }, 'Local suggestions use merchant descriptions and your previous corrections. Bank labels stay in the original record. Choose the categories you want before importing.'),
      el('div', { class: 'bank-category-ai' },
        el('button', { type: 'button', disabled: aiBusy || busy || !aiGroups.length, onclick: askAi }, aiBusy ? 'Getting AI suggestions…' : 'Suggest with AI'),
        el('small', {}, `Sends up to ${Math.min(aiGroups.length, 200)} selected merchant groups, sample amounts, currencies and bank labels to OpenAI. Suggestions need your approval. No files or card details are uploaded.`)),
      el('div', { class: 'bank-category-controls' }, categoryView, categorySearch,
        el('button', { type: 'button', disabled: !suggestions.length, onclick: () => applyCategories(suggestions) }, 'Use suggested categories'),
        el('button', { type: 'button', disabled: !categoryUndo, onclick: undoCategories }, 'Undo category change')),
      list, categoryFeedback);
    if (focusedSearch) { categorySearch.focus({ preventScroll: true }); categorySearch.setSelectionRange(...selection); }
  }

  function pendingAiGroups() {
    return categoryGroups.filter(group => group.source !== 'user-history' && !aiReviewed.has(group.id) && !categoryDrafts.has(group.id))
      .map(group => ({ ...group, itemIds: group.itemIds.filter(id => selected.has(id) && !edited.get(id)?.bankReviewFields?.includes('personalCategory')) }))
      .filter(group => group.itemIds.length);
  }
  async function askAi() {
    if (!personalImport || !valid || busy || aiBusy || !active()) return;
    const groups = pendingAiGroups().slice(0, 200), revision = previewRevision;
    if (!groups.length) return;
    aiBusy = true; files.disabled = true; categoryFeedback.textContent = 'Getting category suggestions…'; paintCategories(); updateSave();
    try {
      const client = typeof aiClient === 'function' ? aiClient() : aiClient;
      const suggestions = await requestImportCategorySuggestions(client, groups, plan.map(item => ({ ...item, row: currentRow(item) })), { signal: aborter.signal, isCurrent: () => active() && valid && revision === previewRevision });
      if (!active() || !valid || revision !== previewRevision) return;
      const byId = new Map(suggestions.map(group => [group.id, group]));
      // A draft typed while the request was running remains the user's choice.
      categoryGroups = categoryGroups.map(group => byId.has(group.id) && !categoryDrafts.has(group.id) ? { ...group, ...byId.get(group.id) } : group);
      for (const group of suggestions) aiReviewed.add(group.id);
      categoryView.value = 'suggested';
      categoryFeedback.textContent = `${suggestions.filter(group => group.category).length} AI category suggestions ready. Review them, then use the ones you want.`;
    } catch (error) { if (active() && revision === previewRevision) categoryFeedback.textContent = error.message || 'AI is unavailable. Your import is unchanged.'; }
    finally { aiBusy = false; if (active()) { files.disabled = false; paintCategories(); updateSave(); } }
  }

  async function buildPreview() {
    previewRevision++;
    if (!workbooks.length) throw Error('Choose your Excel exports first.');
    existing = await db.all('expenses'); if (!active()) return;
    parsed = workbooks.map(book => parseBankWorkbook(book, { cardAliases: aliases }));
    plan = planBankImport(parsed, existing, { cardAliases: aliases, keepReferenceRows: keepReferences.checked, restorePersonalReset: currentScope().workspace === 'personal' });
    // Preserve deliberate draft edits on rows that remain in the new preview.
    edited = new Map([...edited].filter(([id]) => plan.some(item => item.id === id && ready(item))));
    selected = new Set(plan.filter(item => item.status === 'new').map(item => item.id));
    detailChoice.checked = false;
    valid = true; page = 1; status.classList.remove('error'); status.textContent = '';
    if (personalImport) {
      categoryGroups = suggestImportCategories(plan.map(item => ({ ...item, row: { ...item.row, ...edited.get(item.id) } })), existing);
      categoryDrafts = new Map([...categoryDrafts].filter(([id]) => categoryGroups.some(group => group.id === id)));
      categoryUndo = null; categoryFeedback.textContent = '';
      aiReviewed = new Set();
      if (!categoryGroups.some(group => group.category)) categoryView.value = 'all';
      paintCategories();
    }
    review.hidden = false; options.hidden = false;
    const counts = Object.fromEntries(['new', 'duplicate', 'possible-match', 'enrichment', 'excluded', 'error'].map(key => [key, plan.filter(item => item.status === key).length]));
    const needsReview = counts['possible-match'] + counts.enrichment;
    detailsBatch.hidden = !counts.enrichment;
    detailLabel.textContent = ` Add workbook details to ${counts.enrichment} existing transactions`;
    exceptions.hidden = !counts['possible-match'] && !counts.error;
    exceptions.replaceChildren(
      counts['possible-match'] ? el('button', { type: 'button', class: 'link', onclick: () => { view.value = 'possible-match'; page = 1; review.open = true; paintRows(); } }, `${counts['possible-match']} possible duplicate${counts['possible-match'] === 1 ? '' : 's'} — check only these`) : null,
      counts.error ? el('p', { class: 'error' }, `${counts.error} rows could not be read. Open Review transactions → Errors for details.`) : null,
      counts['possible-match'] && !parsed.some(file => file.sourceType === 'spending-workbook') ? el('p', { class: 'help' }, 'Your detailed workbook can connect masked card numbers to the card names in other downloads. Add it above, or set the card names in Import options.') : null);
    summary.replaceChildren(el('p', {}, counts.new ? `${counts.new} transaction${counts.new === 1 ? '' : 's'} ready to import` : 'No new transactions'),
      el('small', {}, [[counts.duplicate, 'duplicates skipped'], [needsReview, 'need review'], [counts.error, 'cannot be imported'], [counts.excluded, 'excluded']].filter(([count]) => count).map(([count, label]) => `${count} ${label}`).join(' · ')),
      ...(needsReview ? [el('small', { class: 'bank-review-needed' }, 'Review these before selecting them.')] : []));
    warnings.replaceChildren(...[...new Set(parsed.flatMap(file => file.warnings || []))].map(message => el('small', {}, message)));
    paintRows();
  }
  function currentRow(item) { return { ...item.row, ...edited.get(item.id) }; }
  function updateSave() {
    saveButton.disabled = !valid || !selected.size || busy || aiBusy;
    saveButton.textContent = selected.size ? `Import ${selected.size} transaction${selected.size === 1 ? '' : 's'}` : 'Import';
    if (valid && summary.firstElementChild) summary.firstElementChild.textContent = selected.size ? `${selected.size} transaction${selected.size === 1 ? '' : 's'} ready to import` : 'No transactions selected';
  }
  function paintRows() {
    if (!valid || !active()) return;
    const chosen = plan.filter(item => view.value === 'all' || item.status === view.value);
    const pages = Math.max(1, Math.ceil(chosen.length / 25)); page = Math.min(page, pages);
    const heading = el('div', { class: 'bank-preview-controls' }, view, ['possible-match', 'enrichment', 'all'].includes(view.value) ? el('small', {}, 'Possible matches and workbook updates are unchecked. Select a possible match only if it is a separate transaction.') : null);
    const list = el('div', { class: 'bank-preview-rows' });
    for (const [offset, item] of chosen.slice((page - 1) * 25, page * 25).entries()) {
      const row = currentRow(item), enabled = ready(item), position = (page - 1) * 25 + offset + 1;
      const cb = el('input', { type: 'checkbox', checked: selected.has(item.id) && enabled, disabled: !enabled, 'aria-label': `Import ${row.date || 'invalid date'} ${row.merchant || 'row'} ${position}` });
      cb.addEventListener('change', () => { cb.checked ? selected.add(item.id) : selected.delete(item.id); updateSave(); paintCategories(); });
      const entry = el('div', { class: 'bank-preview-row' }, el('div', { class: 'bank-preview-main' }, cb,
        el('span', {}, el('strong', {}, row.merchant || row.bankDescription || 'Unrecognized row'), el('small', {}, `${row.date || 'Invalid date'} · ${row.card || 'Unspecified card'} · ${kinds[row.bankKind || row.kind] || row.kind}`)),
        el('b', { class: 'amt' }, row.error ? '—' : `${money(row)} ${row.currency || ''}`)),
        item.status !== 'new' ? el('small', { class: item.status === 'possible-match' || item.status === 'error' ? 'bank-review-needed' : 'help' }, item.reason) : null);
      const rowDetails = el('details', { class: 'bank-transaction-details' }, el('summary', {}, item.status === 'enrichment' ? 'Review changes' : enabled && spending(row) ? 'Edit details' : 'Source details'));
      if (item.status === 'enrichment') rowDetails.append(el('ul', {}, ...(item.enrichmentChanges || []).map(change => el('li', {}, `${change.label}: ${change.before || '(empty)'} → ${change.after}`))));
      if (enabled && item.status !== 'enrichment' && spending(row)) {
        const category = el('input', { value: row.personalCategory || row.category || 'Uncategorized', maxlength: 80, 'aria-label': `Category for transaction ${position}` });
        const purpose = pick(purposes, purposeOf(row), `Purpose for transaction ${position}`);
        const change = field => {
          // Undo a group action must not erase a newer row-by-row correction.
          if (field === 'personalCategory') categoryUndo?.delete(item.id);
          edited.set(item.id, { ...edited.get(item.id), [field]: field === 'personalCategory' ? category.value.trim() || 'Uncategorized' : purpose.value,
            ...(personalImport && field === 'personalCategory' ? { categoryProvenance: 'user correction' } : {}), bankReviewFields: [...new Set([...(edited.get(item.id)?.bankReviewFields || []), field])] });
          if (field === 'personalCategory') paintCategories();
        };
        category.addEventListener('input', () => change('personalCategory')); purpose.addEventListener('change', () => change('spendingPurpose'));
        rowDetails.append(el('div', { class: 'bank-review-fields' }, field('Category', category), field('Purpose', purpose)));
      }
      rowDetails.append(el('small', { class: 'bank-provenance' }, `${row.sourceFile || ''} · ${row.sourceSheet || ''} · row ${row.sourceRow || ''}`));
      entry.append(rowDetails);
      list.append(entry);
    }
    const previous = el('button', { type: 'button', disabled: page <= 1, onclick: () => { page--; paintRows(); } }, 'Previous');
    const next = el('button', { type: 'button', disabled: page >= pages, onclick: () => { page++; paintRows(); } }, 'Next');
    preview.replaceChildren(heading, list, chosen.length ? el('div', { class: 'personal-pagination' }, previous, `Page ${page} of ${pages}`, next) : el('p', { class: 'empty' }, 'No rows in this group.'));
    updateSave();
  }
  saveButton.addEventListener('click', safe(async () => {
    if (!valid || busy || aiBusy || !selected.size) return;
    busy = true; saveButton.disabled = true; body.inert = true;
    try {
      const latest = await db.all('expenses'); if (!active()) return;
      const fresh = planBankImport(parsed, latest, { cardAliases: aliases, keepReferenceRows: keepReferences.checked, restorePersonalReset: currentScope().workspace === 'personal' });
      const chosen = plan.filter(item => ready(item) && selected.has(item.id));
      for (const item of chosen) {
        const now = fresh.find(candidate => candidate.id === item.id && ready(candidate));
        if (!now || now.status !== item.status || now.matchingExistingId !== item.matchingExistingId || now.personalResetReimport !== item.personalResetReimport || now.expectedUpdatedAt !== item.expectedUpdatedAt || (item.status === 'enrichment' && JSON.stringify(now.enrichmentPatch) !== JSON.stringify(item.enrichmentPatch))) { invalidate(); throw Error('Records changed since the preview. Build it again before importing.'); }
      }
      const batchId = uuid(), at = new Date().toISOString();
      const items = chosen.map(item => {
        if (item.status === 'enrichment') {
          const prior = latest.find(row => row.id === item.matchingExistingId);
          return { table: 'expenses', record: { ...prior, ...item.enrichmentPatch, bankCardAliases: { ...prior.bankCardAliases, ...item.row.bankCardAliases } }, expectedUpdatedAt: item.expectedUpdatedAt };
        }
        return { table: 'expenses', record: bankExpenseRecord({ ...item, row: currentRow(item) }, { sheet, settings: currentSettings(), batchId, at }), expectedUpdatedAt: item.personalResetReimport ? item.expectedUpdatedAt : null };
      });
      // A posted charge and removal of its earlier pending snapshot are one Undo.
      const pendingIds = new Set(chosen.flatMap(item => item.matchingPendingIds || []));
      for (const id of pendingIds) { const prior = latest.find(row => row.id === id); if (prior && !prior.deleted) items.push({ table: 'expenses', record: { ...prior, deleted: true }, expectedUpdatedAt: prior.updated_at }); }
      // Matching prepares these records before their first write. Import,
      // classification and pending-row replacement therefore share one Undo.
      let prepared = { items, matched: 0, message: '' };
      if (matchWork) {
        status.textContent = 'Checking your Work expenses…';
        prepared = await matchWork({ items, existingRows: latest, isCurrent: active });
        if (!active()) return;
        if (!Array.isArray(prepared?.items) || prepared.items.length !== items.length ||
          prepared.items.some((item, index) => item.table !== items[index].table || item.record?.id !== items[index].record.id || item.expectedUpdatedAt !== items[index].expectedUpdatedAt) ||
          !Number.isSafeInteger(prepared.matched) || prepared.matched < 0 || prepared.matched > chosen.length) throw Error('Work matching returned an invalid import. Nothing was saved.');
      }
      assertScopeCurrent();
      const matched = prepared.matched, matchMessage = String(prepared.message || '');
      await atomicBatchSave(prepared.items, { label: `Import ${chosen.length} bank transactions / updates${matched ? ` · ${matched} matched to Work` : ''}`, ...(matched ? { expectedExpenses: latest } : {}) });
      if (!active()) return;
      dialog.close();
      const imported = prepared.items.filter(item => !item.record.deleted).map(item => item.record);
      const months = [...new Set(imported.map(row => String(row.date || '').slice(0, 7)).filter(month => /^\d{4}-\d{2}$/.test(month)))].sort();
      await onChange({ entry: imported.slice().sort((a, b) => String(b.date).localeCompare(String(a.date)))[0],
        importSummary: { count: chosen.filter(item => item.status !== 'enrichment').length, updated: chosen.filter(item => item.status === 'enrichment').length,
          duplicates: plan.filter(item => item.status === 'duplicate').length,
          spendingCount: imported.filter(spending).length, referenceCount: imported.filter(row => !spending(row)).length,
          workCount: imported.filter(row => spending(row) && row.spendingPurpose === 'business').length,
          skippedReview: plan.filter(item => item.status === 'possible-match' && !selected.has(item.id)).length,
          unread: plan.filter(item => item.status === 'error').length, months }, ...(matchWork ? { matched, matchMessage } : {}) });
      sync(); toast(`${chosen.length} transactions saved.${matched ? ` ${matched} matched to Work.` : ''} The whole import has one History Undo.${matchMessage ? ` ${matchMessage}` : ''}`);
    } finally { busy = false; if (active()) { body.inert = false; updateSave(); } }
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
    row.workExpenseLink?.workspace === 'work' ? el('p', { class: 'help' }, 'Matched with Work. Choosing Personal or Needs review removes this match.') : row.workTripSuggestion?.workspace === 'work' ? el('p', { class: 'help' }, 'Marked as Work after your trip review. No expense claim was created.') : null,
    field('Merchant', merchant), spending(row) ? field('Category', category) : null, spending(row) ? field('Purpose', purpose) : null, field('Note', note),
    el('div', { class: 'actions' }, save, confirmButton('Delete transaction', async () => {
      try { assertScopeCurrent(); await atomicBatchSave([{ table: 'expenses', record: { ...row, deleted: true }, expectedUpdatedAt: row.updated_at }], { label: 'Delete bank transaction' }); if (!scopeIsCurrent()) return; d.close(); await onChange(); sync(); }
      catch (error) { if (scopeIsCurrent() && d.isConnected) status.textContent = error.message; }
    })), status));
  save.addEventListener('click', async () => {
    try {
      assertScopeCurrent(); save.disabled = true;
      const updated = { ...row, bankReviewFields: [...new Set([...(row.bankReviewFields || []), 'merchant', 'personalCategory', 'spendingPurpose', 'note'])], merchant: merchant.value.trim(), vendor: merchant.value.trim(), note: note.value.trim(), written: note.value.trim(), ...(spending(row) ? { personalCategory: category.value.trim() || 'Uncategorized', spendingPurpose: purpose.value, business: purpose.value === 'business', code: Number(currentSettings().expenseCodes?.find(c => c.short === category.value.trim())?.code || 90009) } : {}) };
      if (currentScope().workspace === 'personal' && spending(row) && updated.personalCategory !== (row.personalCategory || 'Uncategorized')) updated.categoryProvenance = 'user correction';
      if (spending(row) && purpose.value !== 'business') { delete updated.workExpenseLink; delete updated.workTripSuggestion; }
      await atomicBatchSave([{ table: 'expenses', record: updated, expectedUpdatedAt: row.updated_at }], { label: 'Classify bank transaction' });
      if (!scopeIsCurrent() || !d.isConnected) return;
      d.close(); await onChange({ entry: updated }); sync();
    } catch (error) { if (scopeIsCurrent() && d.isConnected) status.textContent = error.message; }
    finally { save.disabled = false; }
  });
  return d;
}
