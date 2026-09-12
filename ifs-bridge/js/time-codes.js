// Confirmed code availability from the owner's IFS screenshots. These describe
// IFS codes, never infer a Clockify tag's meaning or an employee's leave pay.
export const TIME_CODE_CATALOG = Object.freeze([
  ['F_01', 'Travel Regular Time', 'work', 1],
  ['F_02', 'Over Time (OT) x 1.5', 'work', 1.5],
  ['F_03', 'Regular Time (Normal Calisma)', 'work', 1],
  ['F_04', 'Ücretli İzin', 'general-only', null],
  ['F_05', 'Ücretsiz İzin', 'general-only', null],
  ['F_06', 'Raporlu', 'general-only', null],
  ['F_07', 'Resmi Tatil', 'general-only', null],
  ['F_08', 'Yıllık İzin', 'general-only', null],
  ['F_10', 'Over Time (OT) x 2', 'work', 2],
  ['F_11', 'Over Time (ST) x 1', 'work', 1],
  ['F_12', 'Travel Over Time (ST) x 1', 'work', 1],
].map(([code, label, scope, payMultiplier]) => Object.freeze({ code, label, description: `${code} / ${label}`, scope, payMultiplier })));

export const NORMAL_TIME_CODES = Object.freeze(TIME_CODE_CATALOG.filter(item => item.scope === 'work').map(item => item.code));
export const GENERAL_ONLY_TIME_CODES = Object.freeze(TIME_CODE_CATALOG.filter(item => item.scope === 'general-only').map(item => item.code));
export const timeCodeInfo = code => TIME_CODE_CATALOG.find(item => item.code === code) || null;
export const calculationMode = settings => settings.timeCalculationMode === 'tags' ? 'tags' : 'rules';

/** Read compatibility for pre-unified settings; never mutate the saved setup. */
export function effectiveTimeCodeMappings(settings) {
  const explicit = Array.isArray(settings.timeCodeMappings) ? structuredClone(settings.timeCodeMappings) : [];
  for (const row of explicit) if (row?.mode === 'code' && !timeCodeInfo(row.code)) { row.confirmed = false; row.mode = 'review'; }
  if (settings.timeCodeMappingsVersion === 2) return explicit;
  const legacy = new Map();
  for (const [tagKey, codeKey, fallback] of [['x15', 'ot15', 'F_02'], ['x2', 'ot2', 'F_10'], ['travel', 'travelRegular', 'F_01'], ['travelOT', 'travel', 'F_12']]) {
    const tagName = String(settings.tags?.[tagKey] || '').trim();
    if (!tagName) continue;
    const code = settings.codes?.[codeKey] ?? fallback;
    if (!legacy.has(tagName)) legacy.set(tagName, new Set());
    legacy.get(tagName).add(code);
  }
  for (const [tagName, codes] of legacy) {
    const matches = explicit.filter(row => row && row.tagName === tagName);
    const code = [...codes][0];
    if (matches.length) {
      // Preserve the owner's explicit record. Inconsistent old assignments need
      // review; migration must never replace or confirm a different meaning.
      for (const row of matches) if (codes.size !== 1 || row.mode !== 'code' || row.code !== code) { row.confirmed = false; row.mode = 'review'; }
    } else {
      const valid = codes.size === 1 && !!timeCodeInfo(code);
      explicit.push({ tagId: '', tagName, mode: valid ? 'code' : 'review', code, description: settings.codeDescriptions?.[code] || timeCodeInfo(code)?.description || '', confirmed: valid, payMultiplier: timeCodeInfo(code)?.payMultiplier ?? null });
    }
  }
  return explicit;
}

/** A General destination must identify the actual activity, including its seq. */
export function completeGeneralActivity(mapping) {
  if (mapping?.kind !== 'general') return false;
  const values = ['projectId', 'subProjectId', 'activityNo', 'activitySeq', 'shortName'].map(key => String(mapping[key] ?? '').trim());
  if (values.some(value => !value)) return false;
  return values[4] === `${values[0]}.${values[1]}.${values[2]}`;
}
