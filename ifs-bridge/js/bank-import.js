// Pure, local bank import rules. The browser reads workbook cells; this module
// never reads a file, an account, storage, or the network. All fixtures are fake.
import { stableId, validDate } from './expense-workflows.js';

const text = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const fold = value => text(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/ı/g, 'i').toLowerCase();
const norm = value => fold(value).replace(/\s*\(\s*/g, '(').replace(/\s*\)\s*/g, ')').replace(/\s+/g, ' ');
const present = value => value != null && text(value) !== '';
const formula = value => typeof value === 'string' && value.trim().startsWith('=');
const safeText = value => text(value).replace(/\b(?:\d[ -]?){13,19}\b/g, match => `•••• ${match.replace(/\D/g, '').slice(-4)}`);
const currencyOf = value => { const found = fold(value).match(/\b(try|tl|usd|eur|cad|gbp)\b/); return found ? (found[1] === 'tl' ? 'TRY' : found[1].toUpperCase()) : ''; };
const signedOf = row => Number.isSafeInteger(row.signedMinor) ? row.signedMinor : parseBankAmount(row.amount, { decimal: 'auto' });

export function parseBankAmount(value, { decimal = 'auto' } = {}) {
  if (typeof value === 'number') {
    const minor = Math.round(value * 100);
    if (!Number.isFinite(value) || !Number.isSafeInteger(minor) || Math.abs(value * 100 - minor) > 0.00001) throw Error('Amount must contain at most two decimal places.');
    return minor;
  }
  if (formula(value)) throw Error('Use the original amount, not a conversion formula.');
  let input = text(value).replace(/[₺$€£]/g, '').replace(/\b(?:TRY|TL|USD|EUR|CAD|GBP)\b/gi, '').replace(/\s/g, '');
  let sign = 1;
  if (/^\(.*\)$/.test(input)) { sign = -1; input = input.slice(1, -1); }
  if (/^[+-]/.test(input)) { sign *= input[0] === '-' ? -1 : 1; input = input.slice(1); }
  if (!input) throw Error('Missing amount.');
  let separator = decimal === 'comma' ? ',' : decimal === 'dot' ? '.' : '';
  if (!separator) {
    if (input.includes(',') && input.includes('.')) separator = input.lastIndexOf(',') > input.lastIndexOf('.') ? ',' : '.';
    else if (/[.,]\d{1,2}$/.test(input)) separator = input.includes(',') ? ',' : '.';
    else if (/[.,]/.test(input)) throw Error('Ambiguous amount: choose the decimal format.');
  }
  const group = separator === ',' ? '.' : ',';
  const parts = separator ? input.split(separator) : [input];
  if (parts.length > 2 || (parts.length === 2 && !/^\d{1,2}$/.test(parts[1]))) throw Error('Invalid amount.');
  const whole = parts[0];
  if (!/^\d+$/.test(whole) && !(separator && new RegExp(`^\\d{1,3}(?:\\${group}\\d{3})+$`).test(whole))) throw Error('Invalid amount grouping.');
  const minor = Number(whole.split(group).join('')) * 100 + Number((parts[1] || '').padEnd(2, '0'));
  if (!Number.isSafeInteger(minor)) throw Error('Amount is too large.');
  return sign * minor;
}

export function parseBankDate(value, { dateOrder = 'dmy' } = {}) {
  let result = '';
  if (value instanceof Date && Number.isFinite(value.getTime())) result = value.toISOString().slice(0, 10);
  else if (typeof value === 'number' && Number.isFinite(value) && value > 60 && value < 2958466) result = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86400000).toISOString().slice(0, 10);
  else {
    const input = text(value), iso = /^(\d{4}-\d{2}-\d{2})(?:[ T].*)?$/.exec(input);
    if (iso) result = iso[1];
    else {
      const match = /^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/.exec(input);
      if (match) result = `${match[3]}-${(dateOrder === 'mdy' ? match[1] : match[2]).padStart(2, '0')}-${(dateOrder === 'mdy' ? match[2] : match[1]).padStart(2, '0')}`;
    }
  }
  if (!validDate(result) || Number(result.slice(0, 4)) < 1900) throw Error('Invalid transaction date.');
  return result;
}

function aliasName(value) {
  return norm(value).replace(/\.(?:xlsx?|csv)$/i, '').replace(/^(?:donemici islemler|ekstre islemleri)\s*[-–:]?\s*/i, '').replace(/\b(?:tl|try|usd|eur|cad|gbp)\b/g, '').replace(/\s+/g, ' ').trim();
}
function suffixOf(value) {
  const raw = text(value), masked = /(?:\d{3,6})\s*(?:[*•.…]+\s*)+(\d{3,4})\b/.exec(raw);
  if (masked) return masked[1];
  const named = /^(?:alias:)?[A-Za-z ]+\s+(\d{3,4})\s*(?:\([^)]*\))?(?:\s+(?:TL|TRY|USD|EUR))?$/.exec(raw);
  if (named) return named[1];
  const compact = /^(?:card:|mask:|last:)?(?:[•*]+\s*)?(\d{3,4})$/.exec(raw);
  return compact ? compact[1] : '';
}
function aliasesFrom(value = {}) {
  const map = new Map();
  const entries = value instanceof Map ? [...value] : Array.isArray(value) ? value.map(x => [x.maskedCard || x.accountId || x.from, x.alias || x.to]) : Object.entries(value);
  for (const [key, target] of entries) {
    const alias = aliasName(target), suffix = suffixOf(key);
    if (!alias) continue;
    map.set(suffix ? `mask:${suffix}` : aliasName(key).replace(/^alias:/, ''), alias);
  }
  return map;
}
function resolveAlias(value, aliases) {
  let alias = value; const seen = new Set();
  while (aliases.has(alias) && aliases.get(alias) !== alias) {
    if (seen.has(alias)) throw Error('Card label mappings contain a loop. Use one final label for each card.');
    seen.add(alias); alias = aliases.get(alias);
  }
  return alias;
}
function account(value, aliases = new Map()) {
  const suffix = suffixOf(value), alias = suffix ? '' : aliasName(value).replace(/^alias:/, '');
  if (suffix) { const target = aliases.get(`mask:${suffix}`), mapped = target ? resolveAlias(target, aliases) : ''; return { accountId: mapped ? `alias:${mapped}` : `mask:${suffix}`, card: mapped || `Card •••• ${suffix}`, maskedCard: `•••• ${suffix}` }; }
  const mapped = resolveAlias(alias, aliases);
  return { accountId: mapped ? `alias:${mapped}` : 'unknown', card: mapped || 'Unspecified card', maskedCard: '' };
}
function workbookAliases(sheets) {
  const found = {};
  // These are card-name data, not executable workbook instructions. Only the
  // explicit "masked card = alias" shape is read; other notes are ignored.
  for (const sheet of sheets) if (fold(sheet.name) === 'notes') for (const cells of sheet.rows || []) for (const cell of cells) {
    const re = /\b\d{3,6}\s*(?:[*•.…]+\s*)+(\d{3,4})\s*=\s*([^•\n(]+)/g;
    for (const match of String(cell ?? '').matchAll(re)) found[`mask:${match[1]}`] = safeText(match[2]);
  }
  return found;
}
function canonicalAccount(row, aliases) { return account(row.maskedCard || row.accountId || row.card, aliases).accountId; }
const importedBankRow = row => !!(row?.bankTransaction || row?.sourceType || row?.bankImport || row?.transactionKey || row?.bankFingerprint);

// Mappings travel with imported records, so later uploads on another device can
// reuse the same card identity. Conflicts are returned for review, never guessed.
export function deriveBankCardAliases(existingRows = []) {
  const candidates = new Map();
  const remember = (from, to) => {
    for (const [mappingKey, alias] of aliasesFrom({ [from]: to })) {
      const values = candidates.get(mappingKey) || new Set(); values.add(alias); candidates.set(mappingKey, values);
    }
  };
  for (const row of existingRows) {
    if (!importedBankRow(row)) continue;
    for (const [from, to] of Object.entries(row.bankCardAliases || {})) remember(from, to);
    if (row.maskedCard && String(row.accountId || '').startsWith('alias:')) remember(row.maskedCard, row.accountId.slice(6));
  }
  const cardAliases = {}, conflicts = [];
  for (const [from, values] of candidates) {
    if (values.size === 1) cardAliases[from] = [...values][0];
    else conflicts.push({ from, aliases: [...values].sort() });
  }
  return { cardAliases, conflicts };
}

// A detailed workbook may arrive after the bank export. Only fill annotations
// that still have bank defaults; never rewrite money, identity, or user choices.
export function bankEnrichment(existing, incoming) {
  if (!importedBankRow(existing) || existing.deleted || incoming?.sourceType !== 'spending-workbook') return null;
  const protectedFields = new Set(existing.bankReviewFields || []), patch = {}, changes = [];
  const put = (field, value, label, untouched) => {
    if (!untouched || protectedFields.has(field) || !present(value) || text(existing[field]) === text(value)) return;
    patch[field] = value; changes.push({ field, label, before: existing[field] ?? '', after: value });
  };
  put('merchant', incoming.merchant, 'Merchant', !present(existing.merchant) || norm(existing.merchant) === norm(existing.bankDescription || existing.originalDescription));
  if (patch.merchant) patch.vendor = patch.merchant;
  put('note', incoming.note, 'Note', !present(existing.note) && !present(existing.written));
  if (patch.note) patch.written = patch.note;
  for (const field of ['location', 'placeType']) put(field, incoming[field], field === 'location' ? 'Location' : 'Place type', !present(existing[field]));
  const category = existing.personalCategory || existing.category;
  const defaultCategory = (!present(category) || norm(category) === 'uncategorized' || norm(category) === norm(existing.bankCategory)) && !protectedFields.has('category') && !protectedFields.has('personalCategory');
  if (incoming.categoryProvenance === 'workbook category' && ['bank label', 'unassigned', undefined, ''].includes(existing.categoryProvenance)) {
    put('personalCategory', incoming.personalCategory || incoming.category, 'Category', defaultCategory);
    if (patch.personalCategory) { patch.category = patch.personalCategory; patch.categoryProvenance = 'workbook category'; }
  }
  put('spendingPurpose', incoming.spendingPurpose, 'Purpose', ['personal', 'business'].includes(incoming.spendingPurpose) && !['personal', 'business'].includes(existing.spendingPurpose) && existing.business !== true && !protectedFields.has('business'));
  if (patch.spendingPurpose) { patch.usage = patch.spendingPurpose; patch.business = patch.spendingPurpose === 'business'; }
  if (!changes.length) return null;
  patch.bankEnrichmentSources = [...(existing.bankEnrichmentSources || []), { file: incoming.sourceFile, sheet: incoming.detailSource?.sheet || incoming.sourceSheet, row: incoming.detailSource?.row || incoming.sourceRow }];
  return { patch, changes };
}
function merchantKey(row) { return norm(row.bankDescription || row.originalStatementText || row.merchant || row.vendor || row.description || row.written); }
export function bankFingerprint(row, { cardAliases = {}, includeAccount = true } = {}) {
  const identity = [row.date, currencyOf(row.currency) || text(row.currency).toUpperCase(), signedOf(row), merchantKey(row)];
  if (includeAccount) identity.splice(3, 0, canonicalAccount(row, aliasesFrom(cardAliases)));
  return identity.join('|');
}

function classify(description, label, explicitKind, signedMinor, pending, hasAmount) {
  const words = fold(`${description} ${label} ${explicitKind}`), kind = fold(explicitKind);
  if (pending || /\b(pending|acik provizyon)\b/.test(words)) return ['pending', false, 'Pending authorization; import the posted charge later.'];
  if (/kart odemesi|card payment|borc odeme|internet odeme|\bpayment\b/.test(words)) return ['payment', false, 'Card repayment is not spending.'];
  if (/ekstre taksitlendir|financing|statement instalment|statement installment/.test(words)) return ['financing', false, 'Statement financing would count existing spending again.'];
  if (/ekstre devir bakiyesi|fx balance carried|balance carried|\btransfer\b/.test(words)) return ['transfer', false, 'Balance carry-over or transfer is not a new purchase.'];
  if (!hasAmount || /^(?:reward|miles|bonus)$/.test(kind)) return ['reward', false, 'Reward points do not change spending.'];
  if (!signedMinor) return ['unknown', false, 'Zero-value row.'];
  if (signedMinor < 0 || /^(?:refund|return|iade)$/.test(kind)) return ['refund', true, 'Posted refund.'];
  if (/islem ucreti|\bfee\b|faiz|gecikme|interest|komisyon|bsmv|kkdf/.test(words)) return ['fee', true, 'Posted bank charge.'];
  if (kind && !/^(?:spend|expense|purchase|harcama)$/.test(kind)) return ['unknown', false, 'Unrecognized transaction type; review it before importing.'];
  return ['purchase', true, 'Posted purchase.'];
}
function installmentOf(description) {
  const match = /\((\d{1,2})\s*\/\s*(\d{1,2})\)/.exec(description);
  if (!match) return null;
  const current = Number(match[1]), total = Number(match[2]);
  return current > 0 && total >= current ? { current, total, basis: 'posted-installment' } : null;
}
function normalizedRow(raw, context) {
  const base = { sourceFile: context.fileName, sourceSheet: context.sheetName, sourceRow: context.rowNumber, sourceType: context.sourceType, ...account(raw.card, context.aliases) };
  try {
    const date = parseBankDate(raw.date), currency = currencyOf(raw.currency);
    if (!currency) throw Error('Missing or unsupported currency.');
    const hasAmount = present(raw.amount), originalMinor = hasAmount ? parseBankAmount(raw.amount, { decimal: context.decimal || 'auto' }) : 0;
    let signedMinor = context.bankSigns ? -originalMinor : originalMinor;
    const description = safeText(raw.description || raw.merchant), label = safeText(raw.bankCategory || raw.category);
    const [kind, include, reason] = classify(description, label, raw.kind, signedMinor, raw.pending, hasAmount);
    if (kind === 'refund') signedMinor = -Math.abs(signedMinor);
    const category = safeText(raw.category || raw.bankCategory) || 'Uncategorized';
    const purpose = /^(yes|business)$/i.test(text(raw.business)) ? 'business' : /^(no|personal)$/i.test(text(raw.business)) ? 'personal' : present(raw.business) ? 'review' : 'unspecified';
    const row = { ...base, date, currency, amount: signedMinor / 100, amountMinor: Math.abs(signedMinor), signedMinor, kind, bankKind: kind, include, excludeFromSpending: !include, reason, merchant: safeText(raw.merchant || description), bankDescription: description, note: safeText(raw.note), category, personalCategory: category, bankCategory: safeText(raw.bankCategory), categoryProvenance: raw.category ? 'workbook category' : raw.bankCategory ? 'bank label' : 'unassigned', installment: installmentOf(description), location: safeText(raw.location), placeType: safeText(raw.placeType), usage: purpose, spendingPurpose: purpose };
    row.transactionKey = bankFingerprint(row);
    return row;
  } catch (error) {
    return { ...base, date: '', currency: currencyOf(raw.currency), amount: 0, amountMinor: 0, signedMinor: 0, kind: 'unknown', include: false, merchant: safeText(raw.merchant || raw.description), note: '', error: error.message, reason: error.message };
  }
}
function headerIndex(cells) { const keys = cells.map(fold); return key => keys.indexOf(key); }
function isDatedCandidate(value) { return value instanceof Date || typeof value === 'number' || /^\d/.test(text(value)); }

function parseGaranti(sheets, context, options) {
  const result = []; let recognized = false;
  for (const sheet of sheets) {
    let columns = null, pending = false, card = options.account || options.card || aliasName(context.fileName), currency = currencyOf(context.fileName);
    for (let index = 0; index < sheet.rows.length; index++) {
      const cells = sheet.rows[index], first = text(cells[0]), joined = cells.map(text).join(' '), folded = fold(joined);
      if (/numarali kart/.test(folded)) { const suffix = suffixOf(joined); card = suffix ? `mask:${suffix}` : ''; currency = currencyOf(joined); pending = false; columns = null; }
      if (/^acik provizyon\b/.test(fold(first))) { pending = true; columns = null; }
      if (/^donemici islemler\b/.test(fold(first))) { pending = false; columns = null; }
      const at = headerIndex(cells), amountIndex = cells.findIndex(v => /^tutar\s*\(/.test(fold(v)));
      if (at('tarih') >= 0 && at('islem') >= 0 && amountIndex >= 0) {
        columns = { date: at('tarih'), description: at('islem'), category: at('etiket'), amount: amountIndex };
        currency = currencyOf(cells[amountIndex]) || currency; recognized = true; continue;
      }
      if (!columns || !isDatedCandidate(cells[columns.date])) continue;
      result.push(normalizedRow({ date: cells[columns.date], description: cells[columns.description], bankCategory: cells[columns.category], amount: cells[columns.amount], currency, card, pending }, { ...context, sourceType: /numarali kart|ekstre islemleri/.test(`${fold(context.fileName)} ${folded}`) || fold(context.fileName).startsWith('ekstre') ? 'garanti-statement' : 'garanti-in-month', sheetName: sheet.name, rowNumber: index + 1, decimal: 'comma', bankSigns: true }));
    }
  }
  return { rows: result, recognized };
}

function detailTable(sheet, context, trip = false) {
  const rows = []; let columns = null;
  for (let index = 0; index < sheet.rows.length; index++) {
    const cells = sheet.rows[index], at = headerIndex(cells);
    if (at('date') >= 0 && (trip ? at('merchant') >= 0 && at('amount (original)') >= 0 : at('description') >= 0 && at('amount') >= 0 && at('card') >= 0)) {
      columns = Object.fromEntries(['date', 'card', 'paid with', 'currency', 'description', 'original statement text', 'bank category', 'category (en)', 'category', 'amount', 'amount (original)', 'type', 'merchant', 'note', 'location', 'type of place', 'business?'].map(key => [key, at(key)])); continue;
    }
    if (!columns || !isDatedCandidate(cells[columns.date])) continue;
    const get = key => columns[key] < 0 ? '' : cells[columns[key]];
    // Blank cash placeholders and spare formula rows are planning material.
    if (trip && !present(get('amount (original)'))) continue;
    rows.push(normalizedRow({ date: get('date'), currency: get('currency'), card: get(trip ? 'paid with' : 'card'), description: get(trip ? 'original statement text' : 'description') || get('merchant'), amount: get(trip ? 'amount (original)' : 'amount'), bankCategory: get('bank category'), category: get(trip ? 'category' : 'category (en)'), kind: trip ? '' : get('type'), merchant: get('merchant'), note: get('note'), business: get('business?'), location: get('location'), placeType: get('type of place') }, { ...context, sourceType: 'spending-workbook', sheetName: sheet.name, rowNumber: index + 1, decimal: 'auto', bankSigns: false }));
  }
  return { rows, recognized: !!columns };
}

export function parseBankWorkbook(workbook, options = {}) {
  if (!workbook || !Array.isArray(workbook.sheets)) throw Error('Expected workbook sheets with cell rows.');
  const sheets = workbook.sheets.filter(s => s && Array.isArray(s.rows)).map(s => ({ name: safeText(s.name), rows: s.rows }));
  if (sheets.reduce((sum, s) => sum + s.rows.length, 0) > 100000) throw Error('Use a workbook with fewer than 100,000 rows.');
  const fileName = safeText(workbook.name || 'Workbook'), extractedAliases = workbookAliases(sheets), cardAliases = { ...extractedAliases, ...options.cardAliases }, context = { fileName, aliases: aliasesFrom(cardAliases) };
  const warnings = [], masters = sheets.map(s => detailTable(s, context)), curated = sheets.map(s => detailTable(s, context, true)), hasMaster = masters.some(s => s.recognized), hasCurated = curated.some(s => s.recognized);
  let rows, sourceType;
  if (hasMaster || hasCurated) {
    sourceType = 'spending-workbook'; rows = (hasMaster ? masters : curated).flatMap(s => s.rows);
    if (hasMaster && hasCurated) {
      const groups = new Map();
      for (const row of rows.filter(r => !r.error)) { const key = bankFingerprint(row), group = groups.get(key) || []; group.push(row); groups.set(key, group); }
      const used = new Map(); let unmatched = 0;
      for (const detail of curated.flatMap(s => s.rows).filter(r => !r.error)) {
        const key = bankFingerprint(detail), occurrence = used.get(key) || 0, master = groups.get(key)?.[occurrence]; used.set(key, occurrence + 1);
        if (master) {
          for (const field of ['merchant', 'note', 'location', 'placeType', 'usage', 'spendingPurpose', 'category', 'personalCategory', 'categoryProvenance']) if (detail[field] && detail[field] !== 'unspecified') master[field] = detail[field];
          master.detailSource = { sheet: detail.sourceSheet, row: detail.sourceRow };
        } else { rows.push({ ...detail, reviewRequired: true, reason: 'Detail row does not match the statement table; check before importing.' }); unmatched++; }
      }
      if (unmatched) warnings.push(`${unmatched} detail rows need review because they did not match the statement table.`);
    }
    warnings.push('Original currencies and original amounts are used; workbook conversion formulas and summary totals are ignored.');
  } else {
    const parsed = parseGaranti(sheets, context, options); rows = parsed.rows;
    if (!parsed.recognized) throw Error('No supported bank transaction table found. Use a Garanti statement/in-month export or the detailed spending workbook.');
    sourceType = rows.some(r => r.sourceType === 'garanti-statement') ? 'garanti-statement' : 'garanti-in-month';
  }
  const counts = {};
  for (const row of rows) counts[row.error ? 'error' : row.kind] = (counts[row.error ? 'error' : row.kind] || 0) + 1;
  if (counts.pending) warnings.push(`${counts.pending} pending authorizations are shown separately and excluded from spending.`);
  if (counts.error) warnings.push(`${counts.error} rows contain errors and cannot be imported.`);
  const accounts = [...new Map(rows.map(r => [r.accountId, { id: r.accountId, label: r.card, maskedCard: r.maskedCard, alias: r.accountId.startsWith('alias:') ? r.accountId.slice(6) : '' }])).values()].sort((a, b) => a.id.localeCompare(b.id));
  return { sourceType, rows, warnings, metadata: { fileName, fileHash: safeText(workbook.fileHash), sheets: sheets.map(s => s.name), counts, currencies: [...new Set(rows.map(r => r.currency).filter(Boolean))].sort(), accounts, cardAliases: extractedAliases, suggestedCardAliases: extractedAliases } };
}

function unresolvedAccounts(a, b) {
  if (a === b) return a === 'unknown';
  return a === 'unknown' || b === 'unknown' || (a.startsWith('mask:') !== b.startsWith('mask:'));
}

export function planBankImport(parsedFiles, existingExpenseRows = [], options = {}) {
  const files = Array.isArray(parsedFiles) ? parsedFiles : [parsedFiles], savedMappings = deriveBankCardAliases(existingExpenseRows);
  const mappings = Object.assign({}, savedMappings.cardAliases, ...files.map(f => f?.metadata?.cardAliases || {}), options.cardAliases || {}), aliases = aliasesFrom(mappings);
  const fingerprint = row => bankFingerprint(row, { cardAliases: mappings }), weak = row => bankFingerprint(row, { includeAccount: false });
  const existingStrong = new Map(), existingWeak = new Map(), existingPending = new Map(), byId = new Map();
  const isPending = row => (row.bankKind || row.kind) === 'pending';
  for (const existing of existingExpenseRows) {
    if (!existing || existing.perdiem) continue;
    if (existing.id) byId.set(existing.id, existing);
    try {
      const fp = fingerprint(existing), loose = weak(existing), strongList = existingStrong.get(fp) || [], looseList = existingWeak.get(loose) || [];
      // Manual entries have no bank identity; they need a review, not automatic
      // deletion. Tombstones stay in the matching set to prevent resurrection.
      if (isPending(existing)) { const pendingList = existingPending.get(fp) || []; pendingList.push(existing); existingPending.set(fp, pendingList); }
      else if (existing.sourceType || existing.bankImport || existing.transactionKey || existing.bankFingerprint) { strongList.push(existing); existingStrong.set(fp, strongList); }
      looseList.push(existing); existingWeak.set(loose, looseList);
    } catch { /* Unrelated invalid legacy rows cannot establish a duplicate. */ }
  }
  for (const group of existingStrong.values()) group.sort((a, b) => (a.bankOccurrence || 0) - (b.bankOccurrence || 0) || String(a.id).localeCompare(String(b.id)));
  const output = [], importedStrong = new Map(), importedWeak = new Map(), postedCounts = new Map(), enrichedIds = new Set();
  // Prefer the curated workbook when several uploads overlap. Its friendly
  // names/notes survive, while file identity never enters transaction IDs.
  const priority = type => type === 'spending-workbook' ? 0 : type === 'garanti-statement' ? 1 : 2;
  const ordered = files.map((file, index) => ({ file, index })).sort((a, b) => priority(a.file?.sourceType) - priority(b.file?.sourceType) || a.index - b.index);
  const occurrencesByFile = new Map();
  // Review posted movements before authorizations, independent of file order.
  const flattened = ordered.flatMap(({ file, index }) => (file?.rows || []).map(row => ({ input: row, fileIndex: index }))).sort((a, b) => Number(isPending(a.input)) - Number(isPending(b.input)));
  for (const { input, fileIndex } of flattened) {
      const occurrenceGroup = `${fileIndex}|${isPending(input) ? 'pending' : 'posted'}`;
      const occurrences = occurrencesByFile.get(occurrenceGroup) || new Map(); occurrencesByFile.set(occurrenceGroup, occurrences);
      const row = { ...input, accountId: canonicalAccount(input, aliases) };
      if (row.accountId.startsWith('alias:')) row.card = row.accountId.slice(6);
      row.bankCardAliases = Object.fromEntries([...aliases].map(([from, target]) => [from, resolveAlias(target, aliases)]).filter(([from, target]) => row.accountId === `alias:${target}`));
      if (row.error) { output.push({ status: 'error', row, reason: row.error, fileIndex }); continue; }
      if (!row.include && !(options.keepReferenceRows && ['payment', 'transfer', 'financing', 'pending', 'fee'].includes(row.bankKind || row.kind) && row.amountMinor)) { output.push({ status: 'excluded', row, reason: row.reason || 'Not a posted spending transaction.', fileIndex }); continue; }
      let fp, loose;
      try { fp = fingerprint(row); loose = weak(row); } catch (error) { output.push({ status: 'error', row, reason: error.message, fileIndex }); continue; }
      const occurrence = (occurrences.get(fp) || 0) + 1; occurrences.set(fp, occurrence);
      const pending = isPending(row);
      if (pending && row.accountId !== 'unknown' && occurrence <= Math.max(postedCounts.get(fp) || 0, existingStrong.get(fp)?.length || 0)) { output.push({ status: 'excluded', row, occurrence, reason: 'This authorization has a matching posted transaction.', fileIndex }); continue; }
      if (!pending) postedCounts.set(fp, Math.max(postedCounts.get(fp) || 0, occurrence));
      const transactionKey = `${fp}|occurrence:${occurrence}${pending ? '|pending' : ''}`, id = stableId('bank-transaction-v1', transactionKey);
      Object.assign(row, { id, transactionKey, bankFingerprint: fp, bankOccurrence: occurrence, importKey: `bank:${id}` });
      const replacedPending = !pending ? existingPending.get(fp)?.[occurrence - 1] : null;
      const item = { status: 'new', row, id, occurrence, transactionKey, matchingExistingId: '', matchingPendingIds: replacedPending && !replacedPending.deleted ? [replacedPending.id] : [], reason: row.include ? 'New posted transaction.' : pending ? 'Pending authorization; kept outside spending totals.' : 'Bank movement; kept outside spending totals.', fileIndex };
      const stored = byId.get(id) || (pending ? existingPending : existingStrong).get(fp)?.[occurrence - 1], prior = importedStrong.get(transactionKey);
      if (stored) {
        item.status = 'duplicate'; item.matchingExistingId = stored.id; item.reason = stored.deleted ? 'Previously imported and deleted; reimport will not restore it.' : 'Already imported.';
        const enrichment = bankEnrichment(stored, row);
        if (enrichment && !enrichedIds.has(stored.id)) {
          enrichedIds.add(stored.id);
          item.status = 'enrichment'; item.id = stored.id; item.row.id = stored.id;
          item.enrichmentPatch = enrichment.patch; item.enrichmentChanges = enrichment.changes;
          item.expectedUpdatedAt = stored.updated_at;
          item.reason = 'Already imported. The workbook can add untouched details; review these changes before applying.';
        }
      } else if (prior && row.accountId !== 'unknown') {
        item.status = 'duplicate'; item.matchingExistingId = prior.id; item.reason = 'Overlapping upload: this transaction occurrence is already in the preview.';
      } else {
        const candidates = [...(existingWeak.get(loose) || []).filter(x => isPending(x) === pending), ...(importedWeak.get(loose) || []).filter(x => x.fileIndex !== fileIndex && isPending(x.row) === pending)];
        const possible = candidates.find(other => {
          const accountId = canonicalAccount(other.row || other, aliases);
          const isManual = !(other.sourceType || other.bankImport || other.transactionKey || other.bankFingerprint || other.row);
          // Some in-month exports show an instalment-card financing movement
          // under the main-card alias. Keep that account ambiguity reviewable.
          return isManual || unresolvedAccounts(row.accountId, accountId) || (row.bankKind === 'financing' && (other.row || other).bankKind === 'financing');
        });
        if (possible || row.reviewRequired || row.accountId === 'unknown') {
          item.status = 'possible-match'; item.matchingExistingId = possible?.id || ''; item.reason = row.reviewRequired ? row.reason : possible ? 'Same date, amount and merchant with an unconfirmed card or manual record. Review before adding.' : 'The card could not be identified. Review before adding.';
        }
      }
      if (!importedStrong.has(transactionKey)) importedStrong.set(transactionKey, item);
      const weakList = importedWeak.get(loose) || []; weakList.push(item); importedWeak.set(loose, weakList);
      output.push(item);
  }
  return output;
}
