import { el, openDialog } from './dom.js';
import { fmtMoney } from './expense-ifs.js';
import { expenseReviewQueue } from './review-queue.js';

// The caller supplies the scope guard and existing workflows. Opening or
// switching a review filter only reads records; it never changes their state.
export function openExpenseReviewDialog(context, initialKind = 'all') {
  const status = el('p', { class: 'help', role: 'status', 'aria-live': 'polite' });
  const title = el('p', { class: 'review-total', 'aria-live': 'polite' }, 'Loading review…');
  const stages = el('div', { class: 'review-stages', role: 'group', 'aria-label': 'Review stage' });
  const details = el('div', { class: 'review-detail' }), list = el('div', { class: 'review-list' });
  let kind = initialKind, request = 0, queue, busy = false;
  const d = openDialog('Review expenses', el('div', { class: 'expense-review' }, title, stages, details, status, list), { wide: true });
  const current = () => d.open && d.isConnected && context.isCurrent();
  const run = async (fn, close = true) => {
    if (!current() || busy) return;
    busy = true; status.textContent = '';
    try {
      if (close) d.close();
      await fn();
      if (!close && current()) await refresh();
    } catch (error) { if (current()) status.textContent = error.message; else context.onError?.(error); }
    finally { busy = false; }
  };
  const action = (label, fn, close = true, extra = {}) => el('button', { type: 'button', ...extra, onclick: () => run(fn, close) }, label);
  function paint() {
    if (!current()) return;
    const selected = queue.stages.find(stage => stage.kind === kind);
    title.textContent = `${queue.count} expense${queue.count === 1 ? '' : 's'} to review${queue.blockingCount ? ` · ${queue.blockingCount} blocked for IFS` : ''}. Each expense is counted once.`;
    stages.replaceChildren(...[{ kind: 'all', label: 'All', count: queue.count }, ...queue.stages].map(stage => el('button', {
      type: 'button', class: `chip${stage.kind === kind ? ' on' : ''}`, 'data-review-stage': stage.kind, 'aria-pressed': String(stage.kind === kind),
      onclick: () => { if (!current() || busy) return; kind = stage.kind; paint(); }
    }, `${stage.label} ${stage.count}`)));
    details.replaceChildren(el('p', { class: 'help' }, selected?.help || 'Fix IFS blockers first, then handle receipts, rates and payments. Stage counts can overlap. No records change until you use an explicit save action.'));
    if (kind === 'rates' && selected.count) details.append(action('Retry missing rates', () => context.retryRates(queue.records.filter(item => item.kinds.includes('rates')).map(item => item.row)), false));
    if (kind === 'reimbursements' && selected.count) details.append(action('Record received payment…', () => context.reimbursements(selected.ids), true, { class: 'primary' }));
    if (context.inbox) details.append(action('Receipt inbox…', context.inbox, true, { class: 'link' }));
    const visible = kind === 'all' ? queue.records : queue.records.filter(item => item.kinds.includes(kind));
    list.replaceChildren(...visible.map(item => {
      const row = item.row, buttons = [action('Edit expense', () => context.expense(row.id))];
      if (item.sheet && item.kinds.some(value => ['setup', 'rates', 'ready'].includes(value))) buttons.push(action(item.kinds.includes('ready') ? 'Open sheet for IFS' : 'Sheet setup / rates', () => context.sheet(item.sheet.id, item.kinds.includes('ready') ? 'ready' : 'setup')));
      if (item.kinds.includes('setup') && context.settings) buttons.push(action('IFS settings', context.settings));
      if (item.kinds.includes('reimbursements')) buttons.push(action('Record payment…', () => context.reimbursements([row.id])));
      return el('article', { class: 'review-expense', 'data-review-expense': row.id },
        el('div', { class: 'review-expense-title' }, el('b', {}, row.written || row.vendor || 'Expense'), el('strong', {}, fmtMoney(row.amount, row.currency))),
        el('small', { class: 'muted' }, `${row.date || 'No date'} · ${item.sheet?.title || 'No sheet'}${row.entered ? ' · In IFS' : ''}`),
        el('div', { class: 'review-badges' }, item.kinds.map(value => el('span', { class: `review-badge ${value === 'setup' && item.blocking ? 'blocking' : 'followup'}` }, queue.stages.find(stage => stage.kind === value).label))),
        item.reasons.length ? el('p', { class: 'help' }, item.reasons.join(' · ')) : null,
        item.payment?.eligible && item.payment.remaining ? el('p', { class: 'help' }, `Payment outstanding: ${fmtMoney(item.payment.remaining / 100, row.currency)}${item.payment.paid ? ` · received ${fmtMoney(item.payment.paid / 100, row.currency)}` : ''}`) : null,
        el('div', { class: 'review-actions' }, buttons));
    }));
    if (!visible.length) list.append(el('p', { class: 'empty' }, kind === 'all' ? 'No expenses need review.' : `No ${selected?.label.toLowerCase() || 'matching expenses'}.`));
  }
  async function refresh() {
    const id = ++request;
    try {
      const snapshot = await context.read();
      if (!current() || id !== request) return;
      queue = expenseReviewQueue(snapshot);
      if (kind !== 'all' && !queue.stages.some(stage => stage.kind === kind)) kind = 'all';
      paint();
    } catch (error) { if (current() && id === request) { title.textContent = 'Review could not load.'; status.textContent = error.message; } }
  }
  refresh();
  return d;
}
