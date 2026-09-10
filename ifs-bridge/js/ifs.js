// IFS Enterprise Explorer "Copy Object / Paste Object" clipboard format.
//
//   !IFS.COPYOBJECT
//   $LU=ProjectTransWeek
//   $VIEW=PROJECT_TRANS_WEEK
//   $RECORD=!
//   -$0:NAME=value
//   -$15:=45            (unnamed column)
//   -                   (record terminator)
//
// Records are separated by one blank line.

// Parse every record in a Copy Object text. Several rows copied together share one
// header and repeat "$RECORD=!" blocks; pasting several texts one after another
// repeats the header too. Both are handled.
export function parseCopyObjects(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let lu = '', view = '', rec = null;
  const close = () => { if (rec && rec.fields.length) out.push(rec); rec = null; };
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line) continue;
    if (line.startsWith('!IFS.COPYOBJECT')) { close(); continue; }
    if (line.startsWith('$LU=')) { lu = line.slice(4).trim(); continue; }
    if (line.startsWith('$VIEW=')) { view = line.slice(6).trim(); continue; }
    if (line.startsWith('$RECORD=')) { close(); rec = { lu, view, fields: [] }; continue; }
    if (line === '-') { close(); continue; }
    if (line.startsWith('-$') && rec) {
      const colon = line.indexOf(':');
      const n = parseInt(line.slice(2, colon), 10);
      const rest = line.slice(colon + 1);
      const eq = rest.indexOf('=');
      const name = eq >= 0 ? rest.slice(0, eq) : rest;
      const value = eq >= 0 ? rest.slice(eq + 1) : '';
      rec.fields.push({ n, name, value });
    }
  }
  close();
  return out.filter(r => r.lu);
}

export function parseCopyObject(text) {
  return parseCopyObjects(text)[0] || null;
}

// Look up a field by exact name, or by "$n" for unnamed columns.
export function fieldValue(rec, key) {
  const f = findField(rec, key);
  return f ? f.value : undefined;
}

function findField(rec, key) {
  if (/^\$\d+$/.test(key)) {
    const n = parseInt(key.slice(1), 10);
    return rec.fields.find(f => f.n === n);
  }
  return rec.fields.find(f => f.name === key);
}

// Pass this as an override value to leave the column out of the record entirely,
// so IFS applies its own default for it.
export const OMIT = Symbol('omit');

// Build one record from a template record, replacing values by name or "$n".
// Keys in `overrides` that the template does not have are ignored (the paste
// only understands the columns of the target window).
export function buildRecord(template, overrides) {
  const out = [];
  out.push('!IFS.COPYOBJECT');
  out.push(`$LU=${template.lu}`);
  out.push(`$VIEW=${template.view}`);
  out.push('$RECORD=!');
  for (const f of template.fields) {
    let v = f.value;
    if (Object.prototype.hasOwnProperty.call(overrides, f.name) && f.name !== '') v = overrides[f.name];
    else if (Object.prototype.hasOwnProperty.call(overrides, `$${f.n}`)) v = overrides[`$${f.n}`];
    if (v === OMIT) continue;
    out.push(`-$${f.n}:${f.name}=${v == null ? '' : v}`);
  }
  out.push('-');
  return out.join('\n');
}

export function joinRecords(records) {
  return records.join('\n\n');
}

// yyyy-mm-dd -> yyyy-mm-dd-00.00.00
export function ifsDate(isoDate) {
  return `${isoDate}-00.00.00`;
}

// Numbers as IFS expects them: no thousands separator, dot decimal, no trailing .0
export function ifsNumber(n, decimals = 2) {
  if (n == null || n === '' || Number.isNaN(Number(n))) return '';
  const s = Number(n).toFixed(decimals);
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

// Pull the reusable identity/activity data out of a pasted PROJECT_TRANS_WEEK row.
export function activityFromRecord(rec) {
  const v = k => fieldValue(rec, k) ?? '';
  return {
    projectId: v('PROJECT_ID'),
    projectName: v('PROJECT_API.GET_NAME(PROJECT_ID)'),
    subProjectId: v('SUB_PROJECT_ID'),
    subProjectDesc: v('SUB_PROJECT_API.GET_DESCRIPTION(PROJECT_ID,SUB_PROJECT_ID)'),
    activityNo: v('ACTIVITY_NO'),
    activitySeq: v('ACTIVITY_SEQ'),
    activityDesc: v('ACTIVITY_API.GET_DESCRIPTION(ACTIVITY_SEQ)'),
    shortName: v('SHORT_NAME'),
  };
}

export function identityFromRecord(rec) {
  const v = k => fieldValue(rec, k) ?? '';
  return {
    companyId: v('COMPANY_ID'),
    empNo: v('EMP_NO'),
    resourceId: v('RESOURCE_ID'),
    resourceSeq: v('RESOURCE_SEQ'),
    resourceName: v('RESOURCE_API.GET_DESCRIPTION(RESOURCE_SEQ)'),
  };
}
