// Minimal Clockify REST client (api.clockify.me, CORS is open, key in X-Api-Key).
const BASE = 'https://api.clockify.me/api/v1';

export class Clockify {
  constructor(apiKey) { this.apiKey = apiKey; }

  async request(method, path, { params = {}, body } = {}) {
    const url = new URL(BASE + path);
    for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
    const res = await fetch(url, { method, headers: { 'X-Api-Key': this.apiKey, ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
    if (res.status === 401 || res.status === 403) throw new Error('Clockify rejected the API key. Check it in Settings.');
    if (!res.ok) { const t = await res.text().catch(() => ''); throw new Error(`Clockify ${res.status} on ${method} ${path}${t ? ': ' + t.slice(0, 160) : ''}`); }
    return res.status === 204 ? null : res.json();
  }

  get(path, params = {}) { return this.request('GET', path, { params }); }

  user() { return this.get('/user'); }
  projects(ws) { return this.get(`/workspaces/${ws}/projects`, { 'page-size': 200, archived: false }); }
  tags(ws) { return this.get(`/workspaces/${ws}/tags`, { 'page-size': 200 }); }

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
