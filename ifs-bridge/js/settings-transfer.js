// Portable preferences only. Account sessions and expense records never enter this format.
export const SETTINGS_FILE_LIMIT = 1024 * 1024;
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
const fail = message => { throw new Error(message); };
const invalid = path => fail(`Invalid ${path} in settings file.`);
const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const string = (max = 2000) => (value, path) => typeof value === 'string' && value.length <= max ? value : invalid(path);
const number = (min, max, integer = false) => (value, path) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max && (!integer || Number.isInteger(value)) ? value : invalid(path);
const bool = (value, path) => typeof value === 'boolean' ? value : invalid(path);
const enumeration = values => (value, path) => values.includes(value) ? value : invalid(path);
const currency = (value, path) => typeof value === 'string' && /^[A-Z]{3}$/.test(value) ? value : invalid(path);
const array = (item, max = 1000, min = 0) => (value, path) => {
  if (!Array.isArray(value) || value.length < min || value.length > max) invalid(path);
  return value.map((entry, index) => item(entry, `${path}[${index + 1}]`));
};
const object = (shape, required = []) => (value, path) => {
  if (!plain(value) || required.some(key => !own(value, key))) invalid(path);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (forbidden.has(key) || !own(shape, key)) invalid(`${path}.${key}`);
    result[key] = shape[key](entry, `${path}.${key}`);
  }
  return result;
};
const dictionary = (item, max = 1000) => (value, path) => {
  if (!plain(value) || Object.keys(value).length > max) invalid(path);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (forbidden.has(key) || key.length > 200) invalid(path);
    result[key] = item(entry, path);
  }
  return result;
};
const timezone = (value, path) => {
  string(100)(value, path);
  try { new Intl.DateTimeFormat('en', { timeZone: value }); } catch { invalid(path); }
  return value;
};
const date = (value, path) => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) invalid(path);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) invalid(path);
  return value;
};
const optionalHours = (value, path) => {
  if (value === '') return value;
  if (typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value)) { number(0, 24)(Number(value), path); return value; }
  return number(0, 24)(value, path);
};
const code = (value, path) => {
  if (typeof value === 'string' && /^[1-9]\d{0,8}$/.test(value)) return value;
  return number(1, 999999999, true)(value, path);
};
const travel = object({ activityNo: string(), activitySeq: string(), activityDesc: string(), shortName: string() });
const mapping = object({ clockifyProjectId: string(), clockifyProjectName: string(), kind: enumeration(['project', 'general', 'ignore']), regularHours: optionalHours, travelAfterHours: optionalHours,
  projectId: string(), projectName: string(), subProjectId: string(), subProjectDesc: string(), activityNo: string(), activitySeq: string(), activityDesc: string(), shortName: string(), travel });
const workShape = {
  settingsListsVersion: enumeration([2]),
  timeCalculationMode: enumeration(['rules', 'tags']), timeCodeMappingsVersion: enumeration([2]),
  timeZone: timezone, regularHours: number(0, 24), travelAfterHours: number(0, 24), topUpMinimum: bool,
  roundStep: number(0.001, 24), roundMode: enumeration(['nearest', 'down', 'up']), holidays: array(date, 10000),
  tags: object({ x15: string(), x2: string(), travel: string(), travelOT: string() }),
  travelKeyword: (value, path) => { string()(value, path); try { new RegExp(`^\\s*${value}\\b`, 'i'); } catch { invalid(path); } return value; },
  codes: object({ regular: string(), ot15: string(), ot2: string(), travel: string(), travelRegular: string() }),
  codeDescriptions: dictionary(string()),
  timeCodeMappings: array(object({ tagId: string(200), tagName: string(200), mode: enumeration(['review', 'code', 'label']), code: string(40), description: string(2000), confirmed: bool, payMultiplier: (value, path) => value === null ? null : number(0, 10)(value, path) }, ['tagName', 'mode', 'confirmed']), 20000),
  timeCodeCatalog: array(object({ code: string(40), description: string(2000), source: enumeration(['ifs-copy', 'manual', 'documented']) }, ['code', 'description', 'source']), 1000),
  identity: object({ companyId: string(), empNo: string(), resourceId: string(), resourceSeq: string(), resourceName: string() }),
  template: string(200000), defaultCurrency: currency, currencies: array(currency, 200, 1), costObjects: array(string()),
  expenseCodes: array(object({ code, desc: string(), short: string() }, ['code', 'desc', 'short']), 1000, 1),
  perDiemCode: code, expenseTemplate: string(200000), expenseActivitySuffix: string(), knownShortNames: array(string()),
  homeCurrency: currency, rateSource: enumeration(['tcmb', 'manual']),
  tcmbField: enumeration(['ForexBuying', 'ForexSelling', 'BanknoteBuying', 'BanknoteSelling']),
  currRateMode: enumeration(['blank', 'omit', 'one']),
  perDiemDefaults: array(object({ country: string(), rate: number(0, 1000000000), currency }, ['country', 'rate', 'currency'])),
  payRate: number(0, 1000000000), payCurrency: currency, restDaysPaid: bool, restDayHours: number(0, 24), payMinDay: number(0, 24),
  mapping: array(mapping), clockify: object({ apiKey: string(4096) }, ['apiKey']),
};
const personalShape = Object.fromEntries(['settingsListsVersion', 'timeZone', 'defaultCurrency', 'currencies', 'expenseCodes'].map(key => [key, workShape[key]]));
const workspaceOf = workspace => enumeration(['work', 'personal'])(workspace, 'workspace');
const shapeOf = workspace => workspace === 'personal' ? personalShape : workShape;

function inspectTree(value, depth = 0, budget = { left: 50000 }) {
  if (--budget.left < 0 || depth > 12) fail('Settings file is too complex.');
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) fail('Settings file contains an unsafe property.');
    inspectTree(child, depth + 1, budget);
  }
}

function validateSettings(value, workspace) {
  const settings = object(shapeOf(workspace))(value, 'settings');
  if (!Object.keys(settings).length) fail('This file contains no settings to import.');
  if (settings.currencies && settings.defaultCurrency && !settings.currencies.includes(settings.defaultCurrency)) fail('Default currency is missing from the currency list.');
  if (settings.expenseCodes) {
    const ids = settings.expenseCodes.map(item => String(item.code));
    if (new Set(ids).size !== ids.length) fail('Settings file contains duplicate expense category codes.');
  }
  return settings;
}

/** Export the visible workspace preferences, optionally including the Clockify key. */
export function createSettingsFile(settings, { workspace, includeApiKey = false, createdAt = new Date().toISOString() } = {}) {
  workspaceOf(workspace);
  if (!plain(settings)) fail('Settings are unavailable.');
  const selected = {};
  for (const key of Object.keys(shapeOf(workspace))) {
    if (key !== 'clockify' && own(settings, key)) selected[key] = settings[key];
  }
  // Clockify supplies these IDs again after Connect, so they cannot leak across accounts.
  if (workspace === 'work' && includeApiKey && settings.clockify?.apiKey) selected.clockify = { apiKey: string(4096)(settings.clockify.apiKey, 'Clockify API key').trim() };
  const envelope = { type: 'ifsbridge-settings', version: 1, workspace, createdAt, settings: validateSettings(selected, workspace) };
  // Use the import checks too: an exported file should always be readable by this version.
  const text = JSON.stringify(envelope);
  parseSettingsFile(text, { workspace, current: {} });
  return envelope;
}

/** Validate everything before returning a new settings object; never mutates current. */
export function parseSettingsFile(text, { workspace, current = {} } = {}) {
  workspaceOf(workspace);
  if (typeof text !== 'string' || new TextEncoder().encode(text).byteLength > SETTINGS_FILE_LIMIT) fail('Choose a settings JSON file smaller than 1 MB.');
  let envelope;
  try { envelope = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { fail('That file is not valid JSON. Choose an exported settings file.'); }
  inspectTree(envelope);
  if (!plain(envelope) || envelope.type !== 'ifsbridge-settings') fail('Choose an exported settings file. Expense backups belong in Restore from backup.');
  if (envelope.version !== 1) fail('This settings file version is not supported.');
  if (!['work', 'personal'].includes(envelope.workspace)) invalid('workspace');
  if (envelope.workspace !== workspace) fail(`This file is for ${envelope.workspace === 'work' ? 'Work' : 'Personal'}. Switch to that space before importing.`);
  for (const key of Object.keys(envelope)) if (!['type', 'version', 'workspace', 'createdAt', 'settings'].includes(key)) fail('The settings file contains unexpected data.');
  if (own(envelope, 'createdAt') && (typeof envelope.createdAt !== 'string' || envelope.createdAt.length > 40 || !Number.isFinite(Date.parse(envelope.createdAt)))) invalid('creation date');
  const imported = validateSettings(envelope.settings, workspace);
  if (!plain(current)) fail('Current settings are unavailable.');
  const settings = structuredClone(current);
  for (const [key, value] of Object.entries(imported)) {
    if (key === 'clockify') continue;
    // Nested forms keep fields absent from older exports; an imported list replaces that list.
    settings[key] = plain(value) ? { ...(plain(settings[key]) ? settings[key] : {}), ...structuredClone(value) } : structuredClone(value);
  }
  // A legacy export defines its own tag setup. Do not let a newer device's
  // unified marker or unrelated mappings silently override that imported setup.
  if (workspace === 'work' && own(imported, 'tags') && !own(imported, 'timeCodeMappingsVersion')) {
    settings.tags = { x15: '', x2: '', travel: '', travelOT: '', ...structuredClone(imported.tags) };
    settings.timeCodeMappings = structuredClone(imported.timeCodeMappings || []);
    delete settings.timeCodeMappingsVersion;
    if (!own(imported, 'timeCalculationMode')) delete settings.timeCalculationMode;
  }
  if (settings.currencies && settings.defaultCurrency && !settings.currencies.includes(settings.defaultCurrency)) fail('Default currency is missing from the currency list. Include both settings in the file.');
  const includesApiKey = own(imported, 'clockify');
  let clockifyKeyAction = 'keep';
  if (includesApiKey) {
    const apiKey = imported.clockify.apiKey.trim();
    const changed = apiKey !== (current.clockify?.apiKey || '');
    settings.clockify = { ...(current.clockify || {}), apiKey, ...(changed ? { userId: '', workspaceId: '', userName: '' } : {}) };
    clockifyKeyAction = !changed ? 'keep' : apiKey ? 'replace' : 'remove';
  }
  return { settings, includesApiKey, summary: { workspace, createdAt: envelope.createdAt || '', fieldCount: Object.keys(imported).length,
    mappingCount: imported.mapping?.length || 0, categoryCount: imported.expenseCodes?.length || 0,
    currencyCount: imported.currencies?.length || 0, holidayCount: imported.holidays?.length || 0,
    perDiemCount: imported.perDiemDefaults?.length || 0, includesApiKey, clockifyKeyAction,
    sections: Object.keys(imported) } };
}
