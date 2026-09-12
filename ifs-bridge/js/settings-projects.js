import { el } from './dom.js';
import { Clockify } from './clockify.js';
import { parseCopyObjects, activityFromRecord, identityFromRecord } from './ifs.js';
import { calculationMode, completeGeneralActivity } from './time-codes.js';

const field = (label, control, hint) => el('label', { class: 'field' }, el('span', {}, label), control, hint ? el('small', {}, hint) : null);
const templateText = record => ['!IFS.COPYOBJECT', `$LU=${record.lu}`, `$VIEW=${record.view}`, '$RECORD=!', ...record.fields.map(f => `-$${f.n}:${f.name}=${f.value}`), '-'].join('\n');

/** Import only into the project and activity explicitly chosen in the editor. */
export function applyCopiedProjectRow(draft, project, text, target = 'main') {
  if (!draft.mapping?.includes(project)) throw Error('This project is no longer in the settings draft.');
  if (!['main', 'travel'].includes(target)) throw Error('Choose Main activity or Travel activity.');
  const records = parseCopyObjects(text);
  if (records.length !== 1) throw Error('Paste one copied IFS timesheet row for this activity.');
  const record = records[0];
  if (record.lu !== 'ProjectTransWeek') throw Error('Use a row from the IFS weekly project time grid (Proje Zaman Kaydı).');
  const activity = activityFromRecord(record), identity = identityFromRecord(record);
  if (!activity.projectId || !activity.subProjectId || !activity.activityNo || !activity.shortName) throw Error('The copied row is missing its IFS activity fields. Copy the complete row again.');
  if (target === 'travel' && ((project.projectId && project.projectId !== activity.projectId) || (project.subProjectId && project.subProjectId !== activity.subProjectId))) throw Error('This travel row belongs to another project or subproject. Choose that project or correct the main activity first.');
  const blank = new Set(['MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT', 'SUN'].map(day => `${day}_INTERNAL_QUANTITY`));
  for (const item of record.fields) if (blank.has(item.name) || item.n === 15 || item.name === 'ACCOUNT_DATE' || (item.name === 'COST_ACCOUNTING' && item.n === 4)) item.value = '';
  const code = record.fields.find(item => item.name === 'REPORT_COST_CODE')?.value || '';
  const description = record.fields.find(item => item.name.startsWith('REPORT_COST_API.GET_DESCRIPTION'))?.value || '';
  // Parse and validate before updating the draft, then preserve object references
  // used by the surrounding identity and project editors.
  if (identity.empNo) Object.assign(draft.identity ||= {}, identity);
  if (target === 'travel') {
    Object.assign(project.travel ||= {}, { activityNo: activity.activityNo, activitySeq: activity.activitySeq, activityDesc: activity.activityDesc, shortName: activity.shortName });
    if (!project.projectId) { project.projectId = activity.projectId; project.projectName = activity.projectName; project.subProjectId = activity.subProjectId; project.subProjectDesc = activity.subProjectDesc; }
  } else Object.assign(project, activity);
  if (project.kind === 'ignore') project.kind = 'project';
  draft.template = templateText(record);
  if (code && description) {
    (draft.codeDescriptions ||= {})[code] = description;
    draft.timeCodeCatalog = [...(draft.timeCodeCatalog || []).filter(item => item.code !== code), { code, description, source: 'ifs-copy' }];
  }
  return { shortName: activity.shortName, target, identityUpdated: !!identity.empNo, catalogUpdated: !!(code && description) };
}

export function validateProjectSettings(draft) {
  const errors = [], ids = new Set();
  for (const project of draft.mapping || []) {
    const name = project.clockifyProjectName || 'Project';
    if (!['project', 'general', 'ignore'].includes(project.kind)) errors.push(`${name}: choose how to use this project.`);
    if (project.clockifyProjectId) { if (ids.has(project.clockifyProjectId)) errors.push(`${name}: this Clockify project has another mapping.`); ids.add(project.clockifyProjectId); }
    for (const key of ['regularHours', 'travelAfterHours']) { const value = project[key]; if (value != null && value !== '' && (!Number.isFinite(Number(value)) || Number(value) < 0 || Number(value) > 24)) errors.push(`${name}: hours must be between 0 and 24, or blank.`); }
    for (const key of ['projectId', 'subProjectId', 'activityNo', 'activitySeq', 'shortName', 'clockifyProjectId']) if (/[\r\n]/.test(String(project[key] || ''))) errors.push(`${name}: activity identifiers must be on one line.`);
  }
  return [...new Set(errors)];
}

export function renderProjectSettings(draft, options = {}) {
  draft.mapping ||= [];
  const element = el('div', { class: 'settings-projects', 'data-settings-editor': 'projects' });
  const alive = () => element.isConnected && (options.isCurrent?.() ?? true);
  const changed = () => options.onChange?.();
  const connection = () => options.connection?.() || { ...draft.clockify, enteredKey: draft.clockify?.apiKey || '' };
  const list = el('div', { class: 'settings-project-list' });
  const status = el('p', { class: 'help', role: 'status', 'aria-live': 'polite', id: 'project-setup-status' });
  const openProjects = new Set();
  let filter = '', request = 0;
  const statusOf = project => {
    if (project.kind === 'ignore') return { text: 'Ignored', ready: true };
    const complete = ['projectId', 'subProjectId', 'activityNo', 'activitySeq', 'shortName'].every(key => String(project[key] ?? '').trim());
    const matches = project.shortName === `${project.projectId}.${project.subProjectId}.${project.activityNo}`;
    if (project.kind === 'general') return { text: completeGeneralActivity(project) ? 'General ready' : 'General needs activity details', ready: completeGeneralActivity(project) };
    return { text: complete && matches ? 'Ready for IFS' : 'Needs activity details', ready: complete && matches };
  };
  const render = () => {
    list.replaceChildren();
    const projects = draft.mapping.filter(project => !filter || `${project.clockifyProjectName} ${project.shortName} ${project.projectName}`.toLowerCase().includes(filter));
    for (const project of projects) {
      const ready = statusOf(project), name = project.clockifyProjectName || project.clockifyProjectId || 'Unnamed mapping';
      const heading = el('summary', { class: 'settings-project-summary' }, el('span', {}, el('strong', {}, name), el('small', {}, project.kind === 'ignore' ? 'Left out of IFS exports' : project.shortName || 'Choose an IFS destination')), el('span', { class: `settings-readiness ${ready.ready ? 'ready' : 'pending'}` }, ready.text), el('span', { class: 'settings-edit-label' }, 'Edit'));
      const details = el('details', { class: 'settings-project-card', open: openProjects.has(project), 'data-project-id': project.clockifyProjectId || '' }, heading);
      details.addEventListener('toggle', () => { if (!alive() || !details.isConnected) return; details.open ? openProjects.add(project) : openProjects.delete(project); });
      const editor = el('div', { class: 'settings-project-editor' });
      const updateHeading = () => { const current = statusOf(project); const badge = heading.querySelector('.settings-readiness'); badge.textContent = current.text; badge.classList.toggle('ready', current.ready); badge.classList.toggle('pending', !current.ready); heading.querySelector('strong').textContent = project.clockifyProjectName || project.clockifyProjectId || 'Unnamed mapping'; heading.querySelector('small').textContent = project.kind === 'ignore' ? 'Left out of IFS exports' : project.shortName || 'Choose an IFS destination'; };
      const canEdit = () => alive() && details.isConnected && draft.mapping.includes(project);
      const text = (object, key, label, attrs = {}) => el('input', { value: object[key] ?? '', 'aria-label': `${name}: ${label}`, ...attrs, oninput: e => { if (!canEdit()) return; object[key] = e.target.value.trim(); changed(); updateHeading(); } });
      const kind = el('select', { 'aria-label': `${name}: project use`, onchange: e => { if (!canEdit()) return; project.kind = e.target.value; changed(); render(); } }, [['project', 'Work project'], ['general', 'General · leave, holidays and general time'], ['ignore', 'Ignore in IFS']].map(([value, label]) => el('option', { value, selected: project.kind === value }, label)));
      editor.append(field('Use this project for', kind));
      if (project.kind !== 'ignore') {
        const importTarget = el('select', { 'aria-label': `${name}: import destination` }, el('option', { value: 'main' }, 'Main activity'), el('option', { value: 'travel' }, 'Travel activity'));
        const pasted = el('textarea', { rows: '4', placeholder: 'In IFS select one activity row → Copy Object, then paste it here.', 'aria-label': `${name}: copied IFS row` });
        const importStatus = el('p', { class: 'help', role: 'status' });
        editor.append(el('div', { class: 'settings-project-import' }, el('h5', {}, 'Connect this project with one copied IFS row'), el('p', { class: 'help' }, 'The row fills the activity details and refreshes your employee fields and export template.'), field('Put this row into', importTarget), pasted,
          el('button', { class: 'project-import-row', onclick: () => { if (!canEdit()) return; try { const result = applyCopiedProjectRow(draft, project, pasted.value, importTarget.value); changed(); if (result.catalogUpdated) options.onImportCatalog?.(); status.textContent = `${name}: ${result.target === 'travel' ? 'travel' : 'main'} activity ${result.shortName} added to your draft. Save settings to keep it.`; openProjects.add(project); render(); } catch (error) { importStatus.textContent = error.message; } } }, 'Use this IFS row'), importStatus));
        editor.append(field('Main IFS short name', text(project, 'shortName', 'main short name'), 'Project.subproject.activity — copied from IFS above.'));
        if (calculationMode(draft) === 'rules') editor.append(el('div', { class: 'grid2' }, field('Regular hours for this project', text(project, 'regularHours', 'regular hours', { type: 'number', min: '0', max: '24', step: '0.5', placeholder: `Default: ${draft.regularHours ?? 9}` }), 'Blank keeps the shared daily hours.'), field('Travel overtime after', text(project, 'travelAfterHours', 'travel threshold', { type: 'number', min: '0', max: '24', step: '0.5', placeholder: `Default: ${draft.travelAfterHours ?? 9}` }), 'Blank keeps the shared travel threshold.')));
        const advanced = el('details', { class: 'settings-subdetails' }, el('summary', {}, 'Advanced activity fields'));
        advanced.append(el('div', { class: 'grid3' }, field('IFS project ID', text(project, 'projectId', 'IFS project ID')), field('Subproject ID', text(project, 'subProjectId', 'subproject ID')), field('Activity number', text(project, 'activityNo', 'activity number')), field('Activity sequence', text(project, 'activitySeq', 'activity sequence')), field('IFS project name', text(project, 'projectName', 'IFS project name')), field('Activity description', text(project, 'activityDesc', 'activity description')), field('Subproject description', text(project, 'subProjectDesc', 'subproject description'))));
        const travel = project.travel || {};
        // Do not add an empty travel object merely by opening Settings.
        const travelInput = (key, label) => el('input', { value: travel[key] || '', 'aria-label': `${name}: ${label}`, oninput: e => { if (!canEdit()) return; (project.travel ||= {})[key] = e.target.value.trim(); changed(); updateHeading(); } });
        advanced.append(el('h5', {}, 'Travel activity'), el('div', { class: 'grid2' }, field('Travel short name', travelInput('shortName', 'travel short name')), field('Travel activity number', travelInput('activityNo', 'travel activity number')), field('Travel activity sequence', travelInput('activitySeq', 'travel activity sequence')), field('Travel description', travelInput('activityDesc', 'travel description'))));
        editor.append(advanced);
      }
      editor.append(el('details', { class: 'settings-subdetails' }, el('summary', {}, 'Clockify identifier and removal'), field('Clockify project ID', text(project, 'clockifyProjectId', 'Clockify project ID')), field('Clockify project name', text(project, 'clockifyProjectName', 'Clockify project name')),
        el('button', { class: 'link danger', onclick: () => { if (!canEdit()) return; draft.mapping.splice(draft.mapping.indexOf(project), 1); openProjects.delete(project); changed(); render(); } }, 'Remove this mapping from draft')));
      details.append(editor); list.append(details);
    }
    if (!projects.length) list.append(el('p', { class: 'empty' }, filter ? 'No project matches this search.' : 'Read your Clockify projects, then connect each one to an IFS activity.'));
  };
  const read = el('button', { id: 'project-read-clockify', onclick: async () => {
    if (!alive()) return;
    const captured = connection(), id = ++request;
    if (!captured.apiKey || !captured.workspaceId || (captured.enteredKey ?? captured.apiKey) !== captured.apiKey) { status.textContent = 'Connect Clockify first, then read its projects.'; return; }
    read.disabled = true; status.textContent = 'Reading Clockify projects…';
    try {
      let projects;
      if (options.getProjects) projects = await options.getProjects(captured);
      else {
        const client = new Clockify(captured.apiKey), found = [], seen = new Set();
        for (let page = 1; page <= 100; page++) {
          const chunk = await client.get(`/workspaces/${encodeURIComponent(captured.workspaceId)}/projects`, { archived: false, 'page-size': 200, page });
          if (!alive() || id !== request) return;
          if (!Array.isArray(chunk) || chunk.some(project => typeof project?.id !== 'string' || typeof project?.name !== 'string')) throw Error('Clockify returned an invalid project list.');
          for (const project of chunk) { if (seen.has(project.id)) throw Error('Clockify repeated a project page. Try reading projects again.'); seen.add(project.id); found.push(project); }
          if (chunk.length < 200) { projects = found; break; }
        }
        if (!projects) throw Error('The project list exceeded the supported page limit. No partial list was applied.');
      }
      const current = connection();
      if (!alive() || id !== request || current.apiKey !== captured.apiKey || current.workspaceId !== captured.workspaceId || (current.enteredKey ?? current.apiKey) !== captured.apiKey) return;
      if (!Array.isArray(projects) || projects.some(project => typeof project?.id !== 'string' || typeof project?.name !== 'string')) throw Error('Clockify returned an invalid project list.');
      let added = 0;
      for (const project of projects) if (!draft.mapping.some(item => item.clockifyProjectId === project.id)) { draft.mapping.push({ clockifyProjectId: project.id, clockifyProjectName: project.name, kind: 'project', regularHours: '', projectId: '', projectName: '', subProjectId: '', subProjectDesc: '', activityNo: '', activitySeq: '', activityDesc: '', shortName: '' }); added++; }
      if (added) changed(); render(); status.textContent = added ? `${added} new projects added to your draft. Connect their IFS activities below.` : 'Your Clockify projects are already listed. Existing mappings were kept.';
    } catch (error) { if (alive() && id === request) status.textContent = `Could not read projects: ${error.message}`; }
    finally { if (alive()) read.disabled = false; }
  } }, 'Read projects from Clockify');
  const search = el('input', { type: 'search', placeholder: 'Find a project', 'aria-label': 'Find a project', oninput: e => { if (!alive()) return; filter = e.target.value.trim().toLowerCase(); render(); } });
  element.append(el('p', { class: 'help' }, 'Connect each Clockify project to its IFS activity. Choose General for the destination used by leave and holidays.'), el('div', { class: 'settings-project-toolbar' }, search, read), status, list);
  function validate() {
    return validateProjectSettings(draft);
  }
  render();
  return { element, validate };
}
