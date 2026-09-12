import { currentScope, scopeIsCurrent } from './scope.js';
import { attentionPanel } from './workspace-ui.js';
// Overview tab: business vs personal vs per diem by month, by type, by trip; sheets and weeks status.
import { live, db } from './db.js';
import { totalsByCurrency, fmtMoney } from './expense-ifs.js';
import { el, $, download, toast } from './dom.js';
import { Clockify } from './clockify.js';
import { buildWeek, fetchWindow, mondayOf } from './rules.js';
import { effectiveTimeCodeMappings, calculationMode, timeCodeInfo } from './time-codes.js';

let ctx = null;
let renderId = 0;
const state = { month: '' };

// ---------- working hours per month (Clockify, through the same rules as the Week tab) ----------
function monthDays(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${ym}-01`, last: `${ym}-${String(last).padStart(2, '0')}` };
}
const shift = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

function hoursRulesKey(s) {
  const keys = ['timeZone', 'regularHours', 'travelAfterHours', 'topUpMinimum', 'roundStep', 'roundMode', 'holidays', 'travelKeyword', 'codes', 'mapping'];
  // v3 distinguishes actual Work tag hours from General-only codes and records
  // the effective unified mapping, including legacy settings only when in use.
  return JSON.stringify([3, calculationMode(s), s.timeCodeMappingsVersion ?? null,
    s.clockify?.workspaceId || '', s.clockify?.userId || '', effectiveTimeCodeMappings(s),
    ...(s.timeCodeMappingsVersion === 2 ? [] : [s.tags ?? null]), ...keys.map(key => s[key] ?? null)]);
}
const hoursCurrent = (rec, s) => rec?.version === 3 && rec.rulesKey === hoursRulesKey(s);
const roundHours = value => Math.round(value * 100) / 100;
const timeKindOf = row => row.timeKind || timeCodeInfo(row.code)?.scope || 'general-only';
const multiplierOf = row => row.payMultiplier ?? timeCodeInfo(row.code)?.payMultiplier ?? null;
function workHoursByCode(rec) {
  if (rec.workByCode) return rec.workByCode;
  const totals = { ...(rec.ordinaryByCode || rec.byCode || {}) };
  for (const row of rec.directRows || []) if (timeKindOf(row) === 'work') totals[row.code] = roundHours((totals[row.code] || 0) + row.hours);
  return totals;
}
const codeHours = (totals, codes) => roundHours([...new Set(codes.filter(Boolean))].reduce((sum, code) => sum + (totals[code] || 0), 0));
function workBreakdown(rec, s) {
  const totals = workHoursByCode(rec), codes = s.codes || {};
  return { totals, regular: codeHours(totals, [codes.regular, 'F_03']),
    overtime: codeHours(totals, [codes.ot15, codes.ot2, 'F_02', 'F_10', 'F_11']),
    travel: codeHours(totals, [codes.travelRegular, codes.travel, 'F_01', 'F_12']) };
}
async function fetchMonthHours(ym) {
  const s = ctx.settings();
  if (!s.clockify.apiKey) throw new Error('Add the Clockify API key in Settings to load hours on this device.');
  const c = new Clockify(s.clockify.apiKey);
  if (!s.clockify.userId) { const u = await c.user(); s.clockify.userId = u.id; s.clockify.workspaceId = u.activeWorkspace; ctx.saveSettings(s); }
  const { first, last } = monthDays(ym);
  const rulesKey = hoursRulesKey(s);
  const checkCurrent = () => { if (!scopeIsCurrent() || rulesKey !== hoursRulesKey(ctx.settings())) throw new Error('Settings or account changed. Load the month again.'); };
  const byCode = {}, ordinaryByCode = {}, directByKey = new Map(), byActivity = {}, byDay = {};
  for (let monday = mondayOf(first); monday <= last; monday = shift(monday, 7)) {
    const win = fetchWindow(monday, s.timeZone);
    const entries = await c.entries(s.clockify.workspaceId, s.clockify.userId, win.start, win.end);
    checkCurrent();
    const w = buildWeek(entries, monday, s, s.mapping);
    const errors = w.warnings.filter(warning => warning.level === 'error');
    if (errors.length) throw new Error(`Review time settings before estimating pay: ${errors[0].text}`);
    for (const r of w.rows) r.hours.forEach((h, i) => {
      const d = w.dates[i];
      if (h > 0 && d >= first && d <= last) {
        byCode[r.code] = Math.round(((byCode[r.code] || 0) + h) * 100) / 100;
        if (r.directCode) {
          const timeKind = timeKindOf(r), payMultiplier = multiplierOf(r);
          const key = `${r.code}|${timeKind}|${payMultiplier ?? 'unknown'}`;
          const direct = directByKey.get(key) || { code: r.code, description: r.description || '', timeKind, payMultiplier, hours: 0 };
          direct.hours = Math.round((direct.hours + h) * 100) / 100; directByKey.set(key, direct);
        } else ordinaryByCode[r.code] = Math.round(((ordinaryByCode[r.code] || 0) + h) * 100) / 100;
        const a = r.mapping.shortName || r.mapping.clockifyProjectName;
        byActivity[a] = Math.round(((byActivity[a] || 0) + h) * 100) / 100;
        const day = byDay[d] || (byDay[d] = { regular: 0, total: 0, direct: 0, weekday: i < 5 });
        day.total = Math.round((day.total + h) * 100) / 100;
        if (r.directCode) day.direct = Math.round((day.direct + h) * 100) / 100;
        else if (r.code === s.codes.regular) day.regular = Math.round((day.regular + h) * 100) / 100;
      }
    });
  }
  const total = Math.round(Object.values(byCode).reduce((a, b) => a + b, 0) * 100) / 100;
  checkCurrent();
  const rec = { version: 3, rulesKey, month: ym, fetchedAt: new Date().toISOString(), byCode, ordinaryByCode, directRows: [...directByKey.values()], byActivity, byDay, total, days: Object.keys(byDay).length };
  rec.workByCode = workHoursByCode(rec);
  await db.setMeta(`hours.${ym}`, rec);
  return rec;
}

// Paid rest days of a month: every Sunday, plus the public holidays listed in Settings that fall
// on a weekday. Turkish payroll counts them at 45 h / 6 = 7.5 h each (editable).
function restDays(ym, s, byDay = {}) {
  const { first, last } = monthDays(ym);
  let sundays = 0, holidays = 0, excluded = 0;
  for (let d = first; d <= last; d = shift(d, 1)) {
    const dow = new Date(d + 'T00:00:00Z').getUTCDay();
    if (byDay[d]?.direct > 0 && (dow === 0 || (dow !== 6 && (s.holidays || []).includes(d)))) { excluded++; continue; }
    if (dow === 0) sundays++;
    else if (dow !== 6 && (s.holidays || []).includes(d)) holidays++;
  }
  const perDay = Number(s.restDayHours ?? 7.5) || 0;
  return { sundays, holidays, excluded, hours: s.restDaysPaid === false ? 0 : Math.round((sundays + holidays) * perDay * 100) / 100, perDay };
}

function payFor(rec, s) {
  const rate = Number(s.payRate) || 0, tagMode = calculationMode(s) === 'tags';
  const codes = s.codes || {};
  const mult = { [codes.regular]: 1, [codes.ot15]: 1.5, [codes.ot2]: 2, [codes.travelRegular]: 1, [codes.travel]: 1 };
  const ordinary = rec.ordinaryByCode || rec.byCode || {};
  const rows = Object.entries(ordinary).sort().map(([code, h]) => {
    const multiplier = mult[code] ?? timeCodeInfo(code)?.payMultiplier ?? null;
    return { code, desc: s.codeDescriptions?.[code] || '', hours: h, mult: multiplier, timeKind: 'work', amount: multiplier == null ? null : roundHours(h * rate * multiplier) };
  });
  for (const direct of rec.directRows || []) {
    const multiplier = multiplierOf(direct), timeKind = timeKindOf(direct);
    rows.push({ code: direct.code, desc: direct.description || s.codeDescriptions?.[direct.code] || (timeKind === 'work' ? 'Confirmed work tag' : 'Confirmed General time code'),
      hours: direct.hours, mult: multiplier, timeKind, directCode: true, amount: multiplier == null ? null : roundHours(direct.hours * rate * multiplier) });
  }
  // Rule mode keeps the existing pay additions. Tag mode pays only recorded time.
  const minDay = Number(s.payMinDay ?? 9) || 0;
  let topUp = 0, topUpDays = 0;
  if (!tagMode) for (const day of Object.values(rec.byDay || {})) if (!day.direct && day.weekday && day.regular > 0 && day.regular < minDay) { topUp += minDay - day.regular; topUpDays++; }
  topUp = roundHours(topUp);
  if (topUp > 0) rows.push({ code: 'Min', desc: `Day minimum ${minDay} h: ${topUpDays} day${topUpDays === 1 ? '' : 's'} topped up`, hours: topUp, mult: 1, amount: roundHours(topUp * rate) });
  const rest = tagMode ? { sundays: 0, holidays: 0, excluded: 0, hours: 0, perDay: 0 } : restDays(rec.month, s, rec.byDay);
  if (rest.hours > 0) rows.push({ code: 'Rest', desc: `Paid rest days: ${rest.sundays} Sunday${rest.sundays === 1 ? '' : 's'}${rest.holidays ? ` + ${rest.holidays} holiday${rest.holidays === 1 ? '' : 's'}` : ''} × ${rest.perDay} h`, hours: rest.hours, mult: 1, amount: roundHours(rest.hours * rate) });
  const workByCode = workHoursByCode(rec);
  const worked = roundHours(Object.values(workByCode).reduce((a, b) => a + b, 0));
  const directHours = roundHours((rec.directRows || []).reduce((sum, row) => sum + row.hours, 0));
  const generalHours = roundHours((rec.directRows || []).filter(row => timeKindOf(row) !== 'work').reduce((sum, row) => sum + row.hours, 0));
  const unknownHours = roundHours(rows.filter(row => row.amount === null).reduce((sum, row) => sum + row.hours, 0));
  const paidHours = roundHours(rows.filter(row => row.mult > 0).reduce((sum, row) => sum + row.hours, 0));
  return { rows, rest, topUp, topUpDays, worked, directHours, generalHours, recordedHours: roundHours(worked + generalHours), workByCode,
    unknownHours, partial: unknownHours > 0, paidHours, amount: roundHours(rows.reduce((a, r) => a + (r.amount ?? 0), 0)), needsReload: !hoursCurrent(rec, s) };
}
async function renderHours(root, ym, allMonths) {
  const s = ctx.settings(), tagMode = calculationMode(s) === 'tags';
  const host = el('section', { class: 'ov-section' });
  root.append(host);
  const body = el('div');
  const status = el('span', { class: 'help status' });
  const paint = async () => {
    body.replaceChildren();
    const months = ym ? [ym] : allMonths, recs = [];
    let outdated = 0;
    for (const m of months) { const r = await db.meta(`hours.${m}`); if (r && hoursCurrent(r, s)) recs.push(r); else if (r) outdated++; }
    if (ym) {
      const rec = recs[0];
      if (!rec) { body.append(el('p', { class: 'muted' }, outdated ? 'Time settings changed. Load hours again with the current calculation mode and tag mappings.' : 'Not loaded yet for this month.')); return; }
      const pay = payFor(rec, s), work = workBreakdown(rec, s);
      body.append(
        el('div', { class: 'ov-cards' },
          card('Worked', `${pay.worked} h`, `${rec.days} day${rec.days === 1 ? '' : 's'} with entries · regular ${work.regular} h`),
          pay.generalHours ? card('General time', `${pay.generalHours} h`, pay.partial ? `${pay.unknownHours} h have no confirmed pay multiplier` : 'General-only codes, separate from work') : null,
          card('Overtime', `${work.overtime} h`, 'Includes recorded overtime at ×1, ×1.5 and ×2'),
          card('Travel', `${work.travel} h`, 'Recorded travel codes'),
          tagMode ? null : card('Day minimum', `${pay.topUp} h`, pay.topUp ? `${pay.topUpDays} day${pay.topUpDays === 1 ? '' : 's'} below ${s.payMinDay ?? 9} h topped up` : 'No addition; direct-code days are excluded'),
          tagMode ? null : card('Rest days', `${pay.rest.hours} h`, pay.rest.hours ? `${pay.rest.sundays} Sunday${pay.rest.sundays === 1 ? '' : 's'}${pay.rest.holidays ? ` + ${pay.rest.holidays} holiday${pay.rest.holidays === 1 ? '' : 's'}` : ''} × ${pay.rest.perDay} h, paid` : 'not counted'),
          card(pay.partial ? 'Known paid hours' : 'Paid hours', `${pay.paidHours} h`, pay.partial ? `Excludes ${pay.unknownHours} h with unknown pay` : 'Hours with a confirmed positive multiplier'),
          card(pay.partial ? 'Partial pay estimate' : 'Pay estimate', s.payRate ? fmtMoney(pay.amount, s.payCurrency) : '—', pay.partial ? `Excludes ${pay.unknownHours} h until their pay multiplier is confirmed` : s.payRate ? `at ${fmtMoney(s.payRate, s.payCurrency)} per hour` : 'set the rate in Settings')),
        table(['Code', 'Description', 'Hours', '× rate', 'Amount'], pay.rows.map(r => [r.code, r.desc, String(r.hours), r.mult == null ? 'Unknown' : `× ${r.mult}`, r.amount == null ? 'Unknown' : s.payRate ? fmtMoney(r.amount, s.payCurrency) : '—'])),
        pay.rest.excluded ? el('p', { class: 'help' }, `${pay.rest.excluded} rest/holiday date${pay.rest.excluded === 1 ? '' : 's'} with direct-code entries excluded from automatic rest pay to avoid counting the same day twice.`) : null,
        el('details', { class: 'more-opts' }, el('summary', {}, 'By activity'), table(['Activity', 'Hours'], Object.entries(rec.byActivity).sort().map(([a, h]) => [a, String(h)]))),
        el('small', { class: 'help' }, `Loaded ${fmtWhen(rec.fetchedAt)} from Clockify. ${tagMode ? 'Tag mode uses recorded hours and confirmed codes; no daily minimum or automatic rest-day pay is added.' : 'Calculated with the Week tab rules. The table shows each code’s pay multiplier.'}`));
    } else {
      if (!recs.length) { body.append(el('p', { class: 'muted' }, outdated ? 'Time settings changed. Pick a month and load its hours again.' : 'No month loaded yet. Pick a month above and press Load hours.')); return; }
      const totals = { worked: 0, general: 0, regular: 0, overtime: 0, travel: 0, rest: 0, paid: 0, amount: 0, partial: false };
      const rows = recs.sort((a, b) => b.month.localeCompare(a.month)).map(rec => {
        const pay = payFor(rec, s), work = workBreakdown(rec, s);
        totals.worked += pay.worked; totals.general += pay.generalHours; totals.regular += work.regular;
        totals.overtime += work.overtime; totals.travel += work.travel; totals.rest += pay.rest.hours;
        totals.paid += pay.paidHours; totals.amount += pay.amount; totals.partial ||= pay.partial;
        return [monthLabel(rec.month), String(pay.worked), String(pay.generalHours), String(work.regular), String(work.overtime), String(work.travel),
          ...(tagMode ? [] : [String(pay.rest.hours)]), String(pay.paidHours) + (pay.partial ? ' + unknown' : ''),
          (s.payRate ? fmtMoney(pay.amount, s.payCurrency) : '—') + (pay.partial ? ' (partial)' : '')];
      });
      const totalRow = ['Total', ...['worked', 'general', 'regular', 'overtime', 'travel'].map(key => String(roundHours(totals[key]))),
        ...(tagMode ? [] : [String(roundHours(totals.rest))]), String(roundHours(totals.paid)) + (totals.partial ? ' + unknown' : ''),
        (s.payRate ? fmtMoney(roundHours(totals.amount), s.payCurrency) : '—') + (totals.partial ? ' (partial)' : '')];
      body.append(table(['Month', 'Worked', 'General time', 'Regular', 'Overtime', 'Travel', ...(tagMode ? [] : ['Rest days']), 'Known paid hours', 'Pay estimate'], [...rows, totalRow]),
        el('small', { class: 'help' }, `${recs.length} month${recs.length === 1 ? '' : 's'} loaded.${outdated ? ` ${outdated} old month${outdated === 1 ? '' : 's'} omitted until reloaded with the current settings.` : ''} Months are loaded one at a time: pick one above and press Load hours.`));
    }
  };
  const loadBtn = el('button', { class: 'primary', disabled: !ym, onclick: async () => { loadBtn.disabled = true; status.textContent = 'Loading from Clockify…'; try { await fetchMonthHours(ym); status.textContent = ''; await paint(); } catch (e) { status.textContent = e.message; } loadBtn.disabled = false; } }, ym ? 'Load hours' : 'Pick a month to load');
  const payHelp = s.payRate ? `Pay estimate at ${fmtMoney(s.payRate, s.payCurrency)} per hour${tagMode ? ', using recorded hours only.' : `, day minimum ${s.payMinDay ?? 9} h, rest days ${s.restDaysPaid === false ? 'not counted' : (s.restDayHours ?? 7.5) + ' h each'} (Settings → Pay estimate).`}` :
    'For a pay estimate, set the hourly rate under Settings → Pay estimate.';
  host.append(el('div', { class: 'section-head' }, el('h4', {}, 'Working hours' + (ym ? ` · ${monthLabel(ym)}` : '')), loadBtn), el('small', { class: 'help' }, payHelp), status, body);
  await paint();
}
export function initReport(context) { ctx = context; }

const monthOf = iso => (iso || '').slice(0, 7);
const monthLabel = ym => ym ? new Date(ym + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : 'All months';
const money = ls => Object.entries(totalsByCurrency(ls)).map(([c, n]) => fmtMoney(n, c)).join(' + ') || '—';
const fmtWhen = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

export async function render() {
  const request = ++renderId;
  const root = $('#tab-overview');
  if (!root) return;
  const s = ctx.settings();
  const [sheets, trips, lines, weeks] = await Promise.all([live('sheets'), live('trips'), live('expenses'), live('weeks')]);
  if (!scopeIsCurrent() || request !== renderId) return;
  const codeOf = code => (s.expenseCodes || []).find(c => String(c.code) === String(code));
  // months with expenses, plus the last six months so hours can be loaded for a month without expenses
  const now = new Date();
  const recent = Array.from({ length: 6 }, (_, i) => new Date(Date.UTC(now.getFullYear(), now.getMonth() - i, 1)).toISOString().slice(0, 7));
  const months = [...new Set([...lines.map(l => monthOf(l.date)).filter(Boolean), ...recent])].sort().reverse();
  if (state.month && !months.includes(state.month)) state.month = '';
  const inMonth = l => !state.month || monthOf(l.date) === state.month;
  const ls = lines.filter(inMonth);
  const biz = ls.filter(l => l.business && !l.perdiem), pers = ls.filter(l => !l.business), perdiem = ls.filter(l => l.perdiem);

  root.replaceChildren();
  // month chips
  const chips = el('div', { class: 'chips' }, [['', 'All months'], ...months.map(m => [m, monthLabel(m)])].map(([k, l]) =>
    el('button', { type: 'button', class: 'chip' + (state.month === k ? ' on' : ''), onclick: () => { state.month = k; render(); } }, l)));
  root.append(el('div', { class: 'section-head' }, el('h3', {}, monthLabel(state.month)), el('button', { onclick: () => exportMonth(ls, sheets, trips, codeOf) }, 'Export CSV')), chips);

  const attention = await attentionPanel();
  if (!scopeIsCurrent() || request !== renderId) return;
  if (attention) root.prepend(attention);
  if (currentScope().workspace === 'personal') {
    const refunds = ls.filter(line => Number(line.amount) < 0).map(line => ({ ...line, amount: -Number(line.amount) }));
    root.append(el('div', { class: 'ov-cards' },
      card('Net spending', money(ls), `${ls.length} entries · after refunds`),
      card('Refunds', money(refunds), `${refunds.length} refunds`)));
    const categories = new Map();
    for (const line of ls) {
      const category = line.category || codeOf(line.code)?.short || 'Uncategorized';
      if (!categories.has(category)) categories.set(category, []);
      categories.get(category).push(line);
    }
    root.append(section('By category', categories.size ? table(['Category', 'Net spending', 'Entries'],
      [...categories.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([category, records]) => [category, money(records), String(records.length)])) :
      el('p', { class: 'empty' }, 'No spending in this period. Add an expense or import a CSV from Expenses.')));
    return;
  }
  // working hours and pay estimate (Clockify), then the expense summary
  await renderHours(root, state.month, months);
  if (!scopeIsCurrent() || request !== renderId) return;

  // summary cards
  root.append(el('div', { class: 'ov-cards' },
    card('To IFS (business)', money(biz), `${biz.length} line${biz.length === 1 ? '' : 's'} · ${biz.filter(l => l.receipt).length} with receipt · ${biz.filter(l => l.entered).length} in IFS`),
    card('Personal', money(pers), `${pers.length} line${pers.length === 1 ? '' : 's'}`),
    card('Per diem', money(perdiem), `${perdiem.length} line${perdiem.length === 1 ? '' : 's'}`),
    card('Everything', money(ls), `${ls.length} lines`)));

  // by type
  const byType = new Map();
  for (const l of ls) { const k = codeOf(l.code)?.short || String(l.code); if (!byType.has(k)) byType.set(k, { biz: [], pers: [] }); byType.get(k)[l.business ? 'biz' : 'pers'].push(l); }
  root.append(section('By type', table(['Type', 'Business', 'Personal', 'Lines'], [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, v]) => [k, money(v.biz), money(v.pers), String(v.biz.length + v.pers.length)]))));

  // Use the same dated lines as the cards and CSV, including for trips or sheets spanning months.
  const periodLabel = state.month ? ` · ${monthLabel(state.month)}` : '';
  if (state.month) root.append(el('p', { class: 'help' }, 'Trip and sheet amounts and open-line counts use expenses dated in this month. Trip dates and sheet status describe the whole trip or sheet.'));

  // trips (those with lines in the month, or all when no month chosen)
  const tripRows = trips.filter(t => !state.month || ls.some(l => l.tripId === t.id)).map(t => {
    const tl = ls.filter(l => l.tripId === t.id);
    const income = tl.filter(l => l.perdiem), pocket = tl.filter(l => !l.perdiem && !l.business), reimb = tl.filter(l => !l.perdiem && l.business);
    const net = {};
    for (const l of income) net[l.currency] = (net[l.currency] || 0) + Number(l.amount);
    for (const l of pocket) net[l.currency] = (net[l.currency] || 0) - Number(l.amount);
    return [t.name, `${t.start} → ${t.end} (${t.days} d)`, money(income), money(pocket), money(reimb), Object.entries(net).map(([c, n]) => fmtMoney(Math.round(n * 100) / 100, c)).join(' + ') || '—'];
  });
  root.append(section('Trips' + periodLabel, tripRows.length ? table(['Trip', 'Full trip dates', 'Per diem', 'Out of pocket', 'Reimbursed', 'Net'], tripRows) : el('p', { class: 'empty' }, 'No trips in this period.')));

  // sheets
  const sheetRows = sheets.filter(sh => !state.month || ls.some(l => l.sheetId === sh.id)).map(sh => {
    const sl = ls.filter(l => l.sheetId === sh.id && l.business);
    return [sh.title, sh.expenseId || '—', sh.shortName || '—', money(sl), sh.status + (sh.enteredAt ? ` · ${fmtWhen(sh.enteredAt)}` : ''), `${sl.filter(l => !l.entered).length} not in IFS`];
  });
  root.append(section('Expense sheets' + periodLabel, sheetRows.length ? table(['Sheet', 'IFS ID', 'Project', 'To IFS', 'Sheet status', 'Open lines'], sheetRows) : el('p', { class: 'empty' }, 'No sheets in this period.')));

  // weeks
  const weekRows = weeks.filter(w => !state.month || monthOf(w.monday) === state.month).sort((a, b) => (b.monday || '').localeCompare(a.monday || '')).map(w => [w.monday, `${w.total} h`, `entered ${fmtWhen(w.enteredAt)}`]);
  root.append(section('Timesheet weeks entered in IFS', weekRows.length ? table(['Week of', 'Hours', 'Status'], weekRows) : el('p', { class: 'empty' }, 'No weeks marked as entered yet (Week tab → Mark week as entered).')));
}

function card(k, v, sub) { return el('div', { class: 'ov-card' }, el('span', { class: 'k' }, k), el('b', {}, v), el('small', {}, sub)); }
function section(title, body) { return el('section', { class: 'ov-section' }, el('h4', {}, title), body); }
function table(head, rows) {
  return el('div', { class: 'tbl' }, el('table', {}, el('thead', {}, el('tr', {}, head.map((h, i) => el('th', { class: i > 0 ? 'num' : '' }, h)))),
    el('tbody', {}, rows.map(r => el('tr', {}, r.map((c, i) => el('td', { class: i > 0 ? 'num' : '' }, c)))))));
}

function exportMonth(ls, sheets, trips, codeOf) {
  const esc = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const rows = [['Date', 'Sheet', 'Type', 'Written', 'Explanation', 'Cost object', 'Currency', 'Amount', 'Business', 'Per diem', 'Trip', 'In IFS']];
  for (const l of [...ls].sort((a, b) => (a.date || '').localeCompare(b.date || ''))) {
    rows.push([l.date, sheets.find(s => s.id === l.sheetId)?.title, codeOf(l.code)?.short, l.written, l.vendor, l.costObject, l.currency, l.amount, l.business ? 'yes' : 'no', l.perdiem ? 'yes' : 'no', trips.find(t => t.id === l.tripId)?.name, l.entered ? 'yes' : 'no']);
  }
  download(`overview-${state.month || 'all'}.csv`, '﻿' + rows.map(r => r.map(esc).join(';')).join('\r\n'), 'text/csv');
}

