// Preferences sync separately from expense/time records. Nothing here changes
// the app's saved settings: the caller applies a returned `settings` only after
// accepting a download. Existing local and cloud setups are never auto-merged.
import { createSettingsFile } from './settings-transfer.js';
export const ACCOUNT_SETTINGS_LIMIT = 1024 * 1024;
const WORK_KEYS = ('settingsListsVersion timeCalculationMode timeCodeMappingsVersion timeZone regularHours travelAfterHours topUpMinimum roundStep roundMode holidays tags travelKeyword codes codeDescriptions timeCodeMappings timeCodeCatalog identity template defaultCurrency currencies costObjects expenseCodes perDiemCode expenseTemplate expenseActivitySuffix knownShortNames homeCurrency rateSource tcmbField currRateMode perDiemDefaults payRate payCurrency restDaysPaid restDayHours payMinDay mapping workPolicyVersion workPolicy workPolicyMigrationWarnings timeTypes').split(' ');
const PERSONAL_KEYS = ['settingsListsVersion', 'timeZone', 'defaultCurrency', 'currencies', 'expenseCodes'];
const ACCOUNT_KEYS = ['theme', 'timeZone'];
const CONNECTION_KEYS = ['apiKey', 'workspaceId', 'userId', 'userName'];
const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'access_token', 'refresh_token', 'service_role', 'serviceRoleKey']);
const plain = value => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const clone = value => structuredClone(value);
const keysFor = workspace => workspace === 'work' ? WORK_KEYS : workspace === 'personal' ? PERSONAL_KEYS : ACCOUNT_KEYS;
const same = (left, right) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  return plain(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
}
function inspectTree(value, depth = 0, budget = { left: 100000 }) {
  if (--budget.left < 0 || depth > 20) throw Error('Settings are too complex to sync.');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!plain(value) && !Array.isArray(value)) throw Error('Settings contain an unsupported value.');
  for (const [key, child] of Object.entries(value)) {
    if (forbidden.has(key)) throw Error('Settings contain an unsafe property.');
    inspectTree(child, depth + 1, budget);
  }
}
function workspaceValid(workspace) {
  if (!['work', 'personal', 'account'].includes(workspace)) throw Error('Invalid settings workspace.');
}
/** Explicit allowlist prevents sessions, Supabase credentials and records uploads. */
export function accountSettingsPayload(settings, { workspace = 'work', includeClockifyKey = false } = {}) {
  workspaceValid(workspace);
  if (!plain(settings)) throw Error('Settings are unavailable.');
  const payload = {};
  for (const key of keysFor(workspace)) if (Object.hasOwn(settings, key)) payload[key] = clone(settings[key]);
  if (workspace === 'work' && includeClockifyKey && plain(settings.clockify)) {
    payload.clockify = Object.fromEntries(CONNECTION_KEYS.filter(key => Object.hasOwn(settings.clockify, key)).map(key => {
      if (typeof settings.clockify[key] !== 'string' || settings.clockify[key].length > 4096) throw Error('Invalid Clockify connection settings.');
      return [key, settings.clockify[key]];
    }));
  }
  inspectTree(payload);
  if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > ACCOUNT_SETTINGS_LIMIT) throw Error('Settings exceed the 1 MB sync limit.');
  if (workspace === 'account' && payload.theme !== undefined && !['light', 'dark', 'auto'].includes(payload.theme)) throw Error('Choose a supported appearance.');
  if (payload.timeZone !== undefined) {
    if (typeof payload.timeZone !== 'string' || payload.timeZone.length > 100) throw Error('Choose a valid time zone.');
    try { new Intl.DateTimeFormat('en', { timeZone: payload.timeZone }); } catch { throw Error('Choose a valid time zone.'); }
  }
  // Reuse the import schema for nested project/policy/category types. The key
  // lives outside this preferences validation because shared connections also
  // include verified Clockify identifiers, which portable files intentionally omit.
  if (workspace !== 'account' && Object.keys(payload).some(key => key !== 'clockify')) createSettingsFile(payload, { workspace, includeApiKey: false });
  return payload;
}

function checkedRow(row, workspace) {
  if (row === null) return null;
  if (!plain(row) || !Number.isSafeInteger(row.revision) || row.revision < 1 || !plain(row.payload)) throw Error('The settings service returned an invalid response.');
  const payload = accountSettingsPayload(row.payload, { workspace, includeClockifyKey: true });
  if (!same(payload, row.payload)) throw Error('The settings service returned unsupported fields.');
  return { revision: row.revision, payload, updatedAt: typeof row.updated_at === 'string' ? row.updated_at : null };
}
function applyPayload(localSettings, payload, workspace, includeClockifyKey) {
  const next = clone(localSettings);
  for (const key of keysFor(workspace)) {
    delete next[key];
    if (Object.hasOwn(payload, key)) next[key] = clone(payload[key]);
  }
  if (workspace === 'work' && includeClockifyKey) {
    delete next.clockify;
    if (payload.clockify) next.clockify = clone(payload.clockify);
  }
  return next;
}

/**
 * `client` is the existing frozen-scope Supabase adapter; its rest method checks
 * both identity and Personal AAL2 before/after requests. This module checks again
 * before touching the owner-bound queue, including after every async response.
 */
export function createAccountSettingsSync({ client, workspace = client?.scope?.workspace, storage = globalThis.localStorage, onStatus = () => {}, includeClockifyKey = false } = {}) {
  workspaceValid(workspace);
  if (!client?.scope?.userId || !client?.scope?.backend || !client.assertScope || !client.rest) throw Error('Sign in before syncing account settings.');
  if (workspace !== 'account' && workspace !== client.scope.workspace) throw Error('Open that workspace before syncing its settings.');
  const binding = { backend: client.scope.backend, userId: client.scope.userId, workspace };
  const storageKey = 'ifsbridge.account-settings.v1.' + encodeURIComponent(JSON.stringify(binding));
  let disposed = false, busy = false, cloud = undefined, review = false, download = null;
  let status = { state: 'unchecked', message: 'Account settings have not been checked.' };
  const guard = () => { if (disposed) throw Error('This settings page is closed.'); client.assertScope(); };
  const show = (state, message, extra = {}) => { guard(); status = { state, message, ...extra }; onStatus({ state, message }); return status; };
  function readMeta() {
    guard();
    const text = storage.getItem(storageKey);
    if (!text) return { version: 1, ...binding, baseline: null, pending: null };
    let value;
    try { value = JSON.parse(text); } catch { throw Error('The saved settings queue is unreadable. Export your local settings before resetting it.'); }
    if (value.version !== 1 || Object.entries(binding).some(([key, item]) => value[key] !== item)) throw Error('The saved settings queue belongs to a different account.');
    if (value.baseline) checkedRow(value.baseline, workspace);
    if (value.pending) {
      const p = value.pending;
      if (!plain(p) || !/^[a-zA-Z0-9-]{16,128}$/.test(p.operationId) || (p.expectedRevision !== null && (!Number.isSafeInteger(p.expectedRevision) || p.expectedRevision < 1))) throw Error('The saved settings queue is invalid.');
      if (!same(accountSettingsPayload(p.payload, { workspace, includeClockifyKey: true }), p.payload)) throw Error('The saved settings queue contains unsupported fields.');
    }
    return value;
  }
  function persist(meta) { guard(); storage.setItem(storageKey, JSON.stringify(meta)); }
  function failure(error, queued = false) {
    guard();
    const message = String(error?.message || error);
    if (/PGRST202|42883|Could not find the function|function .* does not exist/i.test(message)) return show('schema-required', queued ? 'Saved on this device; account sync needs supabase/account-settings-v4.sql. Your changes are queued.' : 'Account sync needs supabase/account-settings-v4.sql. Existing settings stay on this device.');
    if (/Failed to fetch|fetch failed|NetworkError|network|offline|Supabase 50[0234]/i.test(message)) return show(queued ? 'queued' : 'offline', queued ? 'Saved on this device. Waiting for a connection to save to your account.' : 'Account settings are unavailable while offline.');
    return show('error', queued ? 'Saved on this device, but account sync failed. Your changes remain queued. Try again.' : 'Could not check account settings. Try again.');
  }
  async function run(action) {
    guard();
    if (busy) throw Error('A settings sync is already running.');
    busy = true;
    try { return await action(); } finally { busy = false; }
  }
  const payloadOf = (settings, options = {}) => accountSettingsPayload(settings, { workspace, includeClockifyKey: options.includeClockifyKey ?? includeClockifyKey });
  async function fetchCloud() {
    guard();
    const result = await client.rest('rpc/ifsbridge_read_settings', { method: 'POST', body: JSON.stringify({ p_workspace: workspace }) });
    guard(); cloud = checkedRow(result, workspace); return cloud;
  }
  function acceptBaseline(meta, row) { meta.baseline = row; meta.pending = null; persist(meta); review = false; }
  const differs = message => { review = true; return show('review', message); };
  function offerDownload(localSettings, message) {
    download = { row: clone(cloud), pendingId: readMeta().pending?.operationId };
    return show('updated', message, { settings: applyPayload(localSettings, cloud.payload, workspace, includeClockifyKey) });
  }
  async function flush() {
    const meta = readMeta(), pending = meta.pending;
    if (!pending) return show('local', 'No settings changes are waiting to sync. Check your account for updates.');
    // Reading first makes an uncertain previous write retry-safe, and means a
    // first offline save cannot replace an existing setup on another device.
    await fetchCloud();
    const latest = readMeta();
    if (latest.pending?.operationId !== pending.operationId) return differs('Settings changed in another tab. Review the latest saved setup before syncing.');
    if (cloud && same(cloud.payload, pending.payload)) { acceptBaseline(latest, cloud); return show('synced', 'Settings are saved to your account.'); }
    const actualRevision = cloud?.revision ?? null;
    if (actualRevision !== pending.expectedRevision) return differs('Your account has different settings. Choose which setup to keep before syncing.');
    const result = await client.rest('rpc/ifsbridge_write_settings', { method: 'POST', body: JSON.stringify({ p_workspace: workspace, p_expected_revision: pending.expectedRevision, p_payload: pending.payload, p_operation_id: pending.operationId }) });
    guard();
    if (!plain(result) || typeof result.applied !== 'boolean') throw Error('The settings service returned an invalid response.');
    cloud = checkedRow(result.row, workspace);
    if (!result.applied) return differs('Settings changed on another device. Review the account version before saving.');
    if (!cloud || !same(cloud.payload, pending.payload)) throw Error('The settings service did not confirm the saved setup.');
    const after = readMeta();
    if (after.pending?.operationId !== pending.operationId) return differs('A newer change is waiting in another tab. Check it before syncing again.');
    acceptBaseline(after, cloud); return show('synced', 'Settings are saved to your account.');
  }
  function queue(settings, options = {}) {
    const meta = readMeta(), payload = payloadOf(settings, options);
    meta.pending = { payload, expectedRevision: meta.baseline?.revision ?? null, operationId: globalThis.crypto.randomUUID() };
    persist(meta); return meta;
  }
  return {
    get status() { return { state: status.state, message: status.message }; },
    get hasPending() { return !!readMeta().pending; },
    get storageKey() { return storageKey; },
    inspect(localSettings, { fresh = false } = {}) {
      return run(async () => {
        try {
          const meta = readMeta(), payload = payloadOf(localSettings);
          await fetchCloud();
          if (readMeta().pending?.operationId !== meta.pending?.operationId) return differs('Settings changed in another tab. Check the latest setup before syncing.');
          if (meta.pending) {
            const result = await flush();
            if (result.state === 'synced' && cloud && !same(payloadOf(cloud.payload), payload)) return differs('The pending setup was saved, but this device has newer settings. Review both versions before syncing those changes.');
            return result;
          }
          if (!cloud) return show('local', 'Your account has no saved settings yet. Save to make this setup available on your other devices.');
          if (same(payloadOf(cloud.payload), payload)) { acceptBaseline(meta, cloud); return show('synced', 'Settings are saved to your account.'); }
          if (fresh || (meta.baseline && same(payload, payloadOf(meta.baseline.payload)))) {
            // The caller must commit the download locally, then call accepted().
            return offerDownload(localSettings, 'Account settings are ready to use on this device.');
          }
          return differs('This device and your account have different settings. Choose which setup to keep.');
        } catch (error) { return failure(error, !!readMeta().pending); }
      });
    },
    save(settings, options = {}) {
      return run(async () => {
        queue(settings, options);
        try { return await flush(); } catch (error) { return failure(error, true); }
      });
    },
    // Called only after the downloaded settings were successfully saved locally.
    accepted(settings) {
      guard();
      if (!download || !same(payloadOf(settings), payloadOf(download.row.payload))) throw Error('Save the reviewed account settings locally before confirming the download.');
      const meta = readMeta();
      if (meta.pending?.operationId !== download.pendingId) return differs('Another tab saved changes while you downloaded settings. Review that pending setup before syncing.');
      acceptBaseline(meta, download.row); download = null; return show('synced', 'Settings are saved to your account.');
    },
    useCloud(localSettings) {
      guard();
      if (!cloud) throw Error('Check account settings before choosing its setup.');
      return offerDownload(localSettings, 'Save this account setup on this device to finish.');
    },
    keepLocal(settings, options = {}) {
      return run(async () => {
        if (!review || cloud === undefined) throw Error('Review the account setup before replacing it.');
        // Explicit user choice authorizes replacement only of the version shown.
        const meta = readMeta(); meta.baseline = cloud; persist(meta); queue(settings, options);
        try { return await flush(); } catch (error) { return failure(error, true); }
      });
    },
    retry() { return run(async () => { try { return await flush(); } catch (error) { return failure(error, !!readMeta().pending); } }); },
    // Closing/signing out invalidates late responses; queued changes are retained
    // for this owner. Do not erase another account's queue during sign-out.
    dispose() { disposed = true; cloud = undefined; },
  };
}
