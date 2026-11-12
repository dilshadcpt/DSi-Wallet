// Network-first for the app's own files, so updates arrive; cached copy when offline.
const CACHE = 'dsi-wallet-v12';
const FILES = ['./', 'index.html', 'style.css', 'app.js', 'core.js', 'pdf.js', 'reports.js', 'import-old.js', 'excel.js', 'loan-math.js', 'accounting.js', 'loan-bridge.js', 'od-bridge.js', 'old-state.js', 'records.js', 'finance-math.js', 'debt-actions.js', 'advances.js', 'construction-funding.js', 'parties.js', 'drive-sync.js', 'format.js', 'security.js', 'vendor/xlsx.full.min.js', 'config.js', 'manifest.webmanifest', 'icon.svg'];

self.addEventListener('install', e => e.waitUntil(caches.open(CACHE).then(c => c.addAll(FILES)).then(() => self.skipWaiting())));
self.addEventListener('activate', e => e.waitUntil(
  caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim())));
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return; // Supabase and CDN calls go straight to network
  e.respondWith(fetch(e.request).then(res => {
    const copy = res.clone();
    caches.open(CACHE).then(c => c.put(e.request, copy));
    return res;
  }).catch(() => caches.match(e.request).then(r => r || caches.match('index.html'))));
});

// ---- Push: a reminder sent by the relay, shown even when the app is closed ----
self.addEventListener('push', e => {
  let data = { title: 'DSi Digital', body: 'You have a payment due soon.', tag: 'dsi-due' };
  try { data = { ...data, ...e.data.json() }; } catch (_) { /* empty or plain push */ }
  e.waitUntil(self.registration.showNotification(data.title, {
    body: data.body, icon: 'icon.svg', badge: 'icon.svg', tag: data.tag, renotify: false,
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
    const win = list.find(c => 'focus' in c);
    return win ? win.focus() : self.clients.openWindow('./');
  }));
});
