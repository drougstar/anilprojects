// Presentation-only groups. The detailed statement registry and its financial
// records remain unchanged; membership, not the displayed date span, sets totals.
import { validDate } from './expense-workflows.js';

const text = value => String(value ?? '').trim();
const unique = values => [...new Set(values.map(text).filter(Boolean))].sort();
const date = value => validDate(value) ? value : '';
const rank = basis => ({ manual: 4, bank: 3, schedule: 2, estimated: 1 }[basis] || 0);
const endRank = period => rank(period.dateBasis) * 10 + (period.estimateMethod === 'matched-try' ? 2 : period.currency === 'TRY' ? 1 : 0);
const minDate = values => values.map(date).filter(Boolean).sort()[0] || '';
const maxDate = values => values.map(date).filter(Boolean).sort().at(-1) || '';
const priorMonth = month => { const [year, number] = month.split('-').map(Number); return new Date(Date.UTC(year, number - 2, 1)).toISOString().slice(0, 7); };
const knownCount = value => Number.isSafeInteger(value) && value >= 0;

export function bankPeriodGroupLabel(group, { locale = 'en-GB' } = {}) {
  const format = (value, options) => {
    const label = new Intl.DateTimeFormat(locale, { timeZone: 'UTC', ...options }).format(new Date(`${value}T00:00:00Z`));
    return options.month === 'short' && /^en(?:-|$)/i.test(locale) ? label.replace(/\bSept\b/g, 'Sep') : label;
  };
  if (!date(group.end)) {
    const through = date(group.observedEnd);
    return `${group.status === 'open' ? 'Ongoing' : 'Closed statements'}${through ? ` · transactions through ${format(through, { day: 'numeric', month: 'short', year: 'numeric' })}` : ' · dates not set'}`;
  }
  const month = format(group.end, { month: 'long', year: 'numeric' });
  const short = value => format(value, { day: 'numeric', month: 'short', ...(value.slice(0, 4) !== group.end.slice(0, 4) ? { year: 'numeric' } : {}) });
  const span = date(group.start) ? `${short(group.start)}–${short(group.end)}` : `closes ${short(group.end)}`;
  return `${month} · ${span}${group.status === 'open' ? ' · Ongoing' : ''}`;
}

/** Accepts current bankPeriodView results, before applying card/currency filters. */
export function groupBankPeriods(periodViews = []) {
  if (!Array.isArray(periodViews)) throw Error('Expected saved bank period views.');
  const periods = periodViews.filter(period => period && !period.deleted && text(period.id) && ['closed', 'open'].includes(period.status));
  const confirmed = new Map();
  for (const period of periods) if (date(period.end) && ['manual', 'bank'].includes(period.dateBasis)) {
    const key = `${period.status}:${period.end.slice(0, 7)}`, ends = confirmed.get(key) || new Set(); ends.add(period.end); confirmed.set(key, ends);
  }
  const buckets = new Map();
  for (const period of periods) {
    const end = date(period.end), observed = date(period.observedEnd), month = (end || observed).slice(0, 7);
    let key = end ? `${period.status}:${month}` : `${period.status}-observed:${month || 'unknown'}`;
    // Two explicitly confirmed closes are separate cycles even in one month.
    // An estimate must not silently choose which confirmed cycle it belongs to.
    if (end && confirmed.get(key)?.size > 1) key += `:${end}`;
    const bucket = buckets.get(key) || { key, month, status: period.status, periods: [] }; bucket.periods.push(period); buckets.set(key, bucket);
  }
  const groups = [...buckets.values()].map(bucket => {
    const details = bucket.periods, ends = details.filter(period => date(period.end)).sort((a, b) => endRank(b) - endRank(a) || b.end.localeCompare(a.end) || text(a.id).localeCompare(text(b.id)));
    const authority = ends[0], memberIds = unique(details.flatMap(period => [...(period.memberIds || []), ...(period.spendingMemberIds || [])]));
    const spendingMemberIds = unique(details.flatMap(period => period.spendingMemberIds || []));
    const sources = new Map();
    for (const period of details) {
      const source = period.sources?.find(item => item.id === period.authoritativeSourceId);
      const key = source?.id || period.id, old = sources.get(key);
      const expected = source?.expectedSpendingCount ?? period.expectedSpendingCount;
      sources.set(key, { ids: unique([...(old?.ids || []), ...(source?.spendingMemberIds || []), ...(period.spendingMemberIds || [])]),
        expected: knownCount(expected) ? Math.max(old?.expected || 0, expected) : old?.expected ?? null,
        errors: Math.max(old?.errors || 0, source?.errorCount || period.errorCount || 0) });
    }
    const expectedIds = unique([...sources.values()].flatMap(source => source.ids));
    const unresolvedCount = [...sources.values()].reduce((sum, source) => sum + Math.max(0, (source.expected || 0) - source.ids.length), 0);
    const unknownExpected = [...sources.values()].some(source => source.expected === null);
    const errorCount = [...sources.values()].reduce((sum, source) => sum + source.errors, 0);
    const available = new Set(spendingMemberIds), missingKnown = expectedIds.filter(id => !available.has(id)).length;
    const coverageComplete = !errorCount && !unresolvedCount && !missingKnown && !unknownExpected && details.every(period => period.coverageComplete !== false);
    return { id: `bank-period:${bucket.key}`, month: bucket.month, status: bucket.status, periodIds: unique(details.map(period => period.id)),
      start: '', end: authority?.end || '', dateBasis: authority?.dateBasis || 'unknown', startDateBasis: 'unknown',
      observedStart: minDate(details.map(period => period.observedStart)), observedEnd: maxDate(details.map(period => period.observedEnd)),
      memberIds, spendingMemberIds, cards: unique(details.map(period => period.card)), accountIds: unique(details.map(period => period.accountId)), currencies: unique(details.map(period => period.currency)),
      entryCount: memberIds.length, importedSpendingCount: spendingMemberIds.length,
      // Skipped source rows have no IDs to deduplicate. Keep that uncertainty
      // explicit instead of adding overlapping statement counts together.
      expectedSpendingCount: unresolvedCount || unknownExpected ? null : expectedIds.length,
      missingSpendingCount: missingKnown + unresolvedCount, missingCountIsExact: !unresolvedCount && !unknownExpected,
      errorCount, coverageComplete, complete: bucket.status === 'closed' && coverageComplete,
      dueDates: unique(details.map(period => date(period.dueDate))), _details: details };
  });
  for (const group of groups) {
    if (group.end) {
      const explicitStarts = group._details.filter(period => date(period.start) && period.start <= group.end && rank(period.startDateBasis) >= 2)
        .sort((a, b) => rank(b.startDateBasis) - rank(a.startDateBasis) || a.start.localeCompare(b.start));
      const previous = groups.filter(other => other !== group && other.status === 'closed' && date(other.end) && other.end < group.end && other.month === priorMonth(group.month) &&
        (!group.accountIds.length || other.accountIds.some(account => group.accountIds.includes(account)))).sort((a, b) => b.end.localeCompare(a.end));
      if (explicitStarts.length) { group.start = explicitStarts[0].start; group.startDateBasis = explicitStarts[0].startDateBasis; }
      else if (previous.length) { group.start = previous[0].end; group.startDateBasis = 'previous-close'; }
      else {
        group.start = minDate(group._details.flatMap(period => [period.observedStart, period.start]).filter(value => value <= group.end));
        group.startDateBasis = group.start ? 'estimated' : 'unknown';
      }
    }
    delete group._details; group.label = bankPeriodGroupLabel(group);
  }
  return groups.sort((a, b) => (b.end || b.observedEnd).localeCompare(a.end || a.observedEnd) || a.id.localeCompare(b.id));
}

/** Resolves saved per-card IDs so switching to grouped periods keeps selection. */
export function resolveBankPeriodSelection(id, groups = []) {
  const selected = text(id); if (!selected) return '';
  return groups.find(group => group.id === selected)?.id || groups.find(group => group.periodIds?.includes(selected))?.id || '';
}
