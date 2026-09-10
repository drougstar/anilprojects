// Network-first for the app shell, cache as fallback so the page opens offline.
const CACHE = 'ifsbridge-v19';
const SHELL = ['./', './index.html', './css/app.css', './js/app.js', './js/rules.js', './js/ifs.js', './js/clockify.js', './js/store.js', './js/dom.js', './js/db.js', './js/supabase.js', './js/sync.js', './js/expense-ifs.js', './js/expenses.js', './js/localbackup.js', './manifest.webmanifest', './icons/icon-192.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || e.request.method !== 'GET') return; // Clockify etc. go straight to the network
  // Bypass the HTTP cache so an updated file is never shadowed by an old copy; the SW cache is the offline fallback.
  e.respondWith(fetch(e.request.url, { cache: 'no-store', credentials: 'same-origin' }).then(res => { const copy = res.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); return res; }).catch(() => caches.match(e.request)));
});
