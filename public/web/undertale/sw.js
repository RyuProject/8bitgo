const CACHE = '8bitgo-undertale-shell-2026-11-16-10'
const BASE = '/web/undertale/'
const CORE = [
  BASE,
  `${BASE}index.html`,
  `${BASE}styles.css`,
  `${BASE}app.js`,
  `${BASE}distribution-manifest.json`,
  `${BASE}runtime/butterscotch.mjs`,
  `${BASE}runtime/butterscotch.wasm`,
]

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key.startsWith('8bitgo-undertale-shell-') && key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.startsWith(BASE)) return

  if (url.pathname === `${BASE}distribution-manifest.json`) {
    // 包版本可以独立更新：联网时先拿最新版，断网时才退回上次缓存的清单。
    event.respondWith(fetch(request).then((response) => {
      if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()))
      return response
    }).catch(() => caches.match(request)))
    return
  }

  if (request.mode === 'navigate' || url.pathname.endsWith('.html')) {
    event.respondWith(fetch(request).then((response) => {
      const copy = response.clone()
      caches.open(CACHE).then((cache) => cache.put(request, copy))
      return response
    }).catch(() => caches.match(request).then((cached) => cached || caches.match(`${BASE}index.html`))))
    return
  }

  event.respondWith(caches.match(request).then((cached) => cached || fetch(request).then((response) => {
    if (response.ok) caches.open(CACHE).then((cache) => cache.put(request, response.clone()))
    return response
  })))
})
