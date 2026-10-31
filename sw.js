'use strict';
/* 静的ファイルのキャッシュのみ。対戦データは一切キャッシュ・保存しない。
 * 取得はネットワーク優先（更新が即座に届くように）。オフライン時のみキャッシュへフォールバックする。 */
const CACHE = 'angel-demon-v10';
const ASSETS = [
  './',
  './index.html',
  './css/style.css',
  './js/game.js',
  './js/icons.js',
  './js/net.js',
  './js/session.js',
  './js/cpu.js',
  './js/fx.js',
  './js/app.js',
  './vendor/peerjs.min.js',
  './manifest.webmanifest',
  './icon.svg',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((c) => c.put(e.request, copy));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
