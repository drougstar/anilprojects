import { TIME_CODE_CATALOG, effectiveTimeCodeMappings, timeCodeInfo } from './time-codes.js';

// One pay policy per IFS time type. Tags only select a type; they never own pay.
export const DEFAULT_WORK_POLICY = Object.freeze({ weekdayMinimumHours: 9, fullDayHours: 9, overtimeAfterHours: 9, sundayPaidHours: 7.5, sundayPayMode: 'plus-work', sickEmployerPay: 'none', holidayPaidHours: null });
const leaveDefaults = { F_04: 1, F_05: 0, F_06: 0, F_07: 1, F_08: 1 };
const validMultiplier = value => value === null || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10);
export function normalizeWorkSettings(settings = {}) {
  const s = structuredClone(settings), migrating = s.workPolicyVersion !== 1;
  const warnings = Array.isArray(s.workPolicyMigrationWarnings) ? [...s.workPolicyMigrationWarnings] : [];
  s.workPolicy = { ...DEFAULT_WORK_POLICY, ...(s.workPolicy || {}) };
  const mappings = effectiveTimeCodeMappings(s);
  s.timeTypes = TIME_CODE_CATALOG.map(info => {
    const existing = (Array.isArray(s.timeTypes) ? s.timeTypes : []).find(row => row?.code === info.code);
    let multiplier = Object.hasOwn(leaveDefaults, info.code) ? leaveDefaults[info.code] : info.payMultiplier;
    if (existing && Object.hasOwn(existing, 'payMultiplier')) multiplier = existing.payMultiplier;
    else if (migrating) {
      const values = [...new Set(mappings.filter(row => row?.mode === 'code' && row.code === info.code && row.payMultiplier != null).map(row => row.payMultiplier))];
      if (values.length === 1 && validMultiplier(values[0])) multiplier = values[0];
      else if (values.length) { multiplier = null; warnings.push(`${info.code}: previous tags had conflicting or invalid pay multipliers. Confirm pay on the time type.`); }
    }
    let description = existing?.description || s.codeDescriptions?.[info.code] || '';
    if (migrating) {
      const descriptions = [...new Set(mappings.filter(row => row?.mode === 'code' && row.code === info.code && typeof row.description === 'string' && row.description.trim()).map(row => row.description.trim()))];
      if (!description && descriptions.length === 1) description = descriptions[0];
      else if (descriptions.length && (descriptions.length > 1 || descriptions[0] !== description)) warnings.push(`${info.code}: review previous tag descriptions (${descriptions.slice(0, 3).map(value => value.length > 140 ? value.slice(0, 140) + '…' : value).join(' | ')}${descriptions.length > 3 ? ` | +${descriptions.length - 3} more` : ''}). ${description ? 'The stored IFS description was kept.' : 'The documented IFS description is used until you choose one.'} Previous tag values remain in your settings.`);
    }
    return { code: info.code, description: description || info.description, payMultiplier: multiplier };
  });
  s.timeCodeMappings = mappings.map(({ payMultiplier, ...row }) => row);
  s.timeCodeMappingsVersion = 2;
  s.workPolicyVersion = 1;
  s.workPolicyMigrationWarnings = [...new Set(warnings)];
  return s;
}
export function typePolicy(settings, code) {
  const info = timeCodeInfo(code);
  if (!info) return null;
  const row = (settings.timeTypes || []).find(type => type?.code === code);
  const fallback = Object.hasOwn(leaveDefaults, code) ? leaveDefaults[code] : info.payMultiplier;
  return { ...info, ...row, payMultiplier: row && Object.hasOwn(row, 'payMultiplier') ? row.payMultiplier : fallback };
}
export function validateWorkPolicy(settings) {
  const errors = [], p = settings.workPolicy || {};
  for (const key of ['weekdayMinimumHours', 'fullDayHours', 'overtimeAfterHours', 'sundayPaidHours']) if (typeof p[key] !== 'number' || !Number.isFinite(p[key]) || p[key] < 0 || p[key] > 24 || (['fullDayHours', 'overtimeAfterHours'].includes(key) && p[key] === 0)) errors.push(`${key}: enter valid hours from ${['fullDayHours', 'overtimeAfterHours'].includes(key) ? 'above 0' : '0'} to 24.`);
  if (p.holidayPaidHours !== null && (typeof p.holidayPaidHours !== 'number' || !Number.isFinite(p.holidayPaidHours) || p.holidayPaidHours < 0 || p.holidayPaidHours > 24)) errors.push('Public-holiday pay hours must be blank or between 0 and 24.');
  if (!['unconfirmed', 'plus-work', 'work-only'].includes(p.sundayPayMode)) errors.push('Choose how Sunday base pay combines with worked hours.');
  if (!['unconfirmed', 'normal', 'none'].includes(p.sickEmployerPay)) errors.push('Choose the employer sick-leave pay treatment.');
  const types = settings.timeTypes || [];
  for (const info of TIME_CODE_CATALOG) {
    const matches = types.filter(row => row?.code === info.code);
    if (matches.length !== 1) errors.push(`${info.code}: keep exactly one time-type definition.`);
    else if (!validMultiplier(matches[0].payMultiplier)) errors.push(`${info.code}: multiplier must be blank or a number from 0 to 10.`);
  }
  for (const row of types) if (!timeCodeInfo(row?.code)) errors.push(`Unsupported time type: ${row?.code || 'missing code'}.`);
  return errors;
}
