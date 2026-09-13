import { el, field, openDialog } from './dom.js';
import { GENERAL_ONLY_TIME_CODES, timeCodeInfo, completeGeneralActivity, effectiveTimeCodeMappings } from './time-codes.js';
import { localToUtc, utcToLocalInput } from './rules.js';

export function leaveAliases(settings, tags, code) {
  return effectiveTimeCodeMappings(settings).filter(row => row.confirmed && row.mode === 'code' && row.code === code).flatMap(row => {
    const matches = tags.filter(tag => row.tagId ? tag.id === row.tagId && (!row.tagName || row.tagName === tag.name) : tag.name === row.tagName);
    return matches.length === 1 ? matches : [];
  }).filter((tag, index, rows) => rows.findIndex(other => other.id === tag.id) === index);
}

export function prepareLeaveEntry({ settings, meta, date, code, tagId, start = '08:00', hours = 9 }) {
  if (!GENERAL_ONLY_TIME_CODES.includes(code)) throw Error('Choose a supported leave or holiday type.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || new Date(date + 'T00:00:00Z').toISOString().slice(0, 10) !== date) throw Error('Choose a valid leave date.');
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(start || '')) throw Error('Use a 24-hour start time such as 08:00.');
  if (typeof hours !== 'number' || !Number.isFinite(hours) || hours <= 0 || hours > 24) throw Error('Leave hours must be above 0 and no more than 24.');
  const general = (settings.mapping || []).filter(row => row.kind === 'general' && completeGeneralActivity(row));
  if (general.length !== 1) throw Error('Set up one complete General destination in Work setup first.');
  const projectId = general[0].clockifyProjectId;
  if (!projectId || !meta.projects.some(project => project.id === projectId && project.archived !== true)) throw Error('Connect General to an available Clockify project first.');
  const aliases = leaveAliases(settings, meta.tags, code);
  if (!aliases.some(tag => tag.id === tagId)) throw Error('Choose a confirmed Clockify tag for this leave type in Work setup.');
  const from = localToUtc(date + 'T' + start, settings.timeZone), end = new Date(new Date(from).getTime() + hours * 3600000).toISOString();
  return { start: from, end, projectId, tagIds: [tagId], billable: false, description: timeCodeInfo(code).label };
}

export function openLeaveEntryDialog({ settings, meta, date, onSave, openSettings, isCurrent = () => true }) {
  const type = el('select', { 'aria-label': 'Leave type' }, GENERAL_ONLY_TIME_CODES.map(code => el('option', { value: code, selected: code === 'F_08' }, timeCodeInfo(code).label)));
  const when = el('input', { type: 'date', value: date, 'aria-label': 'Leave date' });
  const hours = el('input', { type: 'number', min: 0.25, max: 24, step: 0.25, value: settings.workPolicy?.fullDayHours || 9, 'aria-label': 'Leave hours' });
  const start = el('input', { value: '08:00', 'aria-label': 'Leave start time', inputmode: 'numeric' });
  const tag = el('select', { 'aria-label': 'Clockify leave tag' });
  const status = el('p', { role: 'status', class: 'help' });
  const preview = el('p', { class: 'help' });
  let pending = false, dialog;
  const alive = () => isCurrent() && dialog?.isConnected && dialog.open;
  const plan = () => prepareLeaveEntry({ settings, meta, date: when.value, code: type.value, tagId: tag.value, start: start.value, hours: Number(hours.value) });
  const updatePreview = () => {
    try { const entry = plan(); preview.textContent = hours.value + ' hours · General · ' + type.value + ' · ' + start.value + '–' + utcToLocalInput(entry.end, settings.timeZone).slice(11); save.disabled = false; }
    catch (error) { preview.textContent = error.message; save.disabled = true; }
  };
  const refill = () => {
    const aliases = leaveAliases(settings, meta.tags, type.value);
    tag.replaceChildren(...aliases.map(item => el('option', { value: item.id }, item.name)));
    if (!aliases.length) tag.append(el('option', { value: '' }, 'No confirmed tag'));
    updatePreview();
  };
  const save = el('button', { type: 'button', class: 'primary', onclick: async () => {
    if (!alive() || pending) return;
    let payload;
    try { payload = plan(); } catch (error) { status.textContent = error.message; return; }
    pending = true; save.disabled = true;
    try { await onSave(payload); if (alive()) dialog.close(); }
    catch (error) { if (alive()) status.textContent = error.message; }
    finally { pending = false; if (alive()) updatePreview(); }
  } }, 'Add leave to Clockify');
  type.addEventListener('change', refill);
  for (const node of [when, hours, start, tag]) node.addEventListener('input', updatePreview);
  const content = el('div', { class: 'form' },
    field('Leave type', type), el('div', { class: 'grid2' }, field('Date', when), field('Hours', hours, 'A full day is 9 hours. Enter fewer hours for part of a day.')),
    field('Clockify tag', tag), el('details', {}, el('summary', {}, 'Time of day'), field('Start · 24-hour', start)),
    preview, el('button', { type: 'button', class: 'link', onclick: () => { if (!alive() || pending) return; dialog.close(); openSettings?.('time', 'time-type-' + type.value); } }, 'Set up this leave type'),
    el('p', { class: 'help' }, 'This creates one Clockify entry. It comes back with your timesheet; you can edit or delete it in Clockify entries.'),
    el('div', { class: 'actions' }, save, el('button', { type: 'button', onclick: () => { if (!pending) dialog.close(); } }, 'Cancel')), status);
  dialog = openDialog('Add leave', content);
  refill();
  return dialog;
}
