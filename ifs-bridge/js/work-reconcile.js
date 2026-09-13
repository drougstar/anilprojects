import { db, atomicBatchSave } from './db.js';
import { assertScopeCurrent, scopeIsCurrent, currentScope } from './scope.js';
import { readOnlyWorkContext } from './work-context.js';
import { planAutomaticWorkMatches, prepareAutomaticWorkMatchChanges } from './work-match.js';

const now = () => new Date().toISOString();
const guardScope = () => { assertScopeCurrent(); if (currentScope().workspace !== 'personal') throw Error('Open Personal to match card purchases with Work.'); };
const deferred = message => ({ state: 'deferred', matched: 0, unresolved: 0, message });
async function refreshedWork(readWork, guard) {
  let context;
  try { context = await readWork(); }
  catch { guard(); return { result: deferred('Work expenses could not be refreshed. Connect and use Match with Work again; your purchases are unchanged.') }; }
  guard();
  if (context?.canAutoMatch !== true || context.source !== 'cloud') return { result: deferred(context?.source === 'cloud'
    ? 'Resolve the sync conflicts in Work, then match again. Purchases have not been guessed.'
    : 'Connect to refresh your Work expenses before automatic matching. Offline suggestions are still available in Review exceptions.') };
  return { context };
}
function completed(plan, matched) {
  const unresolved = plan.counts.unresolved;
  let message = matched ? `${matched} purchase${matched === 1 ? '' : 's'} matched with Work. Use Exclude company costs to leave company costs out of the analysis.`
    : unresolved ? 'No clear Work matches were found.' : 'No unreviewed purchases need Work matching in this month.';
  if (unresolved) message += ` ${unresolved} unmatched purchase${unresolved === 1 ? '' : 's'} left unchanged.`;
  if (!plan.counts.workExpenses && unresolved) message += ' No business purchases are currently available in your Work area.';
  if (matched) message += ' History can undo this match batch.';
  return { state: matched ? 'matched' : 'complete', matched, unresolved, message };
}

// A single deliberate command handles all clear matches. Rendering, filtering,
// syncing and History Undo never call this, so an Undo is not immediately redone.
export function createWorkReconciler({ onStatus = () => {}, readBank = () => db.all('expenses'), readWork = readOnlyWorkContext,
  commit = atomicBatchSave, isCurrent = scopeIsCurrent, assertCurrent = guardScope, timestamp = now } = {}) {
  let running = null, disposed = false;
  const guard = () => { if (disposed || !isCurrent()) throw Error('The account changed. Open Personal again before matching.'); assertCurrent(); };
  const notify = result => { if (!disposed && isCurrent()) { try { onStatus(result); } catch { /* Status painting must not alter a completed database action. */ } } return result; };
  async function execute({ month } = {}) {
    guard(); notify({ state: 'checking', message: 'Checking purchases against your Work expenses…' });
    try {
      const work = await refreshedWork(readWork, guard);
      if (work.result) return notify(work.result);
      const rows = await readBank(); guard();
      const options = { month, dateWindow: 3 }, plan = planAutomaticWorkMatches(rows, work.context, options);
      const changes = prepareAutomaticWorkMatchChanges(rows, work.context, plan, { ...options, at: timestamp() });
      if (changes.length) {
        guard();
        await commit(changes, { label: `Match ${changes.length} bank purchases with Work`, uniqueWorkExpenseLinks: true, expectedExpenses: rows });
        guard();
      }
      return notify(completed(plan, changes.length));
    } catch (error) {
      guard(); notify({ state: 'error', matched: 0, message: 'Matching could not finish. Reload your purchases and try again.' }); throw error;
    }
  }
  return {
    run(options) {
      if (running) return running;
      const pending = execute(options);
      running = pending.finally(() => { running = null; });
      return running;
    },
    dispose() { disposed = true; },
  };
}

// Enrich only NEW rows in this import before its existing single atomic commit.
// Existing rows still participate in duplicate detection, but are not changed.
export async function matchImportedWorkPurchases({ items, existingRows, isCurrent = scopeIsCurrent,
  readWork = readOnlyWorkContext, assertCurrent = guardScope, timestamp = now }) {
  const guard = () => { if (!isCurrent()) throw Error('The import was closed or the account changed.'); assertCurrent(); };
  guard();
  if (!Array.isArray(items) || !Array.isArray(existingRows)) throw Error('The bank import comparison is incomplete.');
  const newIds = new Set(items.filter(item => item.table === 'expenses' && item.expectedUpdatedAt === null && !item.record.deleted && item.record.bankTransaction).map(item => item.record.id));
  if (!newIds.size) return { items, matched: 0, message: '' };
  const work = await refreshedWork(readWork, guard);
  if (work.result) return { items, matched: 0, message: 'Imported transactions are saved without Work matching. ' + work.result.message };
  const combined = new Map(existingRows.map(row => [row.id, row]));
  for (const item of items) if (item.table === 'expenses') combined.set(item.record.id, item.record);
  const rows = [...combined.values()], plan = planAutomaticWorkMatches(rows, work.context, { dateWindow: 3 });
  const selected = { ...plan, matches: plan.matches.filter(item => newIds.has(item.bankId)) };
  const changes = prepareAutomaticWorkMatchChanges(rows, work.context, selected, { at: timestamp() });
  const changed = new Map(changes.map(item => [item.record.id, item.record]));
  guard();
  return { items: items.map(item => changed.has(item.record.id) && item.table === 'expenses' ? { ...item, record: changed.get(item.record.id) } : item),
    ...(changes.length ? { expectedExpenses: existingRows } : {}),
    matched: changes.length, message: changes.length ? `${changes.length} imported purchase${changes.length === 1 ? '' : 's'} matched with Work. Use Exclude company costs to leave company costs out of the analysis.` : 'No clear Work matches in these new transactions; existing purpose choices were kept.' };
}
