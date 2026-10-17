// オフラインでも使えるようにするサービスワーカー
const VERSION = 'v10';
const SHELL = [
  './', 'index.html', 'css/style.css', 'manifest.webmanifest',
  'js/app.js', 'js/srs.js', 'js/store.js', 'js/sync.js', 'js/stats.js',
  'js/merge.js', 'js/review.js', 'js/grade.js', 'js/handwriting.js', 'js/recognize.js', 'js/cloud.js', 'js/firebase-config.js',
  'icons/icon-192.png', 'icons/apple-touch-icon.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open('shell-' + VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => !k.endsWith('-' + VERSION)).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // Firebase の SDK（バージョンつきURLなので中身は変わらない）は、オフラインでも開けるようにキャッシュ優先
  if (url.origin === 'https://www.gstatic.com' && url.pathname.startsWith('/firebasejs/')) {
    e.respondWith(caches.open('sdk-' + VERSION).then(async (c) => (await c.match(e.request)) || fetch(e.request).then((res) => { if (res.ok) c.put(e.request, res.clone()); return res; })));
    return;
  }
  if (url.origin !== location.origin) return;
  // アプリ本体は「ネット優先・だめならキャッシュ」（カードの中身はここではなく Firestore から読む）
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      if (res.ok) caches.open('shell-' + VERSION).then((c) => c.put(e.request, copy));
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }))
  );
});
