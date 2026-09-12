import { el, field, openDialog, download } from './dom.js';
import { Clockify } from './clockify.js';
import { createSettingsFile, parseSettingsFile } from './settings-transfer.js';
import { createSettingsDraft, decimalSetting, validateStructuredSettings, mergeSettingsDraft } from './settings-model.js';
import { renderTimeSetup, validateTimeSettings } from './settings-time.js';
import { renderProjectSettings, validateProjectSettings } from './settings-projects.js';
import { parseCopyObject } from './ifs.js';

const groups = { connections: 'Connections', time: 'Time', projects: 'Projects', spending: 'Spending', backup: 'Backup' };
const button = (label, run, attrs = {}) => el('button', { type: 'button', onclick: run, ...attrs }, label);
const card = (title, ...content) => el('section', { class: 'settings-card' }, el('h3', {}, title), ...content);
const advanced = (title, ...content) => el('details', { class: 'settings-advanced' }, el('summary', {}, title), ...content);
const jsonClone = value => structuredClone(value);
function ancestors(node) { const out = []; while ((node = node.parentElement)) out.push(node); return out; }

// This controller owns only a draft. Business modules keep reading the saved
// settings until a successful explicit Save replaces them through onSave.
export function createSettingsPage(options) {
  const { workspace = 'work', getSaved, onSave, isCurrent = () => true } = options;
  let session = createSettingsDraft(getSaved(), workspace), root, content, saveStatus, saveButton, reviewButton, discardButton;
  let group = workspace === 'personal' ? 'spending' : 'time', generation = 0, disposed = false, pending = false, importUndo = null;
  let validators = [], fieldChecks = [], heading, errorBox, search, navigation, picker;
  const validGroups = Object.keys(groups).filter(name => workspace !== 'personal' || !['time', 'projects'].includes(name));
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
    if (picker) picker.disabled = pending;
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
  const setMessage = message => { if (saveStatus && current()) saveStatus.textContent = message; };
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
  function connections() {
    const s = draft(), nodes = [];
    nodes.push(card('Account & security', el('p', { class: 'help' }, 'Sign-in and authenticator protection apply to this account. Work and Personal keep separate preferences.'),
      button('Open Account & Security', () => { if (current()) options.openAccount?.(); }), options.connectionStatusPanel?.() || ''));
    if (workspace === 'work') {
      const key = input(s.clockify, 'apiKey', 'Clockify API key', { type: 'password', autocomplete: 'off', spellcheck: 'false', id: 'set-key' });
      const status = el('p', { id: 'key-status', class: 'help', role: 'status' }, s.clockify.userName ? `Connected as ${s.clockify.userName}` : 'Add your key, then test the connection.');
      key.addEventListener('input', () => { s.clockify.userId = ''; s.clockify.workspaceId = ''; s.clockify.userName = ''; status.textContent = 'Key changed. Test this connection before reading projects or tags.'; changed(); });
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
          status.textContent = `Connected as ${user.name}. Save to use this connection. No time entries were changed.`; changed();
        } catch (error) { if (alive(ticket)) status.textContent = `Connection failed: ${error.message}`; }
        finally { if (alive(ticket)) test.disabled = false; }
      }, { id: 'test-clockify-connection' });
      nodes.push(card('Clockify', field('API key', key, 'Clockify → Profile settings → API.'), el('div', { class: 'row' }, test, button('Time setup', () => navigate('time')), button('Project destinations', () => navigate('projects'))), status));
    }
    const theme = options.getTheme?.() || 'auto';
    nodes.push(card('This device', field('Appearance', el('select', { 'aria-label': 'Appearance', onchange: event => options.setTheme?.(event.target.value) },
      [['auto', 'Follow system'], ['light', 'Light'], ['dark', 'Dark']].map(([value, label]) => el('option', { value, selected: value === theme }, label))), 'Applies immediately on this device.'), field('Time zone', input(s, 'timeZone', 'Time zone'))));
    return nodes;
  }
  function paySettings() {
    const s = draft(), tags = s.timeCalculationMode === 'tags';
    const checkbox = (key, label) => el('label', { class: 'inline' }, el('input', { type: 'checkbox', checked: s[key] !== false, onchange: event => { s[key] = event.target.checked; changed(); } }), label);
    return card('Pay estimate', el('div', { class: 'grid2' }, field('Hourly rate', number(s, 'payRate', 'Hourly rate')), field('Currency', currency(s, 'payCurrency', 'Pay currency'))),
      el('p', { class: 'help' }, 'An estimate only. Leave and holiday pay stay unknown until you set their multiplier.'),
      tags ? el('p', { class: 'help' }, 'Clockify tag mode uses recorded hours only. No automatic day minimum or paid-rest hours are added.') : advanced('Advanced · pay additions',
        field('Day minimum (h)', number(s, 'payMinDay', 'Pay day minimum', { max: 24 })), checkbox('restDaysPaid', 'Include paid rest days'), field('Rest-day hours', number(s, 'restDayHours', 'Rest-day hours', { max: 24 }))));
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
    paintRows(); return card('Categories', el('p', { class: 'help' }, workspace === 'work' ? 'Use the expense codes accepted by IFS. Changing this list does not rewrite old expenses.' : 'Organize future spending entries. Removing a category does not delete its old transactions.'), host);
  }
  function perDiem() {
    const s = draft(), host = el('div');
    const paintRows = () => {
      host.replaceChildren(...(s.perDiemDefaults || []).map((item, index) => el('div', { class: 'settings-rate-row' },
        field('Country', input(item, 'country', `Per diem country ${index + 1}`)), field('Daily amount', number(item, 'rate', `Per diem amount ${index + 1}`, { empty: null })), field('Currency', currency(item, 'currency', `Per diem currency ${index + 1}`)),
        button('Remove', () => { s.perDiemDefaults.splice(index, 1); changed(); paintRows(); }, { class: 'link' }))));
      host.append(button('Add country rate', () => { (s.perDiemDefaults ||= []).push({ country: '', rate: 0, currency: s.defaultCurrency }); changed(); paintRows(); }));
    };
    paintRows(); return card('Per diem defaults', el('p', { class: 'help' }, 'A daily amount for each country. Both 70.50 and 70,50 mean seventy and a half.'), host);
  }
  function spending() {
    const s = draft(), nodes = [card('Currency', field('Default currency', currency(s, 'defaultCurrency', 'Default currency')), advanced('Available currencies', simpleList('currencies', 'Currency', 'USD'))), categories()];
    if (workspace === 'personal') return nodes;
    nodes.push(card('Exchange rates', el('div', { class: 'grid2' }, field('Home currency', currency(s, 'homeCurrency', 'Home currency')),
      field('Other currencies', select(s, 'rateSource', 'Exchange-rate source', [['tcmb', 'Daily Central Bank rate'], ['manual', 'Rate entered on the expense sheet']]))),
      advanced('Advanced · IFS rate fields', field('TCMB rate column', select(s, 'tcmbField', 'TCMB rate column', [['ForexBuying', 'Döviz alış'], ['ForexSelling', 'Döviz satış'], ['BanknoteBuying', 'Efektif alış'], ['BanknoteSelling', 'Efektif satış']])),
        field('If a rate is unavailable', select(s, 'currRateMode', 'Missing-rate behavior', [['blank', 'Send the field empty'], ['omit', 'Omit the rate field'], ['one', 'Always 1 (legacy behavior)']])))), perDiem(),
      card('Expense destinations', simpleList('costObjects', 'Cost object', '/Personal 1'), advanced('Advanced · IFS destinations', field('Activity suffix', input(s, 'expenseActivitySuffix', 'Expense activity suffix')), simpleList('knownShortNames', 'Destination', 'PROJECT.SUBPROJECT.ACTIVITY'))));
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
    return nodes;
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
    const nodes = [card('Transfer your setup', el('p', { class: 'help' }, `Export this ${workspace === 'personal' ? 'Personal' : 'Work'} setup for your phone or another browser. Records and login sessions are not included.`),
      workspace === 'work' ? el('label', { class: 'inline' }, includeKey, 'Include Clockify API key (readable in the file)') : '',
      el('div', { class: 'row' }, button('Export settings', () => {
        if (!current() || !validate()) return;
        try { const payload = createSettingsFile(s, { workspace, includeApiKey: workspace === 'work' && includeKey.checked });
          (options.download || download)(`ifsbridge-${workspace}-settings-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2), 'application/json'); status.textContent = 'Settings file downloaded. It includes the current draft.';
        } catch (error) { status.textContent = error.message; }
      }, { id: 'settings-export' }), button('Import settings…', () => file.click(), { id: 'settings-import' }), importUndo ? button('Undo last import', () => { const previous = importUndo; importUndo = null; replaceDraft(previous); }, { id: 'settings-undo-import' }) : ''), file, status)];
    nodes.push(card('Records and receipts', el('p', { class: 'help' }, 'These actions operate on saved records. Unsaved Settings edits are not included.'),
      el('div', { class: 'row' }, button('Export expenses CSV', () => options.exportRecords?.()), button('Download full backup', () => options.backupRecords?.())),
      advanced('Restore records from backup', el('p', { class: 'help' }, 'Save or discard your Settings draft first. Restoring records is separate from importing settings.'),
        field('Backup file', el('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Restore records file', onchange: async event => {
          const selected = event.target.files?.[0], ticket = generation; event.target.value = ''; if (!selected || !current()) return;
          if (dirty().length) { setMessage('Save or discard your Settings draft before restoring records.'); return; }
          try { const text = await selected.text(); if (!alive(ticket)) return; await options.restoreRecords?.(text); if (!alive(ticket)) return; session = createSettingsDraft(getSaved(), workspace); paint(); setMessage('Backup restored.'); }
          catch (error) { if (alive(ticket)) setMessage(`Restore failed: ${error.message}`); }
        } })))));
    if (options.backupAvailable?.()) nodes.push(card('PC backup', el('p', { class: 'help' }, 'The local backup service is available.'), button('Back up now', async () => {
      const ticket = generation; try { const result = await options.pushBackup?.(); if (alive(ticket)) setMessage(result?.error || 'PC backup saved.'); } catch (error) { if (alive(ticket)) setMessage(error.message); }
    })));
    nodes.push(card('Reset preferences', advanced('Reset this space to defaults', el('p', { class: 'help' }, 'Loads defaults into a draft. Your connection is kept; review and Save to apply. Records are unchanged.'), button('Load defaults into draft', () => {
      const keep = { clockify: jsonClone(s.clockify), supabase: jsonClone(s.supabase) }; replaceDraft({ ...options.defaults(), ...keep }); setMessage('Defaults loaded into the draft. Review before saving.');
    }, { class: 'link danger' }))));
    return nodes;
  }
  function paintGroup() {
    validators = []; fieldChecks = [];
    const s = draft(), ticket = generation;
    const connection = () => ({ ...s.clockify, enteredKey: s.clockify.apiKey });
    const opts = { onChange: changed, isCurrent: () => alive(ticket) && s === draft(), connection, getTags: options.getTags, getProjects: options.getProjects };
    let nodes;
    if (group === 'connections') nodes = connections();
    else if (group === 'spending') nodes = spending();
    else if (group === 'backup') nodes = backup();
    else if (group === 'time') {
      let shownMode = s.timeCalculationMode, pay = paySettings();
      const time = renderTimeSetup(s, { ...opts, onChange: () => {
        changed();
        if (s.timeCalculationMode !== shownMode) { shownMode = s.timeCalculationMode; const next = paySettings(); pay.replaceWith(next); pay = next; }
      } }); validators.push(time.validate);
      nodes = [time.element, pay];
    } else {
      const projects = renderProjectSettings(s, opts); validators.push(projects.validate); nodes = [projects.element];
      const id = s.identity ||= {};
      nodes.push(card('IFS identity', el('p', { class: 'help' }, 'Copied IFS time rows can fill this automatically. Review these fields when setting up a new account.'),
        advanced('Advanced · employee fields', el('div', { class: 'grid2' }, ...[['companyId', 'Company'], ['empNo', 'Employee number'], ['resourceId', 'Resource ID'], ['resourceSeq', 'Resource sequence'], ['resourceName', 'Name']].map(([key, label]) => field(label, input(id, key, label)))))));
    }
    content.replaceChildren(...nodes);
    heading.textContent = groups[group]; picker.value = group;
    for (const item of navigation.querySelectorAll('button')) item.setAttribute('aria-current', item.dataset.group === group ? 'page' : 'false');
    content.scrollTop = 0; errorBox.hidden = true;
    if (search) search.value = '';
  }
  function navigate(name, focus) {
    if (!current() || pending || !validGroups.includes(name)) return;
    ++generation; group = name; paintGroup(); changed();
    if (focus) {
      const destination = { 'time-code-rows': 'time-setup-attention', 'project-mapping': 'project-read-clockify' }[focus] || focus;
      const token = String(destination).replace(/[^a-zA-Z0-9_-]/g, '');
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
    heading = el('h2', { class: 'settings-group-heading' });
    picker = el('select', { class: 'settings-group-picker', 'aria-label': 'Settings section', onchange: event => navigate(event.target.value) }, validGroups.map(name => el('option', { value: name }, groups[name])));
    navigation = el('nav', { class: 'settings-group-nav', 'aria-label': 'Settings sections' }, validGroups.map(name => button(groups[name], () => navigate(name), { 'data-group': name })));
    content = el('div', { class: 'settings-fields', role: 'region', 'aria-label': 'Settings fields', tabindex: 0 });
    errorBox = el('div', { class: 'settings-errors', role: 'alert', tabindex: -1, hidden: true });
    saveStatus = el('span', { id: 'save-status', role: 'status', 'aria-live': 'polite' });
    saveButton = button('Save changes', commit, { class: 'primary', id: 'settings-save' });
    reviewButton = button('Review changes', review, { id: 'settings-review' });
    discardButton = button('Discard', discard, { class: 'link', id: 'settings-discard' });
    root.classList.add('settings-redesign');
    root.replaceChildren(el('div', { class: 'settings-navigation' }, picker, navigation),
      el('div', { class: 'settings-editor' }, heading, errorBox, content), el('div', { class: 'actions settings-save' }, el('div', { class: 'settings-save-buttons' }, saveButton, reviewButton, discardButton), saveStatus));
    paintGroup(); changed();
  }
  return {
    mount(node, name, focus) { root = node; if (validGroups.includes(name)) group = name; paint(); if (focus) navigate(group, focus); },
    navigate, dispose() { disposed = true; ++generation; root?.replaceChildren(); options.onDirty?.(0); },
    get dirty() { return dirty().length > 0; }, get draft() { return jsonClone(draft()); },
    discard, save: commit
  };
}
