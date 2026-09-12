import { el } from './dom.js';
import { Clockify } from './clockify.js';
import { TIME_CODE_CATALOG, effectiveTimeCodeMappings, calculationMode, timeCodeInfo, completeGeneralActivity } from './time-codes.js';

const field = (label, control, hint) => el('label', { class: 'field' }, el('span', {}, label), control, hint ? el('small', {}, hint) : null);
const defaultConnection = draft => ({ ...draft.clockify, enteredKey: draft.clockify?.apiKey || '' });
const sameConnection = (a, b) => a.apiKey === b.apiKey && a.workspaceId === b.workspaceId && (b.enteredKey ?? b.apiKey) === a.apiKey;
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

function timeMeaningProblems(draft, row) {
  const errors = [];
  if (!row.tagName?.trim()) errors.push('Enter the Clockify tag name.');
  if (!['code', 'label'].includes(row.mode)) errors.push('Choose what the tag means.');
  if (row.mode === 'code') {
    const info = timeCodeInfo(row.code);
    if (!info) errors.push('Choose a supported IFS meaning.');
    if (row.payMultiplier != null && (!Number.isFinite(row.payMultiplier) || row.payMultiplier < 0 || row.payMultiplier > 10)) errors.push('Use a pay multiplier from 0 to 10, or leave it blank.');
    if (calculationMode(draft) === 'rules' && info?.scope === 'work' && Object.values(draft.codes || {}).includes(row.code) && row.payMultiplier != null && row.payMultiplier !== info.payMultiplier) errors.push('Automatic work rules use the standard multiplier. Clear the override or choose Use Clockify tags.');
  }
  if ((draft.timeCodeMappings || []).some(other => other !== row && (other.tagName === row.tagName || (row.tagId && other.tagId === row.tagId)))) errors.push('This tag already has another mapping. Keep one meaning.');
  return errors;
}

// Save validates the entire draft, even when another Settings section is open.
// Unfinished meanings remain savable; confirmed invalid meanings do not.
export function validateTimeSettings(draft) {
  const errors = [];
  for (const [key, label, min] of [['roundStep', 'Rounding step', 0.001], ...(calculationMode(draft) === 'rules' ? [['regularHours', 'Regular hours', 0], ['travelAfterHours', 'Travel threshold', 0]] : [])]) {
    const value = draft[key]; if (value == null || !Number.isFinite(value) || value < min || value > 24) errors.push(`${label} must be between ${min} and 24 hours.`);
  }
  if (!['nearest', 'up', 'down'].includes(draft.roundMode)) errors.push('Choose a rounding direction.');
  if (calculationMode(draft) === 'rules') {
    if ((draft.holidays || []).some(date => !validDate(date))) errors.push('Use real holiday dates in YYYY-MM-DD format.');
    try { new RegExp(`^\\s*${draft.travelKeyword || ''}\\b`, 'i'); } catch { errors.push('The travel recognition expression is invalid.'); }
    if (Object.values(draft.codes || {}).some(code => timeCodeInfo(code)?.scope !== 'work')) errors.push('Automatic rules need supported work codes. Check their advanced settings.');
  }
  for (const row of draft.timeCodeMappings || []) {
    if (row.payMultiplier != null && (!Number.isFinite(row.payMultiplier) || row.payMultiplier < 0 || row.payMultiplier > 10)) errors.push(`${row.tagName || 'Tag'}: use a pay multiplier from 0 to 10, or leave it blank.`);
    if (row.confirmed) errors.push(...timeMeaningProblems(draft, row).map(error => `${row.tagName || 'Tag'}: ${error}`));
  }
  return [...new Set(errors)];
}

/** A local draft editor. The surrounding Settings page owns Save and Discard. */
export function renderTimeSetup(draft, options = {}) {
  draft.timeCodeMappings = effectiveTimeCodeMappings(draft);
  draft.timeCodeMappingsVersion = 2;
  draft.timeCalculationMode = calculationMode(draft);
  const element = el('div', { class: 'settings-time', 'data-settings-editor': 'time' });
  const alive = () => element.isConnected && (options.isCurrent?.() ?? true);
  const changed = () => options.onChange?.();
  const connection = () => options.connection?.() || defaultConnection(draft);
  let fetchedTags = [], request = 0;
  const selected = new Set(), leaveDrafts = new WeakSet(), openRows = new WeakSet();
  const descriptions = new Map();
  const summary = el('div', { class: 'settings-attention', role: 'status', 'aria-live': 'polite', id: 'time-setup-attention' });
  const tagCount = el('small', { class: 'time-tag-count', id: 'time-tag-count' });
  const status = el('p', { class: 'help', role: 'status', 'aria-live': 'polite', id: 'time-setup-status' });
  const automatic = el('div', { class: 'time-automatic', id: 'time-automatic-settings' });
  const workRows = el('div', { class: 'time-meaning-list', id: 'time-work-mappings' });
  const leaveRows = el('div', { class: 'time-meaning-list', id: 'time-leave-mappings' });
  const generalStatus = el('p', { class: 'help', id: 'time-general-readiness' });
  const tagChoices = el('datalist', { id: 'settings-time-tag-options' });
  const confirmSelected = el('button', { id: 'time-confirm-selected', hidden: true, onclick: () => {
    if (!alive()) return;
    const rows = draft.timeCodeMappings.filter(row => selected.has(row));
    if (!rows.length) { status.textContent = 'Select the tag meanings you want to confirm first.'; return; }
    const errors = rows.flatMap(meaningProblems);
    if (errors.length) { status.textContent = errors.join(' '); return; }
    rows.forEach(row => { row.confirmed = true; openRows.delete(row); }); selected.clear(); changed(); refreshRows(); status.textContent = `${rows.length} meanings confirmed in your draft.`;
  } }, 'Confirm selected');
  const isLeave = row => timeCodeInfo(row.code)?.scope === 'general-only' || leaveDrafts.has(row);
  const meaningProblems = row => timeMeaningProblems(draft, row);
  const updateSummary = () => {
    const pending = draft.timeCodeMappings.filter(row => !row.confirmed).length;
    const invalid = draft.timeCodeMappings.filter(row => row.confirmed && meaningProblems(row).length).length;
    const confirmed = draft.timeCodeMappings.length - pending - invalid;
    tagCount.textContent = `${confirmed} confirmed · ${pending + invalid} need review`;
    confirmSelected.hidden = selected.size === 0;
    confirmSelected.textContent = `Confirm selected (${selected.size})`;
    summary.textContent = invalid ? `${invalid} confirmed meaning${invalid === 1 ? '' : 's'} conflict with the current settings. Review the message beside each affected tag before saving.` : pending ? `${pending} tag meaning${pending === 1 ? '' : 's'} need your confirmation. You can save the draft and finish later; affected timesheets cannot be exported yet.` : 'Your tag meanings are confirmed. Read tags again when you add or rename them in Clockify.';
    summary.classList.toggle('is-clear', !pending && !invalid);
    summary.hidden = !pending && !invalid;
    const generals = (draft.mapping || []).filter(completeGeneralActivity);
    const unique = new Set(generals.map(m => `${m.shortName}|${m.activitySeq}`));
    generalStatus.textContent = unique.size === 1 ? `Destination: ${generals[0].shortName}. Leave logged against a mapped work project goes here.` : unique.size ? 'Several General destinations exist. An entry on General keeps its own destination; work-project leave needs an unambiguous destination.' : 'General needs setup under IFS project destinations below before leave or holiday hours can be exported.';
  };
  const refreshCatalog = () => {
    descriptions.clear();
    for (const info of TIME_CODE_CATALOG) descriptions.set(info.code, info.description);
    for (const [code, description] of Object.entries(draft.codeDescriptions || {})) descriptions.set(code, description);
    for (const item of draft.timeCodeCatalog || []) descriptions.set(item.code, item.description);
    updateSummary();
  };
  const refreshRows = () => {
    workRows.replaceChildren(); leaveRows.replaceChildren();
    draft.timeCodeMappings.forEach((row, index) => {
      const card = el('details', { class: 'time-meaning-row', 'data-tag-index': index, open: openRows.has(row) });
      card.addEventListener('toggle', () => { if (!alive() || !card.isConnected) return; card.open ? openRows.add(row) : openRows.delete(row); });
      const rowName = el('strong'), rowMeaning = el('span', { class: 'time-meaning-label' }), rowBadge = el('small', { class: 'time-meaning-badge' });
      const updateRowSummary = () => {
        rowName.textContent = row.tagName || 'New tag';
        rowMeaning.textContent = row.mode === 'label' ? 'Label only' : timeCodeInfo(row.code)?.label || 'Choose meaning';
        const needsReview = !row.confirmed || meaningProblems(row).length > 0;
        rowBadge.textContent = needsReview ? 'Review' : 'Confirmed'; rowBadge.classList.toggle('needs-review', needsReview);
      };
      const check = el('input', { type: 'checkbox', checked: selected.has(row), 'aria-label': `Select ${row.tagName || 'new tag'} for confirmation`, onchange: e => { if (!alive()) return; e.target.checked ? selected.add(row) : selected.delete(row); updateSummary(); } });
      const name = el('input', { value: row.tagName || '', list: 'settings-time-tag-options', placeholder: 'Tag as shown in Clockify', 'aria-label': `Clockify tag ${index + 1}` });
      const choice = el('select', { 'aria-label': `Meaning of tag ${index + 1}` }, el('option', { value: '' }, 'Choose meaning…'),
        el('optgroup', { label: 'Work and travel' }, TIME_CODE_CATALOG.filter(info => info.scope === 'work').map(info => el('option', { value: info.code, selected: row.mode === 'code' && row.code === info.code }, info.label))),
        el('optgroup', { label: 'Leave & holidays · General' }, TIME_CODE_CATALOG.filter(info => info.scope === 'general-only').map(info => el('option', { value: info.code, selected: row.mode === 'code' && row.code === info.code }, info.label))),
        el('option', { value: 'label', selected: row.mode === 'label' }, 'Label only · no effect on hours'));
      const rowStatus = el('small', { class: 'time-meaning-state', role: 'status' }, row.confirmed ? meaningProblems(row).join(' ') || 'Confirmed' : 'Needs confirmation');
      const confirm = el('button', { class: 'time-confirm', disabled: row.confirmed, onclick: () => {
        if (!alive()) return;
        const errors = meaningProblems(row);
        if (errors.length) { rowStatus.textContent = errors.join(' '); return; }
        row.confirmed = true; selected.delete(row); openRows.delete(row); changed(); refreshRows();
      } }, 'Confirm');
      const reset = () => { row.confirmed = false; rowStatus.textContent = 'Needs confirmation'; confirm.disabled = false; updateRowSummary(); updateSummary(); changed(); };
      name.addEventListener('input', () => { if (!alive()) return; row.tagName = name.value.trim(); row.tagId = fetchedTags.find(tag => tag.name === row.tagName)?.id || ''; reset(); });
      choice.addEventListener('change', () => {
        if (!alive()) return;
        const oldDescription = descriptions.get(row.code);
        if (choice.value === 'label') { row.mode = 'label'; row.code = ''; leaveDrafts.delete(row); }
        else { row.mode = choice.value ? 'code' : 'review'; row.code = choice.value; if (row.code && (!row.description || row.description === oldDescription)) row.description = descriptions.get(row.code) || ''; }
        reset(); refreshRows();
      });
      const description = el('input', { value: row.description || '', 'aria-label': `IFS description for tag ${index + 1}`, oninput: e => { if (!alive()) return; row.description = e.target.value; reset(); } });
      const advanced = el('details', { class: 'time-meaning-advanced' }, el('summary', {}, 'Details'),
        row.mode === 'code' ? field('Description sent to IFS', description) : null,
        row.mode === 'code' && options.openPay ? el('button', { class: 'link', onclick: () => { if (alive()) options.openPay(); } }, 'Edit pay in Pay settings') : null,
        row.code && !timeCodeInfo(row.code) ? el('p', { class: 'help' }, `Previous code ${row.code} is kept for review. Choose one of the available meanings.`) : null,
        el('button', { class: 'link danger', onclick: () => { if (!alive()) return; draft.timeCodeMappings.splice(draft.timeCodeMappings.indexOf(row), 1); selected.delete(row); changed(); refreshRows(); } }, 'Remove tag mapping'));
      updateRowSummary();
      card.append(el('summary', { class: 'time-meaning-summary' }, rowName, el('span', { class: 'time-meaning-arrow', 'aria-hidden': 'true' }, '→'), rowMeaning, row.code ? el('code', {}, row.code) : null, rowBadge),
        el('div', { class: 'time-meaning-editor' }, el('div', { class: 'time-meaning-main' }, field('Clockify tag', name), el('span', { class: 'time-meaning-arrow', 'aria-hidden': 'true' }, '→'), field('Means', choice), confirm),
          el('div', { class: 'time-meaning-foot' }, rowStatus, advanced), el('label', { class: 'time-meaning-select' }, check, 'Select for batch confirmation')));
      (isLeave(row) ? leaveRows : workRows).append(card);
    });
    if (!workRows.childElementCount) workRows.append(el('p', { class: 'help' }, calculationMode(draft) === 'rules' ? 'No overrides needed. Ordinary work follows the automatic settings above.' : 'Without a time-code tag, entries stay regular time.'));
    if (!leaveRows.childElementCount) leaveRows.append(el('p', { class: 'help' }, 'Add your annual leave, holiday or absence tags here when you use them.'));
    updateSummary();
  };
  const addTag = leave => {
    if (!alive()) return;
    const row = { tagId: '', tagName: '', code: '', description: '', mode: 'review', confirmed: false, payMultiplier: null };
    draft.timeCodeMappings.push(row); if (leave) leaveDrafts.add(row); openRows.add(row); changed(); refreshRows();
    element.querySelector(`[data-tag-index="${draft.timeCodeMappings.length - 1}"] input[list]`)?.focus();
  };
  const choices = el('div', { class: 'time-mode-choices', role: 'radiogroup', 'aria-label': 'How to calculate time' });
  for (const [value, title, detail] of [
    ['rules', 'Calculate overtime for me', 'Daily hours, weekends and travel rules. Tags can override.'],
    ['tags', 'Use Clockify tags', 'Confirmed tags choose the code. Untagged hours stay regular.'],
  ]) {
    const radio = el('input', { type: 'radio', name: 'settings-time-mode', value, checked: calculationMode(draft) === value, onchange: () => { if (!alive()) return; draft.timeCalculationMode = value; changed(); reflectMode(); refreshRows(); } });
    choices.append(el('label', { class: 'time-mode-card' }, radio, el('span', {}, el('strong', {}, title), el('small', {}, detail))));
  }
  const numberControl = (key, fallback, attrs = {}) => el('input', { type: 'number', value: draft[key] ?? fallback, ...attrs, oninput: e => { if (!alive()) return; draft[key] = e.target.value === '' ? null : Number(e.target.value); changed(); } });
  const holidays = el('textarea', { rows: '2', value: (draft.holidays || []).join(', '), placeholder: '2026-10-29, 2027-01-01', oninput: e => { if (!alive()) return; draft.holidays = e.target.value.split(/[\s,;]+/).filter(Boolean); changed(); } });
  const roleFields = el('div', { class: 'grid2' });
  for (const [key, label] of [['regular', 'Regular time'], ['ot15', 'Overtime ×1.5'], ['ot2', 'Overtime ×2'], ['travelRegular', 'Travel inside the day'], ['travel', 'Travel overtime']]) {
    const value = draft.codes?.[key] || '', select = el('select', { 'aria-label': `Automatic ${label} code`, onchange: e => { if (!alive()) return; (draft.codes ||= {})[key] = e.target.value; changed(); } },
      !timeCodeInfo(value) ? el('option', { value, selected: true }, value || 'Not set') : null,
      TIME_CODE_CATALOG.filter(info => info.scope === 'work').map(info => el('option', { value: info.code, selected: info.code === value }, `${info.code} · ${info.label}`)));
    roleFields.append(field(label, select));
  }
  automatic.append(el('h4', {}, 'Hours & overtime'), el('div', { class: 'grid2' }, field('Regular hours per weekday', numberControl('regularHours', 9, { min: '0', max: '24', step: '0.5' }), 'Project-specific hours are under IFS project destinations below.'), field('Travel overtime starts after', numberControl('travelAfterHours', 9, { min: '0', max: '24', step: '0.5' }), 'Total work and travel hours in the day.')),
    el('label', { class: 'settings-inline-check' }, el('input', { type: 'checkbox', checked: draft.topUpMinimum !== false, onchange: e => { if (!alive()) return; draft.topUpMinimum = e.target.checked; changed(); } }), 'Top up a worked weekday to its regular hours'),
    el('details', { class: 'settings-subdetails' }, el('summary', {}, 'Holidays and travel recognition'), field('Public holiday dates', holidays, 'Work on these dates follows Sunday rates. A holiday tag records leave on General instead.'), field('Recognize travel descriptions starting with', el('input', { value: draft.travelKeyword || '', oninput: e => { if (!alive()) return; draft.travelKeyword = e.target.value; changed(); } }), 'Only used when no time-code tag chooses another meaning.')),
    el('details', { class: 'settings-subdetails' }, el('summary', {}, 'Advanced: IFS codes for automatic rules'), roleFields));
  const reflectMode = () => {
    const mode = calculationMode(draft); automatic.hidden = mode !== 'rules';
    for (const card of choices.querySelectorAll('.time-mode-card')) { const radio = card.querySelector('input'); radio.checked = radio.value === mode; card.classList.toggle('is-selected', radio.checked); }
    workTitle.textContent = mode === 'rules' ? 'Work & travel · optional overrides' : 'Work & travel';
  };
  const read = el('button', { id: 'time-read-tags', onclick: async () => {
    if (!alive()) return;
    const captured = connection(), id = ++request;
    if (!captured.apiKey || !captured.workspaceId || (captured.enteredKey ?? captured.apiKey) !== captured.apiKey) { status.textContent = 'Connect Clockify first, then read its tags.'; return; }
    read.disabled = true; status.textContent = 'Reading tags…';
    try {
      const tags = await (options.getTags ? options.getTags(captured) : new Clockify(captured.apiKey).tags(captured.workspaceId));
      if (!alive() || request !== id || !sameConnection(captured, connection())) return;
      if (!Array.isArray(tags) || tags.some(tag => typeof tag?.id !== 'string' || typeof tag?.name !== 'string')) throw Error('Clockify returned an invalid tag list.');
      fetchedTags = tags; tagChoices.replaceChildren(...tags.map(tag => el('option', { value: tag.name })));
      for (const tag of tags) {
        let row = draft.timeCodeMappings.find(item => item.tagId && item.tagId === tag.id) || draft.timeCodeMappings.find(item => item.tagName === tag.name);
        if (row) {
          if ((row.tagId && row.tagId !== tag.id) || row.tagName !== tag.name) row.confirmed = false;
          row.tagId = tag.id; row.tagName = tag.name;
        } else { row = { tagId: tag.id, tagName: tag.name, mode: 'review', code: '', description: '', confirmed: false, payMultiplier: null }; draft.timeCodeMappings.push(row); }
        // These two names were explicitly supplied by the owner; proposals still
        // need confirmation. Preserve every existing code and Label only choice.
        const suggested = { 'annual leave': 'F_08', holiday: 'F_07' }[row.tagName.trim().toLowerCase()];
        if (suggested && !row.code && row.mode !== 'label') { row.code = suggested; row.mode = 'code'; row.description ||= descriptions.get(suggested); row.confirmed = false; }
      }
      changed(); refreshRows(); status.textContent = `${tags.length} tags read. Review any new or changed meanings, then save your settings.`;
    } catch (error) { if (alive() && request === id) status.textContent = `Could not read tags: ${error.message}`; }
    finally { if (alive()) read.disabled = false; }
  } }, 'Read tags from Clockify');
  const workTitle = el('h4');
  element.append(choices, automatic,
    el('details', { class: 'settings-subdetails' }, el('summary', {}, 'Rounding · applies to both choices'), el('div', { class: 'grid2' }, field('Round each day/project to (hours)', numberControl('roundStep', 0.5, { min: '0.001', max: '24', step: '0.25' })), field('Round', el('select', { onchange: e => { if (!alive()) return; draft.roundMode = e.target.value; changed(); } }, [['nearest', 'To nearest'], ['up', 'Up'], ['down', 'Down']].map(([value, label]) => el('option', { value, selected: (draft.roundMode || 'nearest') === value }, label)))))),
    el('details', { class: 'settings-subdetails time-tags-panel', id: 'time-tags-settings' }, el('summary', { class: 'time-tags-heading' }, el('span', {}, 'Clockify tags & IFS time codes'), tagCount),
    summary, el('div', { class: 'settings-read-actions' }, read, confirmSelected),
    el('p', { class: 'help' }, 'Read tags, choose their meaning, then confirm. Clockify is not changed.'), status,
    el('section', { class: 'settings-time-group' }, el('div', { class: 'settings-group-heading' }, workTitle, el('button', { class: 'link', onclick: () => addTag(false) }, 'Add work tag')), workRows),
    el('section', { class: 'settings-time-group time-leave-group' }, el('div', { class: 'settings-group-heading' }, el('h4', {}, 'Leave & holidays · General'), el('button', { class: 'link', onclick: () => addTag(true) }, 'Add leave tag')), el('p', { class: 'help' }, 'Recorded hours go to General; weekend overtime does not apply.'), generalStatus, leaveRows)), tagChoices);
  function validate() {
    return validateTimeSettings(draft);
  }
  refreshCatalog(); reflectMode(); refreshRows();
  return { element, validate, refreshCatalog };
}
