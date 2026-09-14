// Pure category proposals for the Personal workspace. The caller supplies only
// Personal snapshots, shows the proposal, and performs any approved saves.
const clean = value => typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
const key = value => clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
  .toLocaleLowerCase('en-US').replace(/ı/g, 'i').replace(/\s*([/&])\s*/g, '$1');
export const personalCategoryKey = key;
const clone = value => structuredClone(value);
const own = value => value && typeof value === 'object' && !Array.isArray(value);
const allowed = record => own(record) && !record.deleted && record.workspace !== 'work' && record.sourceWorkspace !== 'work' && !record.ledgerReadOnly;
const spendingCategory = row => !row.perdiem && !row.excludeFromSpending && (!clean(row.bankKind || row.kind) || ['purchase', 'refund', 'fee'].includes(clean(row.bankKind || row.kind).toLowerCase()));
const paths = { expenses: null, budgets: null, templates: 'defaults', inbox: 'draft' };

// These are category-name synonyms, not merchant or purchase classifiers.
// Shopping deliberately remains separate from clothing and electronics.
const families = [
  { preferred: 'Groceries', names: ['Groceries', 'Grocery', 'Market'] },
  { preferred: 'Food & drink', names: ['Food & drink', 'Food and drink', 'Yeme / İçme'] },
  { preferred: 'Transport', names: ['Transport', 'Transportation', 'Ulaşım'] },
  { preferred: 'Home', names: ['Home', 'Ev / Dekorasyon'] },
  { preferred: 'Health', names: ['Health', 'Sağlık / Bakım'] },
  { preferred: 'Shopping', names: ['Shopping', 'Alışveriş'] },
  { preferred: 'Subscriptions', names: ['Subscriptions', 'Subscription', 'Abonelik', 'Abonelikler'] },
  { preferred: 'Travel', names: ['Travel', 'Turizm / Konaklama'] },
  { preferred: 'Other', names: ['Other', 'Diğer'] },
  { preferred: 'Family', names: ['Family', 'Aile'] },
];
const familyFor = label => families.find(family => family.names.some(name => key(name) === key(label)));
const englishDefaults = new Set([...families.map(family => family.preferred), 'Grocery', 'Food and drink', 'Transportation', 'Subscription'].map(key));
const explicitLabel = row => clean(row.personalCategory) || clean(row.category);

function normalizedDefinitions(settings, { allowEmpty = false } = {}) {
  if (!own(settings) || !Array.isArray(settings.expenseCodes)) throw Error('Personal category settings are required.');
  if (settings.workspace === 'work' || settings.sourceWorkspace === 'work') throw Error('Category changes are only available in Personal.');
  if (!allowEmpty && !settings.expenseCodes.length) throw Error('Keep at least one Personal category.');
  const codes = new Set();
  return settings.expenseCodes.map(entry => {
    if (!own(entry) || !/^[1-9]\d{0,8}$/.test(String(entry.code)) || codes.has(String(entry.code))) throw Error('Personal categories need unique numeric codes.');
    codes.add(String(entry.code));
    const short = clean(entry.short);
    if (!short || short.length > 80) throw Error('Personal category names must contain 1–80 characters.');
    if (entry.aliases !== undefined && (!Array.isArray(entry.aliases) || entry.aliases.some(alias => !clean(alias) || clean(alias).length > 80))) throw Error(`Invalid aliases for “${short}”.`);
    const seen = new Set([key(short)]), aliases = [];
    for (const alias of entry.aliases || []) if (!seen.has(key(alias))) { seen.add(key(alias)); aliases.push(clean(alias)); }
    if (aliases.length > 100) throw Error(`Too many aliases for “${short}”.`);
    const normalized = { ...clone(entry), short };
    if (aliases.length) normalized.aliases = aliases; else delete normalized.aliases;
    return normalized;
  });
}
function indexDefinitions(definitions, { allowDuplicateNames = false } = {}) {
  const labels = new Map(), codes = new Map();
  for (const entry of definitions) {
    codes.set(String(entry.code), entry);
    for (const label of [entry.short, ...(entry.aliases || [])]) {
      const previous = labels.get(key(label));
      if (previous && String(previous.code) !== String(entry.code)) {
        if (!allowDuplicateNames || key(previous.short) !== key(entry.short)) throw Error(`Ambiguous category name or alias “${label}”. Keep it under only one category.`);
        continue; // Same name under two old codes can be consolidated safely.
      }
      labels.set(key(label), entry);
    }
  }
  return { labels, codes };
}
function readableDefinitions(settings) { return normalizedDefinitions({ ...(settings || {}), expenseCodes: settings?.expenseCodes ?? [] }, { allowEmpty: true }); }
function categoryIndex(settings) { return indexDefinitions(readableDefinitions(settings), { allowDuplicateNames: true }); }
function selectedLabel(value, index) {
  if (typeof value === 'string') return clean(value);
  if (!own(value)) return '';
  // Bank imports historically assigned the fallback code 90009 to many named
  // categories. A supplied label always wins over that unrelated numeric code.
  const label = explicitLabel(value);
  if (label) return label;
  if (value.bankTransaction && String(value.code) === '90009') return '';
  return index.codes.get(String(value.code))?.short || '';
}

/** Resolve confirmed aliases only; unknown explicit labels remain intact. */
export function resolvePersonalCategory(value, settings) {
  const index = categoryIndex(settings), label = selectedLabel(value, index);
  return index.labels.get(key(label))?.short || label;
}

/** Canonical category names for a dropdown, including unmatched existing labels. */
export function personalCategoryChoices(settings, rows = []) {
  if (!Array.isArray(rows)) throw Error('Expected Personal records for category choices.');
  const definitions = readableDefinitions(settings), index = indexDefinitions(definitions, { allowDuplicateNames: true });
  const choices = new Map();
  for (const entry of definitions) if (!choices.has(key(entry.short))) choices.set(key(entry.short), index.labels.get(key(entry.short)).short);
  for (const row of rows) {
    if (typeof row !== 'string' && (!allowed(row) || !spendingCategory(row))) continue;
    const raw = selectedLabel(row, index), label = index.labels.get(key(raw))?.short || raw;
    if (label && !choices.has(key(label))) choices.set(key(label), label);
  }
  return [...choices.values()];
}

function categoryRecords(tables = {}) {
  if (!own(tables)) throw Error('Expected Personal table snapshots.');
  const records = [];
  for (const [table, path] of Object.entries(paths)) {
    const rows = tables[table] ?? [];
    if (!Array.isArray(rows)) throw Error(`Expected a ${table} snapshot.`);
    for (const record of rows) {
      if (!allowed(record)) continue;
      const value = path ? record[path] : record;
      if (!allowed(value)) continue;
      records.push({ table, path, record, value });
    }
  }
  return records;
}
function withAliases(entry, labels) {
  const seen = new Set([key(entry.short)]), aliases = [];
  for (const value of [...(entry.aliases || []), ...labels]) if (clean(value) && !seen.has(key(value))) { seen.add(key(value)); aliases.push(clean(value)); }
  const result = { ...entry };
  if (aliases.length) result.aliases = aliases; else delete result.aliases;
  return result;
}

/**
 * Plan explicit Settings edits. Renaming a retained code keeps its previous
 * names as aliases. To remove an in-use category, put its name in the retained
 * category's aliases; an unmapped removal is rejected rather than choosing Other.
 */
export function planPersonalCategoryChanges(beforeSettings, nextSettings, tables = {}) {
  const before = normalizedDefinitions(beforeSettings), oldIndex = indexDefinitions(before, { allowDuplicateNames: true });
  let after = normalizedDefinitions(nextSettings);
  indexDefinitions(after);
  after = after.map(entry => {
    const previous = oldIndex.codes.get(String(entry.code));
    return previous ? withAliases(entry, [previous.short, ...(previous.aliases || [])]) : entry;
  });
  let nextIndex = indexDefinitions(after);
  // Carry former names through a later merge: A -> B -> C becomes aliases A,B
  // on C. Every alias points directly to a retained code, never to another alias.
  let remaining = before.filter(entry => !nextIndex.codes.has(String(entry.code))), progress = true;
  while (remaining.length && progress) {
    progress = false;
    remaining = remaining.filter(previous => {
      const targets = new Set([previous.short, ...(previous.aliases || [])].map(label => nextIndex.labels.get(key(label))).filter(Boolean));
      if (targets.size > 1) throw Error(`Previous aliases for “${previous.short}” point to different categories.`);
      const target = [...targets][0]; if (!target) return true;
      after = after.map(entry => entry === target ? withAliases(entry, [previous.short, ...(previous.aliases || [])]) : entry);
      nextIndex = indexDefinitions(after); progress = true; return false;
    });
  }
  const settings = { ...clone(nextSettings), expenseCodes: after };
  // Revalidate alias bounds after carrying history forward.
  settings.expenseCodes = normalizedDefinitions(settings); nextIndex = indexDefinitions(settings.expenseCodes);
  const records = categoryRecords(tables), items = [], countLabels = new Map(), observedLabels = new Map();
  for (const { table, path, record, value } of records) {
    const label = selectedLabel(value, oldIndex); if (!label) continue; // Includes all-category budgets.
    const labelKey = key(label), known = oldIndex.labels.get(labelKey);
    const target = nextIndex.labels.get(labelKey) || (known && nextIndex.labels.get(key(known.short)));
    observedLabels.set(labelKey, label);
    const count = countLabels.get(labelKey) || { count: 0, referenceCount: 0 };
    count.referenceCount++; if (table === 'expenses') count.count++; countLabels.set(labelKey, count);
    if (!target) {
      if (known) throw Error(`“${known.short}” is still used by Personal records. Choose a category to receive it before removing it.`);
      continue; // Unknown named fallback-code records are not the removed code's category.
    }
    const labelChanged = explicitLabel(value) ? explicitLabel(value) !== target.short : label !== target.short;
    const codeChanged = String(value.code ?? '') !== String(target.code);
    if (!labelChanged && !codeChanged) continue;
    if (!clean(record.id)) throw Error(`Cannot update a ${table} category without its record ID.`);
    const updated = { ...clone(value), personalCategory: target.short,
      code: typeof value.code === 'string' ? String(target.code) : Number(target.code),
      personalCategoryMerge: { from: label, to: target.short, previousCode: value.code ?? null } };
    if (clean(value.category)) updated.category = target.short;
    // Keep any previous manual provenance and every unrelated review flag. This
    // approved name merge also protects bank rows from later workbook enrichment.
    if (table === 'expenses') updated.bankReviewFields = [...new Set([...(value.bankReviewFields || []), 'personalCategory'])];
    const nextRecord = path ? { ...clone(record), [path]: updated } : updated;
    items.push({ table, record: nextRecord, expectedRecord: clone(record) });
  }
  const mergeLabels = new Map(before.map(entry => [key(entry.short), entry.short]));
  for (const [labelKey, label] of observedLabels) if (!mergeLabels.has(labelKey)) mergeLabels.set(labelKey, label);
  const merges = [];
  for (const [labelKey, from] of mergeLabels) {
    const to = nextIndex.labels.get(labelKey)?.short;
    if (to && from !== to) merges.push({ from, to, count: countLabels.get(labelKey)?.count || 0, referenceCount: countLabels.get(labelKey)?.referenceCount || 0 });
  }
  return { settings, merges, items };
}

/** Review proposal that reconciles clear synonyms and adds existing user labels. */
export function proposePersonalCategories(settings, tables = {}) {
  const definitions = normalizedDefinitions(settings), index = indexDefinitions(definitions, { allowDuplicateNames: true }), records = categoryRecords(tables);
  const labels = new Map(), add = (label, table = '') => {
    if (!label) return;
    const existing = labels.get(key(label)) || { label, count: 0, refs: 0 };
    if (table) existing.refs++; if (table === 'expenses') existing.count++;
    labels.set(key(label), existing);
  };
  for (const entry of definitions) add(entry.short);
  for (const { table, value } of records) {
    if (table !== 'budgets' && !spendingCategory(value)) continue;
    const raw = selectedLabel(value, index);
    add(index.labels.get(key(raw))?.short || raw, table);
  }
  const buckets = new Map();
  for (const value of labels.values()) {
    const family = familyFor(value.label), id = family ? `family:${family.preferred}` : `label:${key(value.label)}`;
    const bucket = buckets.get(id) || { family, labels: [], definitions: [] }; bucket.labels.push(value); buckets.set(id, bucket);
  }
  for (const entry of definitions) {
    const family = familyFor(entry.short), id = family ? `family:${family.preferred}` : `label:${key(entry.short)}`;
    buckets.get(id).definitions.push(entry);
  }
  const usedCodes = new Set(definitions.map(entry => String(entry.code))); let newCode = 90001;
  const allocate = () => { while (usedCodes.has(String(newCode))) newCode++; usedCodes.add(String(newCode)); return newCode++; };
  const ranked = values => values.slice().sort((a, b) => b.count - a.count || b.refs - a.refs || a.label.localeCompare(b.label, 'en'));
  const prepared = [];
  for (const bucket of buckets.values()) {
    const { family } = bucket;
    const explicitDefinition = bucket.definitions.find(entry => entry.aliases?.length) || bucket.definitions.find(entry => !family || key(entry.short) !== key(family.preferred));
    const nonDefault = family ? bucket.labels.filter(item => !englishDefaults.has(key(item.label))) : [];
    const target = explicitDefinition?.short || (nonDefault.length ? ranked(nonDefault)[0].label : family?.preferred || ranked(bucket.labels)[0].label);
    const retained = bucket.definitions.find(entry => key(entry.short) === key(target)) || bucket.definitions[0];
    const definition = retained ? { ...clone(retained), short: target,
      desc: key(retained.desc) === key(retained.short) ? target : retained.desc } : { code: allocate(), short: target, desc: target };
    const aliases = [...bucket.labels.map(item => item.label), ...bucket.definitions.flatMap(entry => [entry.short, ...(entry.aliases || [])]), ...(family?.names || [])];
    prepared.push(withAliases(definition, aliases));
  }
  return planPersonalCategoryChanges(settings, { ...clone(settings), expenseCodes: prepared }, tables);
}
