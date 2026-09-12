// Only public app assets enter the offline cache. Backups and receipt APIs never do.
const CACHE = 'ifsbridge-v39-test-1';
const SHELL = ['./', './index.html', './css/app.css', './css/expense-tools.css', './js/app.js', './js/shell.js', './js/scope.js', './js/workspace-ui.js', './js/expense-tools.js', './js/expense-workflows.js', './js/rules.js', './js/ifs.js', './js/clockify.js', './js/store.js', './js/dom.js', './js/db.js', './js/supabase.js', './js/sync.js', './js/expense-ifs.js', './js/expenses.js', './js/localbackup.js', './js/week-status.js', './js/ocr.js', './js/report.js', './manifest.webmanifest', './icons/icon-192.png'];
SHELL.push('./css/personal.css', './js/personal.js', './js/personal-analytics.js', './js/settings-transfer.js');
SHELL.push('./css/auth.css', './css/bank-import.css', './css/personal-study.css', './js/bank-ui.js', './js/bank-import.js', './js/bank-files.js', './js/bank-reader-worker.js', './js/personal-study.js', './vendor/xlsx-0.20.3.full.min.js');
SHELL.push('./js/mfa-ui.js', './js/work-match.js', './js/work-match-ui.js', './js/work-context.js', './supabase/personal-mfa-v3.sql');
SHELL.push('./js/site-config.js');
const paths = new Set(SHELL.map(path => new URL(path, self.registration.scope).pathname));
const ratePath = new URL('./rates/', self.registration.scope).pathname;

self.addEventListener('install', event => {
  event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('ifsbridge-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin || event.request.method !== 'GET') return;
  const publicRate = url.pathname.startsWith(ratePath) && /^\d{4}-\d{2}-\d{2}\.json$/.test(url.pathname.slice(ratePath.length));
  if (!paths.has(url.pathname) && !publicRate) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request, { cache: 'no-store' });
      if (response.ok) await cache.put(event.request, response.clone());
      return response;
    } catch {
      return await cache.match(event.request) || new Response('This app file is unavailable offline. Reconnect and reload.', { status: 503, headers: { 'Content-Type': 'text/plain' } });
    }
  })());
});

