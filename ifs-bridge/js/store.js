import { currentScope, scopedKey, getConnection, assertScopeCurrent } from './scope.js';
// Settings and mapping. localStorage now; the same shape moves to Supabase in phase 2.
const KEY = 'ifsbridge.settings.v1';

// A real PROJECT_TRANS_WEEK row copied from IFS Enterprise Explorer, used as the
// template for every generated row. Replace it from Settings by pasting a newer copy.
export const DEFAULT_TEMPLATE = `!IFS.COPYOBJECT
$LU=ProjectTransWeek
$VIEW=PROJECT_TRANS_WEEK
$RECORD=!
-$0:LINKED_COMPANY_ID=
-$1:LINKED_SHORT_NAME=
-$2:LINKED_REPORT_CODE=
-$3:PROJECT_TRANSACTION_API.HAS_LINKED_TRANS_IN_WEEK( COMPANY_ID, EMP_NO, ACTIVITY_SEQ, REPORT_COST_CODE, ACCOUNT_DATE)=0
-$4:COST_ACCOUNTING=
-$5:RESOURCE_SEQ=
-$6:RESOURCE_ID=
-$7:RESOURCE_API.GET_DESCRIPTION(RESOURCE_SEQ)=
-$8:MON_INTERNAL_QUANTITY=
-$9:TUE_INTERNAL_QUANTITY=
-$10:WED_INTERNAL_QUANTITY=
-$11:THU_INTERNAL_QUANTITY=
-$12:FRI_INTERNAL_QUANTITY=
-$13:SAT_INTERNAL_QUANTITY=
-$14:SUN_INTERNAL_QUANTITY=
-$15:=
-$16:PURCHASE_ORDER_NO=
-$17:PURCHASE_ORDER_LINE_REF=
-$18:COMPANY_ID=
-$19:EMP_NO=
-$20:ACCOUNT_DATE=
-$21:REPORT_COST_TYPE=Zaman
-$22:SHORT_NAME=
-$23:PROJECT_ID=
-$24:PROJECT_API.GET_NAME(PROJECT_ID)=
-$25:SUB_PROJECT_ID=
-$26:SUB_PROJECT_API.GET_DESCRIPTION(PROJECT_ID,SUB_PROJECT_ID)=
-$27:ACTIVITY_NO=
-$28:ACTIVITY_SEQ=
-$29:ACTIVITY_API.GET_DESCRIPTION(ACTIVITY_SEQ)=
-$30:REPORT_COST_CODE=
-$31:REPORT_COST_API.GET_DESCRIPTION_NEW_DATES(COMPANY_ID,REPORT_COST_CODE, ACCOUNT_DATE)=
-$32:COST_ACCOUNTING=0
-`;

// Expense Details row, exactly as the Excel workbook pasted it (LU ExpenseDetail).
export const DEFAULT_EXPENSE_TEMPLATE = `!IFS.COPYOBJECT
$LU=ExpenseDetail
$VIEW=DETAIL_EXPENSE
$RECORD=!
-$0:C_SHORT_NAME=
-$1:COMPANY_ID=
-$3:EXPENSE_RULE=
-$4:CONV_FACTOR=1
-$5:=2
-$6:=FALSE
-$2:EXPENSE_ID=
-$7:ACCOUNT_DATE=
-$8:EXPENSE_CODE=
-$9:DESCRIPTION=
-$10:REIMBURSABLE=1
-$11:REFERENCE=
-$12:CURRENCY_CODE=
-$13:CURR_RATE=1
-$14:GROSS_CURR_AMOUNT=
-$15:VAT_CURR_AMOUNT=0
-$16:GROSS_PAY_AMOUNT=
-$17:VAT_PAY_AMOUNT=0
-$18:AREA=
-$19:SHORT_NAME=
-$24:ORG_CODE=
-$25:CREDIT_CARD_TRANS=FALSE
-$38:SEQ_NO=
-$42:PAYMENT_DATE=
-$44:TAX_AMOUNT_MODIFIED=FALSE
-$45:VOUCHER_TYPE=
-$46:VOUCHER_NO=
-`;

export const DEFAULTS = {
  clockify: { apiKey: '', workspaceId: '', userId: '', userName: '' },
  timeZone: 'Europe/Istanbul',
  regularHours: 9,          // default weekday regular hours; a mapping can override (US projects: 8)
  travelAfterHours: 9,      // weekday travel beyond this many hours (work + travel) is travel overtime
  topUpMinimum: true,       // a worked weekday is booked with at least the regular hours (8 abroad, 9 in TR)
  roundStep: 0.5,
  roundMode: 'up',          // nearest | down | up
  holidays: [],             // yyyy-mm-dd dates treated like Sunday (×2)
  tags: { x15: 'Overtime', x2: 'Overtime x2', travel: 'Travel', travelOT: 'Travel OT' },
  travelKeyword: 'travel',  // description starting with this word also counts as travel
  codes: { regular: 'F_03', ot15: 'F_02', ot2: 'F_10', travel: 'F_12', travelRegular: 'F_01' },
  codeDescriptions: { F_03: 'Regular Time (Normal Calisma)', F_02: 'Over Time (OT) x 1.5', F_10: 'Over Time (OT) x 2', F_12: 'Travel Over Time (ST) x 1', F_01: 'Travel  Regular Time', F_11: 'Over Time (ST) x 1' },
  identity: { companyId: '', empNo: '', resourceId: '', resourceSeq: '', resourceName: '' },
  template: DEFAULT_TEMPLATE,
  // ---- expenses (phase 2) ----
  supabase: { url: '', anonKey: '' },
  defaultCurrency: 'TRY',
  currencies: ['TRY', 'USD', 'EUR', 'GBP', 'CHF', 'PLN', 'SEK', 'AUD', 'JPY'],
  costObjects: [],
  expenseCodes: [
    { code: 3351, desc: 'Harcırah (Per-Diem)', short: 'Per diem' },
    { code: 3352, desc: 'Bonus', short: 'Bonus' },
    { code: 7301, desc: 'Yemek Masrafı - (Meals)', short: 'Meals' },
    { code: 7305, desc: 'Konaklama Bedeli - (Lodging/Hotel/Accommodations)', short: 'Hotel' },
    { code: 7307, desc: 'Araç Kiralama - (Car Rental)', short: 'Car rental' },
    { code: 7309, desc: 'Uçak Bedeli - (Airfare)', short: 'Airfare' },
    { code: 7311, desc: 'Taksi Bedeli - (Taxi)', short: 'Taxi' },
    { code: 7313, desc: 'Otopark Bedeli - (Parking)', short: 'Parking' },
    { code: 7315, desc: 'Araç Yakıt Masrafı - (Fuel)', short: 'Fuel' },
    { code: 7316, desc: 'Seyahat Sigortaları - (Travel Insurance)', short: 'Travel insurance' },
    { code: 7318, desc: 'Otoban Diğer Ulaşım Giderleri - (Other Transportation)', short: 'Toll / transport' },
    { code: 7320, desc: 'Temsil Ağırlama - (Entret. - Outside Parties)', short: 'Entertainment' },
    { code: 7324, desc: 'Küçük Demirbaş Masrafları - (Fixtures)', short: 'Fixtures' },
    { code: 7328, desc: 'Eğitim Masrafları - (Training)', short: 'Training' },
    { code: 7329, desc: 'Diğer Çeşitli Masraflar - (Misc.Travel Expense)', short: 'Misc travel' },
    { code: 7332, desc: 'Araç Tamir Bakım Giderleri - (Co. Vehicle Repair And Maint.)', short: 'Vehicle repair' },
    { code: 7333, desc: 'Diğer Vergi Resim ve Harçlar - (Other Tax Duties and Fees)', short: 'Taxes / fees' },
    { code: 7334, desc: 'İş Güvenliği Malzemeleri - (Safety Materials)', short: 'Safety materials' },
    { code: 7335, desc: 'KKEG – Araç Giderleri', short: 'KKEG vehicle' },
    { code: 7336, desc: 'KKEG Diğer Giderleri (Expense)', short: 'KKEG other' },
    { code: 7341, desc: 'Personel Vize Masraf Giderileri', short: 'Visa' },
    { code: 7390, desc: 'Expense KDV %18', short: 'VAT 18%' },
  ],
  perDiemCode: 3351,
  expenseTemplate: DEFAULT_EXPENSE_TEMPLATE,
  // Project short name for expense lines = PROJECT.SUBPROJECT.ACTIVITY of the project's expense activity.
  // Set the expense activity suffix and project names in your own Settings.
  expenseActivitySuffix: '',
  knownShortNames: [],
  homeCurrency: 'TRY',      // lines in this currency get CURR_RATE=1
  rateSource: 'tcmb',       // tcmb = rate for the line's date from the Central Bank via the PC server | manual = the sheet's typed rate
  tcmbField: 'ForexBuying', // which TCMB column IFS uses: ForexBuying (döviz alış), ForexSelling, BanknoteBuying, BanknoteSelling
  currRateMode: 'blank',    // when no rate is known: blank = send the field empty | omit = leave the field out | one = always 1
  perDiemDefaults: [],      // [{ country: 'USA', rate: 70, currency: 'USD' }] used to prefill a new trip
  payRate: 0,               // hourly salary rate for the pay estimate on the Overview tab
  payCurrency: 'TRY',
  restDaysPaid: true,       // Sundays and public holidays count as paid rest days in the pay estimate
  restDayHours: 7.5,        // 45 h / 6 days
  payMinDay: 9,             // a worked weekday counts as at least this many regular hours for pay (8 h US days get +1)
  mapping: [],
};

// Public defaults contain no employee or project details.
// New accounts and Personal start with no inherited identity, Clockify key or mapping.
export function defaultsForScope() {
  const defaults = structuredClone(DEFAULTS);
  defaults.supabase = getConnection();
  if (!currentScope().legacy) {
    defaults.identity = Object.fromEntries(Object.keys(defaults.identity).map(key => [key, '']));
    defaults.mapping = [];
    defaults.knownShortNames = [];
    defaults.costObjects = [];
    const clearIdentity = text => text.replace(/^(-\$\d+:(?:COMPANY_ID|EMP_NO|RESOURCE_SEQ|RESOURCE_ID|RESOURCE_API\.GET_DESCRIPTION\(RESOURCE_SEQ\)|ORG_CODE)=).*$/gm, '$1');
    defaults.template = clearIdentity(defaults.template);
    defaults.expenseTemplate = clearIdentity(defaults.expenseTemplate);
  }
  if (currentScope().workspace === 'personal') {
    defaults.currencies = [...new Set([...defaults.currencies, 'CAD'])];
    // Numeric IDs keep existing expense/import storage compatible; these are private categories.
    defaults.expenseCodes = ['Groceries', 'Food & drink', 'Transport', 'Home', 'Health', 'Shopping', 'Subscriptions', 'Travel', 'Other', 'Family']
      .map((name, index) => ({ code: 90001 + index, desc: name, short: name }));
  }
  return defaults;
}

export function loadSettings() {
  assertScopeCurrent();
  const defaults = defaultsForScope();
  try {
    const raw = localStorage.getItem(scopedKey(KEY));
    if (!raw) return defaults;
    const s = JSON.parse(raw);
    const merged = {
      ...defaults, ...s,
      clockify: { ...DEFAULTS.clockify, ...(s.clockify || {}) },
      supabase: getConnection(),
      tags: { ...DEFAULTS.tags, ...(s.tags || {}) },
      codes: { ...DEFAULTS.codes, ...(s.codes || {}) },
      codeDescriptions: { ...DEFAULTS.codeDescriptions, ...(s.codeDescriptions || {}) },
      identity: { ...defaults.identity, ...(s.identity || {}) },
      holidays: Array.isArray(s.holidays) ? s.holidays : [],
      mapping: currentScope().legacy ? mergeMapping(s.mapping || []) : (Array.isArray(s.mapping) ? s.mapping : []),
    };
    // Lists that newer versions may extend: keep the user's entries, add unknown defaults.
    merged.expenseCodes = mergeById(defaults.expenseCodes, s.expenseCodes, 'code');
    merged.currencies = [...new Set([...(s.currencies || []), ...defaults.currencies])];
    merged.costObjects = [...new Set([...(s.costObjects || []), ...defaults.costObjects])];
    merged.knownShortNames = [...new Set([...(s.knownShortNames || []), ...defaults.knownShortNames])];
    return merged;
  } catch { return defaults; }
}

// Keep saved mapping rows, fill blanks from the built-in defaults, add rows the user does not have yet.
function mergeMapping(saved) {
  const out = saved.map(m => ({ ...m }));
  for (const d of DEFAULTS.mapping) {
    const m = out.find(x => x.clockifyProjectId === d.clockifyProjectId);
    if (!m) { out.push(structuredClone(d)); continue; }
    for (const [k, v] of Object.entries(d)) {
      if (k === 'travel') { m.travel = m.travel || {}; for (const [tk, tv] of Object.entries(v)) if (!m.travel[tk]) m.travel[tk] = tv; }
      else if (m[k] == null || m[k] === '') m[k] = v;
    }
  }
  return out;
}

function mergeById(defaults, saved, key) {
  if (!Array.isArray(saved) || !saved.length) return structuredClone(defaults);
  const out = saved.map(x => ({ ...x }));
  for (const d of defaults) if (!out.some(x => String(x[key]) === String(d[key]))) out.push({ ...d });
  return out;
}

// SHORT_NAME in IFS is PROJECT.SUBPROJECT.ACTIVITY_NO; fill it when the parts are known.
export function normalizeMapping(mapping) {
  for (const m of mapping) {
    if (!m.shortName && m.projectId && m.subProjectId && m.activityNo) m.shortName = `${m.projectId}.${m.subProjectId}.${m.activityNo}`;
    if (m.travel && !m.travel.shortName && m.projectId && m.subProjectId && m.travel.activityNo) m.travel.shortName = `${m.projectId}.${m.subProjectId}.${m.travel.activityNo}`;
  }
  return mapping;
}

export function saveSettings(s) {
  assertScopeCurrent();
  normalizeMapping(s.mapping || []);
  try { localStorage.setItem(scopedKey(KEY), JSON.stringify({ ...s, supabase: getConnection() })); } catch { /* private mode etc. */ }
  document.dispatchEvent(new CustomEvent('ifsbridge:changed', { detail: { store: 'settings' } }));
}


