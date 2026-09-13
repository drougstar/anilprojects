import { createAccountSettingsSync } from './account-settings.js';
import { Supabase } from './supabase.js';
import { createSettingsFile } from './settings-transfer.js';
import { settingsChanges } from './settings-model.js';
import { el, openDialog } from './dom.js';

// The app still has an offline copy. A successful local write is never labelled
// account-saved until the server acknowledges both workspace and appearance.
export function createAccountPreferences({ workspace, getSaved, saveLocal, onApplied = () => {}, isCurrent = () => true, hasDraft = () => false, client, storage, syncFactory = createAccountSettingsSync }) {
  let disposed = false, busy = false, started = false;
  const panes = new Set(), dialogs = new Set(), states = new Map(), services = new Map();
  const scopes = [workspace, 'account'];
  const active = () => !disposed && isCurrent();
  const guard = () => { if (!active()) throw Error('The account changed. Sign in again before saving settings.'); };
  const current = () => getSaved();
  const validate = value => { createSettingsFile(value, { workspace, includeApiKey: workspace === 'work' }); return value; };
  const localApply = value => { guard(); validate(value); saveLocal(value); guard(); onApplied(current(), { external: true }); };
  const name = scope => scope === 'account' ? 'Appearance' : workspace === 'personal' ? 'Personal settings' : 'Work settings';
  const payload = (scope, saved = current()) => scope === 'account' ? { theme: saved.theme || 'auto' } : saved;
  const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
  const allSynced = () => scopes.every(scope => states.get(scope)?.state === 'synced');
  const syncMessage = () => {
    const pending = scopes.map(scope => [scope, states.get(scope) || { state: 'unchecked', message: 'Account settings have not been checked.' }]).filter(([, result]) => result.state !== 'synced');
    return pending.length ? pending.map(([scope, result]) => name(scope) + ': ' + result.message).join(' ') : 'Settings are saved to your account and available on your other devices.';
  };
  function changed(scope, result) { if (!active()) return; states.set(scope, result); for (const pane of panes) if (pane.isConnected) paint(pane); }
  function init() {
    guard(); if (services.size === scopes.length) return;
    const adapter = client || new Supabase(current().supabase);
    for (const scope of scopes) if (!services.has(scope)) {
      changed(scope, { state: 'unchecked', message: 'Account settings have not been checked.' });
      services.set(scope, syncFactory({ client: adapter, workspace: scope, storage, includeClockifyKey: true, onStatus: result => changed(scope, result) }));
    }
  }
  function accept(scope, result, snapshot) {
    if (result.state !== 'updated') return;
    if (hasDraft() || (snapshot && !same(payload(scope), snapshot))) {
      changed(scope, { state: 'review', message: 'Local settings changed while account settings were loading. Save or discard your draft, then review both versions.' });
      return;
    }
    const next = scope === 'account' ? { ...current(), theme: result.settings.theme || 'auto' } : { ...result.settings, theme: current().theme || 'auto' };
    try {
      localApply(structuredClone(next));
      // Confirm the exact reviewed payload, before default/migration expansion.
      services.get(scope).accepted(result.settings);
    } catch (error) {
      if (active()) changed(scope, { state: 'error', message: 'Account settings could not be applied on this device. Check browser storage, then try again.' });
      throw error;
    }
  }
  async function inspectAll(fresh) {
    init();
    for (const scope of scopes) {
      if (hasDraft()) { changed(scope, { state: 'draft', message: 'Save or discard your open Settings draft before checking account changes.' }); continue; }
      const snapshot = structuredClone(payload(scope));
      const result = await services.get(scope).inspect(snapshot, { fresh }); guard(); accept(scope, result, snapshot);
    }
    return current();
  }
  async function action(run) {
    if (!active() || busy) return;
    if (hasDraft()) { changed(workspace, { state: 'draft', message: 'Save or discard your open Settings draft before checking account changes.' }); return; }
    busy = true; for (const pane of panes) if (pane.isConnected) paint(pane);
    try { await run(); }
    catch (error) { if (active()) changed(workspace, { state: 'error', message: 'Account settings could not finish. Check the current setup before trying again.' }); }
    finally { busy = false; for (const pane of panes) if (pane.isConnected) paint(pane); }
  }
  function review(scope) {
    guard();
    if (hasDraft()) { changed(scope, { state: 'review', message: 'Save or discard the open draft before choosing an account setup.' }); return; }
    const service = services.get(scope), downloaded = service.useCloud(payload(scope));
    changed(scope, { state: 'review', message: 'This device and your account have different settings. Review which setup to keep.' });
    const local = payload(scope), remote = downloaded.settings;
    const reviewedLocal = structuredClone(local);
    const reviewStillCurrent = () => {
      if (same(payload(scope), reviewedLocal)) return true;
      changed(scope, { state: 'review', message: 'Settings changed after this review opened. Review the latest versions before choosing.' }); return false;
    };
    const changes = settingsChanges(local, remote);
    const content = el('div', {}, el('p', {}, 'This device and your account have different ' + name(scope).toLowerCase() + '. Choose one version. API keys are never displayed.'),
      ...changes.map(change => el('div', { class: 'settings-diff-row' }, el('strong', {}, change.label), el('p', {}, 'This device: ' + change.before), el('p', {}, 'Account: ' + change.after))));
    let dialog;
    dialog = openDialog('Review account settings', content, { wide: true, onClose: () => dialogs.delete(dialog) });
    dialogs.add(dialog);
    content.append(el('div', { class: 'actions' },
      el('button', { type: 'button', onclick: () => { if (!active()) return; dialog.close(); action(async () => { if (reviewStillCurrent()) accept(scope, downloaded, reviewedLocal); }); } }, 'Use account version'),
      el('button', { type: 'button', onclick: () => { if (!active()) return; dialog.close(); action(async () => { if (reviewStillCurrent()) await service.keepLocal(reviewedLocal); guard(); }); } }, 'Use this device’s version for my account'),
      el('button', { type: 'button', onclick: () => dialog.close() }, 'Decide later')));
  }
  function paint(pane) {
    const entries = [...states.entries()];
    const saved = allSynced();
    const summary = el('summary', {}, saved ? 'Account settings · saved' : 'Account settings · ' + (busy ? 'checking…' : 'needs attention'));
    pane.replaceChildren(summary);
    for (const [scope, result] of entries) {
      const buttons = [];
      if (result.state === 'review') buttons.push(el('button', { type: 'button', disabled: busy, onclick: () => review(scope) }, 'Review versions'));
      else if (result.state === 'local') buttons.push(el('button', { type: 'button', disabled: busy, onclick: () => action(async () => { await services.get(scope).save(payload(scope)); guard(); }) }, 'Save this setup to my account'));
      else if (!['synced', 'updated'].includes(result.state)) buttons.push(el('button', { type: 'button', disabled: busy, onclick: () => action(async () => {
        init(); const service = services.get(scope), snapshot = structuredClone(payload(scope));
        accept(scope, await service.inspect(snapshot), snapshot); guard();
      }) }, 'Try account sync again'));
      pane.append(el('p', { class: 'help', role: 'status' }, name(scope) + ': ' + result.message), ...buttons);
    }
    if (saved) pane.append(el('button', { type: 'button', disabled: busy, onclick: () => action(() => inspectAll(false)) }, 'Check for account changes'));
  }
  const online = () => { if (started && active() && !hasDraft() && !busy) action(() => inspectAll(false)); };
  return {
    async start(local, { fresh = false } = {}) {
      guard();
      if (busy) throw Error('Wait for the current account-settings check to finish.');
      busy = true;
      try { init(); await inspectAll(fresh); }
      catch (error) { if (!active()) throw error; changed(workspace, { state: 'error', message: 'Account settings could not be checked. Your existing setup is still available.' }); }
      finally { busy = false; for (const pane of panes) if (pane.isConnected) paint(pane); }
      if (!started) { started = true; globalThis.addEventListener?.('online', online); globalThis.addEventListener?.('focus', online); }
      return current();
    },
    async save(next) {
      guard();
      if (busy) throw Error('Wait for the current account-settings check to finish.');
      validate(next); saveLocal(next); guard(); onApplied(current());
      const savedSnapshot = structuredClone(current());
      busy = true;
      try {
        init();
        for (const scope of scopes) changed(scope, { state: 'saving', message: 'Saved on this device. Saving to your account…' });
        for (const scope of scopes) {
          if (!same(current(), savedSnapshot)) { changed(scope, { state: 'review', message: 'Settings changed again on this device while saving. Save the latest setup before syncing again.' }); continue; }
          await services.get(scope).save(payload(scope, savedSnapshot)); guard();
        }
      } catch (error) { if (!active()) throw error; changed(workspace, { state: 'error', message: 'Saved on this device. Account save could not finish. Try again.' }); }
      finally { busy = false; for (const pane of panes) if (pane.isConnected) paint(pane); }
      return { settings: current(), message: syncMessage(), state: allSynced() ? 'synced' : 'pending' };
    },
    panel() { const pane = el('details', { class: 'settings-account-status' }); panes.add(pane); paint(pane); return pane; },
    dispose() { disposed = true; for (const service of services.values()) service.dispose(); for (const dialog of dialogs) dialog.close(); dialogs.clear(); panes.clear(); globalThis.removeEventListener?.('online', online); globalThis.removeEventListener?.('focus', online); },
  };
}
