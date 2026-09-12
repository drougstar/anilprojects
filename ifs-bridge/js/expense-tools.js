import { db, live, save, softDelete, uuid, atomicBatchSave } from './db.js';
import { currentScope, assertScopeCurrent } from './scope.js';
import { el, $, field, openDialog, confirmButton, toast } from './dom.js';
import { receiptBlob } from './sync.js';
import { readReceipt } from './ocr.js';
import { fmtMoney } from './expense-ifs.js';
import { minorAmount, fromMinor, validDate, photoIds, reimbursementSummary, settleReimbursements, addPayment, splitExpense, templateFromExpense, recurringDraft, budgetSummary, parseCsv, mapCsvRows, validatePocketUrl, stableId } from './expense-workflows.js';

let ctx;
export function initExpenseTools(context) { ctx = context; }
const personal = () => currentScope().workspace === 'personal';
const defaultCode = () => personal() ? Number(ctx.settings().expenseCodes[0]?.code) : Number(ctx.settings().expenseCodes.find(c => Number(c.code) === 7301)?.code || ctx.settings().expenseCodes[0]?.code);
const today = () => ctx.today();
const statusNode = () => el('p', { class: 'help workflow-status', role: 'status', 'aria-live': 'polite' });
const input = (value = '', type = 'text', extra = {}) => el('input', { type, value, ...extra });
const select = (values, value, extra = {}) => el('select', extra, values.map(([key, label]) => el('option', { value: key, selected: String(key) === String(value) }, label)));
const currencySelect = value => select((personal() ? [...new Set([...ctx.settings().currencies, value].filter(Boolean))] : ctx.settings().currencies).map(c => [c, c]), value || ctx.settings().defaultCurrency);
const expenseLabel = row => `${row.date} · ${fmtMoney(row.amount, row.currency)} · ${row.written || 'Expense'}`;
const changed = async () => { assertScopeCurrent(); await ctx.refresh(); ctx.scheduleSync(); };
function action(label, status, fn, primary = false) {
  const button = el('button', { type: 'button', class: primary ? 'primary' : '', onclick: async () => {
    if (button.disabled) return;
    button.disabled = true; status.textContent = '';
    try { assertScopeCurrent(); await fn(); }
    catch (error) { status.textContent = error.message; }
    finally { if (button.isConnected) button.disabled = false; }
  } }, label);
  return button;
}
const expected = row => row.updated_at ?? null;
async function freshExpense(row) {
  const latest = await db.get('expenses', row.id); assertScopeCurrent();
  if (!latest || latest.deleted || latest.updated_at !== row.updated_at) throw Error('This expense changed. Close this dialog and reopen it to continue.');
  return latest;
}
function closeThen(dialog, fn) { dialog.close(); return fn(); }

export function openExpenseTools(row = null) {
  const body = el('div', { class: 'workflow-menu' });
  const d = openDialog(row ? 'Expense actions' : 'Expense tools', body);
  const add = (label, description, fn) => body.append(el('button', { class: 'workflow-menu-item', onclick: () => closeThen(d, fn) }, el('b', {}, label), el('small', {}, description)));
  if (row) {
    if (!personal() && reimbursementSummary(row).eligible) add('Reimbursement', 'Mark the balance paid, or record a partial payment.', () => openReimbursement(row));
    add('Split receipt', personal() ? 'Divide the exact total into separate spending entries.' : 'Divide the exact total between business, personal, or project lines.', () => openSplit(row));
    add('Save as template', 'Reuse these details or prepare a monthly draft.', () => openTemplate(null, row));
  } else {
    if (!personal()) add('Review expenses', 'Receipts, rates, IFS readiness and reimbursements in one place.', () => ctx.review ? ctx.review() : openReimbursements());
    add('Receipt inbox', 'Add several photos, review them, then create or match expenses.', openInbox);
    add('Templates and recurring drafts', 'Reusable details and monthly bills that you confirm before adding.', openTemplates);
    add('Budgets', personal() ? 'Monthly spending limits, with each currency kept separate.' : 'Monthly or trip limits, with each currency kept separate.', openBudgets);
    add(personal() ? 'Import spending' : 'Import CSV', 'Map columns, review rows and skip duplicates before importing.', () => openCsvImport('CSV'));

  }
}

export async function openReimbursements({ ids } = {}) {
  const allowed = Array.isArray(ids) ? new Set(ids) : null;
  const rows = (await live('expenses')).filter(l => (!allowed || allowed.has(l.id)) && reimbursementSummary(l).eligible).sort((a, b) => String(b.date).localeCompare(String(a.date))); assertScopeCurrent();
  const host = el('div', { class: 'workflow-list reimbursement-list' }), mode = select([['open', 'Awaiting payment'], ['all', 'All business expenses'], ['paid', 'Fully paid']], 'open');
  const status = statusNode(), selected = new Set(), selection = el('p', { class: 'help reimbursement-selection', 'aria-live': 'polite' });
  const date = input(today(), 'date'), note = input('', 'text', { placeholder: 'Transfer reference (optional)' });
  let saving = false;
  const selectAll = el('input', { type: 'checkbox', 'aria-label': 'Select all shown unpaid expenses', onchange: () => {
    if (saving) return;
    for (const row of visible()) if (reimbursementSummary(row).remaining) selectAll.checked ? selected.add(row.id) : selected.delete(row.id);
    updateSelection();
  } });
  const markPaid = action('Mark selected paid', status, async () => {
    saving = true; updateSelection();
    try {
      const chosen = rows.filter(row => selected.has(row.id));
      const latest = await Promise.all(chosen.map(freshExpense)); assertScopeCurrent();
      if (!d.open) return;
      const next = settleReimbursements(latest, { date: date.value, note: note.value, paymentIds: latest.map(() => uuid()) });
      await atomicBatchSave(next.map((record, index) => ({ table: 'expenses', record, expectedUpdatedAt: expected(latest[index]) })), { label: `Mark ${next.length} reimbursements paid` });
      await changed(); toast(`${next.length} reimbursement${next.length === 1 ? '' : 's'} recorded. Undo in History.`);
      closeThen(d, openReimbursements);
    } finally { saving = false; if (d.open) updateSelection(); }
  }, true);
  const d = openDialog('Reimbursements', el('div', { class: 'reimbursement-manager' }, field('Show', mode),
    el('p', { class: 'help' }, 'Select the expenses covered by money you received. Each selected balance is recorded in full; partial payments are in the expense details.'),
    el('label', { class: 'reimbursement-select-all' }, selectAll, 'Select all shown unpaid expenses'), host,
    el('div', { class: 'reimbursement-save' }, selection,
      el('details', {}, el('summary', {}, 'Payment date or note'), el('div', { class: 'grid2' }, field('Date received', date), field('Payment note', note))),
      markPaid, status)), { wide: true });
  function visible() { return rows.filter(row => mode.value === 'all' || (mode.value === 'paid' ? !reimbursementSummary(row).remaining : reimbursementSummary(row).remaining)); }
  function updateSelection() {
    const outstanding = visible().filter(row => reimbursementSummary(row).remaining);
    const chosen = rows.filter(row => selected.has(row.id)), totals = reimbursementTotals(chosen);
    selection.textContent = chosen.length ? `${chosen.length} selected · ${totals} · received ${date.value}` : 'No expenses selected.';
    markPaid.disabled = saving || !chosen.length;
    selectAll.disabled = saving || !outstanding.length;
    selectAll.checked = !!outstanding.length && outstanding.every(row => selected.has(row.id));
    selectAll.indeterminate = outstanding.some(row => selected.has(row.id)) && !selectAll.checked;
    for (const checkbox of host.querySelectorAll('input[type=checkbox]')) { checkbox.checked = selected.has(checkbox.dataset.expenseId); checkbox.disabled = saving; }
    mode.disabled = date.disabled = note.disabled = saving;
  }
  function paint() {
    const chosen = visible();
    host.replaceChildren(el('p', { class: 'help' }, reimbursementTotals(chosen) ? `${reimbursementTotals(chosen)} awaiting payment` : 'Nothing awaiting payment.'),
      ...chosen.map(row => {
        const summary = reimbursementSummary(row);
        const checkbox = summary.remaining ? el('input', { type: 'checkbox', 'data-expense-id': row.id, 'aria-label': `Select ${expenseLabel(row)}`, onchange: event => {
          if (saving) return; event.target.checked ? selected.add(row.id) : selected.delete(row.id); updateSelection();
        } }) : null;
        return el('div', { class: 'reimbursement-row' }, checkbox,
          el('button', { class: 'workflow-menu-item', onclick: () => { if (!saving) closeThen(d, () => openReimbursement(row)); } }, el('b', {}, expenseLabel(row)),
            el('small', {}, `${reimbursementStatus(summary)}${summary.paid ? ` · received ${fmtMoney(fromMinor(summary.paid), row.currency)}` : ''}${summary.remaining ? ` · remaining ${fmtMoney(fromMinor(summary.remaining), row.currency)}` : ''}`)));
      }));
    updateSelection();
  }
  mode.addEventListener('change', () => { selected.clear(); paint(); }); date.addEventListener('change', updateSelection); paint();
}

const reimbursementStatus = summary => ({ awaiting: 'Awaiting payment', partial: 'Partly paid', paid: 'Paid' })[summary.status];
function reimbursementTotals(rows) {
  const totals = {};
  for (const row of rows) { const { remaining } = reimbursementSummary(row); if (remaining) totals[row.currency] = (totals[row.currency] || 0) + remaining; }
  return Object.entries(totals).map(([currency, total]) => fmtMoney(fromMinor(total), currency)).join(' · ');
}

export function openReimbursement(row) {
  const summary = reimbursementSummary(row), status = statusNode();
  const amount = input('', 'number', { step: '0.01', min: '0.01', max: fromMinor(summary.remaining), placeholder: fromMinor(summary.remaining).toFixed(2) });
  const date = input(today(), 'date'), note = input('', 'text', { placeholder: 'Transfer reference or note (optional)' });
  const payments = el('div', { class: 'workflow-list' });
  let saving = false;
  async function recordPayment(full) {
    if (saving) return; saving = true;
    try {
      const latest = await freshExpense(row); if (!d.open) return;
      const next = full ? settleReimbursements([latest], { date: date.value, note: note.value, paymentIds: [uuid()] })[0] : addPayment(latest, { id: uuid(), amount: amount.value, date: date.value, currency: row.currency, note: note.value.trim() });
      await atomicBatchSave([{ table: 'expenses', record: next, expectedUpdatedAt: expected(latest) }], { label: full ? 'Mark reimbursement paid' : 'Record partial reimbursement payment' });
      await changed(); closeThen(d, openReimbursements);
    } finally { saving = false; }
  }
  const d = openDialog('Reimbursement', el('div', { class: 'form' }, el('p', {}, expenseLabel(row)),
    el('p', { class: 'help' }, `${reimbursementStatus(summary)} · received ${fmtMoney(fromMinor(summary.paid), row.currency)} · remaining ${fmtMoney(fromMinor(summary.remaining), row.currency)}.`),
    summary.remaining ? el('div', { class: 'reimbursement-quick' },
      action(`Mark ${fmtMoney(fromMinor(summary.remaining), row.currency)} paid`, status, () => recordPayment(true), true),
      el('p', { class: 'help' }, 'Records the remaining balance. The payment date defaults to today; Undo is available in History.'),
      el('details', {}, el('summary', {}, 'Partial payment, date or note'), el('div', { class: 'grid2' }, field(`Payment amount (${row.currency})`, amount), field('Date received', date)), field('Payment note', note),
        action('Record payment', status, () => recordPayment(false)))) : null,
    el('details', {}, el('summary', {}, `Payment history (${row.reimbursement?.payments?.length || 0})`), payments,
      ['submitted', 'approved'].includes(row.reimbursement?.stage) ? el('p', { class: 'help' }, `Earlier tracking: ${row.reimbursement.stage}.`) : null),
    status));
  // Corrections are explicit and audited; they never write to a bank or IFS.
  for (const p of row.reimbursement?.payments || []) payments.append(el('div', { class: 'workflow-item' }, el('span', {}, `${p.date} · ${fmtMoney(p.amount, row.currency)}${p.note ? ` · ${p.note}` : ''}`), confirmButton('Remove payment', async () => {
    try { if (saving) return; saving = true; const latest = await freshExpense(row); if (!d.open) return; const next = { ...latest, reimbursement: { ...latest.reimbursement, stage: latest.reimbursement.stage === 'paid' ? 'recorded' : latest.reimbursement.stage, payments: latest.reimbursement.payments.filter(x => x.id !== p.id) } }; await atomicBatchSave([{ table: 'expenses', record: next, expectedUpdatedAt: expected(latest) }], { label: 'Correct reimbursement payment' }); await changed(); closeThen(d, openReimbursements); }
    catch (error) { status.textContent = error.message; }
    finally { saving = false; }
  })));
  if (!payments.childNodes.length) payments.append(el('p', { class: 'help' }, 'No payments recorded.'));
}

export function openSplit(row) {
  const partsHost = el('div', { class: 'workflow-list' }), status = statusNode(), parts = [];
  const total = minorAmount(row.amount), half = Math.trunc(total / 2);
  function addPart(amount = '', business = !personal()) {
    const amountIn = input(amount, 'number', { step: '0.01', 'aria-label': 'Split amount' });
    const who = select(personal() ? [['personal', 'Personal']] : [['business', 'Business'], ['personal', 'Personal']], business ? 'business' : 'personal', { 'aria-label': 'Split type' });
    const shortName = input(row.shortName || '', 'text', { placeholder: 'Project short name (business only)', 'aria-label': 'Split project' });
    const written = input(personal() ? row.note ?? row.written ?? '' : row.written || '', 'text', { 'aria-label': 'Split description' });
    const currentCategory = row.personalCategory || ctx.settings().expenseCodes.find(c => Number(c.code) === Number(row.code))?.short || 'Other';
    const category = select([...new Set([...ctx.settings().expenseCodes.map(c => c.short), currentCategory])].map(c => [c, c]), currentCategory, { 'aria-label': 'Split category' });
    const part = { amountIn, who, shortName, written, category };
    const node = el('div', { class: 'workflow-split-row' }, field(`Amount (${row.currency})`, amountIn), personal() ? field('Category', category) : field('Type', who), field(personal() ? 'Note' : 'Description', written), personal() ? null : field('Project', shortName), el('button', { class: 'link', onclick: () => { parts.splice(parts.indexOf(part), 1); node.remove(); showTotal(); } }, 'Remove'));
    parts.push(part); partsHost.append(node); amountIn.addEventListener('input', showTotal);
  }
  const remaining = el('p', { class: 'help', role: 'status' });
  function showTotal() { try { const sum = parts.reduce((n, p) => n + minorAmount(p.amountIn.value || 0), 0); remaining.textContent = `Parts: ${fmtMoney(fromMinor(sum), row.currency)} · remaining ${fmtMoney(fromMinor(total - sum), row.currency)}`; } catch { remaining.textContent = 'Use at most two decimals per part.'; } }
  addPart(fromMinor(half), row.business); addPart(fromMinor(total - half), false); showTotal();
  const d = openDialog('Split receipt', el('div', { class: 'form' }, el('p', {}, `Original: ${expenseLabel(row)}`), el('p', { class: 'help' }, 'The original is replaced by these parts in one save. They keep its date, currency and photos. History can undo the whole split.'), partsHost, remaining,
    el('button', { onclick: () => { if (parts.length < 20) addPart(); showTotal(); } }, 'Add part'),
    action('Replace with these parts', status, async () => {
      const latest = await freshExpense(row), groupId = uuid();
      const result = splitExpense(latest, parts.map(p => ({ amount: p.amountIn.value, business: p.who.value === 'business', shortName: p.shortName.value.trim(), written: p.written.value.trim(), ...(personal() ? { note: p.written.value.trim(), personalCategory: p.category.value, code: Number(ctx.settings().expenseCodes.find(c => c.short === p.category.value)?.code || row.code || defaultCode()) } : {}) })), { groupId, ids: parts.map(() => uuid()), at: new Date().toISOString() });
      await atomicBatchSave([{ table: 'expenses', record: result.parent, expectedUpdatedAt: expected(latest) }, ...result.children.map(record => ({ table: 'expenses', record, expectedUpdatedAt: null }))], { label: 'Split receipt' });
      await changed(); d.close(); toast(`Receipt split into ${parts.length} parts.`);
    }, true), status), { wide: true });
}

export async function openInbox() {
  const rows = (await live('inbox')).filter(r => r.status !== 'matched' && r.status !== 'created'); assertScopeCurrent();
  const status = statusNode(), list = el('div', { class: 'workflow-list' });
  const files = input('', 'file', { accept: 'image/*', multiple: true });
  const d = openDialog('Receipt inbox', el('div', {}, el('p', { class: 'help' }, 'Select receipt photos. They stay in the inbox until you review and create an expense or attach one to an existing expense.'), field('Receipt photos', files),
    action('Add selected photos', status, async () => {
      if (!files.files.length) throw Error('Select one or more photos.');
      if (files.files.length > 30) throw Error('Add at most 30 photos at once.');
      const all = await db.all('inbox'), known = new Set(all.map(r => r.fileHash).filter(Boolean)), changes = []; let skipped = 0;
      for (const file of files.files) {
        if (!file.type.startsWith('image/')) throw Error(`${file.name} is not an image.`);
        if (file.size > 20_000_000) throw Error(`${file.name} is larger than 20 MB.`);
        const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
        const fileHash = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
        if (known.has(fileHash)) { skipped++; continue; } known.add(fileHash);
        const receiptId = uuid(), blob = await ctx.downscale(file); assertScopeCurrent();
        changes.push({ table: 'receipts', record: { id: receiptId, blob, dirty: true }, expectedUpdatedAt: null }, { table: 'inbox', record: { id: stableId('inbox', `${currentScope().key}|${fileHash}`), receiptId, fileHash, name: file.name, status: 'pending', created_at: new Date().toISOString() }, expectedUpdatedAt: null });
      }
      if (changes.length) await atomicBatchSave(changes, { label: 'Add receipt photos to inbox' });
      await changed(); d.close(); toast(`${changes.length / 2} photos added${skipped ? `; ${skipped} already in inbox` : ''}.`); openInbox();
    }, true), status, list));
  if (!rows.length) list.append(el('p', { class: 'empty' }, 'No receipts waiting for review.'));
  for (const row of rows) list.append(el('button', { class: 'workflow-menu-item', onclick: () => closeThen(d, () => openInboxReview(row)) }, el('b', {}, row.name || 'Receipt photo'), el('small', {}, row.draft?.written || 'Review amount, date and currency')));
}

export async function openInboxReview(item) {
  const status = statusNode(), draft = item.draft || {}, amount = input(draft.amount || '', 'number', { step: '0.01' }), date = input(draft.date || today(), 'date'), cur = currencySelect(draft.currency), written = input(draft.written || '', 'text'), code = select(ctx.settings().expenseCodes.map(c => [c.code, c.short]), draft.code || defaultCode());
  const receiptCategory = draft.personalCategory || ctx.settings().expenseCodes.find(c => Number(c.code) === Number(draft.code || defaultCode()))?.short || 'Other';
  const category = select([...new Set([...ctx.settings().expenseCodes.map(c => c.short), receiptCategory])].map(c => [c, c]), receiptCategory), merchant = input(draft.merchant ?? draft.vendor ?? '');
  if (personal()) written.value = draft.note ?? draft.written ?? '';
  const who = select(personal() ? [['personal', 'Personal']] : [['business', 'Business'], ['personal', 'Personal']], personal() || draft.business === false ? 'personal' : 'business');
  const image = el('img', { class: 'workflow-receipt', alt: 'Receipt awaiting review' });
  const ocrText = el('pre', { class: 'workflow-ocr' });
  const existing = await live('expenses'); assertScopeCurrent();
  const match = select([['', 'Choose an existing expense…'], ...existing.sort((a, b) => (b.date || '').localeCompare(a.date || '')).map(l => [l.id, expenseLabel(l)])], '');
  let blob, imageUrl;
  const values = () => ({ amount: amount.value, date: date.value, currency: cur.value, written: written.value.trim(), code: Number(code.value), business: !personal() && who.value === 'business', ...(personal() ? { personalCategory: category.value, code: Number(ctx.settings().expenseCodes.find(c => c.short === category.value)?.code || draft.code || defaultCode()), merchant: merchant.value.trim(), vendor: merchant.value.trim(), note: written.value.trim(), kind: Number(amount.value) < 0 ? 'refund' : 'purchase' } : {}) });
  async function latestInbox() { const latest = await db.get('inbox', item.id); assertScopeCurrent(); if (!latest || latest.deleted || ['created', 'matched'].includes(latest.status) || latest.updated_at !== item.updated_at) throw Error('This receipt changed or has already been used. Reopen the inbox.'); return latest; }
  const d = openDialog('Review receipt', el('div', { class: 'form' }, image,
    action('Read text from photo', status, async () => { if (!blob) throw Error('The photo is still loading.'); const found = await readReceipt(blob, { onProgress: percent => { status.textContent = `Reading ${percent}%`; } }); assertScopeCurrent(); if (!d.isConnected) return; if (found.amount) amount.value = found.amount; if (found.date) date.value = found.date; if (found.currency && ctx.settings().currencies.includes(found.currency)) cur.value = found.currency; ocrText.textContent = found.text; status.textContent = 'Suggestions filled. Check every field before creating an expense.'; }),
    el('div', { class: 'grid2' }, field('Amount', amount), field('Currency', cur), field('Date', date), field(personal() ? 'Category' : 'Type', personal() ? category : code)), field(personal() ? 'Note' : 'Description', written), personal() ? field('Merchant', merchant) : null, personal() ? null : field('Who pays', who),
    el('details', {}, el('summary', {}, 'Read text'), ocrText),
    action('Create expense from reviewed fields', status, async () => {
      const latest = await latestInbox(), value = values();
      if (!validDate(value.date)) throw Error('Choose a valid date.');
      const minor = minorAmount(value.amount); if (!minor) throw Error('Enter a non-zero amount.');
      if (!personal() && !value.written) throw Error('Add a description.');
      const row = { ...value, id: uuid(), amount: fromMinor(minor), sheetId: ctx.currentSheet().id, receiptIds: [item.receiptId], receipt: value.business, entered: false, created_at: new Date().toISOString(), inboxId: item.id };
      const matches = existing.filter(l => l.date === row.date && l.currency === row.currency && minorAmount(l.amount) === minor);
      if (matches.length && !$('#inbox-duplicate-confirm', d)?.checked) throw Error('A matching date, amount and currency exists. Attach the photo below, or tick “This is a separate purchase”.');
      await atomicBatchSave([{ table: 'expenses', record: row, expectedUpdatedAt: null }, { table: 'inbox', record: { ...latest, status: 'created', expenseId: row.id, draft: value }, expectedUpdatedAt: expected(latest) }], { label: 'Create expense from receipt inbox' });
      await changed(); closeThen(d, openInbox);
    }, true),
    el('label', { class: 'inline' }, input('', 'checkbox', { id: 'inbox-duplicate-confirm' }), ' This is a separate purchase if a matching amount already exists'),
    el('h4', {}, 'Or attach to an existing expense'), field('Existing expense', match),
    action('Attach photo to selected expense', status, async () => {
      if (!match.value) throw Error('Choose an existing expense.');
      const latest = await latestInbox(), row = await db.get('expenses', match.value); assertScopeCurrent();
      if (!row || row.deleted) throw Error('This expense is no longer available.');
      await atomicBatchSave([{ table: 'expenses', record: { ...row, receiptIds: [...new Set([...photoIds(row), item.receiptId])], receipt: !!row.business || !!row.receipt }, expectedUpdatedAt: expected(row) }, { table: 'inbox', record: { ...latest, status: 'matched', expenseId: row.id }, expectedUpdatedAt: expected(latest) }], { label: 'Match inbox receipt to expense' });
      await changed(); closeThen(d, openInbox);
    }),
    el('div', { class: 'actions' }, action('Save review for later', status, async () => { const latest = await latestInbox(); await atomicBatchSave([{ table: 'inbox', record: { ...latest, draft: values() }, expectedUpdatedAt: expected(latest) }], { label: 'Save receipt review' }); await changed(); closeThen(d, openInbox); }),
      confirmButton('Remove from inbox', async () => { try { const latest = await latestInbox(); await atomicBatchSave([{ table: 'inbox', record: { ...latest, deleted: true }, expectedUpdatedAt: expected(latest) }], { label: 'Remove inbox receipt' }); await changed(); closeThen(d, openInbox); } catch (error) { status.textContent = error.message; } })), status), { onClose: () => { if (imageUrl) URL.revokeObjectURL(imageUrl); } });
  try { blob = await receiptBlob(ctx.client(), item.receiptId); assertScopeCurrent(); if (blob && d.isConnected) { imageUrl = URL.createObjectURL(blob); image.src = imageUrl; } else if (d.isConnected) status.textContent = 'Photo is not available on this device yet. Sync and reopen the receipt.'; } catch (error) { if (d.isConnected) status.textContent = error.message; }
}

export async function openTemplates() {
  const templates = await live('templates'), existing = await db.all('expenses'); assertScopeCurrent();
  const month = input(today().slice(0, 7), 'month'), host = el('div', { class: 'workflow-list' }), status = statusNode();
  const d = openDialog('Templates and recurring drafts', el('div', {}, el('p', { class: 'help' }, 'Monthly entries are drafts until you confirm them here. Nothing is added automatically.'), field('Month to review', month), el('button', { onclick: () => closeThen(d, () => openTemplate(null, null)) }, 'New template'), host, status));
  function paint() {
    host.replaceChildren();
    for (const t of templates) {
      let draft; try { draft = recurringDraft(t, month.value, existing); } catch { draft = null; }
      host.append(el('div', { class: 'workflow-item' }, el('div', {}, el('b', {}, t.name), el('small', { class: 'help' }, `${fmtMoney(t.defaults.amount, t.defaults.currency)}${t.recurrence ? ` · monthly on day ${t.day}${t.active ? '' : ' · paused'}` : ''}`)),
        el('div', { class: 'actions' }, el('button', { onclick: () => closeThen(d, () => ctx.newExpense({ ...t.defaults, templateId: t.id, business: personal() ? false : !!t.defaults.business, receipt: false, entered: false })) }, 'Use once'),
          el('button', { onclick: () => closeThen(d, () => openTemplate(t)) }, 'Edit'),
          draft ? action(`Review ${draft.date}`, status, () => closeThen(d, () => openRecurringReview(t, month.value))) : null,
          t.recurrence && !draft ? el('small', { class: 'help' }, !t.active ? 'Paused' : month.value < t.startMonth ? 'Not started' : 'Already confirmed this month') : null)));
    }
    if (!templates.length) host.append(el('p', { class: 'empty' }, 'Save a frequent expense as a template, or create one here.'));
  }
  month.addEventListener('change', paint); paint();
}

export function openTemplate(template = null, row = null) {
  const defaults = template?.defaults || row || { amount: '', currency: ctx.settings().defaultCurrency, written: '', business: !personal(), code: defaultCode() };
  const name = input(template?.name || row?.written || ''), amount = input(defaults.amount, 'number', { step: '0.01' }), cur = currencySelect(defaults.currency), written = input(defaults.written || ''), code = select(ctx.settings().expenseCodes.map(c => [c.code, c.short]), defaults.code || defaultCode()), who = select(personal() ? [['personal', 'Personal']] : [['business', 'Business'], ['personal', 'Personal']], defaults.business && !personal() ? 'business' : 'personal');
  const personalCategory = defaults.personalCategory || ctx.settings().expenseCodes.find(c => Number(c.code) === Number(defaults.code))?.short || ctx.settings().expenseCodes[0]?.short || 'Other';
  const category = select([...new Set([...ctx.settings().expenseCodes.map(c => c.short), personalCategory])].map(c => [c, c]), personalCategory), merchant = input(defaults.merchant ?? defaults.vendor ?? '');
  if (personal()) written.value = defaults.note ?? defaults.written ?? '';
  const repeat = select([['', 'Only when I choose Use once'], ['monthly', 'Monthly draft']], template?.recurrence || ''), day = input(template?.day || Number(today().slice(8)), 'number', { min: 1, max: 31 }), start = input(template?.startMonth || today().slice(0, 7), 'month'), active = input('', 'checkbox', { checked: template?.active !== false }), status = statusNode();
  const d = openDialog(template ? 'Edit template' : 'New template', el('div', { class: 'form' }, field('Template name', name), el('div', { class: 'grid2' }, field('Amount', amount), field('Currency', cur)), field(personal() ? 'Note' : 'Description', written), personal() ? field('Merchant', merchant) : null, field(personal() ? 'Category' : 'Type', personal() ? category : code), personal() ? null : field('Who pays', who), field('Repeat', repeat), el('div', { class: 'grid2' }, field('Day of month', day, 'Days 29–31 use the last day in shorter months.'), field('First month', start)), el('label', { class: 'inline' }, active, ' Active'),
    action('Save template', status, async () => { const record = templateFromExpense({ ...defaults, amount: fromMinor(minorAmount(amount.value)), currency: cur.value, written: written.value.trim(), code: Number(code.value), business: who.value === 'business' }, { id: template?.id || uuid(), name: name.value, recurrence: repeat.value, day: Number(day.value), startMonth: start.value }); record.active = active.checked; if (personal()) Object.assign(record.defaults, { personalCategory: category.value, code: Number(ctx.settings().expenseCodes.find(c => c.short === category.value)?.code || defaults.code || defaultCode()), merchant: merchant.value.trim(), vendor: merchant.value.trim(), note: written.value.trim(), kind: record.defaults.amount < 0 ? 'refund' : 'purchase', business: false, costObject: '', shortName: '', tripId: '' }); await atomicBatchSave([{ table: 'templates', record, expectedUpdatedAt: template ? expected(template) : null }], { label: 'Save expense template' }); await changed(); closeThen(d, openTemplates); }, true),
    template ? confirmButton('Delete template', async () => { try { await atomicBatchSave([{ table: 'templates', record: { ...template, deleted: true }, expectedUpdatedAt: expected(template) }], { label: 'Delete expense template' }); await changed(); closeThen(d, openTemplates); } catch (error) { status.textContent = error.message; } }) : null, status));
}

async function openRecurringReview(template, month) {
  const existing = await db.all('expenses'), draft = recurringDraft(template, month, existing); assertScopeCurrent();
  if (!draft) { toast('This occurrence is already confirmed or paused.'); return openTemplates(); }
  const amount = input(draft.amount, 'number', { step: '0.01' }), date = input(draft.date, 'date'), written = input(personal() ? draft.note ?? draft.written ?? '' : draft.written || ''), status = statusNode();
  const d = openDialog('Confirm recurring expense', el('div', { class: 'form' }, el('p', {}, `${template.name} · ${month}`), field(`Amount (${draft.currency})`, amount), field('Date', date), field('Description', written), el('p', { class: 'help' }, personal() ? 'Confirming adds one spending entry. The same template and month cannot be confirmed twice.' : 'Confirming adds one expense to the current sheet. The same template and month cannot be confirmed twice.'),
    action('Confirm and add expense', status, async () => {
      if (!validDate(date.value) || date.value.slice(0, 7) !== month) throw Error('Choose a date in the month being confirmed.');
      const minor = minorAmount(amount.value); if (!minor) throw Error('Enter a non-zero amount.');
      const latest = await db.get('templates', template.id), all = await db.all('expenses'); assertScopeCurrent();
      if (!latest || latest.deleted || latest.updated_at !== template.updated_at || !recurringDraft(latest, month, all)) throw Error('The template changed or this month is already confirmed. Reopen templates.');
      const record = { ...draft, id: stableId('recurring', `${currentScope().key}|${draft.recurringOccurrence}`), amount: fromMinor(minor), date: date.value, written: written.value.trim(), business: personal() ? false : !!draft.business, sheetId: ctx.currentSheet().id, created_at: new Date().toISOString(), ...(personal() ? { note: written.value.trim(), kind: minor < 0 ? 'refund' : 'purchase' } : {}) };
      await atomicBatchSave([{ table: 'expenses', record, expectedUpdatedAt: null }], { label: 'Confirm recurring expense' }); await changed(); closeThen(d, openTemplates);
    }, true), status));
}

export async function openBudgets() {
  const budgets = (await live('budgets')).filter(b => !personal() || b.kind !== 'trip'), lines = await live('expenses'); assertScopeCurrent();
  const host = el('div', { class: 'workflow-list' });
  const d = openDialog('Budgets', el('div', {}, el('p', { class: 'help' }, personal() ? 'Set a monthly limit for the purpose and category you choose. Currencies stay separate; refunds reduce spending.' : 'Each budget uses one currency. Refunds reduce spending; per diem income is excluded.'), el('button', { onclick: () => closeThen(d, () => openBudget(null)) }, 'New budget'), host));
  for (const budget of budgets) {
    let summary; try { summary = budgetSummary(budget, lines); } catch { continue; }
    host.append(el('button', { class: 'workflow-menu-item', onclick: () => closeThen(d, () => openBudget(budget)) }, el('b', {}, budget.name || (budget.kind === 'trip' ? 'Trip budget' : budget.month)),
      el('small', {}, `${fmtMoney(fromMinor(summary.spent), budget.currency)} of ${fmtMoney(fromMinor(summary.limit), budget.currency)} · ${summary.remaining < 0 ? 'over by' : 'remaining'} ${fmtMoney(Math.abs(fromMinor(summary.remaining)), budget.currency)}`),
      el('progress', { value: Math.min(100, summary.percent), max: 100, 'aria-label': 'Budget used' })));
  }
  if (!budgets.length) host.append(el('p', { class: 'empty' }, 'No budgets yet.'));
}

async function openBudget(budget) {
  const trips = personal() ? [] : await live('trips'); assertScopeCurrent();
  const name = input(budget?.name || ''), kind = select([['month', 'Month'], ['trip', 'Trip']], personal() ? 'month' : budget?.kind || 'month'), amount = input(budget?.amount || '', 'number', { step: '0.01', min: '0.01' }), cur = currencySelect(budget?.currency), month = input(budget?.month || today().slice(0, 7), 'month'), trip = select([['', 'Choose trip…'], ...trips.map(t => [t.id, t.name])], budget?.tripId || ''), audience = select([['all', 'All spending'], ['personal', 'Personal spending'], ['business', 'Business spending'], ...(personal() ? [['review', 'Needs review']] : [])], budget?.audience || (personal() ? 'personal' : 'all')), code = select([['', 'All categories'], ...ctx.settings().expenseCodes.map(c => [c.code, c.short])], budget?.code || ''), status = statusNode();
  const personalLines = personal() ? await live('expenses') : []; assertScopeCurrent();
  const selectedCategory = budget?.personalCategory || ctx.settings().expenseCodes.find(c => String(c.code) === String(budget?.code))?.short || '';
  const category = select([['', 'All categories'], ...[...new Set([...ctx.settings().expenseCodes.map(c => c.short), ...personalLines.map(l => l.personalCategory).filter(Boolean), selectedCategory].filter(Boolean))].map(c => [c, c])], selectedCategory);
  const d = openDialog(budget ? 'Edit budget' : 'New budget', el('div', { class: 'form' }, field('Name', name), el('div', { class: 'grid2' }, field('Limit', amount), field('Currency', cur)), personal() ? null : field('Budget period', kind), field('Month', month), personal() ? null : field('Trip', trip), field('Count', audience, personal() ? 'Needs review keeps unclassified bank spending separate.' : null), field('Category', personal() ? category : code),
    action('Save budget', status, async () => {
      const minor = minorAmount(amount.value), period = personal() ? 'month' : kind.value;
      if (minor <= 0) throw Error('Enter a positive budget limit.');
      if (period === 'month' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(month.value)) throw Error('Choose a month.');
      if (period === 'trip' && !trip.value) throw Error('Choose a trip.');
      const record = { ...budget, id: budget?.id || uuid(), name: name.value.trim(), kind: period, amount: fromMinor(minor), currency: cur.value, month: month.value, tripId: period === 'trip' ? trip.value : '', audience: audience.value, code: personal() ? (ctx.settings().expenseCodes.find(c => c.short === category.value)?.code || '') : code.value };
      if (personal()) record.personalCategory = category.value;
      await atomicBatchSave([{ table: 'budgets', record, expectedUpdatedAt: budget ? expected(budget) : null }], { label: 'Save budget' }); await changed(); closeThen(d, openBudgets);
    }, true),
    budget ? confirmButton('Delete budget', async () => { try { await atomicBatchSave([{ table: 'budgets', record: { ...budget, deleted: true }, expectedUpdatedAt: expected(budget) }], { label: 'Delete budget' }); await changed(); closeThen(d, openBudgets); } catch (error) { status.textContent = error.message; } }) : null, status));
}

export function openCsvImport(sourceName = 'CSV') {
  const file = input('', 'file', { accept: '.csv,text/csv,text/plain' }), text = el('textarea', { rows: 5, placeholder: 'Or paste CSV text here' }), delimiter = select([['', 'Detect separator'], [',', 'Comma'], [';', 'Semicolon'], ['\t', 'Tab']], ''), status = statusNode(), mappingHost = el('div'), previewHost = el('div');
  const source = input(sourceName, 'text'), options = {}, maps = {}; let parsed, preview = [], selected = new Set();
  file.addEventListener('change', async () => { try { if (file.files[0]?.size > 5_000_000) throw Error('Use a file smaller than 5 MB.'); if (file.files[0]) text.value = await file.files[0].text(); } catch (error) { status.textContent = error.message; } });
  const d = openDialog(personal() ? 'Import spending' : `${sourceName === 'Pocket' ? 'Pocket ' : ''}CSV import`, el('div', { class: 'form' }, el('p', { class: 'help' }, 'Only selected valid rows are imported. Check the amount units, currency, date and refund direction in the preview. Your original file is unchanged.'), field('Source name', source, 'Keep this name consistent to detect repeat imports.'), field('CSV file', file), text, field('Separator', delimiter),
    action('Read columns', status, () => { parsed = parseCsv(text.value, delimiter.value); previewHost.replaceChildren(); mappingHost.replaceChildren(); selected.clear();
      const aliases = { date: ['date', 'transaction_date', 'transactiondate', 'posted date'], amount: ['amount', 'amount_minor', 'amountminor', 'gross amount'], currency: ['currency', 'currency_code'], written: ['description', 'written', 'merchant', 'title', 'name'], vendor: ['vendor', 'explanation'], code: ['code', 'category_code'], kind: ['kind', 'type', 'transaction_type'], id: ['id', 'transaction_id', 'transactionid'] };
      if (personal()) Object.assign(aliases, { written: ['description', 'written', 'title', 'name'], vendor: ['vendor', 'explanation'], merchant: ['merchant', 'payee', 'vendor'], note: ['note', 'notes', 'memo'], category: ['category', 'personalcategory', 'personal_category'] });
      for (const [key, names] of Object.entries(aliases)) { const hit = parsed.headers.findIndex(h => names.includes(h.toLowerCase().trim())); maps[key] = select([['', key === 'date' || key === 'amount' ? 'Choose required column…' : 'Not supplied'], ...parsed.headers.map((h, i) => [String(i), h])], hit >= 0 ? String(hit) : ''); }
      options.date = select([['iso', 'YYYY-MM-DD'], ['dmy', 'DD/MM/YYYY'], ['mdy', 'MM/DD/YYYY']], 'iso'); options.decimal = select([['dot', 'Decimal dot (1,234.56)'], ['comma', 'Decimal comma (1.234,56)']], 'dot'); options.units = select([['decimal', 'Decimal amount (12.34)'], ['minor', 'Integer hundredths (1234 = 12.34)']], 'decimal'); options.cur = currencySelect(); options.category = select(ctx.settings().expenseCodes.map(c => [c.code, c.short]), defaultCode()); options.business = select(personal() ? [['personal', 'Personal']] : [['business', 'Business'], ['personal', 'Personal']], personal() || sourceName === 'Pocket' ? 'personal' : 'business');
      mappingHost.append(el('h4', {}, `${parsed.rows.length} rows · map columns`), el('div', { class: 'grid2' }, ...Object.entries(maps).map(([key, control]) => field(`${key}${key === 'date' || key === 'amount' ? ' (required)' : ''}`, control))), el('div', { class: 'grid2' }, field('Date format', options.date), field('Number format', options.decimal), field('Amount units', options.units), field('Currency if column is empty', options.cur)), field('Default category', options.category), field('Imported expenses are', options.business), action('Build preview', status, buildPreview, true));
    }), mappingHost, previewHost, status), { wide: true });
  const mapping = () => Object.fromEntries(Object.entries(maps).map(([k, control]) => [k, control.value]));
  const importOptions = () => ({ source: source.value.trim() || sourceName, dateFormat: options.date.value, decimal: options.decimal.value, amountUnits: options.units.value, currency: options.cur.value, code: Number(options.category.value), codes: ctx.settings().expenseCodes.map(c => Number(c.code)), business: options.business.value === 'business', currencies: ctx.settings().currencies, ...(personal() ? { personal: true, categories: ctx.settings().expenseCodes, category: ctx.settings().expenseCodes.find(c => Number(c.code) === Number(options.category.value))?.short || 'Other' } : {}) });
  async function buildPreview() {
    if (maps.date.value === '' || maps.amount.value === '') throw Error('Map the date and amount columns first.');
    const all = await db.all('expenses'); assertScopeCurrent();
    preview = mapCsvRows(parsed, mapping(), importOptions(), all); selected = new Set(preview.filter(p => p.row && !p.duplicate && !p.error).map(p => p.index));
    const count = el('p', { class: 'help', role: 'status' });
    const updateCount = () => { count.textContent = `${selected.size} selected · ${preview.filter(p => p.duplicate).length} duplicates skipped · ${preview.filter(p => p.error).length} invalid rows`; };
    const frozenMap = JSON.stringify(mapping()), frozenOptions = JSON.stringify(importOptions());
    const rows = preview.map(p => { const cb = input('', 'checkbox', { checked: selected.has(p.index), disabled: !p.row || p.duplicate || !!p.error, 'aria-label': `Import row ${p.index + 2}`, onchange: ev => { ev.target.checked ? selected.add(p.index) : selected.delete(p.index); updateCount(); } }); return el('tr', {}, el('td', {}, cb), el('td', {}, String(p.index + 2)), el('td', {}, p.row?.date || ''), el('td', { class: 'num' }, p.row ? fmtMoney(p.row.amount, p.row.currency) : ''), el('td', {}, personal() ? p.row?.merchant || '' : p.row?.written || ''), personal() ? el('td', {}, p.row?.personalCategory || '') : null, personal() ? el('td', {}, p.row?.note || '') : null, personal() ? el('td', {}, p.row ? (p.row.amount < 0 ? 'Refund' : 'Purchase') : '') : null, el('td', {}, p.error || (p.duplicate ? 'Duplicate — skipped' : p.row.business ? 'Business' : 'Personal'))); });
    previewHost.replaceChildren(el('h4', {}, 'Review transactions'), count,
      el('div', { class: 'actions' }, el('button', { onclick: () => { selected.clear(); for (const cb of previewHost.querySelectorAll('input[type=checkbox]')) cb.checked = false; updateCount(); } }, 'Select none'),
        el('button', { onclick: () => { selected = new Set(preview.filter(p => p.row && !p.duplicate && !p.error).map(p => p.index)); for (const cb of previewHost.querySelectorAll('input[type=checkbox]')) if (!cb.disabled) cb.checked = true; updateCount(); } }, 'Select valid rows')),
      el('div', { class: 'tbl workflow-csv-preview' }, el('table', {}, el('thead', {}, el('tr', {}, (personal() ? ['Import', 'Row', 'Date', 'Amount', 'Merchant', 'Category', 'Note', 'Kind', 'Status'] : ['Import', 'Row', 'Date', 'Amount', 'Description', 'Status']).map(h => el('th', {}, h)))), el('tbody', {}, rows))),
      action('Import selected rows', status, async () => {
        if (!selected.size) throw Error('Select at least one valid row.');
        if (JSON.stringify(mapping()) !== frozenMap || JSON.stringify(importOptions()) !== frozenOptions) throw Error('The mapping changed. Build a fresh preview before importing.');
        const latest = mapCsvRows(parsed, mapping(), importOptions(), await db.all('expenses')); assertScopeCurrent();
        const chosen = latest.filter(p => selected.has(p.index));
        if (chosen.some(p => p.error || p.duplicate || !p.row)) throw Error('A selected transaction has already been added or changed. Build a fresh preview.');
        const at = new Date().toISOString();
        await atomicBatchSave(chosen.map(p => ({ table: 'expenses', record: { ...p.row, id: stableId('import', `${currentScope().key}|${p.row.importKey}`), sheetId: ctx.currentSheet().id, created_at: at, importSource: importOptions().source }, expectedUpdatedAt: null })), { label: `Import ${chosen.length} CSV expenses` });
        await changed(); d.close(); toast(`${chosen.length} expenses imported.`);
      }, true)); updateCount();
  }
}

export async function openPocket() {
  const saved = await db.meta('pocketUrl'); assertScopeCurrent();
  const url = input(saved || '', 'url', { placeholder: 'https://your-pocket-website.example' }), status = statusNode(), link = el('div');
  const showLink = value => { link.replaceChildren(); if (value) link.append(el('a', { href: value, target: '_blank', rel: 'noopener noreferrer', class: 'workflow-external' }, 'Open Pocket ↗')); };
  try { showLink(validatePocketUrl(saved)); } catch { /* Keep an invalid old value editable. */ }
  const d = openDialog('Pocket connection', el('div', { class: 'form' }, el('p', { class: 'help' }, 'Pocket can keep changing independently. Save its website address here, or review a CSV export before importing selected transactions. Opening the link does not send expenses or sign you into Pocket.'), field('Pocket website', url),
    action('Save link', status, async () => { const value = validatePocketUrl(url.value); await db.setMeta('pocketUrl', value); showLink(value); status.textContent = value ? 'Pocket link saved for this space.' : 'Pocket link removed.'; }), link,
    el('button', { onclick: () => closeThen(d, () => openCsvImport('Pocket')) }, 'Review a Pocket CSV export'), status));
}

