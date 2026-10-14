const CACHE_NAME = 'nf-app-v8'; // 💡 キャッシュ更新のため v8 に変更

// 事前キャッシュ対象リスト
const ASSETS = [
  './',
  './index.html',
  './input.html',
  './viewer.html',
  './history.html', // 💡 history.html を追加
  './style.css',
  './app.js',
  './viewer.js',
  './manifest.json',
  './apple-touch-icon.png'
];

// インストール処理
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

// アクティベート処理（古いキャッシュの自動破棄）
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) return caches.delete(key);
        })
      );
    }).then(() => self.clients.claim())
  );
});

// フェッチ処理（HTMLは Network-First、その他静的ファイルは Cache-First）
self.addEventListener('fetch', (event) => {
  if (!event.request.url.startsWith('http')) return;

  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
          return networkResponse;
        })
        .catch(() => {
          return caches.match(event.request, { ignoreSearch: true });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
      if (cachedResponse) return cachedResponse;

      return fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseClone));
        }
        return networkResponse;
      });
    })
  );
});
