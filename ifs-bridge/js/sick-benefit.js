import { el, field } from './dom.js';

export const SGK_SICKNESS_SOURCE = 'https://istanbul.sgk.gov.tr/Content/Post/e33fffdb-16b9-4722-a9c1-2bd0a2a220d1/Hastalik-Hali-2025-02-27-11-27-26';

// Ordinary sickness only. SGK's earnings base is not the hourly wage used by
// IFS Bridge. The first two report days have no ordinary sickness benefit.
export function estimateSicknessBenefit({ reportDays, dailyInsuredEarnings, treatment, eligibilityConfirmed }) {
  if (!Number.isInteger(reportDays) || reportDays < 1 || reportDays > 366) throw Error('Enter 1–366 calendar days in one sickness report period.');
  if (typeof dailyInsuredEarnings !== 'number' || !Number.isFinite(dailyInsuredEarnings) || dailyInsuredEarnings < 0) throw Error('Enter the daily earnings amount used by SGK.');
  if (!['outpatient', 'inpatient'].includes(treatment)) throw Error('Choose one treatment type for this estimate.');
  const eligibleDays = Math.max(0, reportDays - 2), fraction = treatment === 'outpatient' ? 2 / 3 : 1 / 2;
  return { reportDays, waitingDays: Math.min(reportDays, 2), eligibleDays, fraction,
    amount: eligibilityConfirmed === true ? Math.round(eligibleDays * dailyInsuredEarnings * fraction * 100) / 100 : null,
    employerAmount: 0, eligibilityConfirmed: eligibilityConfirmed === true };
}

export function renderSickBenefitTool() {
  const days = el('input', { type: 'number', min: 1, max: 366, step: 1, 'aria-label': 'Sickness report calendar days', placeholder: 'Days, including weekends' });
  const earnings = el('input', { inputmode: 'decimal', 'aria-label': 'SGK daily insured earnings', placeholder: 'TRY per day' });
  const treatment = el('select', { 'aria-label': 'Sickness treatment' }, el('option', { value: 'outpatient' }, 'Outpatient · 2/3'), el('option', { value: 'inpatient' }, 'Inpatient · 1/2'));
  const eligible = el('input', { type: 'checkbox', 'aria-label': 'SGK sickness eligibility confirmed' });
  const status = el('p', { role: 'status', 'aria-live': 'polite', class: 'help' });
  const calculate = () => {
    try {
      const raw = earnings.value.trim();
      if (!/^\d+(?:[.,]\d{1,2})?$/.test(raw)) throw Error('Enter the SGK daily earnings amount, using . or , for decimals.');
      const result = estimateSicknessBenefit({ reportDays: Number(days.value), dailyInsuredEarnings: Number(raw.replace(',', '.')), treatment: treatment.value, eligibilityConfirmed: eligible.checked });
      status.textContent = result.amount == null ? 'Confirm the SGK conditions to calculate an estimate. Employer sick-leave pay remains 0.' :
        result.eligibleDays + ' benefit days after the first ' + result.waitingDays + ' days: approximately ' + new Intl.NumberFormat(undefined, { style: 'currency', currency: 'TRY' }).format(result.amount) + ' from SGK. This is separate from employer pay.';
    } catch (error) { status.textContent = error.message; }
  };
  const root = el('details', { class: 'settings-subdetails' }, el('summary', {}, 'Estimate SGK sickness benefit'),
    el('p', { class: 'help' }, 'Your employer sick-leave pay is 0. For eligible ordinary sickness, SGK benefits start on report day 3. A full leave day in IFS is 9 hours; that does not determine SGK daily earnings.'),
    el('div', { class: 'grid2' }, field('Report calendar days', days), field('SGK daily earnings · TRY', earnings, 'Use the earnings base confirmed by SGK/payroll, not hourly pay × 9.')),
    field('Treatment throughout this report period', treatment),
    el('label', { class: 'settings-inline-check' }, eligible, 'I have confirmed SGK eligibility: insured at the start, an authorized medical report, and at least 90 short-term premium days in the preceding year.'),
    el('button', { type: 'button', onclick: calculate }, 'Calculate estimate'), status,
    el('p', { class: 'help' }, 'For mixed treatment, continuation reports or a work accident, use the SGK assessment. This calculator does not save health details or add an amount to your wage total.'),
    el('a', { href: SGK_SICKNESS_SOURCE, target: '_blank', rel: 'noopener noreferrer' }, 'SGK: ordinary sickness benefit rules'));
  return root;
}
