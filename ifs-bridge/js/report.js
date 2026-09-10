// Overview tab: business vs personal vs per diem by month, by type, by trip; sheets and weeks status.
import { live, db } from './db.js';
import { totalsByCurrency, fmtMoney } from './expense-ifs.js';
import { el, $, download, toast } from './dom.js';
import { Clockify } from './clockify.js';
import { buildWeek, fetchWindow, mondayOf } from './rules.js';

let ctx = null;
const state = { month: '' };

// ---------- working hours per month (Clockify, through the same rules as the Week tab) ----------
function monthDays(ym) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { first: `${ym}-01`, last: `${ym}-${String(last).padStart(2, '0')}` };
}
const shift = (iso, n) => { const [y, m, d] = iso.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };

async function fetchMonthHours(ym) {
  const s = ctx.settings();
  if (!s.clockify.apiKey) throw new Error('Add the Clockify API key in Settings to load hours on this device.');
  const c = new Clockify(s.clockify.apiKey);
  if (!s.clockify.userId) { const u = await c.user(); s.clockify.userId = u.id; s.clockify.workspaceId = u.activeWorkspace; ctx.saveSettings(s); }
  const { first, last } = monthDays(ym);
  const byCode = {}, byActivity = {}, days = new Set();
  for (let monday = mondayOf(first); monday <= last; monday = shift(monday, 7)) {
    const win = fetchWindow(monday, s.timeZone);
    const entries = await c.entries(s.clockify.workspaceId, s.clockify.userId, win.start, win.end);
    const w = buildWeek(entries, monday, s, s.mapping);
    for (const r of w.rows) r.hours.forEach((h, i) => {
      const d = w.dates[i];
      if (h > 0 && d >= first && d <= last) {
        byCode[r.code] = Math.round(((byCode[r.code] || 0) + h) * 100) / 100;
        const a = r.mapping.shortName || r.mapping.clockifyProjectName;
        byActivity[a] = Math.round(((byActivity[a] || 0) + h) * 100) / 100;
        days.add(d);
      }
    });
  }
  const total = Math.round(Object.values(byCode).reduce((a, b) => a + b, 0) * 100) / 100;
  const rec = { month: ym, fetchedAt: new Date().toISOString(), byCode, byActivity, total, days: days.size };
  await db.setMeta(`hours.${ym}`, rec);
  return rec;
}

function payFor(rec, s) {
  const rate = Number(s.payRate) || 0;
  const mult = { [s.codes.regular]: 1, [s.codes.ot15]: 1.5, [s.codes.ot2]: 2, [s.codes.travelRegular]: 1, [s.codes.travel]: 1 };
  const rows = Object.entries(rec.byCode).sort().map(([code, h]) => ({ code, desc: s.codeDescriptions?.[code] || '', hours: h, mult: mult[code] ?? 1, amount: Math.round(h * rate * (mult[code] ?? 1) * 100) / 100 }));
  return { rows, amount: Math.round(rows.reduce((a, r) => a + r.amount, 0) * 100) / 100 };
}

async function renderHours(root, ym, allMonths) {
  const s = ctx.settings();
  const host = el('section', { class: 'ov-section' });
  root.append(host);
  const rate = el('input', { type: 'number', step: '0.01', inputmode: 'decimal', value: s.payRate || '', placeholder: '0.00', class: 'rate-in' });
  const cur = el('select', { class: 'cur' }, s.currencies.map(c => el('option', { value: c, selected: c === (s.payCurrency || 'TRY') }, c)));
  const saveRate = () => { s.payRate = Number(String(rate.value).replace(',', '.')) || 0; s.payCurrency = cur.value; ctx.saveSettings(s); paint(); };
  rate.addEventListener('change', saveRate); cur.addEventListener('change', saveRate);
  const body = el('div');
  const status = el('span', { class: 'help status' });
  const paint = async () => {
    body.replaceChildren();
    const months = ym ? [ym] : allMonths;
    const recs = [];
    for (const m of months) { const r = await db.meta(`hours.${m}`); if (r) recs.push(r); }
    if (ym) {
      const rec = recs[0];
      if (!rec) { body.append(el('p', { class: 'muted' }, 'Not loaded yet for this month.')); return; }
      const pay = payFor(rec, s);
      body.append(
        el('div', { class: 'ov-cards' },
          card('Hours', `${rec.total} h`, `${rec.days} day${rec.days === 1 ? '' : 's'} worked`),
          card('Regular', `${rec.byCode[s.codes.regular] || 0} h`, s.codes.regular),
          card('Overtime', `${Math.round(((rec.byCode[s.codes.ot15] || 0) + (rec.byCode[s.codes.ot2] || 0)) * 100) / 100} h`, `${s.codes.ot15} + ${s.codes.ot2}`),
          card('Travel', `${Math.round(((rec.byCode[s.codes.travelRegular] || 0) + (rec.byCode[s.codes.travel] || 0)) * 100) / 100} h`, `${s.codes.travelRegular} + ${s.codes.travel}`),
          card('Pay estimate', s.payRate ? fmtMoney(pay.amount, s.payCurrency) : '—', s.payRate ? `at ${fmtMoney(s.payRate, s.payCurrency)} per hour` : 'type the hourly rate')),
        table(['Code', 'Description', 'Hours', '× rate', 'Amount'], pay.rows.map(r => [r.code, r.desc, String(r.hours), `× ${r.mult}`, s.payRate ? fmtMoney(r.amount, s.payCurrency) : '—'])),
        el('h4', {}, 'By activity'),
        table(['Activity', 'Hours'], Object.entries(rec.byActivity).sort().map(([a, h]) => [a, String(h)])),
        el('small', { class: 'help' }, `Loaded ${fmtWhen(rec.fetchedAt)} from Clockify with the Week tab rules. Overtime ×1.5 and ×2, travel ×1; change the multipliers in the code if your contract differs.`));
    } else {
      if (!recs.length) { body.append(el('p', { class: 'muted' }, 'No month loaded yet. Pick a month above and press Load hours.')); return; }
      const rows = recs.sort((a, b) => b.month.localeCompare(a.month)).map(r => { const p = payFor(r, s); return [monthLabel(r.month), String(r.total), String(r.byCode[s.codes.regular] || 0), String(Math.round(((r.byCode[s.codes.ot15] || 0) + (r.byCode[s.codes.ot2] || 0)) * 100) / 100), String(Math.round(((r.byCode[s.codes.travelRegular] || 0) + (r.byCode[s.codes.travel] || 0)) * 100) / 100), s.payRate ? fmtMoney(p.amount, s.payCurrency) : '—']; });
      const sum = recs.reduce((a, r) => a + payFor(r, s).amount, 0);
      body.append(table(['Month', 'Hours', 'Regular', 'Overtime', 'Travel', 'Pay estimate'], [...rows, ['Total', String(Math.round(recs.reduce((a, r) => a + r.total, 0) * 100) / 100), '', '', '', s.payRate ? fmtMoney(Math.round(sum * 100) / 100, s.payCurrency) : '—']]),
        el('small', { class: 'help' }, `${recs.length} month${recs.length === 1 ? '' : 's'} loaded. Months are loaded one at a time: pick one above and press Load hours.`));
    }
  };
  const loadBtn = el('button', { class: 'primary', disabled: !ym, onclick: async () => { loadBtn.disabled = true; status.textContent = 'Loading from Clockify…'; try { await fetchMonthHours(ym); status.textContent = ''; await paint(); } catch (e) { status.textContent = e.message; } loadBtn.disabled = false; } }, ym ? 'Load hours' : 'Pick a month to load');
  host.append(el('div', { class: 'section-head' }, el('h4', {}, 'Working hours' + (ym ? ` · ${monthLabel(ym)}` : '')), el('span', { class: 'row' }, el('label', { class: 'inline' }, 'Hourly rate', rate, cur), loadBtn)), status, body);
  await paint();
}

export function initReport(context) { ctx = context; }

const monthOf = iso => (iso || '').slice(0, 7);
const monthLabel = ym => ym ? new Date(ym + '-01T00:00:00').toLocaleDateString('en-GB', { month: 'long', year: 'numeric' }) : 'All months';
const money = ls => Object.entries(totalsByCurrency(ls)).map(([c, n]) => fmtMoney(n, c)).join(' + ') || '—';
const fmtWhen = iso => iso ? new Date(iso).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

export async function render() {
  const root = $('#tab-overview');
  if (!root) return;
  const s = ctx.settings();
  const [sheets, trips, lines, weeks] = await Promise.all([live('sheets'), live('trips'), live('expenses'), live('weeks')]);
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

  // working hours and pay estimate (Clockify), then the expense summary
  await renderHours(root, state.month, months);

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

  // trips (those with lines in the month, or all when no month chosen)
  const tripRows = trips.filter(t => !state.month || lines.some(l => l.tripId === t.id && monthOf(l.date) === state.month)).map(t => {
    const tl = lines.filter(l => l.tripId === t.id);
    const income = tl.filter(l => l.perdiem), pocket = tl.filter(l => !l.perdiem && !l.business), reimb = tl.filter(l => !l.perdiem && l.business);
    const net = {};
    for (const l of income) net[l.currency] = (net[l.currency] || 0) + Number(l.amount);
    for (const l of pocket) net[l.currency] = (net[l.currency] || 0) - Number(l.amount);
    return [t.name, `${t.start} → ${t.end} (${t.days} d)`, money(income), money(pocket), money(reimb), Object.entries(net).map(([c, n]) => fmtMoney(Math.round(n * 100) / 100, c)).join(' + ') || '—'];
  });
  root.append(section('Trips', tripRows.length ? table(['Trip', 'Dates', 'Per diem', 'Out of pocket', 'Reimbursed', 'Net'], tripRows) : el('p', { class: 'empty' }, 'No trips in this period.')));

  // sheets
  const sheetRows = sheets.filter(sh => !state.month || lines.some(l => l.sheetId === sh.id && monthOf(l.date) === state.month)).map(sh => {
    const sl = lines.filter(l => l.sheetId === sh.id && l.business);
    return [sh.title, sh.expenseId || '—', sh.shortName || '—', money(sl), sh.status + (sh.enteredAt ? ` · ${fmtWhen(sh.enteredAt)}` : ''), `${sl.filter(l => !l.entered).length} not in IFS`];
  });
  root.append(section('Expense sheets', sheetRows.length ? table(['Sheet', 'IFS ID', 'Project', 'To IFS', 'Status', 'Open'], sheetRows) : el('p', { class: 'empty' }, 'No sheets in this period.')));

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
