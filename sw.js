// Caches the app shell so PRM opens with no network at all. Your data is not
// here — it lives in OPFS, managed by SQLite — so this only ever caches code.

const VERSION = 'prm-v3'
const SHELL = [
  './',
  './index.html',
  './app.css',
  './manifest.json',
  // Self-hosted so the type still renders with no network.
  './fonts/karla.woff2',
  './fonts/newsreader.woff2',
  './js/app.js',
  './js/rpc.js',
  './js/worker.js',
  './js/queries.js',
  './js/vcard.js',
  './js/import.js',
  './vendor/sqlite3.mjs',
  './vendor/sqlite3.wasm',
  './icons/icon-32.png',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
]

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return
  // Network first so a deployed update is picked up, cache as the fallback
  // that makes offline work. Successful responses refresh the cache.
  e.respondWith(
    fetch(e.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone()
          caches.open(VERSION).then((c) => c.put(e.request, copy))
        }
        return res
      })
      .catch(() => caches.match(e.request).then((hit) => hit ?? caches.match('./index.html'))),
  )
})
