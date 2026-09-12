// Small fetch client. Every data request belongs to the page's frozen scope.
import { currentScope, assertScopeCurrent, assertScopeIdentityCurrent, sessionKeyFor, savedSessionFor, sessionExpiresAt, rotateSessionGeneration, notifySessionChanged, lockScope, visitRevision, assertVisitRevision, admitFreshSignIn, sessionAssurance } from './scope.js';
const SCOPED_TABLES = ['sheets', 'trips', 'expenses', 'weeks', 'templates', 'budgets', 'inbox'];
const refreshing = new Map();
export class Supabase {
  constructor({ url, anonKey }) {
    this.url = (url || '').replace(/\/+$/, ''); this.anonKey = anonKey || '';
    this.scope = currentScope(); this.session = this.url ? savedSessionFor(this.url) : null;
  }
  get configured() { return !!(this.url && this.anonKey); }
  get signedIn() { return !!this.session?.access_token; }
  get userId() { return this.session?.user?.id || null; }
  get email() { return this.session?.user?.email || ''; }
  assertIdentity() {
    assertScopeIdentityCurrent();
    if (this.url !== this.scope.backend || this.userId !== this.scope.userId || !this.scope.userId) throw Error('Reload this tab after signing in or changing accounts before syncing.');
  }
  assertScope() { this.assertIdentity(); assertScopeCurrent(); }
  saveSession(s, { newSession = false } = {}) {
    this.session = s;
    const key = sessionKeyFor(this.url);
    s ? localStorage.setItem(key, JSON.stringify(s)) : localStorage.removeItem(key);
    localStorage.setItem(key + '.migrated', '1');
    if (!s || newSession) rotateSessionGeneration(this.url);
    notifySessionChanged();
    if (s && newSession) admitFreshSignIn(this.url);
  }
  async auth(path, body) {
    const res = await fetch(this.url + '/auth/v1/' + path, { method: 'POST', headers: { apikey: this.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { const error = Error(data.msg || data.error_description || data.error || 'Auth error ' + res.status); error.authStatus = res.status; throw error; }
    return data;
  }
  async signUp(email, password) {
    const revision = visitRevision();
    const d = await this.auth('signup', { email, password });
    assertVisitRevision(revision);
    if (d.access_token) { this.saveSession({ ...d, expires_at: Date.now() + d.expires_in * 1000 }, { newSession: true }); return 'signed-in'; }
    return 'confirm-email';
  }
  async signIn(email, password) {
    const revision = visitRevision();
    const d = await this.auth('token?grant_type=password', { email, password });
    assertVisitRevision(revision);
    this.saveSession({ ...d, expires_at: Date.now() + d.expires_in * 1000 }, { newSession: true });
  }
  signOut() {
    try { this.saveSession(null); }
    finally { lockScope(); notifySessionChanged(); }
  }
  async ensureToken({ identityOnly = false } = {}) {
    // Refresh validates identity only: an expired access token must be renewable
    // before any private database or API request is allowed to run.
    this.assertIdentity();
    this.session = savedSessionFor(this.url);
    this.assertIdentity();
    if (Date.now() < sessionExpiresAt(this.session) - 60000) return this.session.access_token;
    if (!this.session.refresh_token) {
      if (Date.now() < sessionExpiresAt(this.session)) return this.session.access_token;
      this.signOut(); throw Error('Your session expired. Sign in again.');
    }
    if (!refreshing.has(this.url)) {
      const original = this.session;
      const request = (async () => {
        try {
          const d = await this.auth('token?grant_type=refresh_token', { refresh_token: original.refresh_token });
          this.assertIdentity();
          if (d.user?.id !== this.scope.userId || !d.access_token) { this.signOut(); throw Error('Session identity changed. Sign in again.'); }
          this.saveSession({ ...d, expires_at: Date.now() + d.expires_in * 1000 });
        } catch (error) {
          const latest = savedSessionFor(this.url);
          // A second window may already have refreshed the same session.
          if (latest?.access_token !== original.access_token && latest?.user?.id === this.scope.userId && sessionExpiresAt(latest) > Date.now()) return;
          if ([400, 401, 403].includes(error.authStatus)) { this.assertIdentity(); this.signOut(); }
          throw error;
        }
      })().finally(() => refreshing.delete(this.url));
      refreshing.set(this.url, request);
    }
    await refreshing.get(this.url);
    this.session = savedSessionFor(this.url);
    identityOnly ? this.assertIdentity() : this.assertScope();
    return this.session.access_token;
  }
  // MFA is available after password sign-in even while Personal records are locked.
  // These calls check identity and visit lifetime without granting record access.
  async mfaRequest(path, { method = 'POST', body } = {}) {
    const revision = visitRevision();
    this.assertIdentity();
    const token = await this.ensureToken({ identityOnly: true });
    assertVisitRevision(revision); this.assertIdentity();
    const res = await fetch(this.url + '/auth/v1/' + path, {
      method, headers: { apikey: this.anonKey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    });
    const data = await res.json().catch(() => ({}));
    assertVisitRevision(revision); this.assertIdentity();
    if (!res.ok) {
      const error = Error(data.msg || data.error_description || data.error || 'Authenticator request failed (' + res.status + ')');
      error.authStatus = res.status;
      throw error;
    }
    return data;
  }
  async mfaPolicyReady() {
    const revision = visitRevision();
    this.assertIdentity();
    const token = await this.ensureToken({ identityOnly: true });
    assertVisitRevision(revision); this.assertIdentity();
    const res = await fetch(this.url + '/rest/v1/rpc/ifsbridge_schema_version', {
      method: 'POST', headers: { apikey: this.anonKey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: '{}'
    });
    const data = await res.json().catch(() => null);
    assertVisitRevision(revision); this.assertIdentity();
    if (!res.ok) throw Error('Could not check Personal security setup. Try again when connected.');
    return Number(data) >= 3;
  }
  async listFactors() {
    // Supabase's client lists factors from its authenticated user endpoint.
    const user = await this.mfaRequest('user', { method: 'GET' });
    if (user.id !== this.scope.userId) throw Error('The account changed. Sign in again.');
    const all = Array.isArray(user.factors) ? user.factors : [];
    return { all, totp: all.filter(factor => factor.factor_type === 'totp' && factor.status === 'verified') };
  }
  async enrollTotp() {
    const result = await this.mfaRequest('factors', { body: {
      factor_type: 'totp', friendly_name: 'Personal authenticator ' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 7), issuer: 'Pocket / IFS Bridge'
    } });
    if (!result.id || result.type !== 'totp' || !result.totp?.secret || !result.totp?.qr_code)
      throw Error('The authenticator setup response was incomplete. Try again.');
    return result;
  }
  async challengeAndVerifyTotp(factorId, code) {
    const id = String(factorId || '').trim(), digits = String(code || '').trim();
    if (!/^[a-zA-Z0-9-]{1,128}$/.test(id)) throw Error('Choose an authenticator first.');
    if (!/^\d{6}$/.test(digits)) throw Error('Enter the six-digit code from your authenticator.');
    const revision = visitRevision();
    const path = 'factors/' + encodeURIComponent(id);
    const challenge = await this.mfaRequest(path + '/challenge', { body: {} });
    if (!challenge.id || typeof challenge.id !== 'string') throw Error('The authenticator challenge was incomplete. Try again.');
    assertVisitRevision(revision); this.assertIdentity();
    const result = await this.mfaRequest(path + '/verify', { body: { challenge_id: challenge.id, code: digits } });
    assertVisitRevision(revision); this.assertIdentity();
    const lifetime = Number(result.expires_in);
    if (sessionAssurance(result) !== 'aal2' || result.user?.id !== this.scope.userId ||
        !result.refresh_token || !Number.isFinite(lifetime) || lifetime <= 0)
      throw Error('The authenticator could not verify this account. Sign in again.');
    // This upgrades the same account's session, keeping its workspace generation.
    this.saveSession({ ...result, expires_at: Date.now() + lifetime * 1000 });
    return this.session;
  }
  async headers(extra = {}) {
    const token = await this.ensureToken();
    return { apikey: this.anonKey, Authorization: 'Bearer ' + token, ...extra };
  }
  async rest(path, opts = {}) {
    this.assertScope();
    const parsed = new URL(this.url + '/rest/v1/' + path), table = parsed.pathname.split('/').at(-1);
    if (SCOPED_TABLES.includes(table)) {
      if (opts.method && opts.method !== 'GET') throw Error('Direct writes are disabled. Sync requires the workspace migration.');
      parsed.searchParams.set('workspace_id', 'eq.' + this.scope.workspace);
      parsed.searchParams.set('user_id', 'eq.' + this.scope.userId);
    }
    const headers = await this.headers({ 'Content-Type': 'application/json', ...(opts.headers || {}) });
    this.assertScope();
    const res = await fetch(parsed, { ...opts, headers });
    const text = await res.text(); this.assertScope();
    if (!res.ok) { if (res.status === 401) this.signOut(); throw Error('Supabase ' + res.status + ': ' + text.slice(0, 200)); }
    return text.trim() ? JSON.parse(text) : null;
  }
  schemaVersion() { return this.rest('rpc/ifsbridge_schema_version', { method: 'POST', body: '{}' }); }
  applyChanges(changes) {
    return this.rest('rpc/ifsbridge_apply_changes', { method: 'POST', body: JSON.stringify({ p_workspace: this.scope.workspace, p_changes: changes }) });
  }
  upsert() { throw Error('Direct writes are disabled. Use guarded workspace sync.'); }
  async pull(table) {
    if (!SCOPED_TABLES.includes(table)) throw Error('Unsupported sync table.');
    // Read all pages in this workspace; a client-clock timestamp is not a safe
    // permanent cursor when another device can save an older offline record.
    const all = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await this.rest(table + '?select=*&order=id.asc&limit=1000&offset=' + offset);
      all.push(...page); if (page.length < 1000) return all;
    }
  }
  async uploadReceipt(id, blob) {
    this.assertScope();
    const path = this.scope.userId + '/' + this.scope.workspace + '/' + encodeURIComponent(id) + '.jpg';
    const headers = await this.headers({ 'Content-Type': blob.type || 'image/jpeg', 'x-upsert': 'true' });
    this.assertScope();
    const res = await fetch(this.url + '/storage/v1/object/receipts/' + path, { method: 'POST', headers, body: blob });
    this.assertScope();
    if (!res.ok) { if (res.status === 401) this.signOut(); throw Error('Receipt upload failed (' + res.status + ')'); }
    return path;
  }
  async downloadReceipt(id) {
    this.assertScope();
    const base = this.url + '/storage/v1/object/authenticated/receipts/' + this.scope.userId + '/';
    const headers = await this.headers();
    this.assertScope();
    let res = await fetch(base + this.scope.workspace + '/' + encodeURIComponent(id) + '.jpg', { headers });
    this.assertScope();
    // Old receipt paths belong only to Work, never to Personal.
    if (res.status === 404 && this.scope.workspace === 'work') {
      res = await fetch(base + encodeURIComponent(id) + '.jpg', { headers }); this.assertScope();
    }
    if (!res.ok) { if (res.status === 401) this.signOut(); throw Error('storage ' + res.status); }
    const blob = await res.blob();
    this.assertScope();
    return blob;
  }
}
