import { planPersonalCategoryChanges } from './personal-categories.js';

// Records and account settings use different storage systems. Always migrate
// records first; never remove category names while their references are pending.
export async function savePersonalCategories(next, { getSaved, readTables, saveBatch, syncRecords, savePreferences, guard, hasConflicts }) {
  guard();
  const before = structuredClone(getSaved());
  // A theme or currency save must not repair or migrate unrelated records.
  if (JSON.stringify(before.expenseCodes) === JSON.stringify(next.expenseCodes)) {
    const result = await savePreferences(next); guard(); return result;
  }
  const checkSettings = () => {
    guard();
    // Preferences are not in the records transaction. Refuse a stale draft
    // before writing records and after awaits, including unrelated field edits.
    if (JSON.stringify(getSaved()) !== JSON.stringify(before)) throw Error('Settings changed on another tab. Reopen Settings before merging.');
  };
  const tables = await readTables(); checkSettings();
  const plan = planPersonalCategoryChanges(before, next, tables);
  const categoryChange = JSON.stringify(before.expenseCodes) !== JSON.stringify(plan.settings.expenseCodes);
  if (!categoryChange && !plan.items.length) {
    const result = await savePreferences(plan.settings); guard(); return result;
  }
  if (await hasConflicts()) throw Error('Resolve the Personal sync conflicts before merging categories. No categories were removed.');
  checkSettings();
  if (plan.items.length > 5000) throw Error('This merge exceeds the account batch limit. No changes were saved.');
  let moved = false;
  try {
    if (plan.items.length) {
      await saveBatch(plan.items, { label: 'Merge Personal categories', expectedExpenses: tables.expenses });
      moved = true; checkSettings();
    }
    const synced = await syncRecords(); guard();
    if (synced.skipped || synced.errors?.length || synced.conflicts?.length || synced.pending) {
      throw Error(synced.errors?.[0] || 'The account sync has not finished.');
    }
    // A sync may bring transactions written by another device. Do not prune
    // definitions until these new references have gone through the same review.
    const latest = await readTables(); checkSettings();
    if (planPersonalCategoryChanges(before, plan.settings, latest).items.length) throw Error('New category references arrived from your account. Save again to include them.');
    const result = await savePreferences(plan.settings); guard();
    return { ...result, settings: result.settings || plan.settings,
      message: `${plan.items.length ? `${plan.items.filter(item => item.table === 'expenses').length} transactions updated. ` : ''}${result.message || 'Categories saved.'}` };
  } catch (error) {
    throw Error(`${moved ? 'Transactions were updated and remain available in History. ' : ''}${error.message} Category settings remain pending; your draft is kept. Save again to finish.`);
  }
}
