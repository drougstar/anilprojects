// AI sees a small merchant summary, never the workbook or saved account records.
// This module returns proposals only. The import preview owns confirmation.
export const AI_CATEGORIES = ['Subscriptions', 'Groceries', 'Dining', 'Transport', 'Travel', 'Shopping', 'Housing', 'Utilities', 'Health', 'Education', 'Entertainment', 'Insurance', 'Bank charges', 'Gifts', 'Other'];
const clean = (value, limit) => String(value || '').replace(/[\u0000-\u001f]/g, ' ').replace(/\b[A-Z]{2}\d{2}[A-Z0-9 ]{12,32}\b/g, '[account]').replace(/\b\d[\d -]{7,}\d\b/g, '[number]').replace(/\S+@\S+\.\S+/g, '[email]').replace(/\s+/g, ' ').trim().slice(0, limit);

export function buildCategoryRequest(groups, plan) {
  if (!Array.isArray(groups) || !Array.isArray(plan) || groups.length > 200) throw Error('Choose up to 200 merchant groups for one AI review.');
  const records = new Map(plan.filter(item => ['new', 'possible-match'].includes(item.status)).map(item => [item.id, item.row]));
  const links = new Map();
  const request = groups.filter(group => group.source !== 'user-history').map((group, index) => {
    const rows = group.itemIds.map(id => records.get(id)).filter(row => row && !row.bankReviewFields?.includes('personalCategory'));
    const id = 'g' + index, merchant = clean(group.merchant, 180);
    if (!rows.length || !merchant || !/^[A-Z]{3}$/.test(group.currency)) return null;
    links.set(id, group.id);
    return { id, merchant, currency: group.currency,
      amounts: [...new Set(rows.map(row => Number(row.amount)).filter(amount => Number.isFinite(amount) && Math.abs(amount) <= 1e9))].slice(0, 3),
      count: Math.min(rows.length, 10000), bankCategory: clean(group.currentCategory, 80), monthlyPattern: group.source === 'monthly-pattern' };
  }).filter(Boolean);
  return { groups: request, links };
}

export function readCategorySuggestions(data, request) {
  if (!data || !Array.isArray(data.suggestions) || data.suggestions.length > request.groups.length) throw Error('AI returned an incomplete category review. Your import is unchanged.');
  const seen = new Set();
  return data.suggestions.map(row => {
    if (!row || !request.links.has(row.id) || seen.has(row.id) || !['', ...AI_CATEGORIES].includes(row.category) || !['high', 'medium', 'low'].includes(row.confidence) || typeof row.reason !== 'string' || row.reason.length > 240) throw Error('AI returned an invalid category review. Your import is unchanged.');
    seen.add(row.id);
    return { id: request.links.get(row.id), category: row.category, reason: row.reason, confidence: row.confidence, source: 'ai' };
  });
}

export async function requestImportCategorySuggestions(client, groups, plan, { signal, isCurrent = () => true, fetcher = fetch } = {}) {
  if (!client?.configured || !client?.signedIn) throw Error('Sign in to use AI suggestions.');
  const guard = () => {
    if (signal?.aborted || !isCurrent()) throw Error('This import was closed or the account changed.');
    client.assertScope();
    if (client.scope?.workspace !== 'personal') throw Error('AI import suggestions are available in Personal.');
  };
  guard();
  const url = new URL(client.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/') throw Error('AI needs a secure Supabase connection.');
  const request = buildCategoryRequest(groups, plan), result = [];
  // One click handles a normal multi-file import in small, bounded requests.
  // There are no automatic retries, background calls or record writes.
  for (let offset = 0; offset < request.groups.length; offset += 40) {
    const batch = { groups: request.groups.slice(offset, offset + 40), links: request.links };
    guard();
    const headers = await client.headers({ 'Content-Type': 'application/json' }); guard();
    const aborter = new AbortController(), cancel = () => aborter.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 45000);
    try {
      const response = await fetcher(url.origin + '/functions/v1/ifsbridge-categorize', { method: 'POST', headers, body: JSON.stringify({ groups: batch.groups }), signal: aborter.signal, redirect: 'error' });
      guard();
      if (!response.ok) {
        if ([404, 503].includes(response.status)) throw Error('AI needs its one-time server setup. You can still use the local suggestions and import normally.');
        if ([401, 403].includes(response.status)) throw Error('AI access is not enabled for this account, or your authenticator session needs renewal.');
        if (response.status === 429) throw Error('AI usage is temporarily limited. Try later or use the local suggestions.');
        throw Error('AI could not finish this review. Your import is unchanged; try again or use the local suggestions.');
      }
      const body = await response.text(); guard();
      if (body.length > 64000) throw Error('AI returned too much data. Your import is unchanged.');
      result.push(...readCategorySuggestions(JSON.parse(body), { ...batch, links: new Map(batch.groups.map(group => [group.id, request.links.get(group.id)])) }));
    } catch (error) {
      if (error.name === 'AbortError') throw Error('AI took too long or the import was closed. Your import is unchanged.');
      if (error instanceof TypeError || error instanceof SyntaxError) throw Error('AI is unavailable. You can still use the local suggestions and import normally.');
      throw error;
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
  guard(); return result;
}
