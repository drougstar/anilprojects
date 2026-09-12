// Minimal Clockify REST client (api.clockify.me, CORS is open, key in X-Api-Key).
import { assertScopeCurrent } from './scope.js';
const BASE = 'https://api.clockify.me/api/v1';

export class Clockify {
  constructor(apiKey) { this.apiKey = apiKey; }

  async request(method, path, { params = {}, body } = {}) {
    assertScopeCurrent();
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
    const res = await fetch(url, { method, headers: { 'X-Api-Key': this.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    assertScopeCurrent();
    if (res.status === 401 || res.status === 403) throw new Error('Clockify rejected the API key. Check it in Settings.');
    if (!res.ok) { const t = await res.text().catch(() => ''); assertScopeCurrent(); throw new Error(`Clockify ${res.status} on ${method} ${path}${t ? ': ' + t.slice(0, 160) : ''}`); }
    const result = res.status === 204 ? null : await res.json();
    assertScopeCurrent();
    return result;
  }

  get(path, params = {}) { return this.request('GET', path, { params }); }

  user() { return this.get('/user'); }
  projects(ws) { return this.get(`/workspaces/${ws}/projects`, { 'page-size': 200, archived: false }); }
  async tags(ws) {
    if (!ws) throw new Error('Connect Clockify before syncing tags.');
    const all = [], seen = new Set();
    for (let page = 1; page <= 100; page++) {
      const chunk = await this.get(`/workspaces/${encodeURIComponent(ws)}/tags`, { 'page-size': 200, page });
      if (!Array.isArray(chunk) || chunk.some(tag => !tag || typeof tag.id !== 'string' || typeof tag.name !== 'string')) throw new Error('Clockify returned an invalid tag list. Try syncing tags again.');
      for (const tag of chunk) {
        if (seen.has(tag.id)) throw new Error('Clockify repeated a tag page. No partial tag list was applied; try again.');
        seen.add(tag.id); all.push(tag);
      }
      if (chunk.length < 200) return all.sort((a, b) => a.name.localeCompare(b.name));
    }
    throw new Error('Clockify tag list exceeded the supported page limit. No partial tag list was applied.');
  }

  async entries(ws, userId, startIso, endIso) {
    const all = [];
    for (let page = 1; page < 20; page++) {
      const chunk = await this.get(`/workspaces/${ws}/user/${userId}/time-entries`, { start: startIso, end: endIso, hydrated: true, 'page-size': 200, page });
      all.push(...chunk);
      if (chunk.length < 200) break;
    }
    return all;
  }

  // body: { start, end (ISO UTC), description, projectId, tagIds, billable }
  createEntry(ws, body) { return this.request('POST', `/workspaces/${ws}/time-entries`, { body }); }
  updateEntry(ws, id, body) { return this.request('PUT', `/workspaces/${ws}/time-entries/${id}`, { body }); }
  deleteEntry(ws, id) { return this.request('DELETE', `/workspaces/${ws}/time-entries/${id}`); }
}
