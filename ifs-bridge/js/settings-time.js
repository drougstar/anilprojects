import { el } from './dom.js';
import { Clockify } from './clockify.js';
import { TIME_CODE_CATALOG, timeCodeInfo, completeGeneralActivity } from './time-codes.js';
import { normalizeWorkSettings, validateWorkPolicy } from './work-policy.js';

const field = (label, control, hint) => el('label', { class: 'field' }, el('span', {}, label), control, hint ? el('small', {}, hint) : null);
const fold = (title, subtitle, id, ...content) => el('details', { class: 'settings-disclosure', id }, el('summary', {}, el('span', { class: 'settings-summary-copy' }, el('strong', {}, title), el('small', {}, subtitle))), el('div', { class: 'settings-disclosure-body' }, ...content));
const validDate = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0,10) === value;
const titles = { F_01:'Travel during working hours', F_02:'Overtime ×1.5', F_03:'Regular work', F_04:'Paid leave · Ücretli izin', F_05:'Unpaid leave · Ücretsiz izin', F_06:'Sick leave · Raporlu', F_07:'Public holiday · Resmi tatil', F_08:'Annual leave · Yıllık izin', F_10:'Overtime ×2', F_11:'Overtime at normal rate', F_12:'Travel overtime' };
function meaningProblems(draft,row) {
  const errors=[];
  if (!row.tagName?.trim()) errors.push('Enter the Clockify tag name.');
  if (!['code','label'].includes(row.mode)) errors.push('Choose what the tag means.');
  if (row.mode === 'code' && !timeCodeInfo(row.code)) errors.push('Choose a supported IFS time type.');
  if ((draft.timeCodeMappings||[]).some(other => other !== row && (other.tagName === row.tagName || (row.tagId && other.tagId === row.tagId)))) errors.push('This tag is already linked elsewhere. Keep one meaning.');
  return errors;
}
export function validateTimeSettings(draft) {
  const names={weekdayMinimumHours:'Weekday minimum',fullDayHours:'Full leave day',overtimeAfterHours:'Default overtime threshold',sundayPaidHours:'Sunday paid hours'};
  const errors = validateWorkPolicy(draft).map(message=>message.replace(/^(weekdayMinimumHours|fullDayHours|overtimeAfterHours|sundayPaidHours)/,key=>names[key]));
  if (typeof draft.payRate !== 'number' || !Number.isFinite(draft.payRate) || draft.payRate < 0) errors.push('Hourly rate: enter a number from 0, using . or , for decimals.');
  if (!Number.isFinite(draft.roundStep) || draft.roundStep <= 0 || draft.roundStep > 24) errors.push('Rounding step must be above 0 and at most 24 hours.');
  if (!['nearest','up','down'].includes(draft.roundMode)) errors.push('Choose a rounding direction.');
  if ((draft.holidays || []).some(date => !validDate(date))) errors.push('Use real holiday dates in YYYY-MM-DD format.');
  try { new RegExp(`^\\s*${draft.travelKeyword || ''}\\b`, 'i'); } catch { errors.push('The travel recognition expression is invalid.'); }
  for (const row of draft.timeCodeMappings || []) if (row.confirmed) errors.push(...meaningProblems(draft,row).map(message=>`${row.tagName || 'Tag'}: ${message}`));
  return [...new Set(errors)];
}

/** One time type owns its IFS description and pay. Clockify tags only select it. */
export function renderTimeSetup(draft, options={}) {
  // SettingsPage already normalizes its baseline. Standalone editors use the same migration.
  if (draft.workPolicyVersion !== 1) Object.assign(draft,normalizeWorkSettings(draft));
  const element=el('div',{class:'settings-time','data-settings-editor':'time'});
  const alive=()=>element.isConnected && (options.isCurrent?.() ?? true);
  const changed=()=>options.onChange?.();
  const connection=()=>options.connection?.() || {...draft.clockify,enteredKey:draft.clockify?.apiKey||''};
  let request=0, fetchedTags=[];
  const selected=new Set(), openedRows=new WeakSet(), openedTypes=new Set();
  const catalog=el('div',{class:'time-type-list',id:'time-type-list'});
  const other=el('div',{id:'time-other-mappings'});
  const tagChoices=el('datalist',{id:'settings-time-tag-options'});
  const status=el('p',{class:'help',role:'status','aria-live':'polite',id:'time-setup-status'});
  const attention=el('div',{class:'settings-attention',role:'status',id:'time-setup-attention'});
  const count=el('small',{id:'time-tag-count'});
  const general=el('p',{class:'help',id:'time-general-readiness'});
  const confirmSelected=el('button',{id:'time-confirm-selected',hidden:true,onclick:()=>{
    if(!alive())return;
    const rows=draft.timeCodeMappings.filter(row=>selected.has(row));
    const errors=rows.flatMap(row=>meaningProblems(draft,row));
    if(errors.length){status.textContent=errors.join(' ');return;}
    rows.forEach(row=>{row.confirmed=true;openedRows.delete(row);}); selected.clear(); changed();refreshRows();
    status.textContent=`${rows.length} tag meanings confirmed in your draft.`;
  }},'Confirm selected');
  const summary=()=>{
    const pending=draft.timeCodeMappings.filter(row=>!row.confirmed || meaningProblems(draft,row).length).length;
    count.textContent=`${draft.timeCodeMappings.length-pending} confirmed · ${pending} need review`;
    attention.hidden=!pending;attention.textContent=`${pending} tag meaning${pending===1?' needs':'s need'} your confirmation. You can save unfinished setup; affected entries must be reviewed before IFS export.`;
    confirmSelected.hidden=!selected.size;confirmSelected.textContent=`Confirm selected (${selected.size})`;
    const generals=(draft.mapping||[]).filter(completeGeneralActivity),unique=new Set(generals.map(m=>`${m.shortName}|${m.activitySeq}`));
    general.textContent=unique.size===1?`General destination: ${generals[0].shortName}. Leave and the weekday remainder use this destination.`:unique.size?'Several General destinations exist. Select the intended General project on leave entries.':'General needs setup in Projects before leave or the weekday remainder can be exported.';
  };
  const number=(object,key,label,{fallback='',max=24,min=0,step=0.5,change}={})=>el('input',{type:'text',inputmode:'decimal',value:object[key]??fallback,'aria-label':label,oninput:e=>{if(!alive()||!e.target.isConnected)return;const raw=e.target.value.trim();object[key]=raw===''?null:/^\d+(?:[.,]\d+)?$/.test(raw)?Number(raw.replace(',','.')):raw;change?.();changed();}});
  const policy=draft.workPolicy;
  const holidays=el('textarea',{rows:2,'aria-label':'Public holiday dates',value:(draft.holidays||[]).join(', '),oninput:e=>{if(!alive())return;draft.holidays=e.target.value.split(/[\s,;]+/).filter(Boolean);changed();}});
  const schedule=fold('Hours & schedule','Weekday minimum, overtime and paid days','time-automatic-settings',
    el('p',{class:'help'},'Work and travel build up together during the day. A confirmed Clockify tag overrides the calculated type; a warning explains any difference.'),
    el('div',{class:'grid2'},field('Weekday minimum',number(policy,'weekdayMinimumHours','Weekday minimum'),'Missing hours are shown separately on General. Weekends have no minimum.'),field('Overtime starts after',number(policy,'overtimeAfterHours','Default overtime threshold',{min:0.5}),'The location on each entry can set an 8-hour or 9-hour threshold under Projects.'),field('Full day of leave',number(policy,'fullDayHours','Full leave day',{min:0.5}),'Used by all full-day leave entries.'),field('Sunday base pay hours',number(policy,'sundayPaidHours','Sunday paid hours'),policy.sundayPayMode==='plus-work'?'Paid in addition to Sunday worked hours at ×2.':policy.sundayPayMode==='work-only'?'Imported rule: these base hours are not added on a worked Sunday.':'Sunday base-pay treatment needs review.')),
    policy.sundayPayMode!=='plus-work'?el('div',{class:'settings-attention'},el('p',{},'This imported Sunday rule differs from your confirmed setup: base pay plus worked hours at ×2.'),el('button',{onclick:()=>{if(!alive())return;policy.sundayPayMode='plus-work';changed();options.onPolicyReset?.();}},'Use base pay plus worked hours')):null,
    el('p',{class:'help'},'Weekday hours beyond the threshold and all Saturday work use ×1.5. All Sunday work uses ×2.'),
    fold('Public holidays','Dates, worked hours and base pay','work-holiday-settings',field('Holiday dates',holidays,'YYYY-MM-DD, separated by commas. Work on these dates uses the Sunday overtime rate.'),field('Paid hours when not worked',number(policy,'holidayPaidHours','Public holiday paid hours'),'Leave blank while the holiday base-pay rule is unconfirmed. A Holiday tag uses the Public holiday time type.')),
    fold('Rounding & travel recognition','Options shared by every project','work-rounding-settings',
      el('div',{class:'grid2'},field('Round to hours',number(draft,'roundStep','Rounding step',{min:0.001,step:0.25})),field('Rounding direction',el('select',{'aria-label':'Rounding direction',onchange:e=>{if(!alive())return;draft.roundMode=e.target.value;changed();}},[['nearest','Nearest'],['up','Up'],['down','Down']].map(([value,label])=>el('option',{value,selected:draft.roundMode===value},label))))),
      field('Recognize travel descriptions starting with',el('input',{value:draft.travelKeyword||'','aria-label':'Travel description prefix',oninput:e=>{if(!alive())return;draft.travelKeyword=e.target.value;changed();}}),'Used only when a confirmed tag does not select another time type.')));
  function addTag(code=''){
    if(!alive())return;
    const row={tagId:'',tagName:'',mode:code?'code':'review',code,confirmed:false};
    draft.timeCodeMappings.push(row);openedRows.add(row);if(code)openedTypes.add(code);changed();refreshRows();
    element.querySelector(`[data-tag-index="${draft.timeCodeMappings.length-1}"] input[list]`)?.focus();
  }
  function tagRow(row,index){
    const details=el('details',{class:'time-meaning-row','data-tag-index':index,open:openedRows.has(row)});
    details.addEventListener('toggle',()=>{if(!alive()||!details.isConnected)return;details.open?openedRows.add(row):openedRows.delete(row);});
    const badge=el('small',{class:'time-meaning-badge'}),heading=el('strong',{},row.tagName||'New Clockify tag');
    const rowStatus=el('small',{class:'time-meaning-state',role:'status'});
    const update=()=>{const errors=meaningProblems(draft,row);badge.textContent=row.confirmed&&!errors.length?'Confirmed':'Review';badge.classList.toggle('needs-review',!row.confirmed||!!errors.length);rowStatus.textContent=row.confirmed?errors.join(' ')||'Confirmed':'Needs confirmation';};
    const name=el('input',{value:row.tagName||'',list:'settings-time-tag-options','aria-label':`Clockify tag ${index+1}`});
    const select=el('select',{'aria-label':`Meaning of tag ${index+1}`},el('option',{value:'',selected:!row.code&&row.mode!=='label'},'Choose type…'),TIME_CODE_CATALOG.map(info=>el('option',{value:info.code,selected:row.mode==='code'&&row.code===info.code},`${titles[info.code]} · ${info.code}`)),el('option',{value:'label',selected:row.mode==='label'},'Label only · no effect on time'));
    const confirm=el('button',{class:'time-confirm',disabled:row.confirmed,onclick:()=>{if(!alive()||!details.isConnected)return;const errors=meaningProblems(draft,row);if(errors.length){rowStatus.textContent=errors.join(' ');return;}row.confirmed=true;selected.delete(row);openedRows.delete(row);changed();refreshRows();}},'Confirm');
    const reset=()=>{row.confirmed=false;confirm.disabled=false;update();summary();changed();};
    name.addEventListener('input',()=>{if(!alive()||!details.isConnected)return;row.tagName=name.value.trim();row.tagId=fetchedTags.find(tag=>tag.name===row.tagName)?.id||'';heading.textContent=row.tagName||'New Clockify tag';reset();});
    select.addEventListener('change',()=>{if(!alive()||!details.isConnected)return;row.code=select.value==='label'?'':select.value;row.mode=select.value==='label'?'label':select.value?'code':'review';delete row.description;reset();if(row.code)openedTypes.add(row.code);refreshRows();});
    const check=el('input',{type:'checkbox',checked:selected.has(row),'aria-label':`Select ${row.tagName||'new tag'} for confirmation`,onchange:e=>{if(!alive())return;e.target.checked?selected.add(row):selected.delete(row);summary();}});
    update();
    details.append(el('summary',{class:'time-meaning-summary'},heading,el('span',{class:'time-meaning-label'},row.mode==='label'?'Label only':row.code||'Choose type'),badge),
      el('div',{class:'time-meaning-editor'},el('div',{class:'time-meaning-main'},field('Clockify tag',name),field('Time type',select),confirm),el('div',{class:'time-meaning-foot'},rowStatus,el('button',{class:'link danger',onclick:()=>{if(!alive()||!details.isConnected)return;draft.timeCodeMappings.splice(draft.timeCodeMappings.indexOf(row),1);selected.delete(row);changed();refreshRows();}},'Unlink tag')),el('label',{class:'time-meaning-select'},check,'Select for batch confirmation')));
    return details;
  }
  function refreshRows(){
    catalog.replaceChildren();other.replaceChildren();
    for(const type of draft.timeTypes){
      const info=timeCodeInfo(type.code), linked=draft.timeCodeMappings.filter(row=>row.mode==='code'&&row.code===type.code);
      const payText=()=>type.payMultiplier==null?'Pay needs review':`Pay ×${type.payMultiplier}`;
      const item=fold(titles[type.code],`${type.code} · ${payText()} · ${linked.length} linked tag${linked.length===1?'':'s'}`,`time-type-${type.code}`);
      item.classList.add('time-type-card');item.dataset.timeCode=type.code;item.open=openedTypes.has(type.code);
      item.addEventListener('toggle',()=>{if(!alive()||!item.isConnected)return;item.open?openedTypes.add(type.code):openedTypes.delete(type.code);});
      const body=item.lastElementChild;
      const migration=(draft.workPolicyMigrationWarnings||[]).filter(message=>message.startsWith(`${type.code}:`));
      if(migration.length)body.append(el('p',{class:'settings-attention'},migration.join(' ')));
      const desc=el('input',{value:type.description,'aria-label':`IFS description ${type.code}`,oninput:e=>{if(!alive()||!item.isConnected)return;type.description=e.target.value;draft.workPolicyMigrationWarnings=(draft.workPolicyMigrationWarnings||[]).filter(message=>!(message.startsWith(`${type.code}:`)&&message.toLowerCase().includes('description')));changed();}});
      const multiplier=number(type,'payMultiplier',`Pay multiplier ${type.code}`,{max:10,step:0.25,change:()=>{item.querySelector('summary small').textContent=`${type.code} · ${payText()} · ${linked.length} linked tags`;draft.workPolicyMigrationWarnings=(draft.workPolicyMigrationWarnings||[]).filter(message=>!(message.startsWith(`${type.code}:`)&&message.toLowerCase().includes('pay')));}});
      body.append(el('div',{class:'grid2'},field('Employer pay per recorded hour',multiplier,type.code==='F_06'?'Your confirmed setup is ×0 employer pay. SGK sickness benefit is separate.':'Hourly rate × this multiplier. Blank means pay is unconfirmed.'),field('Description sent to IFS',desc)));
      if(info.scope==='general-only')body.append(el('p',{class:'help'},`A full day uses the hours in Hours & schedule. This code is available only on General.`));
      if(type.code==='F_12')body.append(el('p',{class:'help'},'Travel after the location’s daily threshold uses this IFS code. Travel and work share the same threshold.'));
      if(type.code==='F_06'&&options.sickBenefitTool)body.append(options.sickBenefitTool({fullDayHours:policy.fullDayHours}));
      if(linked.length)body.append(...linked.map(row=>tagRow(row,draft.timeCodeMappings.indexOf(row))));
      else body.append(el('p',{class:'help'},'No Clockify tag linked. This time type still has its own pay and IFS settings.'));
      body.append(el('button',{class:'link',onclick:()=>addTag(type.code)},'Link a Clockify tag'));
      catalog.append(item);
    }
    draft.timeCodeMappings.forEach((row,index)=>{if(row.mode!=='code'||!timeCodeInfo(row.code))other.append(tagRow(row,index));});
    if(!other.childElementCount)other.append(el('p',{class:'help'},'No tags awaiting assignment or used as labels.'));
    summary();
  }
  const read=el('button',{id:'time-read-tags',onclick:async()=>{
    if(!alive())return;const captured=connection(),id=++request;
    if(!captured.apiKey||!captured.workspaceId||(captured.enteredKey??captured.apiKey)!==captured.apiKey){status.textContent='Connect Clockify first, then read its tags.';return;}
    read.disabled=true;status.textContent='Reading tags…';
    try{
      const tags=await(options.getTags?options.getTags(captured):new Clockify(captured.apiKey).tags(captured.workspaceId));
      const current=connection();if(!alive()||id!==request||current.apiKey!==captured.apiKey||current.workspaceId!==captured.workspaceId||(current.enteredKey??current.apiKey)!==captured.apiKey)return;
      if(!Array.isArray(tags)||tags.some(tag=>typeof tag?.id!=='string'||typeof tag?.name!=='string'))throw Error('Clockify returned an invalid tag list.');
      fetchedTags=tags;tagChoices.replaceChildren(...tags.map(tag=>el('option',{value:tag.name})));
      for(const tag of tags){
        let row=draft.timeCodeMappings.find(item=>item.tagId&&item.tagId===tag.id)||draft.timeCodeMappings.find(item=>item.tagName===tag.name);
        if(row){if((row.tagId&&row.tagId!==tag.id)||row.tagName!==tag.name)row.confirmed=false;row.tagId=tag.id;row.tagName=tag.name;}
        else{row={tagId:tag.id,tagName:tag.name,mode:'review',code:'',confirmed:false};draft.timeCodeMappings.push(row);}
        const proposed={'annual leave':'F_08',holiday:'F_07'}[row.tagName.trim().toLowerCase()];
        if(proposed&&!row.code&&row.mode!=='label'){row.code=proposed;row.mode='code';row.confirmed=false;}
      }
      changed();refreshRows();status.textContent='Tags read. Review new meanings and confirm them before use. Nothing was written to Clockify.';
    }catch(error){if(alive()&&id===request)status.textContent=`Could not read tags: ${error.message}`;}
    finally{if(alive())read.disabled=false;}
  }},'Read tags from Clockify');
  const payFields=el('div',{class:'grid2'},field('Hourly rate',number(draft,'payRate','Hourly rate',{fallback:0,max:1e9,step:0.01})),field('Currency',el('select',{'aria-label':'Pay currency',onchange:e=>{if(!alive())return;draft.payCurrency=e.target.value;changed();}},[...new Set([...(draft.currencies||[]),draft.payCurrency||'TRY'])].map(value=>el('option',{value,selected:draft.payCurrency===value},value)))));
  const types=fold('Time types & pay','All 11 IFS codes · pay and Clockify tags together','time-tags-settings',payFields,
    el('p',{class:'help'},'Each type is defined once. Changing its pay does not change or unconfirm a linked tag.'),
    el('div',{class:'row'},read,count,confirmSelected),status,attention,general,
    options.openProjects?el('button',{class:'link',onclick:()=>{if(alive())options.openProjects();}},'Set up the General destination in Projects'):null,
    catalog,fold('Other Clockify tags','Choose a time type or keep a tag as a label','time-other-tags',other,el('button',{class:'link',onclick:()=>addTag()},'Add a tag')),tagChoices);
  element.append(schedule,types);
  refreshRows();
  return{element,validate:()=>validateTimeSettings(draft),refreshCatalog:()=>refreshRows()};
}
