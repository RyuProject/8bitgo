/*
 * 本地 PSP 镜像只在当前浏览器内按需读取。PPSSPP 的同步 Range loader 跑在 pthread，
 * 页面上的 WORKERFS 却不能在 preRun 挂载；让同源 Service Worker 把 Range 请求转给持有 File 的 iframe，
 * 既不上传用户文件，也不复制整张光盘进 Wasm 内存。
 */
const SOURCE = '8bitgo-psp-local-disc-v1'
const PREFIX = new URL('local-disc/', self.registration.scope).pathname
const MAX_READ_BYTES = 4 * 1024 * 1024
const READ_TIMEOUT_MS = 30_000

self.addEventListener('install', (event) => event.waitUntil(self.skipWaiting()))
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

const failure = (status, message) => new Response(message, {
  status,
  headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
})

const readFromPage = (session, start, end, head) => new Promise((resolve, reject) => {
  const channel = new BroadcastChannel(`${SOURCE}:${session}`)
  const id = crypto.randomUUID()
  const timer = setTimeout(() => {
    channel.close()
    reject(new Error('本地光盘读取超时'))
  }, READ_TIMEOUT_MS)
  channel.onmessage = (event) => {
    const message = event.data
    if (message?.source !== SOURCE || message.id !== id || message.type !== 'reply') return
    clearTimeout(timer)
    channel.close()
    if (message.error) reject(new Error(String(message.error)))
    else resolve(message)
  }
  channel.postMessage({ source: SOURCE, id, type: 'read', start, end, head })
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  if (url.origin !== self.location.origin || !url.pathname.startsWith(PREFIX)) return
  event.respondWith((async () => {
    const session = url.pathname.slice(PREFIX.length).split('/')[0]
    if (!/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(session)) return failure(404, '本地光盘会话无效')
    if (event.request.method !== 'GET' && event.request.method !== 'HEAD') return failure(405, '只允许读取本地光盘')

    const range = event.request.headers.get('Range')
    const match = /^bytes=(\d+)-(\d+)$/.exec(range || '')
    if (event.request.method === 'GET' && (!match || Number(match[2]) - Number(match[1]) + 1 > MAX_READ_BYTES)) {
      return failure(416, '本地光盘只支持有界 Range 读取')
    }
    const start = match ? Number(match[1]) : 0
    const end = match ? Number(match[2]) : 0
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) return failure(416, 'Range 无效')

    let reply
    try {
      reply = await readFromPage(session, start, end, event.request.method === 'HEAD')
    } catch (error) {
      return failure(503, error instanceof Error ? error.message : String(error))
    }
    const size = Number(reply.size)
    if (!Number.isSafeInteger(size) || size <= 0) return failure(503, '本地光盘大小无效')
    const common = {
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/octet-stream',
      ETag: `"8bitgo-local-${session}"`,
    }
    if (event.request.method === 'HEAD') {
      return new Response(null, { status: 200, headers: { ...common, 'Content-Length': String(size) } })
    }
    const bytes = reply.bytes
    const length = end - start + 1
    if (!(bytes instanceof ArrayBuffer) || start >= size || end >= size || bytes.byteLength !== length) {
      return failure(416, '本地光盘范围超出镜像')
    }
    return new Response(bytes, {
      status: 206,
      headers: { ...common, 'Content-Length': String(length), 'Content-Range': `bytes ${start}-${end}/${size}` },
    })
  })())
})
