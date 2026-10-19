/* global self, caches, fetch, Request */
'use strict'

const VERSION = '__STREAM_VERSION__'
const CACHE_NAME = `8bitgo-funkin-${VERSION}`
const MANIFEST_URL = `./funkin-prefetch-manifest.json?v=${encodeURIComponent(VERSION)}`
const MAX_CACHEABLE_BYTES = 24 * 1024 * 1024
const inflight = new Map()
let manifestPromise
let prefetchPromise = Promise.resolve()

const assetPath = (url) => url.origin === self.location.origin && (
  url.pathname.startsWith('/assets/') ||
  url.pathname.startsWith('/flixel/') ||
  url.pathname.startsWith('/manifest/') ||
  url.pathname === '/Funkin.js' ||
  url.pathname === '/favicon.png' ||
  url.pathname === '/do%20NOT%20readme.txt' ||
  url.pathname === '/LICENSE.md' ||
  url.pathname === '/CHANGELOG.md' ||
  url.pathname === '/html5-api/8bitgo-runtime-bridge.js'
)

const canCache = (request, response) => {
  if (request.method !== 'GET' || request.headers.has('Range')) return false
  if (!response || response.status !== 200 || response.type === 'opaque') return false
  const length = Number(response.headers.get('Content-Length') || 0)
  return !Number.isFinite(length) || length <= 0 || length <= MAX_CACHEABLE_BYTES
}

async function fetchOnce(request, event) {
  const key = request.url
  let pending = inflight.get(key)
  if (!pending) {
    pending = fetch(request)
    inflight.set(key, pending)
    pending.then((response) => {
      if (!canCache(request, response)) {
        inflight.delete(key)
        return
      }
      const stored = caches.open(CACHE_NAME)
        .then((cache) => cache.put(request, response.clone()))
        .catch((error) => console.warn('[8bitgo-streaming] 写入缓存失败', request.url, error))
        .finally(() => inflight.delete(key))
      event?.waitUntil(stored)
    }, () => inflight.delete(key))
  }
  const response = await pending
  return response.clone()
}

async function cacheFirst(request, event) {
  const cache = await caches.open(CACHE_NAME)
  const hit = await cache.match(request)
  if (hit) return hit
  return fetchOnce(request, event)
}

async function loadManifest() {
  if (!manifestPromise) {
    manifestPromise = fetch(MANIFEST_URL, { cache: 'no-store' }).then((response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return response.json()
    }).then((manifest) => {
      if (manifest.version !== VERSION) throw new Error('预热清单版本不匹配')
      return manifest
    }).catch((error) => {
      manifestPromise = undefined
      throw error
    })
  }
  return manifestPromise
}

async function prefetchProfile(profile) {
  const manifest = await loadManifest()
  const urls = manifest.profiles?.[profile] || []
  const cache = await caches.open(CACHE_NAME)

  // 单路串行和低优先级是刻意的：HTTP/2 多路并发不等于带宽无限，预热不能饿死玩家真正点开的歌曲。
  for (const path of urls) {
    const url = new URL(path, self.registration.scope).href
    const request = new Request(url, { credentials: 'same-origin', priority: 'low' })
    if (await cache.match(request)) continue
    try {
      const response = await fetch(request)
      if (canCache(request, response)) await cache.put(request, response)
    } catch (error) {
      // 预热只是体验加成，网络切换或配额不足时不能让游戏本身失败。
      console.warn('[8bitgo-streaming] 预热跳过', path, error)
    }
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys()
    await Promise.all(names
      .filter((name) => name.startsWith('8bitgo-funkin-') && name !== CACHE_NAME)
      .map((name) => caches.delete(name)))
    await self.clients.claim()
  })())
})

self.addEventListener('message', (event) => {
  const message = event.data
  if (!message || message.type !== 'PREFETCH' || message.version !== VERSION) return
  if (message.profile !== 'metadata' && message.profile !== 'tutorial') return
  prefetchPromise = prefetchPromise
    .then(() => prefetchProfile(message.profile))
    .catch((error) => console.warn('[8bitgo-streaming] 预热失败，继续按需加载', error))
  event.waitUntil?.(prefetchPromise)
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET' || request.headers.has('Range')) return
  const url = new URL(request.url)
  if (!assetPath(url)) return
  event.respondWith(cacheFirst(request, event))
})
