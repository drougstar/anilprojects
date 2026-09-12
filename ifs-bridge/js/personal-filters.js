// One visible selection follows the person between Summary, Transactions and Study.
import { normalizePersonalEntries, filterPersonalEntries } from './personal-analytics.js';
import { spendingPurpose } from './expense-workflows.js';

const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');
export function personalCard(source) {
  const label = clean(source.card || source.cardName || source.accountName);
  return { key: clean(source.accountId) || label || '__unrecorded__', label: label || (source.accountId ? 'Unnamed card' : 'No card recorded') };
}
export const hasPersonalFilters = filters => Object.entries(filters || {}).some(([key, value]) => !!value && !(key === 'purpose' && value === 'all'));
export function filterPersonalViewEntries(entries, filters = {}) {
  if (filters.purpose && !['all', 'personal', 'business', 'review'].includes(filters.purpose)) throw Error('Choose a valid spending purpose.');
  return filterPersonalEntries(entries, filters).filter(entry =>
    (!filters.purpose || filters.purpose === 'all' || spendingPurpose(entry.source) === filters.purpose) &&
    (!filters.card || personalCard(entry.source).key === filters.card));
}
export function filterPersonalViewRows(rows, filters = {}, categories = []) {
  if (!hasPersonalFilters(filters)) return rows;
  const normalized = normalizePersonalEntries(rows, { categories });
  const valid = new Set(normalized.entries.map(entry => entry.source));
  const selected = new Set(filterPersonalViewEntries(normalized.entries, filters).map(entry => entry.source));
  // Keep excluded movements and invalid source rows. Their existing normalizers
  // still exclude them from spending and preserve warnings instead of hiding them.
  return rows.filter(row => !valid.has(row) || selected.has(row));
}
