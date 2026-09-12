import { DEFAULT_CONNECTION } from './site-config.js';
// A page belongs to one account and one workspace for its entire lifetime.
// Switching saves a choice; the caller reloads before reading or syncing data.
const CONNECTION = 'ifsbridge.connection.v1';
const LEGACY_SETTINGS = 'ifsbridge.settings.v1';
const LEGACY_SESSION = 'ifsbridge.supabase.session';
const get = key => { try { return globalThis.localStorage?.getItem(key) || null; } catch { return null; } };
const read = key => { try { return JSON.parse(get(key) || 'null'); } catch { return null; } };
const put = (key, value) => {
  try { localStorage.setItem(key, value); }
  catch { throw Error('Browser storage is unavailable. Allow site storage before changing accounts or workspaces.'); }
};
const cleanUrl = value => {
  if (!value) return '';
  const u = new URL(String(value).trim());
  if (!['https:', 'http:'].includes(u.protocol)) throw Error('Use an HTTP or HTTPS project URL.');
  return (u.origin + u.pathname).replace(/\/+$/, '');
};

export function getConnection() {
  const configured = read(CONNECTION) || read(LEGACY_SETTINGS)?.supabase || {};
  const saved = configured.url && configured.anonKey ? configured : DEFAULT_CONNECTION;
  try { return { url: cleanUrl(saved.url), anonKey: String(saved.anonKey || '') }; }
  catch { return { url: '', anonKey: '' }; }
}

export function setConnection(value) {
  const next = { url: cleanUrl(value.url), anonKey: String(value.anonKey || '').trim() };
  put(CONNECTION, JSON.stringify(next));
  return next;
}

export const sessionKeyFor = url => `ifsbridge.supabase.session.${encodeURIComponent(cleanUrl(url))}`;

// Auth changes also notify this window; the browser's storage event only reaches
// other windows. Never include tokens or user details in these notifications.
export function notifySessionChanged() {
  if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function')
    globalThis.dispatchEvent(new CustomEvent('ifsbridge:session-changed'));
}
export function rotateSessionGeneration(url) {
  put(sessionKeyFor(url) + '.generation', `${Date.now()}.${Math.random().toString(36).slice(2)}`);
}
export function sessionExpiresAt(session) {
  const expiry = Number(session?.expires_at);
  // The older client saved milliseconds; Supabase's standard session uses seconds.
  if (Number.isFinite(expiry) && expiry > 0) return expiry < 1e12 ? expiry * 1000 : expiry;
  return 0;
}

export function savedSessionFor(url) {
  const key = sessionKeyFor(url), direct = read(key);
  if (direct) return direct;
  // Import the old session only for its original backend, once. Never move data.
  const oldUrl = read(LEGACY_SETTINGS)?.supabase?.url;
  let matches = false;
  try { matches = !!oldUrl && cleanUrl(oldUrl) === cleanUrl(url); } catch {}
  if (matches && !get(`${key}.migrated`)) {
    const old = read(LEGACY_SESSION);
    try {
      if (old) put(key, JSON.stringify(old));
      put(`${key}.migrated`, '1');
    } catch { /* Read-only storage can still open the existing account offline. */ }
    return old;
  }
  return null;
}

function derive() {
  const backend = getConnection().url;
  const session = backend ? savedSessionFor(backend) : null;
  const userId = session?.access_token && session?.user?.id ? String(session.user.id) : null;
  const accountKey = userId ? `account.${encodeURIComponent(backend)}.${encodeURIComponent(userId)}` : 'guest';
  const workspace = get(`ifsbridge.workspace.${accountKey}`) === 'personal' ? 'personal' : 'work';
  const legacy = !userId && workspace === 'work';
  const generation = backend ? get(sessionKeyFor(backend) + '.generation') || '' : '';
  return { accountKey, workspace, key: `${accountKey}.${workspace}`, userId, backend, legacy, generation };
}

const SCOPE = Object.freeze(derive());
let pageLocked = false;
export const currentScope = () => SCOPE;
export const scopedKey = base => SCOPE.legacy ? base : `${base}.scope.${SCOPE.key}`;
export function scopeIdentityIsCurrent() {
  const active = derive();
  return !pageLocked && active.key === SCOPE.key && active.backend === SCOPE.backend && active.generation === SCOPE.generation;
}
export function assertScopeIdentityCurrent() {
  if (!scopeIdentityIsCurrent()) throw Error('Account or workspace changed. Reload this tab before continuing.');
}
export function scopeIsCurrent() {
  return !!SCOPE.userId && scopeIdentityIsCurrent() && sessionExpiresAt(savedSessionFor(SCOPE.backend)) > Date.now();
}
export function assertScopeCurrent() {
  assertScopeIdentityCurrent();
  if (!scopeIsCurrent()) throw Error('Sign in to open your records. Your local records are still saved.');
}
export function lockScope() {
  pageLocked = true;
}
export function selectWorkspace(value) {
  if (!['work', 'personal'].includes(value)) throw Error('Choose Work or Personal.');
  assertScopeCurrent();
  put(`ifsbridge.workspace.${SCOPE.accountKey}`, value);
}
