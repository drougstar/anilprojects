// Reads amount, date and currency from a receipt photo with Tesseract.js (loaded on demand
// from the CDN; the English model is cached by the browser after the first use).
// The result is offered as suggestions; the user decides what to apply.

const TESSERACT_URL = 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.1/tesseract.min.js';
let scriptPromise = null;
let workerPromise = null;

function loadScript() {
  if (window.Tesseract) return Promise.resolve(window.Tesseract);
  scriptPromise ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL;
    s.onload = () => resolve(window.Tesseract);
    s.onerror = () => { scriptPromise = null; reject(new Error('Could not load the text reader (no internet?).')); };
    document.head.append(s);
  });
  return scriptPromise;
}

async function getWorker(onProgress) {
  const T = await loadScript();
  workerPromise ||= T.createWorker('eng', 1, { logger: m => { if (onProgress && m.status === 'recognizing text') onProgress(Math.round((m.progress || 0) * 100)); } })
    .catch(e => { workerPromise = null; throw e; });
  return workerPromise;
}

export async function readReceipt(blob, { onProgress } = {}) {
  const w = await getWorker(onProgress);
  const { data } = await w.recognize(blob);
  return parseReceipt(data.text || '');
}

// ---- parsing ----
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
  oca: 1, şub: 2, sub: 2, mar_: 3, nis: 4, may_: 5, haz: 6, tem: 7, ağu: 8, agu: 8, eyl: 9, eki: 10, kas: 11, ara: 12 };

function toNumber(s) {
  s = s.replace(/\s/g, '');
  const lastDot = s.lastIndexOf('.'), lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) s = lastDot > lastComma ? s.replace(/,/g, '') : s.replace(/\./g, '').replace(',', '.');
  else if (lastComma >= 0) s = /,\d{2}$/.test(s) ? s.replace(/,/g, '.') : s.replace(/,/g, '');
  else if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function findDate(text, currency) {
  const t = text.replace(/\s+/g, ' ');
  const valid = (y, m, d) => y >= 2020 && y <= 2035 && m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}` : null;
  let m;
  if ((m = /(20\d{2})-(\d{1,2})-(\d{1,2})/.exec(t))) { const r = valid(+m[1], +m[2], +m[3]); if (r) return r; }
  const re = /(\d{1,2})[\/.\-](\d{1,2})[\/.\-](20\d{2}|\d{2})(?!\d)/g;
  while ((m = re.exec(t))) {
    const a = +m[1], b = +m[2], y = m[3].length === 2 ? 2000 + +m[3] : +m[3];
    let month, day;
    if (a > 12) { day = a; month = b; } else if (b > 12) { month = a; day = b; } else if (currency === 'USD') { month = a; day = b; } else { day = a; month = b; }
    const r = valid(y, month, day); if (r) return r;
  }
  const re2 = /(\d{1,2})\s*([A-Za-zğüşıöçĞÜŞİÖÇ]{3,9})\.?\s*(20\d{2})/g;      // 28 Aug 2026, 28 Ağustos 2026
  while ((m = re2.exec(t))) { const mo = MONTHS[m[2].toLowerCase().slice(0, 3)]; const r = mo && valid(+m[3], mo, +m[1]); if (r) return r; }
  const re3 = /([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(20\d{2})/g;                 // Aug 28, 2026
  while ((m = re3.exec(t))) { const mo = MONTHS[m[1].toLowerCase().slice(0, 3)]; const r = mo && valid(+m[3], mo, +m[2]); if (r) return r; }
  return null;
}

export function parseReceipt(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const all = lines.join('\n');
  let currency = null;
  if (/\$|\bUSD\b/.test(all)) currency = 'USD';
  else if (/₺|\bTL\b|\bTRY\b|KDV/.test(all)) currency = 'TRY';
  else if (/€|\bEUR\b/.test(all)) currency = 'EUR';
  else if (/£|\bGBP\b/.test(all)) currency = 'GBP';

  const numRe = /(?<![\d.,])(\d{1,3}(?:[.,]\d{3})*[.,]\d{2}|\d+[.,]\d{2})(?![\d])/g;
  const candidates = [];   // { value, line, keyword }
  for (const line of lines) {
    const keyword = /total|toplam|amount|tutar|balance|due|grand|genel|sum\b/i.test(line) && !/sub\s*total|ara\s*toplam|tax|kdv|tip|change|para üstü/i.test(line);
    const scrubbed = line.replace(/\d{1,2}[\/.\-]\d{1,2}[\/.\-]\d{2,4}/g, ' ').replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ');   // dates and times are not amounts
    let m;
    while ((m = numRe.exec(scrubbed))) { const v = toNumber(m[1]); if (v != null && v > 0 && v < 1000000) candidates.push({ value: v, line, keyword }); }
  }
  let amount = null;
  const withKeyword = candidates.filter(c => c.keyword);
  if (withKeyword.length) amount = Math.max(...withKeyword.map(c => c.value));
  else if (candidates.length) amount = Math.max(...candidates.map(c => c.value));
  const date = findDate(all, currency);
  return { text, amount, currency, date, candidates: [...new Set(candidates.map(c => c.value))].sort((a, b) => b - a).slice(0, 6) };
}
