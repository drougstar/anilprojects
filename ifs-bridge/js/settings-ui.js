import { el, field, openDialog, download } from './dom.js';
import { Clockify } from './clockify.js';
import { createSettingsFile, parseSettingsFile } from './settings-transfer.js';
import { createSettingsDraft, decimalSetting, validateStructuredSettings, mergeSettingsDraft } from './settings-model.js';
import { renderTimeSetup, validateTimeSettings } from './settings-time.js';
import { renderProjectSettings, validateProjectSettings } from './settings-projects.js';
import { parseCopyObject } from './ifs.js';
import { timeCodeInfo } from './time-codes.js';

const groups = {
  connections: { label: 'Clockify', description: 'API key and connection' },
  time: { label: 'Timesheets', description: 'Hours, tag meanings and IFS project destinations' },
  spending: { label: 'Expenses', description: 'Categories, currencies, daily allowances and IFS export' },
  pay: { label: 'Pay', description: 'Hourly rate, paid rest days and leave pay' },
  app: { label: 'Account & app', description: 'Sign-in, authenticator, appearance and time zone' },
  backup: { label: 'Import / export', description: 'Move settings, download data or restore a backup' }
};
const button = (label, run, attrs = {}) => el('button', { type: 'button', onclick: run, ...attrs }, label);
const card = (title, ...content) => el('section', { class: 'settings-card' }, el('h3', {}, title), ...content);
const advanced = (title, ...content) => el('details', { class: 'settings-advanced' }, el('summary', {}, title), ...content);
const jsonClone = value => structuredClone(value);
function ancestors(node) { const out = []; while ((node = node.parentElement)) out.push(node); return out; }
function disclosure(title, description, ...children) {
  return el('details', { class: 'settings-disclosure' },
    el('summary', {}, el('span', { class: 'settings-summary-copy' }, el('strong', {}, title), el('small', {}, description))),
    el('div', { class: 'settings-disclosure-body' }, ...children));
}
function foldCard(node, description) {
  const title = node.querySelector('h3'); const folded = disclosure(title.textContent, description);
  title.remove(); folded.lastElementChild.append(...node.childNodes);
  if (node.id) folded.id = node.id;
  return folded;
}

// This controller owns only a draft. Business modules keep reading the saved
// settings until a successful explicit Save replaces them through onSave.
export function createSettingsPage(options) {
  const { workspace = 'work', getSaved, onSave, isCurrent = () => true } = options;
  let session = createSettingsDraft(getSaved(), workspace), root, content, saveStatus, saveButton, reviewButton, discardButton;
  let group = 'home', generation = 0, disposed = false, pending = false, importUndo = null;
  let fieldChecks = [], heading, errorBox, navigation, saveBar, notice;
  const validGroups = ['home', ...Object.keys(groups).filter(name => workspace !== 'personal' || !['connections', 'time', 'pay'].includes(name))];
  const labelFor = name => name === 'home' ? 'Settings' : workspace === 'personal' && name === 'spending' ? 'Spending' : groups[name].label;
  const alive = ticket => !disposed && isCurrent() && ticket === generation && !!root?.isConnected;
  const current = () => !disposed && isCurrent() && !!root?.isConnected;
  const draft = () => session.value;
  const dirty = () => session.changes();
  const changed = () => {
    if (!current()) return;
    const count = dirty().length;
    if (saveStatus) saveStatus.textContent = count ? `${count} setting${count === 1 ? '' : 's'} changed · not saved` : 'No unsaved changes';
    if (saveButton) saveButton.disabled = !count || pending;
    if (reviewButton) reviewButton.disabled = !count || pending;
    if (discardButton) discardButton.disabled = !count || pending;
    if (content) content.inert = pending;
    if (navigation) navigation.inert = pending;
    if (saveBar) saveBar.hidden = !count && !pending;
    if (notice) notice.hidden = true;
    options.onDirty?.(count);
  };
  const input = (obj, key, label, attrs = {}, transform = value => value.trim()) => {
    const node = el('input', { type: 'text', value: obj[key] ?? '', 'aria-label': label, ...attrs });
    node.addEventListener('input', () => { if (!current()) return; obj[key] = transform(node.value); changed(); });
    return node;
  };
  const number = (obj, key, label, { max = 1e9, empty = 0 } = {}) => {
    const node = el('input', { value: obj[key] ?? '', inputmode: 'decimal', 'aria-label': label });
    const error = el('small', { class: 'settings-field-error', role: 'status' });
    const check = () => {
      const value = decimalSetting(node.value, { max, empty });
      const okay = value !== null;
      error.textContent = okay ? '' : `Enter a number from 0 to ${max}, using . or , for decimals.`;
      node.setAttribute('aria-invalid', String(!okay));
      return okay ? null : `${label}: ${error.textContent}`;
    };
    node.addEventListener('input', () => { if (!current()) return; const value = decimalSetting(node.value, { max, empty }); obj[key] = value === null ? node.value : value; check(); changed(); });
    fieldChecks.push(() => node.isConnected ? check() : null);
    return el('div', {}, node, error);
  };
  const select = (obj, key, label, choices) => el('select', { 'aria-label': label, onchange: event => { if (current()) { obj[key] = event.target.value; changed(); } } },
    choices.map(([value, text]) => el('option', { value, selected: obj[key] === value }, text)));
  const currency = (obj, key, label) => select(obj, key, label, [...new Set([...(draft().currencies || []), obj[key]])].filter(Boolean).map(value => [value, value]));
  // A clean draft hides Save actions, but action feedback must remain visible.
  const setMessage = message => {
    if (!current()) return;
    if (saveStatus) saveStatus.textContent = message;
    if (notice) { notice.textContent = message; notice.hidden = !saveBar?.hidden; }
  };
  // A section change cannot bypass validation of the other draft sections.
  const errors = () => [...fieldChecks.map(check => check()).filter(Boolean),
    ...(workspace === 'work' ? [...validateTimeSettings(draft()), ...validateProjectSettings(draft())] : []),
    ...validateStructuredSettings(draft(), workspace)];
  function validate() {
    const messages = [...new Set(errors())];
    try { createSettingsFile(draft(), { workspace }); } catch (error) { messages.push(error.message); }
    errorBox.replaceChildren(...messages.map(text => el('p', {}, text)));
    errorBox.hidden = !messages.length;
    if (messages.length) errorBox.focus();
    return !messages.length;
  }
  async function commit() {
    if (!current() || pending || !validate()) return;
    const savingSession = session;
    let next;
    try { next = mergeSettingsDraft(session.baseline, draft(), getSaved(), workspace); }
    catch (error) { setMessage(error.message); return; }
    pending = true; changed();
    try {
      await onSave(next);
      if (!current() || session !== savingSession) return;
      session.committed(next); pending = false; paint(); setMessage('Saved. Your new setup is now in use.');
    } catch (error) { if (current() && session === savingSession) { pending = false; changed(); setMessage(`Save failed: ${error.message}. Your draft is still here.`); } }
  }
  function review() {
    if (!current() || !validate()) return;
    const changes = dirty(), body = el('div', { class: 'settings-diff' }, el('p', {}, 'Review these changes before they take effect. API keys are never shown here.'),
      ...changes.map(change => el('div', { class: 'settings-diff-row' }, el('b', {}, change.label), el('div', {}, el('span', {}, 'Saved'), el('p', {}, change.before)), el('div', {}, el('span', {}, 'Draft'), el('p', {}, change.after)))));
    const dialog = openDialog('Review settings changes', body, { wide: true });
    body.append(el('div', { class: 'actions' }, button('Save these changes', () => { dialog.close(); commit(); }, { class: 'primary' }), button('Keep editing', () => dialog.close())));
  }
  const replaceDraft = next => { if (pending) return; ++generation; session.replace(next); paint(); changed(); };
  function discard() {
    if (!current() || pending) return;
    ++generation; importUndo = null; session = createSettingsDraft(getSaved(), workspace); paint(); changed(); setMessage('Draft discarded. Saved settings restored.');
  }
  function home() {
    return [el('div', { class: 'settings-home', 'aria-label': 'Choose a settings section' },
      validGroups.filter(name => name !== 'home').map(name => button('', () => navigate(name), {
        class: 'settings-home-link', 'data-group': name,
        'aria-label': labelFor(name)
      }))), el('p', { class: 'settings-home-note' }, 'Choose what you want to change. Edits take effect when you Save.')];
  }
  function connections() {
    const s = draft();
    const key = input(s.clockify, 'apiKey', 'Clockify API key', { type: 'password', autocomplete: 'off', spellcheck: 'false', id: 'set-key' });
    const status = el('p', { id: 'key-status', class: 'help', role: 'status' }, s.clockify.userName ? `Saved account: ${s.clockify.userName}` : s.clockify.apiKey ? 'API key saved. Test the connection to check it.' : 'Add your Clockify API key to load your time entries.');
    key.addEventListener('input', () => { s.clockify.userId = ''; s.clockify.workspaceId = ''; s.clockify.userName = ''; status.textContent = 'Key changed. Test the connection, then Save.'; changed(); });
    const test = button('Test Clockify connection', async () => {
      if (!current() || test.disabled) return;
      const ticket = generation, enteredKey = key.value.trim();
      if (!enteredKey) { status.textContent = 'Enter your Clockify API key first.'; return; }
      test.disabled = true; status.textContent = 'Checking Clockify…';
      try {
        const user = await (options.clockifyUser ? options.clockifyUser(enteredKey) : new Clockify(enteredKey).user());
        if (!alive(ticket) || s !== draft() || s.clockify.apiKey !== enteredKey) return;
        Object.assign(s.clockify, { userId: user.id, workspaceId: user.activeWorkspace, userName: user.name });
        if (user.settings?.timeZone) s.timeZone = user.settings.timeZone;
        status.textContent = `Connected as ${user.name}. Save to use this connection.`; changed();
      } catch (error) { if (alive(ticket)) status.textContent = `Connection failed: ${error.message}`; }
      finally { if (alive(ticket)) test.disabled = false; }
    }, { id: 'test-clockify-connection' });
    const editor = disclosure('API key', 'Add or change the saved connection', field('Clockify API key', key, 'Find this in Clockify → Profile settings → API.'));
    editor.open = !s.clockify.apiKey;
    return [card('Connection', status, test), editor,
      button('Set up hours, tags and IFS projects', () => navigate('time'), { class: 'settings-next-link' })];
  }
  function appSettings() {
    const s = draft(), theme = options.getTheme?.() || 'auto';
    const cloud = disclosure('Cloud connection test', 'Check account access without syncing records', options.connectionStatusPanel?.() || el('p', {}, 'Open Account & Security to manage cloud access.'));
    return [card('Account & security', el('p', { class: 'help' }, 'Manage sign-in, authenticator protection and cloud setup.'),
      button('Open Account & Security', () => { if (current()) options.openAccount?.(); })), cloud,
      card('Appearance', field('Theme', el('select', { 'aria-label': 'Appearance', onchange: event => options.setTheme?.(event.target.value) },
        [['auto', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']].map(([value, label]) => el('option', { value, selected: value === theme }, label))), 'Applies immediately on this device.')),
      card('Dates & times', field('Time zone', input(s, 'timeZone', 'Time zone'), 'Used to group dates and hours in this space. Choose Save to apply.'))];
  }
  function paySettings() {
    const s = draft(), tags = s.timeCalculationMode === 'tags';
    const checkbox = (key, label) => el('label', { class: 'inline' }, el('input', { type: 'checkbox', checked: s[key] !== false, onchange: event => { if (!current()) return; s[key] = event.target.checked; changed(); } }), label);
    const nodes = [card('Hourly pay', el('div', { class: 'grid2' }, field('Hourly rate', number(s, 'payRate', 'Hourly rate')), field('Currency', currency(s, 'payCurrency', 'Pay currency'))),
      el('p', { class: 'help' }, 'Used for the pay estimate on Overview.'))];
    nodes.push(tags ? card('Recorded hours only', el('p', { class: 'help' }, 'Clockify tag mode does not add day minimums or paid rest hours.')) : disclosure('Minimum pay & rest days', 'Optional additions for automatic time calculation',
      field('Minimum paid hours per day', number(s, 'payMinDay', 'Pay day minimum', { max: 24 })), checkbox('restDaysPaid', 'Include paid rest days'), field('Hours per rest day', number(s, 'restDayHours', 'Rest-day hours', { max: 24 }))));
    const rows = (s.timeCodeMappings || []).filter(row => row.mode === 'code' && timeCodeInfo(row.code));
    const overrides = el('div', { class: 'settings-pay-overrides' });
    for (const row of rows) {
      const info = timeCodeInfo(row.code);
      const multiplier = el('input', { type: 'number', min: 0, max: 10, step: 0.25, value: row.payMultiplier ?? '',
        placeholder: info.scope === 'work' ? `Default ×${info.payMultiplier}` : 'Unknown', 'aria-label': `Pay multiplier for ${row.tagName}` });
      const status = el('small', { role: 'status', class: 'help' });
      multiplier.addEventListener('input', () => {
        if (!current()) return;
        const value = multiplier.value === '' ? null : Number(multiplier.value);
        row.payMultiplier = value; row.confirmed = false;
        status.textContent = 'Changed. Review and confirm this tag in Timesheets before exporting it.'; changed();
      });
      overrides.append(el('div', { class: 'settings-pay-row' },
        field(row.tagName || info.label, multiplier, `${info.label} · ${row.code}`), status));
    }
    const multipliers = disclosure('Overtime & leave multipliers', `${rows.length} mapped time types · blank uses the work default or leaves leave pay unknown`,
      rows.length ? overrides : el('p', { class: 'help' }, 'Map your Clockify tags in Timesheets first.'),
      button('Review tag meanings in Timesheets', () => navigate('time', 'time-code-rows'), { class: 'link' }));
    multipliers.id = 'pay-multipliers';
    nodes.push(multipliers);
    return nodes;
  }
  function simpleList(key, label, placeholder = '') {
    const s = draft(), host = el('div', { class: 'settings-list-editor' });
    const paintRows = () => {
      host.replaceChildren(...(s[key] || []).map((value, index) => {
        const box = el('input', { value, placeholder, 'aria-label': `${label} ${index + 1}`, oninput: event => { s[key][index] = key === 'currencies' ? event.target.value.trim().toUpperCase() : event.target.value.trim(); changed(); } });
        return el('div', { class: 'settings-list-row' }, box, button('Remove', () => { s[key].splice(index, 1); changed(); paintRows(); }, { class: 'link' }));
      }));
      host.append(button(`Add ${label.toLowerCase()}`, () => { (s[key] ||= []).push(''); changed(); paintRows(); }));
    };
    paintRows(); return host;
  }
  function categories() {
    const s = draft(), host = el('div');
    const paintRows = () => {
      host.replaceChildren(...s.expenseCodes.map((item, index) => el('div', { class: 'settings-category-row' },
        field('Name', input(item, 'short', `Category name ${index + 1}`)),
        workspace === 'work' ? field('IFS code', input(item, 'code', `Category code ${index + 1}`, { inputmode: 'numeric' })) : '',
        workspace === 'work' ? advanced('IFS description', field('Description', input(item, 'desc', `Category description ${index + 1}`))) : '',
        button('Remove', () => { s.expenseCodes.splice(index, 1); changed(); paintRows(); }, { class: 'link' }))));
      if (workspace === 'personal') host.querySelectorAll('input').forEach((node, index) => node.addEventListener('input', () => { s.expenseCodes[index].desc = node.value.trim(); changed(); }));
      host.append(button('Add category', () => { const code = Math.max(workspace === 'personal' ? 90000 : 0, ...s.expenseCodes.map(item => Number(item.code) || 0)) + 1; s.expenseCodes.push({ code, short: '', desc: '' }); changed(); paintRows(); }));
    };
    paintRows(); return card('Expense categories', el('p', { class: 'help' }, workspace === 'work' ? 'Use the expense codes accepted by IFS. Changing this list does not rewrite old expenses.' : 'Organize future spending entries. Removing a category does not delete its old transactions.'), host);
  }
  function perDiem() {
    const s = draft(), host = el('div');
    const paintRows = () => {
      host.replaceChildren(...(s.perDiemDefaults || []).map((item, index) => el('div', { class: 'settings-rate-row' },
        field('Country', input(item, 'country', `Per diem country ${index + 1}`)), field('Daily amount', number(item, 'rate', `Per diem amount ${index + 1}`, { empty: null })), field('Currency', currency(item, 'currency', `Per diem currency ${index + 1}`)),
        button('Remove', () => { s.perDiemDefaults.splice(index, 1); changed(); paintRows(); }, { class: 'link' }))));
      host.append(button('Add country rate', () => { (s.perDiemDefaults ||= []).push({ country: '', rate: 0, currency: s.defaultCurrency }); changed(); paintRows(); }));
    };
    paintRows(); return card('Daily allowances (per diem)', el('p', { class: 'help' }, 'A daily amount for each country. Both 70.50 and 70,50 mean seventy and a half.'), host);
  }
  function spending() {
    const s = draft(), nodes = [card('Currency', field('Default currency', currency(s, 'defaultCurrency', 'Default currency')), advanced('Available currencies', simpleList('currencies', 'Currency', 'USD'))), categories()];
    if (workspace === 'personal') return [nodes[0], foldCard(nodes[1], `${s.expenseCodes.length} categories · names used for your spending`)];
    nodes.push(card('Exchange rates', el('div', { class: 'grid2' }, field('Home currency', currency(s, 'homeCurrency', 'Home currency')),
      field('Exchange-rate source', select(s, 'rateSource', 'Exchange-rate source', [['tcmb', 'Daily Central Bank rate'], ['manual', 'Rate entered on the expense sheet']]))),
      advanced('Advanced · IFS rate fields', field('TCMB rate column', select(s, 'tcmbField', 'TCMB rate column', [['ForexBuying', 'Döviz alış'], ['ForexSelling', 'Döviz satış'], ['BanknoteBuying', 'Efektif alış'], ['BanknoteSelling', 'Efektif satış']])),
        field('If a rate is unavailable', select(s, 'currRateMode', 'Missing-rate behavior', [['blank', 'Send the field empty'], ['omit', 'Omit the rate field'], ['one', 'Always 1 (legacy behavior)']])))), perDiem(),
      card('IFS expense destinations', simpleList('costObjects', 'Cost object', '/Personal 1'), advanced('Advanced · IFS destinations', field('Activity suffix', input(s, 'expenseActivitySuffix', 'Expense activity suffix')), simpleList('knownShortNames', 'Destination', 'PROJECT.SUBPROJECT.ACTIVITY'))));
    const template = el('textarea', { rows: 6, 'aria-label': 'Expense row template', spellcheck: 'false', oninput: event => { s.expenseTemplate = event.target.value; changed(); } }, s.expenseTemplate || '');
    const pasted = el('textarea', { rows: 3, 'aria-label': 'Copied expense row', placeholder: 'Paste one IFS Expense Details Copy Object row…' }), status = el('p', { class: 'help', role: 'status' });
    nodes.push(card('IFS expense template', advanced('Advanced · copied row and raw template', pasted,
      button('Use copied expense row', () => {
        if (!current()) return;
        const rec = parseCopyObject(pasted.value);
        if (rec?.lu !== 'ExpenseDetail') { status.textContent = 'Paste an Expense Details Copy Object row.'; return; }
        const seen = rec.fields.find(f => f.name === 'SHORT_NAME')?.value?.trim();
        if (seen && !(s.knownShortNames || []).includes(seen)) s.knownShortNames = [...(s.knownShortNames || []), seen];
        for (const f of rec.fields) if (['EXPENSE_ID', 'ACCOUNT_DATE', 'EXPENSE_CODE', 'DESCRIPTION', 'REFERENCE', 'CURRENCY_CODE', 'GROSS_CURR_AMOUNT', 'SEQ_NO', 'SHORT_NAME', 'C_SHORT_NAME'].includes(f.name)) f.value = '';
        s.expenseTemplate = ['!IFS.COPYOBJECT', `$LU=${rec.lu}`, `$VIEW=${rec.view}`, '$RECORD=!', ...rec.fields.map(f => `-$${f.n}:${f.name}=${f.value}`), '-'].join('\n');
        template.value = s.expenseTemplate; status.textContent = 'Copied row loaded into your draft. Save settings to keep it.'; changed();
      }), status, field('Raw row template', template))));
    nodes[nodes.length - 1].id = 'expense-template';
    return nodes.map((node, index) => index === 0 ? node : foldCard(node, [null, `${s.expenseCodes.length} categories · names and IFS codes`, 'Where conversion rates come from', `${(s.perDiemDefaults || []).length} country rates`, 'Cost objects and project activity names', 'Copied IFS expense row · initial setup only'][index]));
  }
  function backup() {
    const s = draft(), status = el('p', { id: 'settings-transfer-status', class: 'help', role: 'status' });
    const includeKey = el('input', { type: 'checkbox', id: 'settings-include-key' });
    const file = el('input', { type: 'file', accept: '.json,application/json', hidden: true, id: 'settings-file' });
    file.addEventListener('change', async () => {
      const chosen = file.files?.[0], ticket = generation; file.value = ''; if (!chosen || !current()) return;
      try {
        if (chosen.size > 1024 * 1024) throw Error('Choose a settings file smaller than 1 MB.');
        const text = await chosen.text(); if (!alive(ticket)) return;
        const imported = parseSettingsFile(text, { workspace, current: draft() });
        const body = el('div', {}, el('p', {}, `Load ${imported.summary.fieldCount} settings into this ${workspace === 'personal' ? 'Personal' : 'Work'} draft. Review and Save afterwards to apply them.`),
          el('p', { class: 'help' }, imported.includesApiKey ? 'This file includes a Clockify API key.' : 'Your existing Clockify key is kept.'));
        const dialog = openDialog('Import settings into draft', body);
        body.append(el('div', { class: 'actions' }, button('Load into draft', () => {
          if (!alive(ticket)) { dialog.close(); return; }
          importUndo = jsonClone(draft()); dialog.close(); replaceDraft(imported.settings); setMessage('Settings imported into draft. Review changes, then Save.');
        }, { class: 'primary', id: 'settings-apply' }), button('Cancel', () => dialog.close())));
      } catch (error) { if (alive(ticket)) status.textContent = `Import failed: ${error.message}`; }
    });
    const nodes = [card('Settings file', el('p', { class: 'help' }, `Export this ${workspace === 'personal' ? 'Personal' : 'Work'} setup for your phone or another browser. Records and login sessions are not included.`),
      workspace === 'work' ? el('label', { class: 'inline' }, includeKey, 'Include Clockify API key (readable in the file)') : '',
      el('div', { class: 'row' }, button('Export settings', () => {
        if (!current() || !validate()) return;
        try { const payload = createSettingsFile(s, { workspace, includeApiKey: workspace === 'work' && includeKey.checked });
          (options.download || download)(`ifsbridge-${workspace}-settings-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json'); status.textContent = 'Settings file downloaded. It includes the current draft.';
        } catch (error) { status.textContent = error.message; }
      }, { id: 'settings-export' }), button('Import settings…', () => file.click(), { id: 'settings-import' }), importUndo ? button('Undo last import', () => { const previous = importUndo; importUndo = null; replaceDraft(previous); }, { id: 'settings-undo-import' }) : ''), file, status)];
    nodes.push(card('Records & receipts backup', el('p', { class: 'help' }, 'These actions operate on saved records. Unsaved Settings edits are not included.'),
      el('div', { class: 'row' }, button('Download full backup', () => options.backupRecords?.())),
      advanced('Restore records from backup', el('p', { class: 'help' }, 'Save or discard your Settings draft first. Restoring records is separate from importing settings.'),
        field('Backup file', el('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Restore records file', onchange: async event => {
          const selected = event.target.files?.[0], ticket = generation; event.target.value = ''; if (!selected || !current()) return;
          if (dirty().length) { setMessage('Save or discard your Settings draft before restoring records.'); return; }
          try { const text = await selected.text(); if (!alive(ticket)) return; await options.restoreRecords?.(text); if (!alive(ticket)) return; session = createSettingsDraft(getSaved(), workspace); paint(); setMessage('Backup restored.'); }
          catch (error) { if (alive(ticket)) setMessage(`Restore failed: ${error.message}`); }
        } })))));
    nodes.push(card('Spreadsheet export', el('p', { class: 'help' }, 'Download saved expenses as a CSV file.'), button('Export expenses CSV', () => options.exportRecords?.())));
    if (options.backupAvailable?.()) nodes.push(card('PC backup', el('p', { class: 'help' }, 'The local backup service is available.'), button('Back up now', async () => {
      const ticket = generation; try { const result = await options.pushBackup?.(); if (alive(ticket)) setMessage(result?.error || 'PC backup saved.'); } catch (error) { if (alive(ticket)) setMessage(error.message); }
    })));
    nodes.push(card('Reset preferences', advanced('Reset this space to defaults', el('p', { class: 'help' }, 'Loads defaults into a draft. Your connection is kept; review and Save to apply. Records are unchanged.'), button('Load defaults into draft', () => {
      const keep = { clockify: jsonClone(s.clockify), supabase: jsonClone(s.supabase) }; replaceDraft({ ...options.defaults(), ...keep }); setMessage('Defaults loaded into the draft. Review before saving.');
    }, { class: 'link danger' }))));
    const descriptions = { 'Records & receipts backup': 'Download or restore your saved records', 'Spreadsheet export': 'Export saved expenses as a CSV file', 'PC backup': 'Save a copy through the local backup service', 'Reset preferences': 'Restore default preferences into a draft' };
    return nodes.map((node, index) => index === 0 ? node : foldCard(node, descriptions[node.querySelector('h3').textContent]));
  }
  function paintGroup() {
    fieldChecks = [];
    const s = draft(), ticket = generation;
    const connection = () => ({ ...s.clockify, enteredKey: s.clockify.apiKey });
    const opts = { onChange: changed, isCurrent: () => alive(ticket) && s === draft(), connection, getTags: options.getTags, getProjects: options.getProjects };
    let nodes;
    if (group === 'home') nodes = home();
    else if (group === 'connections') nodes = connections();
    else if (group === 'app') nodes = appSettings();
    else if (group === 'spending') nodes = spending();
    else if (group === 'pay') nodes = paySettings();
    else if (group === 'backup') nodes = backup();
    else {
      const time = renderTimeSetup(s, { ...opts, openPay: () => navigate('pay', 'pay-multipliers') });
      const projects = renderProjectSettings(s, { ...opts, onImportCatalog: time.refreshCatalog });
      const projectSection = disclosure('IFS project destinations', `${(s.mapping || []).length} projects · choose where each timesheet goes`, projects.element);
      projectSection.id = 'settings-project-destinations';
      const id = s.identity ||= {};
      const employee = disclosure('IFS employee details', 'Company and employee identifiers · initial setup only',
        el('p', { class: 'help' }, 'A copied IFS time row can fill these fields for you.'),
        el('div', { class: 'grid2' }, ...[['companyId', 'Company'], ['empNo', 'Employee number'], ['resourceId', 'Resource ID'], ['resourceSeq', 'Resource sequence'], ['resourceName', 'Name']].map(([key, label]) => field(label, input(id, key, label)))));
      nodes = [time.element, projectSection, employee];
    }
    content.replaceChildren(...nodes);
    if (group === 'home') for (const node of content.querySelectorAll('[data-group]')) {
      const name = node.dataset.group;
      node.append(el('span', { class: 'settings-home-copy' }, el('strong', {}, labelFor(name)),
        el('small', {}, workspace === 'personal' && name === 'spending' ? 'Categories and currencies for monthly spending' : groups[name].description)),
        el('span', { class: 'settings-home-arrow', 'aria-hidden': true }, '›'));
    }
    heading.textContent = labelFor(group);
    navigation.hidden = group === 'home';
    root.dataset.settingsSection = group;
    content.scrollTop = 0; errorBox.hidden = true;
  }
  function destination(name, focus) {
    if (name === 'projects') return { name: 'time', focus: focus || 'project-mapping' };
    if (name === 'expenses') name = 'spending';
    return { name, focus };
  }
  function navigate(name, focus) {
    ({ name, focus } = destination(name, focus));
    if (!current() || pending || !validGroups.includes(name)) return;
    ++generation; group = name; paintGroup(); changed();
    if (focus) {
      const target = { 'time-code-rows': 'time-tags-settings', 'project-mapping': 'project-read-clockify' }[focus] || focus;
      const token = String(target).replace(/[^a-zA-Z0-9_-]/g, '');
      const node = content.querySelector(`[data-setting="${token}"],#${token}`);
      if (node) {
        for (const parent of [node, ...ancestors(node)]) if (parent.tagName === 'DETAILS') parent.open = true;
        if (focus === 'expense-template') node.querySelector('details')?.setAttribute('open', '');
        if (!node.matches('button,input,select,textarea,a,[tabindex]')) node.tabIndex = -1;
        node.scrollIntoView({ block: 'center' }); node.focus({ preventScroll: true });
      }
    }
  }
  function paint() {
    if (!root || disposed || !isCurrent()) return;
    ++generation;
    heading = el('h2', { class: 'settings-page-title' });
    navigation = button('‹ All settings', () => navigate('home'), { class: 'settings-back', 'aria-label': 'Back to all settings' });
    content = el('div', { class: 'settings-fields', role: 'region', 'aria-label': 'Settings fields', tabindex: 0 });
    errorBox = el('div', { class: 'settings-errors', role: 'alert', tabindex: -1, hidden: true });
    saveStatus = el('span', { id: 'save-status', role: 'status', 'aria-live': 'polite' });
    saveButton = button('Save changes', commit, { class: 'primary', id: 'settings-save' });
    reviewButton = button('Review changes', review, { id: 'settings-review' });
    discardButton = button('Discard', discard, { class: 'link', id: 'settings-discard' });
    notice = el('p', { class: 'settings-notice', role: 'status', 'aria-live': 'polite', hidden: true });
    saveBar = el('div', { class: 'actions settings-save', hidden: true }, el('div', { class: 'settings-save-buttons' }, saveButton, reviewButton, discardButton), saveStatus);
    root.classList.add('settings-redesign', 'settings-focused');
    root.replaceChildren(el('div', { class: 'settings-page-header' }, navigation, heading),
      el('div', { class: 'settings-editor' }, errorBox, content), notice, saveBar);
    paintGroup(); changed();
  }
  return {
    mount(node, name, focus) { root = node; ({ name, focus } = destination(name, focus)); if (validGroups.includes(name)) group = name; paint(); if (focus) navigate(group, focus); },
    navigate, dispose() { disposed = true; ++generation; root?.replaceChildren(); options.onDirty?.(0); },
    get dirty() { return dirty().length > 0; }, get draft() { return jsonClone(draft()); },
    discard, save: commit
  };
}
