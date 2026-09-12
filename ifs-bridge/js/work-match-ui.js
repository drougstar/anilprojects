import { db, atomicBatchSave } from './db.js';
import { assertScopeCurrent, scopeIsCurrent, currentScope } from './scope.js';
import { el, field, openDialog, toast } from './dom.js';
import { spendingPurpose } from './expense-workflows.js';
import { readOnlyWorkContext } from './work-context.js';
import { planWorkMatches, prepareWorkMatchChanges, groupBankReview, prepareBankPurposeChanges, planTripSuggestions, prepareTripPurposeChanges } from './work-match.js';

const purposeLabels = { business: 'Work', personal: 'Personal', review: 'Needs review' };
const money = row => `${new Intl.NumberFormat('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(row.amount) || 0)} ${row.currency || ''}`;
const merchant = row => row.merchant || row.vendor || row.bankDescription || 'No merchant recorded';
const select = (options, value, label) => el('select', { 'aria-label': label }, options.map(([id, text]) => el('option', { value: id, selected: id === value }, text)));

export async function openWorkExpenseReview({ month = '', onChange = () => {}, sync = () => {}, readWork = readOnlyWorkContext } = {}) {
  assertScopeCurrent();
  if (currentScope().workspace !== 'personal') throw Error('Review card spending from your Personal workspace.');
  let bankRows = await db.all('expenses'); assertScopeCurrent();
  let context = { expenses: [], sheets: [], trips: [] }, preview = [], selected = new Set(), choices = new Map(), mode = 'matches', valid = false, busy = false, closed = false, page = 1;
  const status = el('p', { class: 'help', role: 'status', 'aria-live': 'polite' });
  const controls = el('div', { class: 'work-review-controls' }), list = el('div', { class: 'work-review-list' }), summary = el('p', { class: 'help' }), contextNotice = el('p', { class: 'help work-context-notice' });
  const monthInput = el('input', { type: 'month', value: month, min: '1000-01', max: '9999-12', 'aria-label': 'Card review month' });
  const groupBy = select([['merchant', 'Merchant'], ['card', 'Card']], 'merchant', 'Group bank transactions by');
  const purposeFilter = select([['review', 'Needs review'], ['all', 'All purposes'], ['personal', 'Personal'], ['business', 'Work']], 'review', 'Bank review purpose filter');
  const bulkPurpose = select([['business', 'Work'], ['personal', 'Personal'], ['review', 'Needs review']], 'business', 'Apply spending purpose');
  const cardFilter = select([['', 'All cards'], ...[...new Map(bankRows.filter(row => row.bankTransaction && !row.deleted).map(row => [row.accountId || row.card || '', row.card || 'No card recorded'])).entries()].filter(([id]) => id)], '', 'Trip suggestion card');
  const merchantFilter = el('input', { type: 'search', maxlength: 100, placeholder: 'Optional merchant text', 'aria-label': 'Trip suggestion merchant' });
  const apply = el('button', { type: 'button', class: 'primary', disabled: true }, 'Apply selected');
  const reload = el('button', { type: 'button' }, 'Reload review');
  const navigation = el('div', { class: 'work-review-tabs', role: 'group', 'aria-label': 'Card review tool' });
  const body = el('div', { class: 'work-review' },
    el('p', { class: 'help' }, 'Select transactions, then Apply to confirm. Work charges stay in bank history and leave your Personal summary. Work records and reimbursement status stay unchanged.'),
    el('div', { class: 'work-review-controls' }, field('Month', monthInput), reload), navigation, controls, summary, contextNotice, list,
    el('div', { class: 'bank-import-save' }, apply, status));
  const dialog = openDialog('Review card spending', body, { wide: true, onClose: () => { closed = true; bankRows = []; context = { expenses: [], sheets: [], trips: [] }; preview = []; selected.clear(); choices.clear(); } });
  const active = () => !closed && dialog.open && dialog.isConnected && scopeIsCurrent();
  const reviewMonth = () => { if (!monthInput.value) throw Error('Choose a month before reviewing card spending.'); return monthInput.value; };
  const safe = run => async () => {
    if (busy || !active()) return;
    try { assertScopeCurrent(); await run(); }
    catch (error) { if (active()) { valid = false; status.textContent = error.message || 'The review could not be loaded.'; status.classList.add('error'); updateApply(); } }
  };
  const setBusy = value => { busy = value; body.inert = value; updateApply(); };
  function resetSelection() { selected.clear(); choices.clear(); page = 1; valid = false; updateApply(); }
  function updateApply() {
    const complete = mode === 'groups' || [...selected].every(id => choices.get(id));
    apply.disabled = busy || !valid || !selected.size || !complete;
    apply.textContent = selected.size ? `Apply ${selected.size} selected as ${mode === 'groups' ? purposeLabels[bulkPurpose.value] : 'Work'}` : 'Apply selected';
  }
  function bankLine(item) {
    const bank = item.bank, checkbox = el('input', { type: 'checkbox', checked: selected.has(bank.id), 'aria-label': `Select ${bank.date} ${merchant(bank)} ${money(bank)}` });
    checkbox.addEventListener('change', () => { if (busy || !valid) return; checkbox.checked ? selected.add(bank.id) : selected.delete(bank.id); updateApply(); });
    return el('div', { class: 'bank-preview-main' }, checkbox, el('span', {}, el('strong', {}, merchant(bank)), el('small', {}, `${bank.date} · ${bank.card || 'No card recorded'} · ${purposeLabels[spendingPurpose(bank)]}`)), el('b', { class: 'amt' }, money(bank)));
  }
  function pageRows(items, render) {
    const pages = Math.max(1, Math.ceil(items.length / 25)); page = Math.min(page, pages);
    const rows = items.slice((page - 1) * 25, page * 25).map(render);
    list.replaceChildren(...rows, items.length ? el('div', { class: 'personal-pagination' },
      el('button', { type: 'button', disabled: page <= 1, onclick: () => { if (busy) return; page--; paint(); } }, 'Previous'),
      el('span', {}, `Page ${page} of ${pages}`), el('button', { type: 'button', disabled: page >= pages, onclick: () => { if (busy) return; page++; paint(); } }, 'Next')) : el('p', { class: 'empty' }, mode === 'matches' ? 'No matching Work expenses in this month. Use Group review for charges that still need a purpose.' : 'No transactions in this review.'));
  }
  function paint() {
    if (!active()) return;
    contextNotice.textContent = mode === 'groups' ? '' : context.notice || ''; contextNotice.hidden = !contextNotice.textContent;
    for (const button of navigation.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    if (mode === 'groups') {
      const groups = groupBankReview(bankRows, { month: reviewMonth(), groupBy: groupBy.value, purpose: purposeFilter.value });
      preview = groups.flatMap(group => group.rows);
      summary.textContent = `${preview.length} transactions · ${groups.length} groups. Select a group or individual rows, then apply one purpose. Personal or Needs review removes an existing Work link.`;
      pageRows(groups, group => {
        const all = group.rows.every(row => selected.has(row.bankId));
        const groupCheck = el('input', { type: 'checkbox', checked: all, 'aria-label': `Select group ${group.label} ${group.currency}` });
        groupCheck.indeterminate = !all && group.rows.some(row => selected.has(row.bankId));
        groupCheck.addEventListener('change', () => { if (busy || !valid) return; for (const row of group.rows) groupCheck.checked ? selected.add(row.bankId) : selected.delete(row.bankId); paint(); updateApply(); });
        return el('section', { class: 'work-review-group' }, el('label', { class: 'work-review-group-head' }, groupCheck, el('strong', {}, `${group.label} · ${group.currency}`), el('span', {}, `${group.rows.length} transactions · ${money({ amount: group.amountMinor / 100, currency: group.currency })}`)), ...group.rows.map(item => el('div', { class: 'bank-preview-row' }, bankLine(item), item.bank.workExpenseLink?.expenseId ? el('small', { class: 'help' }, 'Currently linked to a Work expense. Changing to Personal or Needs review removes that link.') : null)));
      });
    } else {
      const shown = mode === 'matches' ? preview.filter(item => item.candidates.length) : preview;
      summary.textContent = mode === 'matches' ? `${shown.length} transactions with possible matches · ${preview.length - shown.length} without a match. Same currency and amount, within 3 days. Every suggestion starts unchecked.` : `${shown.length} transactions within Work trip dates. Low confidence: dates alone cannot distinguish personal shopping from work. Every suggestion starts unchecked.`;
      pageRows(shown, item => {
        const options = [['', mode === 'matches' ? 'Choose Work expense…' : 'Choose Work trip…'], ...item.candidates.map(candidate => mode === 'matches' ? [candidate.expenseId, `${candidate.expense.date} · ${merchant(candidate.expense)} · ${money(candidate.expense)}${candidate.sheetName ? ' · ' + candidate.sheetName : ''} · ${candidate.expenseId.slice(0, 8)}`] : [candidate.tripId, `${candidate.trip.name || 'Work trip'} · ${candidate.trip.start} to ${candidate.trip.end}`])];
        // A single uncontested suggestion can be displayed as the proposed
        // choice, but its separate confirmation checkbox remains unchecked.
        if (!choices.has(item.bankId) && item.candidates.length === 1 && !item.ambiguous) choices.set(item.bankId, mode === 'matches' ? item.candidates[0].expenseId : item.candidates[0].tripId);
        const chosen = select(options, choices.get(item.bankId) || '', `Proposed ${mode === 'matches' ? 'Work expense' : 'trip'} for ${item.bank.date} ${merchant(item.bank)} ${money(item.bank)}`);
        chosen.addEventListener('change', () => { if (busy) return; choices.set(item.bankId, chosen.value); paint(); updateApply(); });
        const candidate = item.candidates.find(entry => (mode === 'matches' ? entry.expenseId : entry.tripId) === choices.get(item.bankId));
        return el('div', { class: 'bank-preview-row' }, bankLine(item),
          mode === 'matches' && item.ambiguous ? el('small', { class: 'bank-review-needed' }, 'Ambiguous: multiple expenses or competing bank charges. Choose explicitly; each Work expense may be linked once.') : null,
          field(mode === 'matches' ? 'Proposed Work expense' : 'Possible Work trip', chosen),
          candidate && mode === 'matches' ? el('small', { class: 'work-review-candidate' }, `Work: ${merchant(candidate.expense)} · ${candidate.expense.date} · ${money(candidate.expense)}${candidate.expense.written ? ' · ' + candidate.expense.written : ''}`) : null,
          candidate ? el('small', { class: 'help' }, mode === 'matches' ? `${candidate.reason} Bank date is ${candidate.dateGap} day${candidate.dateGap === 1 ? '' : 's'} apart.${candidate.contested ? ' Another bank charge also matches this expense.' : ''}` : candidate.reason) : null);
      });
    }
    updateApply();
  }
  async function build({ fetchWork = mode !== 'groups' } = {}) {
    resetSelection(); setBusy(true); status.classList.remove('error'); status.textContent = 'Loading review…';
    try {
      reviewMonth();
      const results = await Promise.all([db.all('expenses'), fetchWork ? readWork() : Promise.resolve(context)]);
      if (!active()) return;
      [bankRows, context] = results;
      if (mode === 'matches') preview = planWorkMatches(bankRows, context, { month: monthInput.value, dateWindow: 3 });
      else if (mode === 'trips') preview = planTripSuggestions(bankRows, context, { month: monthInput.value, card: cardFilter.value, merchant: merchantFilter.value });
      valid = true; status.textContent = 'Nothing changed. Select transactions, then apply your decision.'; paint();
    } finally { if (active()) setBusy(false); }
  }
  async function chooseMode(next) {
    mode = next; resetSelection(); controls.replaceChildren(); list.replaceChildren(); summary.textContent = ''; contextNotice.textContent = ''; contextNotice.hidden = true;
    for (const button of navigation.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset.mode === mode));
    if (mode === 'groups') controls.append(field('Group by', groupBy), field('Show', purposeFilter), field('Apply selected as', bulkPurpose));
    if (mode === 'trips') {
      controls.append(field('Card', cardFilter), field('Merchant contains', merchantFilter), el('button', { type: 'button', onclick: safe(() => build()) }, 'Find trip suggestions'));
      status.textContent = 'Optional tool. Set filters and find suggestions; nothing is classified automatically.';
      return;
    }
    await build();
  }
  for (const [value, text] of [['matches', 'Work matches'], ['groups', 'Group review'], ['trips', 'Trip suggestions']]) navigation.append(el('button', { type: 'button', 'data-mode': value, 'aria-pressed': String(mode === value), onclick: safe(() => chooseMode(value)) }, text));
  reload.addEventListener('click', safe(() => build()));
  monthInput.addEventListener('change', safe(() => chooseMode(mode)));
  for (const input of [groupBy, purposeFilter]) input.addEventListener('change', safe(async () => { resetSelection(); valid = true; paint(); status.textContent = 'Nothing changed. Select the transactions to classify.'; }));
  bulkPurpose.addEventListener('change', updateApply);
  for (const input of [cardFilter, merchantFilter]) input.addEventListener('input', () => { if (busy) return; resetSelection(); list.replaceChildren(); summary.textContent = ''; status.textContent = 'Filters changed. Find trip suggestions again.'; });
  apply.addEventListener('click', safe(async () => {
    if (!valid || apply.disabled) return;
    setBusy(true); status.classList.remove('error');
    try {
      const [latestBank, latestWork] = await Promise.all([db.all('expenses'), mode === 'groups' ? Promise.resolve(context) : readWork()]);
      if (!active()) return;
      const chosen = [...selected].map(bankId => ({ bankId, ...(mode === 'matches' ? { expenseId: choices.get(bankId) } : mode === 'trips' ? { tripId: choices.get(bankId) } : {}) }));
      const at = new Date().toISOString(), options = { at, month: reviewMonth() };
      const items = mode === 'matches' ? prepareWorkMatchChanges(latestBank, latestWork, chosen, preview, { ...options, dateWindow: 3 }) : mode === 'groups' ? prepareBankPurposeChanges(latestBank, chosen, preview, { at, purpose: bulkPurpose.value }) : prepareTripPurposeChanges(latestBank, latestWork, chosen, preview, { ...options, card: cardFilter.value, merchant: merchantFilter.value });
      assertScopeCurrent(); if (!active()) return;
      await atomicBatchSave(items, { label: mode === 'matches' ? `Confirm ${items.length} Work expense links` : `Classify ${items.length} bank transactions as ${mode === 'groups' ? purposeLabels[bulkPurpose.value] : 'Work from trip review'}`, uniqueWorkExpenseLinks: true });
      if (!active()) return;
      dialog.close(); await onChange(); if (!scopeIsCurrent()) return; sync(); toast(`${items.length} transactions updated. History can undo this review in one step.`);
    } finally { if (active()) setBusy(false); }
  }));
  await safe(() => chooseMode('matches'))();
  return dialog;
}
