// Presentation-only groups. The detailed statement registry and its financial
// records remain unchanged; membership, not the displayed date span, sets totals.
import { validDate, isSpendingRecord } from './expense-workflows.js';

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
    if (/^\d{4}-\d{2}$/.test(group.month || '') && date(group.cycleStart)) {
      return `${format(`${group.month}-01`, { month: 'long', year: 'numeric' })} · after ${format(group.cycleStart, { day: 'numeric', month: 'short', ...(group.cycleStart.slice(0, 4) !== group.month.slice(0, 4) ? { year: 'numeric' } : {}) })} · Ongoing`;
    }
    const through = date(group.observedEnd);
    return `${group.status === 'open' ? 'Ongoing' : 'Closed statements'}${through ? ` · transactions through ${format(through, { day: 'numeric', month: 'short', year: 'numeric' })}` : ' · dates not set'}`;
  }
  const month = format(group.end, { month: 'long', year: 'numeric' });
  const short = value => format(value, { day: 'numeric', month: 'short', ...(value.slice(0, 4) !== group.end.slice(0, 4) ? { year: 'numeric' } : {}) });
  const span = date(group.start) ? `${short(group.start)}–${short(group.end)}` : `closes ${short(group.end)}`;
  return `${month} · ${span}${group.status === 'open' ? ' · Ongoing' : ''}`;
}

/** Accepts current bankPeriodView results, before applying card/currency filters. */
function savedBankPeriodGroups(periodViews = []) {
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

const bankRow = row => !!(row.bankTransaction || row.sourceType || row.bankImport || row.transactionKey || row.bankFingerprint);
const nextMonth = month => { const [year, number] = month.split('-').map(Number); return new Date(Date.UTC(year, number, 1)).toISOString().slice(0, 7); };
function projectedClose(month, day) {
  const [year, number] = month.split('-').map(Number);
  return `${month}-${String(Math.min(day, new Date(Date.UTC(year, number, 0)).getUTCDate())).padStart(2, '0')}`;
}
function nextCycle(anchor, activityDate) {
  if (!date(activityDate) || activityDate <= anchor.end) return null;
  // This names the next monthly cycle, not a promised closing weekday. The
  // next bank statement replaces the estimate; no financial record is moved.
  const day = Number(anchor.end.slice(8)), observedMonth = activityDate.slice(0, 7);
  const month = activityDate > projectedClose(observedMonth, day) ? nextMonth(observedMonth) : observedMonth;
  if (!/^\d{4}-\d{2}$/.test(month) || month <= anchor.month) return null;
  const cycleStart = month === nextMonth(anchor.month) ? anchor.end : projectedClose(priorMonth(month), day);
  return { month, cycleStart, sortDate: projectedClose(month, day) };
}
const matchesAccount = (group, account, card) => account && account !== 'unknown'
  ? group.accountIds.includes(account)
  : !!card && card !== 'Unspecified card' && group.cards.includes(card);

/** Add the ongoing cycle from already-saved bank rows. Derived views never write
 * back to statements or transactions. Imported closed membership always wins. */
export function groupBankPeriods(periodViews = [], { expenses, today = '' } = {}) {
  const groups = savedBankPeriodGroups(periodViews);
  if (!Array.isArray(expenses)) return groups;
  const rows = new Map(expenses.filter(row => row && !row.deleted && row.sourceWorkspace !== 'work' && row.workspace_id !== 'work' && text(row.id)).map(row => [text(row.id), row]));
  const closed = groups.filter(group => group.status === 'closed' && date(group.end));
  const closedIds = new Set(groups.filter(group => group.status === 'closed').flatMap(group => group.memberIds));
  const claimed = new Set(closedIds), derived = new Map(), kept = groups.filter(group => group.status === 'closed');
  const latest = (account, card) => closed.filter(group => matchesAccount(group, account, card))
    .sort((a, b) => b.end.localeCompare(a.end))[0];
  const knownOpenFor = (account, card, activityDate) => kept.filter(group => group.status === 'open' && date(group.end) &&
    matchesAccount(group, account, card) && date(activityDate) && activityDate <= group.end &&
    activityDate >= (group.start || latest(account, card)?.end || ''))
    .sort((a, b) => a.end.localeCompare(b.end))[0];
  const latestBoundary = (account, card, activityDate) => {
    const lastClosed = latest(account, card);
    if (!lastClosed || activityDate <= lastClosed.end) return null;
    return [lastClosed, ...kept.filter(group => group.status === 'open' && date(group.end))]
      .filter(group => group.end < activityDate && matchesAccount(group, account, card)).sort((a, b) => b.end.localeCompare(a.end))[0];
  };
  function joinKnown(group, members, original = null) {
    for (const member of members) {
      if (closedIds.has(member.id)) continue;
      group.memberIds.push(member.id); claimed.add(member.id);
      if (isSpendingRecord(member)) group.spendingMemberIds.push(member.id);
    }
    group.memberIds = unique(group.memberIds); group.spendingMemberIds = unique(group.spendingMemberIds);
    group.entryCount = group.memberIds.length; group.importedSpendingCount = group.spendingMemberIds.length;
    group.membershipBasis = 'estimated-cycle'; group.expectedSpendingCount = null;
    if (original) {
      group.periodIds = unique([...group.periodIds, ...original.periodIds]);
      group.selectionAliases = unique([...(group.selectionAliases || []), original.id]);
      group.coverageComplete &&= original.coverageComplete;
      group.errorCount += original.errorCount || 0; group.missingSpendingCount += original.missingSpendingCount || 0;
    }
  }
  function add(anchor, activityDate, members = [], original = null) {
    const cycle = nextCycle(anchor, activityDate); if (!cycle) return false;
    const id = `bank-period:open:${cycle.month}:after:${cycle.cycleStart}`;
    let group = derived.get(id);
    if (!group) {
      group = { id, ...cycle, status: 'open', start: cycle.cycleStart, end: '', dateBasis: 'estimated',
        startDateBasis: 'previous-close', membershipBasis: 'estimated-cycle', periodIds: [], selectionAliases: [],
        memberIds: [], spendingMemberIds: [], accountIds: [], cards: [], currencies: [], observedStart: '', observedEnd: '',
        expectedSpendingCount: null, errorCount: 0, missingSpendingCount: 0, missingCountIsExact: false,
        coverageComplete: true, complete: false, dueDates: [] };
      derived.set(id, group);
    }
    if (original) {
      group.periodIds.push(...original.periodIds); group.selectionAliases.push(original.id);
      group.errorCount += original.errorCount || 0;
      group.missingSpendingCount += original.missingSpendingCount || 0;
      group.coverageComplete &&= original.coverageComplete;
    }
    for (const member of members) {
      if (closedIds.has(member.id)) continue;
      group.memberIds.push(member.id); claimed.add(member.id);
      if (isSpendingRecord(member)) group.spendingMemberIds.push(member.id);
      group.accountIds.push(text(member.accountId)); group.cards.push(text(member.card)); group.currencies.push(text(member.currency));
    }
    if (!members.length) { group.accountIds.push(...anchor.accountIds); group.cards.push(...anchor.cards); group.currencies.push(...anchor.currencies); }
    return true;
  }
  // A bank snapshot may contain installments with much older purchase dates.
  // Carry that snapshot together, excluding IDs the closed statement now owns.
  const ongoing = groups.filter(group => group.status === 'open').sort((a, b) => Number(!!b.end) - Number(!!a.end));
  for (const original of ongoing) {
    const members = original.memberIds.map(id => rows.get(id)).filter(row => row && !closedIds.has(row.id));
    const activityDate = original.observedEnd || maxDate(members.map(row => row.date));
    const destinations = members.map(row => knownOpenFor(text(row.accountId), text(row.card), activityDate));
    const knownOpen = !original.end && destinations.length && destinations.every(group => group && group.id === destinations[0]?.id) ? destinations[0] : null;
    if (knownOpen) { joinKnown(knownOpen, members, original); continue; }
    const anchors = members.map(row => latestBoundary(text(row.accountId), text(row.card), activityDate));
    const anchor = anchors.length && anchors.every(group => group && group.id === anchors[0]?.id) ? anchors[0] : null;
    if (!original.end && anchor && add(anchor, original.observedEnd || maxDate(members.map(row => row.date)), members, original)) continue;
    if (!members.length && original.memberIds.length && original.coverageComplete) continue;
    const group = { ...original, memberIds: members.map(row => row.id), spendingMemberIds: original.spendingMemberIds.filter(id => members.some(row => row.id === id)) };
    group.entryCount = group.memberIds.length; group.importedSpendingCount = group.spendingMemberIds.length;
    group.memberIds.forEach(id => claimed.add(id)); kept.push(group);
  }
  for (const row of rows.values()) {
    if (claimed.has(row.id) || !bankRow(row) || !date(row.date)) continue;
    const anchor = latestBoundary(text(row.accountId), text(row.card), row.date);
    const knownOpen = knownOpenFor(text(row.accountId), text(row.card), row.date);
    if (knownOpen) {
      joinKnown(knownOpen, [row]);
    } else if (anchor) add(anchor, row.date, [row]);
  }
  // The next choice exists as soon as the previous cycle ends, even before a
  // new download. Do not seed an obsolete card whose newer close is known.
  if (date(today)) for (const account of unique(closed.flatMap(group => group.accountIds))) {
    if (knownOpenFor(account, '', today)) continue;
    const anchor = latestBoundary(account, '', today);
    if (anchor) add({ ...anchor, accountIds: [account] }, today);
  }
  for (const group of derived.values()) {
    for (const key of ['memberIds', 'spendingMemberIds', 'periodIds', 'selectionAliases', 'accountIds', 'cards', 'currencies']) group[key] = unique(group[key]);
    group.entryCount = group.memberIds.length; group.importedSpendingCount = group.spendingMemberIds.length;
    group.observedStart = minDate(group.memberIds.map(id => rows.get(id)?.date));
    group.observedEnd = maxDate(group.memberIds.map(id => rows.get(id)?.date));
    group.label = bankPeriodGroupLabel(group); kept.push(group);
  }
  return kept.sort((a, b) => (b.sortDate || b.end || b.observedEnd).localeCompare(a.sortDate || a.end || a.observedEnd) || a.id.localeCompare(b.id));
}

/** Resolves saved per-card IDs so switching to grouped periods keeps selection. */
export function resolveBankPeriodSelection(id, groups = []) {
  const selected = text(id); if (!selected) return '';
  const direct = groups.find(group => group.id === selected) || groups.find(group => group.periodIds?.includes(selected) || group.selectionAliases?.includes(selected));
  if (direct) return direct.id;
  // When its real statement arrives, keep the selected month instead of
  // dropping the user's filters or returning an unavailable ongoing choice.
  const inferred = /^bank-period:open:(\d{4}-\d{2})(?::(?:after:)?\d{4}-\d{2}-\d{2})?$/.exec(selected);
  const closed = inferred ? groups.filter(group => group.status === 'closed' && group.month === inferred[1]) : [];
  return closed.length === 1 ? closed[0].id : '';
}
