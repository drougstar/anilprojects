// Local, review-only category suggestions. Nothing is sent to an AI service,
// written to storage, or applied to the import draft by this module.
const clean = value => String(value ?? '').trim().replace(/\s+/g, ' ');
const norm = value => clean(value).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('en-US').replace(/ı/g, 'i').replace(/[^a-z0-9]+/g, ' ').trim();
const categoryOf = row => clean(row.personalCategory || row.category) || 'Uncategorized';
const merchantOf = row => clean(row.merchant || row.vendor || row.bankDescription || row.originalDescription || row.originalStatementText) || 'Unknown merchant';
// Keep numbers and the full original descriptor: stripping transaction-looking
// text could incorrectly learn one shop's correction for another shop.
const identityOf = row => norm(row.originalStatementText || row.originalDescription || row.bankDescription || row.merchant || row.vendor);
const currencyOf = row => clean(row.currency).toUpperCase();
const kindOf = row => clean(row.bankKind || row.kind || (Number(row.amount) < 0 ? 'refund' : 'purchase'));
const unassigned = value => !value || ['uncategorized', 'unassigned', 'unknown', 'other', 'diger', 'siniflandirilmamis'].includes(norm(value));
const installment = row => !!row.installment || /\b(?:taksit|installments?|\d+\s*\/\s*\d+\s*taksit)\b/i.test([row.bankDescription, row.originalDescription, row.originalStatementText, row.merchant].join(' '));
const reference = row => row.excludeFromSpending === true || row.include === false || !['purchase', 'refund', 'fee'].includes(kindOf(row));
const own = row => !row.deleted && row.sourceWorkspace !== 'work' && !row.ledgerReadOnly;
const positivePurchase = row => own(row) && !reference(row) && kindOf(row) === 'purchase' && Number(row.amount) > 0 && !installment(row);
const protectedCategory = item => {
  const row = item.row;
  return item.categoryOverride !== undefined || row.categoryOverride !== undefined ||
    (row.bankReviewFields || []).some(field => ['personalCategory', 'category'].includes(field)) ||
    ['workbook category', 'user correction', 'user choice', 'manual'].includes(norm(row.categoryProvenance));
};
const explicitCorrection = row => {
  const category = categoryOf(row);
  if (!own(row) || reference(row) || unassigned(category)) return false;
  if (norm(row.categoryProvenance) === 'user correction') return true;
  // Older Save actions marked all fields reviewed, even if only Note changed.
  return (row.bankReviewFields || []).includes('personalCategory') &&
    !!clean(row.bankCategory) && norm(category) !== norm(row.bankCategory);
};
const knownService = identity => /^(?:netflix(?: com)?|spotify(?: ab| premium)?|youtube premium|google youtube premium|openai chatgpt(?: subscription)?|chatgpt(?: plus| pro)|microsoft 365|office 365|adobe creative cloud|amazon prime(?: video)?|disney plus|disneyplus(?: com)?)$/.test(identity);
// Marketplaces and ordinary shopping are not subscription evidence merely
// because a shopper returns every month. Narrow service descriptors above win.
const ambiguousSeller = identity => /\b(?:apple|itunes|amazon|amzn|microsoft|adobe|google|youtube|paypal|iyzico|paytr|market|supermarket|migros|carrefour|walmart|aldi|lidl|bim|a101|sok|trendyol|hepsiburada|restaurant|restoran|cafe|coffee|starbucks|shell|petrol|fuel|grocery|groceries|shopping|store|shop)\b/.test(identity);
function calendar(row) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(clean(row.date));
  if (!match) return null;
  const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > lastDay) return null;
  return { month: year * 12 + month - 1, day, lastDay };
}
function monthlyEvidence(rows, incoming) {
  const account = clean(incoming.accountId || incoming.card || incoming.cardName);
  const relevant = rows.filter(row => positivePurchase(row) && clean(row.accountId || row.card || row.cardName) === account);
  const unique = new Map();
  for (const row of relevant) {
    const date = calendar(row), amount = Number(row.amount);
    if (!date || !Number.isFinite(amount)) continue;
    const key = clean(row.id) || [row.date, amount, identityOf(row), account].join('|');
    unique.set(key, { ...date, amount });
  }
  const months = new Map();
  for (const entry of unique.values()) {
    const month = months.get(entry.month) || []; month.push(entry); months.set(entry.month, month);
  }
  const target = calendar(incoming); if (!target) return false;
  // Require a series containing this import's month, not a retired subscription
  // elsewhere in the history. Multiple purchases in a month make it ambiguous.
  for (let start = target.month - 2; start <= target.month; start++) {
    const series = [start, start + 1, start + 2].map(month => months.get(month));
    if (series.some(entries => entries?.length !== 1)) continue;
    const charges = series.flat(), amounts = charges.map(entry => entry.amount);
    const days = charges.map(entry => entry.day);
    const nearDate = Math.max(...days) - Math.min(...days) <= 3 || charges.every(entry => entry.lastDay - entry.day <= 2);
    if (nearDate && Math.max(...amounts) - Math.min(...amounts) <= Math.max(0.01, Math.min(...amounts) * 0.02)) return true;
  }
  return false;
}

/**
 * Returns review groups, not mutations. category==='' means manual choice is
 * needed. itemIds refer only to incoming new/possible-match rows. Workbook and
 * manual categories, duplicate/enrichment rows, and reference movements are kept.
 */
export function suggestImportCategories(plan, existingRows = []) {
  if (!Array.isArray(plan) || !Array.isArray(existingRows)) throw Error('Expected an import plan and saved Personal records.');
  const groups = new Map(), corrections = new Map(), evidence = new Map();
  const addEvidence = row => {
    if (!row || !own(row) || !identityOf(row)) return;
    const key = JSON.stringify([identityOf(row), currencyOf(row)]);
    const list = evidence.get(key) || []; list.push(row); evidence.set(key, list);
  };
  for (const row of existingRows) {
    if (!row || typeof row !== 'object') continue;
    addEvidence(row);
    if (!explicitCorrection(row)) continue;
    const identity = identityOf(row); if (!identity) continue;
    const categories = corrections.get(identity) || new Map(), category = categoryOf(row), key = norm(category);
    const choice = categories.get(key) || { category, ids: new Set(), trusted: false };
    choice.trusted ||= norm(row.categoryProvenance) === 'user correction';
    choice.ids.add(clean(row.id) || JSON.stringify([row.date, row.amount, currencyOf(row), identity])); categories.set(key, choice); corrections.set(identity, categories);
  }
  for (const item of plan) {
    if (!item?.row || !['new', 'possible-match'].includes(item.status) || !clean(item.id)) continue;
    const row = item.row;
    addEvidence({ ...row, id: item.id });
    if (!own(row) || reference(row) || protectedCategory(item)) continue;
    const identity = identityOf(row), currency = currencyOf(row), currentCategory = categoryOf(row);
    const key = JSON.stringify([identity, currency, norm(currentCategory)]);
    const group = groups.get(key) || { id: `import-category:${encodeURIComponent(key)}`, merchant: merchantOf(row), currency, currentCategory, itemIds: [], category: '', reason: '', source: 'unassigned', confidence: 'low', rows: [], identity };
    if (!group.itemIds.includes(item.id)) { group.itemIds.push(item.id); group.rows.push(row); }
    groups.set(key, group);
  }
  return [...groups.values()].map(({ rows, identity, ...group }) => {
    const history = corrections.get(identity), choices = [...(history?.values() || [])];
    const purchases = rows.filter(positivePurchase);
    if (choices.length > 1) return { ...group, source: 'ambiguous', reason: 'Your previous category corrections disagree for this merchant. Choose the category for these transactions.' };
    if (choices.length === 1 && (choices[0].trusted || choices[0].ids.size >= 2) && purchases.length) {
      const category = choices[0].category;
      if (norm(category) !== 'subscriptions' || rows.every(row => !installment(row))) return { ...group, category, source: 'user-history', confidence: 'high', reason: `You explicitly used “${category}” for this original merchant in ${choices[0].ids.size} saved transaction${choices[0].ids.size === 1 ? '' : 's'}.` };
    }
    if (!purchases.length) return { ...group, reason: 'Refunds and charges without a posted purchase do not establish a subscription. Choose a category if needed.' };
    if (choices.length) return { ...group, source: 'ambiguous', reason: 'There is only one usable previous category correction, or the transactions include instalments. Confirm a category for this group.' };
    if (knownService(identity) && rows.every(row => !installment(row))) return { ...group, category: 'Subscriptions', source: 'known-service', confidence: 'high', reason: 'The original merchant description names a subscription service. Review before applying; this does not prove a recurring contract.' };
    if (ambiguousSeller(identity)) return { ...group, source: 'ambiguous', reason: 'This merchant can sell one-off purchases or several different services. Its bank label or repeated charges do not identify a subscription.' };
    const historyRows = evidence.get(JSON.stringify([identity, group.currency])) || [];
    if (purchases.some(row => monthlyEvidence(historyRows, row))) return { ...group, category: 'Subscriptions', source: 'monthly-pattern', confidence: 'medium', reason: 'A purchase appears in at least three consecutive months on the same card, near the same date and amount. It may be recurring; confirm whether it is a subscription.' };
    return { ...group, reason: identity ? 'There is not enough reliable merchant or correction history. Choose a category; the bank label is only a starting point.' : 'The original merchant description is missing. Choose a category for these transactions.' };
  });
}
