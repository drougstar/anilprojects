import { effectiveTimeCodeMappings, calculationMode } from './time-codes.js';

const clone = value => structuredClone(value);
const labels = {
  clockify: 'Clockify connection', identity: 'IFS identity', timeZone: 'Time zone',
  timeCalculationMode: 'How time codes are chosen', regularHours: 'Regular hours', travelAfterHours: 'Travel threshold',
  topUpMinimum: 'Minimum day', roundStep: 'Rounding step', roundMode: 'Rounding direction', holidays: 'Holiday dates',
  travelKeyword: 'Travel description', codes: 'Automatic report codes', codeDescriptions: 'IFS code descriptions',
  timeCodeMappings: 'Clockify tag meanings', timeCodeCatalog: 'IFS code catalogue', mapping: 'Project destinations',
  template: 'Timesheet template', expenseTemplate: 'Expense template', expenseCodes: 'Categories',
  perDiemCode: 'Per diem category', perDiemDefaults: 'Per diem rates', defaultCurrency: 'Default currency', currencies: 'Currencies',
  costObjects: 'Cost objects', knownShortNames: 'Expense destinations', expenseActivitySuffix: 'Expense activity suffix',
  homeCurrency: 'Home currency', rateSource: 'Exchange-rate source', tcmbField: 'Exchange-rate column', currRateMode: 'Missing-rate behavior',
  payRate: 'Hourly pay', payCurrency: 'Pay currency', restDaysPaid: 'Paid rest days', restDayHours: 'Rest-day hours', payMinDay: 'Pay day minimum'
};
const omitted = new Set(['supabase', 'timeCodeMappingsVersion', 'settingsListsVersion', 'tags']);
const stable = value => JSON.stringify(value && !Array.isArray(value) && typeof value === 'object'
  ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, JSON.parse(stable(item) ?? 'null')])) : value);

export function settingsDraft(saved, workspace = 'work') {
  const draft = clone(saved);
  draft.settingsListsVersion = 2;
  if (workspace === 'work') {
    draft.timeCodeMappings = effectiveTimeCodeMappings(draft);
    draft.timeCodeMappingsVersion = 2;
    draft.timeCalculationMode = calculationMode(draft);
  }
  return draft;
}

export function settingsChanges(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
  return keys.filter(key => !omitted.has(key) && stable(before[key]) !== stable(after[key]))
    .map(key => ({ key, label: labels[key] || key, before: describe(key, before[key]), after: describe(key, after[key]) }));
}
function describe(key, value) {
  if (key === 'clockify') return `${value?.apiKey ? 'Key provided' : 'No key'}${value?.userName ? ` · ${value.userName}` : value?.workspaceId ? ' · connected' : ' · connection not checked'}`;
  if (key.toLowerCase().includes('template')) return value ? `${String(value).length.toLocaleString()} characters` : 'Not set';
  if (key === 'timeCalculationMode') return value === 'tags' ? 'Use Clockify tags' : 'Calculate overtime for me';
  if (Array.isArray(value)) {
    if (!value.length) return 'None';
    const text = value.map(item => typeof item === 'object' ? item.tagName ? `${item.tagName} → ${item.mode === 'label' ? 'Label only' : item.code || 'Needs review'}${item.confirmed ? '' : ' (unconfirmed)'}`
      : item.clockifyProjectName ? `${item.clockifyProjectName} → ${item.shortName || item.kind || 'Not set'}`
      : item.country ? `${item.country}: ${item.rate} ${item.currency}` : item.short || item.desc || JSON.stringify(item) : String(item)).join('; ');
    return `${value.length} item${value.length === 1 ? '' : 's'} · ${text.length > 360 ? text.slice(0, 357) + '…' : text}`;
  }
  if (value && typeof value === 'object') return Object.values(value).filter(x => x !== '' && x != null).join(' · ') || 'Not set';
  return value === true ? 'On' : value === false ? 'Off' : value == null || value === '' ? 'Not set' : String(value);
}

// A comma is a decimal separator here, never a list separator. Reject ambiguous
// or partial numbers instead of accepting parseFloat's truncated value.
export function decimalSetting(raw, { min = 0, max = 1e9, empty = null } = {}) {
  const text = String(raw ?? '').trim();
  if (!text) return empty;
  if (!/^\d+(?:[.,]\d+)?$/.test(text)) return null;
  const value = Number(text.replace(',', '.'));
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

export function validateStructuredSettings(s, workspace = 'work') {
  const errors = [];
  const seen = new Set();
  for (const [i, category] of (s.expenseCodes || []).entries()) {
    const id = String(category.code);
    if (!/^[1-9]\d{0,8}$/.test(id) || seen.has(id)) errors.push(`Category ${i + 1}: use a unique numeric code.`);
    seen.add(id);
    if (!category.short?.trim() || !category.desc?.trim()) errors.push(`Category ${i + 1}: enter a name and description.`);
  }
  if (!s.expenseCodes?.length) errors.push('Keep at least one category.');
  if (!s.currencies?.length || s.currencies.some(c => !/^[A-Z]{3}$/.test(c)) || new Set(s.currencies).size !== s.currencies.length) errors.push('Use a unique three-letter code for each currency.');
  if (!s.currencies?.includes(s.defaultCurrency)) errors.push('Keep the default currency in the currency list.');
  if (workspace === 'work') {
    const countries = new Set();
    for (const [i, item] of (s.perDiemDefaults || []).entries()) {
      const key = item.country?.trim().toLowerCase();
      if (!key || countries.has(key)) errors.push(`Per diem ${i + 1}: enter a unique country.`);
      countries.add(key);
      if (typeof item.rate !== 'number' || decimalSetting(item.rate) == null) errors.push(`Per diem ${i + 1}: enter an amount such as 70.50 or 70,50.`);
      if (!/^[A-Z]{3}$/.test(item.currency)) errors.push(`Per diem ${i + 1}: choose a currency.`);
    }
    for (const key of ['costObjects', 'knownShortNames']) if ((s[key] || []).some(value => !value.trim()) || new Set(s[key] || []).size !== (s[key] || []).length) errors.push(`${labels[key]}: remove blank or duplicate rows.`);
  }
  return errors;
}

/** Only commit replaces the baseline. A rejected save never loses the draft. */
export function createSettingsDraft(saved, workspace = 'work') {
  let baseline = settingsDraft(saved, workspace), draft = clone(baseline);
  return {
    get value() { return draft; }, get baseline() { return clone(baseline); },
    changes: () => settingsChanges(baseline, draft),
    replace(next) { draft = settingsDraft(next, workspace); return draft; },
    discard() { draft = clone(baseline); return draft; },
    committed(next) { baseline = settingsDraft(next, workspace); draft = clone(baseline); return draft; }
  };
}

export function mergeSettingsDraft(baseline, draft, current, workspace = 'work') {
  const saved = settingsDraft(current, workspace), changes = settingsChanges(baseline, draft);
  const conflicts = changes.filter(({ key }) => stable(saved[key]) !== stable(baseline[key]) && stable(saved[key]) !== stable(draft[key]));
  if (conflicts.length) throw Error(`Saved settings changed while you were editing: ${conflicts.map(item => item.label).join(', ')}. Discard this draft and reopen Settings before changing them.`);
  for (const { key } of changes) saved[key] = clone(draft[key]);
  return saved;
}
