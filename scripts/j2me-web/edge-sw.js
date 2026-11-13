/* 8BitGo：J2ME 大文件走大陆加速入口的 Service Worker（源文件在 scripts/j2me-web/edge-sw.js，构建时复制进 public/j2me/）。
 *
 * 为什么要它：J2ME 的 run.html 必须和父页面同源（父页面要读画面、接手柄、截图），CheerpJ 又只会从
 * 同源的 /app/ 取 freej2me-web.jar 和游戏 JAR，没有改源的配置。大陆访客走 Cloudflare 取这几个文件极慢
 * （2026-11-13 实测 libmidi.wasm 3.1MB 要 48 秒）。这个 SW 只在 run.html 带 `edge=cn` 打开时，把这几类
 * 请求原样（含 Range）转给 https://cn.<本站裸域>/_cn/j2me/...（腾讯 EdgeOne），失败就回同源。
 *
 * 安全：加速域名**只从本 SW 自己的地址推出来**，不接受任何参数 —— 否则别人嵌一个
 * run.html?edge=<恶意域名> 就能把任意 JAR 喂给 CheerpJ，在本站源上执行代码。
 */
const EDGE_ORIGIN = `https://cn.${self.location.hostname.replace(/^www\./, '')}`
const SCOPE_PATH = new URL(self.registration.scope).pathname // 例如 /j2me/
const EDGE_PREFIX = '/_cn'

/** 只转这几类：体积大、CheerpJ / libmidi 在 run.html 里取的。其余（run.html、小脚本）一律不碰 */
function edgeTarget(url) {
  if (url.origin !== self.location.origin || !url.pathname.startsWith(SCOPE_PATH)) return null
  const rest = url.pathname.slice(SCOPE_PATH.length)
  if (rest === 'freej2me-web.jar' || rest === 'libmidi/libmidi.wasm' || /^jar\/[^/]+\.jar$/i.test(rest)) {
    return `${EDGE_ORIGIN}${EDGE_PREFIX}${url.pathname}${url.search}`
  }
  return null
}

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

async function fromEdgeEnabledClient(event) {
  if (/[?&]edge=cn(?:&|$)/.test(event.request.referrer || '')) return true
  const id = event.clientId || event.resultingClientId
  if (!id) return false
  const client = await self.clients.get(id)
  return Boolean(client && /[?&]edge=cn(?:&|$)/.test(client.url))
}

async function viaEdge(event, target) {
  const request = event.request
  if (!(await fromEdgeEnabledClient(event))) return fetch(request)
  const headers = new Headers()
  const range = request.headers.get('Range')
  if (range) headers.set('Range', range)
  try {
    const response = await fetch(target, { headers, mode: 'cors', credentials: 'omit' })
    // CheerpJ 必须拿到 206；边缘若把 Range 当整包回 200，或回了错误码，都退回同源
    if (range ? response.status === 206 : response.ok) return response
    void response.body?.cancel().catch(() => {})
  } catch {
    /* 加速入口连不上：退回同源 */
  }
  return fetch(request)
}

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET' || request.mode === 'navigate') return
  const target = edgeTarget(new URL(request.url))
  if (!target) return
  event.respondWith(viaEdge(event, target))
})
