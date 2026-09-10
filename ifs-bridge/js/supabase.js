// Tiny Supabase client over fetch: GoTrue auth, PostgREST rows, Storage objects.
// No library so the offline shell stays small. Session is kept in localStorage.
const SESSION_KEY = 'ifsbridge.supabase.session';

export class Supabase {
  constructor({ url, anonKey }) {
    this.url = (url || '').replace(/\/+$/, '');
    this.anonKey = anonKey || '';
    this.session = null;
    try { this.session = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch {}
  }

  get configured() { return !!(this.url && this.anonKey); }
  get signedIn() { return !!(this.session && this.session.access_token); }
  get userId() { return this.session?.user?.id || null; }
  get email() { return this.session?.user?.email || ''; }

  saveSession(s) {
    this.session = s;
    try { s ? localStorage.setItem(SESSION_KEY, JSON.stringify(s)) : localStorage.removeItem(SESSION_KEY); } catch {}
  }

  async auth(path, body) {
    const res = await fetch(`${this.url}/auth/v1/${path}`, { method: 'POST', headers: { apikey: this.anonKey, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.msg || data.error_description || data.error || `Auth error ${res.status}`);
    return data;
  }

  async signUp(email, password) {
    const d = await this.auth('signup', { email, password });
    if (d.access_token) { this.saveSession({ ...d, expires_at: Date.now() + d.expires_in * 1000 }); return 'signed-in'; }
    return 'confirm-email';
  }

  async signIn(email, password) {
    const d = await this.auth('token?grant_type=password', { email, password });
    this.saveSession({ ...d, expires_at: Date.now() + d.expires_in * 1000 });
  }

  signOut() { this.saveSession(null); }

  async ensureToken() {
    if (!this.session) throw new Error('Not signed in.');
    if (Date.now() < (this.session.expires_at || 0) - 60000) return this.session.access_token;
    const d = await this.auth('token?grant_type=refresh_token', { refresh_token: this.session.refresh_token });
    this.saveSession({ ...d, expires_at: Date.now() + d.expires_in * 1000 });
    return this.session.access_token;
  }

  async headers(extra = {}) {
    const token = await this.ensureToken();
    return { apikey: this.anonKey, Authorization: `Bearer ${token}`, ...extra };
  }

  async rest(path, opts = {}) {
    const res = await fetch(`${this.url}/rest/v1/${path}`, { ...opts, headers: await this.headers({ 'Content-Type': 'application/json', ...(opts.headers || {}) }) });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${res.status}: ${text.slice(0, 200)}`);
    // an upsert with return=minimal answers 201 with an empty body
    return text.trim() ? JSON.parse(text) : null;
  }

  // Upsert rows by id. Server keeps client updated_at so last-write-wins stays consistent.
  upsert(table, rows) {
    return this.rest(`${table}?on_conflict=id`, { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows) });
  }

  pull(table, sinceIso) {
    const q = sinceIso ? `&updated_at=gt.${encodeURIComponent(sinceIso)}` : '';
    return this.rest(`${table}?select=*${q}&order=updated_at.asc&limit=1000`);
  }

  async uploadReceipt(id, blob) {
    const path = `${this.userId}/${id}.jpg`;
    const res = await fetch(`${this.url}/storage/v1/object/receipts/${path}`, { method: 'POST', headers: await this.headers({ 'Content-Type': blob.type || 'image/jpeg', 'x-upsert': 'true' }), body: blob });
    if (!res.ok) throw new Error(`Receipt upload failed (${res.status})`);
    return path;
  }

  async downloadReceipt(id) {
    const res = await fetch(`${this.url}/storage/v1/object/authenticated/receipts/${this.userId}/${id}.jpg`, { headers: await this.headers() });
    if (!res.ok) return null;
    return res.blob();
  }
}
