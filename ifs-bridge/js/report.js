// Overview tab: business vs personal vs per diem by month, by type, by trip; sheets and weeks status.
import { live } from './db.js';
import { totalsByCurrency, fmtMoney } from './expense-ifs.js';
import { el, $, download } from './dom.js';

let ctx = null;
const state = { month: '' };

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
  const months = [...new Set(lines.map(l => monthOf(l.date)).filter(Boolean))].sort().reverse();
  if (state.month && !months.includes(state.month)) state.month = '';
  const inMonth = l => !state.month || monthOf(l.date) === state.month;
  const ls = lines.filter(inMonth);
  const biz = ls.filter(l => l.business && !l.perdiem), pers = ls.filter(l => !l.business), perdiem = ls.filter(l => l.perdiem);

  root.replaceChildren();
  // month chips
  const chips = el('div', { class: 'chips' }, [['', 'All months'], ...months.map(m => [m, monthLabel(m)])].map(([k, l]) =>
    el('button', { type: 'button', class: 'chip' + (state.month === k ? ' on' : ''), onclick: () => { state.month = k; render(); } }, l)));
  root.append(el('div', { class: 'section-head' }, el('h3', {}, monthLabel(state.month)), el('button', { onclick: () => exportMonth(ls, sheets, trips, codeOf) }, 'Export CSV')), chips);

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
