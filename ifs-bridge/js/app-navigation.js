// Browser history is only a pointer into this document's memory. Filters and
// record details never enter the URL, browser history, or persistent storage.
export function createAppNavigation({ capture, restore, isCurrent, window: target = window }) {
  const doc = target.document, entries = new Map(), dialogs = new Map();
  const opaque = () => target.crypto?.randomUUID?.() || `${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const documentId = opaque(), markerKey = 'ifsbridgeNavigation';
  const clone = value => typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
  const signature = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
  let disposed = false, currentId = null, pendingClose = false, queued = [], generation = 0, restoringSignature = null;
  const valid = () => !disposed && isCurrent() && doc.documentElement.dataset.auth !== 'locked';
  const marker = () => target.history.state?.[markerKey];
  const ownEntry = () => { const value = marker(); return value?.document === documentId ? entries.get(value.entry) : null; };
  const liveDialogs = () => [...dialogs.values()].filter(item => !item.closed && item.dialog.open && item.dialog.isConnected).map(item => item.id);
  const same = (a, b) => signature(a) === signature(b);
  const clearRestoration = () => { generation++; restoringSignature = null; };

  function write(snapshot, { replace = false, dialogIds = liveDialogs() } = {}) {
    if (!valid()) { dispose(); return; }
    const previous = entries.get(currentId);
    if (!replace && previous && same(previous.snapshot, snapshot) && same(previous.dialogIds, dialogIds)) return previous;
    const id = replace && previous ? previous.id : opaque();
    const entry = { id, snapshot: clone(snapshot), dialogIds: [...dialogIds] };
    // Deliberately omit the third (URL) argument and all application data.
    try { target.history[replace ? 'replaceState' : 'pushState']({ [markerKey]: { document: documentId, entry: id } }, ''); }
    catch { dispose(); return; } // A restricted browser must still show the app.
    entries.set(id, entry);
    currentId = id;
    return entry;
  }

  function commit(snapshot, replace = false) {
    if (!valid()) { dispose(); return; }
    const value = clone(snapshot === undefined ? capture() : snapshot);
    // A render caused by Back may report its own state again. That is not a
    // fresh navigation, and must not erase the browser's Forward destination.
    if (restoringSignature !== null && signature(value) === restoringSignature) return;
    clearRestoration();
    if (pendingClose) { queued.push({ type: 'view', snapshot: value, replace, dialogIds: liveDialogs() }); return; }
    write(value, { replace });
  }

  function opened(event) {
    if (!valid()) { dispose(); return; }
    const dialog = event.detail?.dialog;
    if (!dialog?.open || !dialog.isConnected || [...dialogs.values()].some(item => item.dialog === dialog)) return;
    const item = { id: opaque(), dialog, closed: false, marker: null };
    dialogs.set(item.id, item);
    const snapshot = clone(capture());
    if (pendingClose) queued.push({ type: 'dialog', item, snapshot, dialogIds: liveDialogs() });
    else item.marker = write(snapshot)?.id;
  }

  function closed(event) {
    if (!valid()) { dispose(); return; }
    const item = [...dialogs.values()].find(value => value.dialog === event.detail?.dialog);
    if (!item) return;
    const wasClosed = item.closed;
    item.closed = true;
    if (!wasClosed) item.closedBy = 'ui';
    if (!valid() || wasClosed || pendingClose) return;
    // close() queues its native event. Another editor may already have opened,
    // so only consume the exact marker belonging to this particular dialog.
    if (item.marker && ownEntry()?.id === item.marker && currentId === item.marker) {
      pendingClose = true;
      target.history.back();
    }
  }

  function closeOutside(entry) {
    const wanted = new Set(entry.dialogIds);
    for (const item of [...dialogs.values()].reverse()) {
      if (item.closed || wanted.has(item.id)) continue;
      item.closed = true; item.closedBy = 'history'; // The later native close event must not trigger Back.
      if (item.dialog.open) item.dialog.close();
    }
  }

  function replay() {
    const work = queued; queued = [];
    for (const item of work) {
      if (!valid()) return;
      const dialogIds = item.dialogIds.filter(id => !dialogs.get(id)?.closed);
      if (item.type === 'view') write(item.snapshot, { replace: item.replace, dialogIds });
      else if (!item.item.closed && item.item.dialog.open && item.item.dialog.isConnected) item.item.marker = write(item.snapshot, { dialogIds })?.id;
    }
  }

  function popped() {
    if (!valid()) { dispose(); return; }
    const entry = ownEntry();
    if (!entry) { dispose(); return; }
    currentId = entry.id;
    clearRestoration();
    if (pendingClose) {
      // Both nested dialogs can be closed before either native event arrives.
      // Consume their own markers in order before replaying the next action.
      if ([...dialogs.values()].some(item => item.closedBy === 'ui' && item.marker === entry.id)) { target.history.back(); return; }
      pendingClose = false;
      // Closing an editor is not an instruction to undo a completed import or
      // the view selected by its onClose callback while Back was in flight.
      if (queued.length) replay();
      else write(capture(), { replace: true });
      return;
    }
    closeOutside(entry);
    if (same(capture(), entry.snapshot)) return;
    const request = generation, snapshot = clone(entry.snapshot);
    restoringSignature = signature(snapshot);
    try {
      const result = restore(snapshot, { isCurrent: () => valid() && request === generation });
      Promise.resolve(result).catch(() => {}).finally(() => { if (request === generation) restoringSignature = null; });
    } catch { if (request === generation) restoringSignature = null; }
  }

  function dispose() {
    if (disposed) return;
    disposed = true; clearRestoration(); queued = []; pendingClose = false;
    entries.clear(); dialogs.clear(); currentId = null;
    target.removeEventListener('popstate', popped);
    doc.removeEventListener('ifsbridge:dialog-opened', opened);
    doc.removeEventListener('ifsbridge:dialog-closed', closed);
  }

  if (valid()) {
    write(capture(), { replace: true });
    if (!disposed) {
      target.addEventListener('popstate', popped);
      doc.addEventListener('ifsbridge:dialog-opened', opened);
      doc.addEventListener('ifsbridge:dialog-closed', closed);
    }
  } else dispose();
  return { record: snapshot => commit(snapshot), replace: snapshot => commit(snapshot, true), dispose };
}
