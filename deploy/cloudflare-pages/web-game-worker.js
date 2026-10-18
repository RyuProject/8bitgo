/*
 * Cloudflare Pages 高级模式 Worker 模板。
 * 构建脚本会把下一行的 null 换成当前游戏的配置；模板本身保持合法 JavaScript，
 * 这样编辑器和静态检查不会因为占位符误报。
 */
const GAME = /*__GAME_CONFIG__*/ null

const ASSET_BASE_DEFAULT = 'https://assets.8bitgo.com'
const PVZ_DATA_BASE_DEFAULT = 'https://html5.8bitgo.com/PvZ/properties'
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_DIABLO_CORE = /^(?:Diablo|DiabloSpawn|MpqCmp)\.[a-f0-9]{8}\.wasm$/
const SAFE_PVZ_DATA_PATH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,1023}$/
const MUTABLE_FRAMEWORK_FILES = new Set(['dotnet.js', 'blazor.boot.json'])

function acceptsBrotli(value) {
  return String(value || '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .some((part) => {
      const [coding, ...params] = part.split(';').map((item) => item.trim())
      if (coding !== 'br') return false
      const q = params.find((item) => item.startsWith('q='))
      return !q || Number(q.slice(2)) > 0
    })
}

function appendVary(headers, value) {
  const values = String(headers.get('Vary') || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  if (!values.some((item) => item.toLowerCase() === value.toLowerCase())) values.push(value)
  headers.set('Vary', values.join(', '))
}

function extensionOf(file) {
  const at = file.lastIndexOf('.')
  let extension = at < 0 ? '' : file.slice(at + 1).toLowerCase()
  if (/^wasm\d$/.test(extension)) extension = 'wasm'
  return extension
}

function contentType(file) {
  const extension = extensionOf(file)
  if (extension === 'wasm') return 'application/wasm'
  if (extension === 'js' || extension === 'mjs') return 'text/javascript; charset=utf-8'
  if (extension === 'json') return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

function frameworkAsset(file, runtime, base) {
  if (!SAFE_FILE.test(file)) return null
  const prefix = `web/${runtime}/_framework`
  const extension = extensionOf(file)
  const immutable = ['wasm', 'dll', 'dat', 'mjs', 'js'].includes(extension) &&
    !MUTABLE_FRAMEWORK_FILES.has(file)
  return {
    url: `${base}/${prefix}/${encodeURIComponent(file)}`,
    contentType: contentType(file),
    cacheControl: immutable
      ? 'public, max-age=31536000, immutable'
      : MUTABLE_FRAMEWORK_FILES.has(file)
        ? 'public, max-age=300, stale-while-revalidate=3600'
        : 'public, max-age=3600',
  }
}

function runtimeAsset(pathname, base) {
  if (GAME.runtime === 'diablo') {
    const match = /^\/web\/diablo\/static\/media\/([^/]+)$/.exec(pathname)
    if (!match) return undefined
    let file
    try { file = decodeURIComponent(match[1]) } catch { return null }
    if (!SAFE_DIABLO_CORE.test(file)) return null
    return {
      url: `${base}/web/diablo/runtime/${encodeURIComponent(file)}`,
      contentType: 'application/wasm',
      cacheControl: 'public, max-age=31536000, immutable',
    }
  }

  if (GAME.runtime === 'celeste' || GAME.runtime === 'terraria') {
    const escaped = GAME.runtime
    const match = new RegExp(`^/web/${escaped}/_framework/([^/]+)$`).exec(pathname)
    if (!match) return undefined
    let file
    try { file = decodeURIComponent(match[1]) } catch { return null }
    return frameworkAsset(file, GAME.runtime, base)
  }
  return undefined
}

function commonHeaders(response, pathname) {
  const headers = new Headers(response.headers)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('Referrer-Policy', 'strict-origin-when-cross-origin')
  headers.set('Cross-Origin-Resource-Policy', 'same-site')
  headers.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()')
  if (GAME.isolated) {
    headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  }
  if (/\.html?$/i.test(pathname) || pathname.endsWith('/')) {
    headers.set('Cache-Control', 'public, max-age=300, stale-while-revalidate=3600')
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

function apiOrigin(value) {
  try {
    const url = new URL(String(value || ''))
    if (url.protocol !== 'https:' || url.username || url.password) return ''
    return url.origin
  } catch {
    return ''
  }
}

function forwardedCloseCode(value) {
  const code = Number(value)
  if (!Number.isInteger(code) || code < 1000 || code > 4999 || [1004, 1005, 1006, 1015].includes(code)) return 1011
  return code
}

async function websocketPayload(value) {
  if (typeof value === 'string' || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value
  // Pages 的服务端 WebSocket 在部分运行时会把入站二进制帧表示成 Blob；出站 WebSocket.send
  // 只接受 ArrayBuffer / TypedArray。显式转换才能避免连接看似成功、实际游戏包静默丢失。
  if (value && typeof value.arrayBuffer === 'function') return value.arrayBuffer()
  throw new TypeError('Unsupported WebSocket payload')
}

function websocketPayloadBytes(value) {
  if (typeof value === 'string') return new TextEncoder().encode(value).byteLength
  return value?.byteLength || 0
}

function cs16SocketProtocol(request, target) {
  if (target.pathname !== '/api/cs16/room') return ''
  const role = target.searchParams.get('role')
  const prefix = role === 'host'
    ? '8bitgo.cs16.host.'
    : role === 'guest'
      ? '8bitgo.cs16.guest.'
      : ''
  if (!prefix) return ''
  const offered = String(request.headers.get('Sec-WebSocket-Protocol') || '')
    .split(',')
    .map((value) => value.trim())
  return offered.find((value) => value.startsWith(prefix) &&
    /^[A-Za-z0-9_-]{24,128}$/.test(value.slice(prefix.length))) || ''
}

async function proxyCs16Socket(request, target) {
  const protocol = cs16SocketProtocol(request, target)
  const upstreamUrl = new URL(target)
  upstreamUrl.protocol = 'wss:'
  const headers = new Headers({ Upgrade: 'websocket' })
  if (protocol) headers.set('Sec-WebSocket-Protocol', protocol)

  let upstreamResponse
  try {
    /*
     * 房主凭证和玩家恢复凭证故意不进 URL，而放在 WebSocket 子协议里。Pages 是浏览器与主站
     * 之间的真正入口，因此必须显式把子协议带到上游；只用 new WebSocket(url) 会悄悄丢掉它，
     * 表现为直连主站测试全绿、cs16.8bitgo.com 却无法创建房间或断线续接。
     */
    upstreamResponse = await fetch(upstreamUrl.href, { headers })
  } catch {
    return new Response('CS1.6 upstream unavailable', { status: 502 })
  }
  const upstream = upstreamResponse.webSocket
  if (upstreamResponse.status !== 101 || !upstream) {
    await upstreamResponse.body?.cancel().catch(() => {})
    const status = upstreamResponse.status >= 400 && upstreamResponse.status <= 599
      ? upstreamResponse.status
      : 502
    return new Response('CS1.6 upstream rejected WebSocket', { status })
  }
  const selectedProtocol = String(upstreamResponse.headers.get('Sec-WebSocket-Protocol') || '').trim()
  if (protocol && selectedProtocol !== protocol) {
    upstream.close(1002, 'WebSocket subprotocol mismatch')
    return new Response('CS1.6 upstream rejected WebSocket protocol', { status: 502 })
  }

  const [client, browser] = Object.values(new WebSocketPair())
  const queued = []
  let queuedBytes = 0
  let browserMessageChain = Promise.resolve()
  browser.binaryType = 'arraybuffer'
  upstream.binaryType = 'arraybuffer'
  browser.accept()
  upstream.accept()

  const close = (socket, code, reason) => {
    if (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN) {
      socket.close(forwardedCloseCode(code), String(reason || '').slice(0, 120))
    }
  }
  browser.addEventListener('message', (event) => {
    // Blob.arrayBuffer() 是异步的；串行链保证同一玩家的 UDP 数据报不会因转换耗时不同而乱序。
    browserMessageChain = browserMessageChain.then(async () => {
      const data = await websocketPayload(event.data)
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data)
        return
      }
      if (upstream.readyState !== WebSocket.CONNECTING) return close(browser, 1011, 'CS1.6 upstream unavailable')
      queuedBytes += websocketPayloadBytes(data)
      if (queuedBytes > 512 * 1024) return close(browser, 1009, 'CS1.6 upstream queue exceeded')
      queued.push(data)
    }).catch(() => {
      close(upstream, 1011, 'CS1.6 WebSocket payload error')
      close(browser, 1011, 'CS1.6 WebSocket payload error')
    })
  })
  upstream.addEventListener('open', () => {
    if (browser.readyState !== WebSocket.OPEN) return close(upstream, 1000, 'Browser disconnected')
    for (const data of queued) upstream.send(data)
    queued.length = 0
    queuedBytes = 0
  })
  upstream.addEventListener('message', (event) => {
    if (browser.readyState === WebSocket.OPEN) browser.send(event.data)
  })
  browser.addEventListener('close', (event) => close(upstream, event.code, event.reason))
  upstream.addEventListener('close', (event) => close(browser, event.code, event.reason))
  browser.addEventListener('error', () => close(upstream, 1011, 'Browser WebSocket error'))
  upstream.addEventListener('error', () => close(browser, 1011, 'CS1.6 upstream unavailable'))

  const responseHeaders = new Headers()
  if (selectedProtocol) responseHeaders.set('Sec-WebSocket-Protocol', selectedProtocol)
  return new Response(null, { status: 101, headers: responseHeaders, webSocket: client })
}

async function proxyCs16Api(request, configuredOrigin) {
  const origin = apiOrigin(configuredOrigin)
  if (!origin) return new Response('CS1.6 API origin is not configured', { status: 503 })
  const incoming = new URL(request.url)
  const target = new URL(`${incoming.pathname}${incoming.search}`, origin)
  const websocketEndpoint = incoming.pathname === '/api/cs16/relay' || incoming.pathname === '/api/cs16/room'
  if (websocketEndpoint) {
    // Pages 的跨域 fetch 会把 Upgrade 降级成普通 GET；显式桥接两条 WebSocket 才能保留二进制帧。
    // 仍按专用路径判定，因为 Pages 边缘不保证把首段 Upgrade 头暴露给脚本。
    return proxyCs16Socket(request, target)
  }
  const upstream = new Request(target, request)
  // 这条代理只开放匿名 CS1.6 接口；不把主站登录凭证带过去，也不让任意客户端伪造跨站来源。
  upstream.headers.delete('Cookie')
  upstream.headers.delete('Authorization')
  upstream.headers.set('Origin', origin)
  return fetch(upstream)
}

function pvzDataPath(pathname) {
  if (!pathname.startsWith('/pvz-data/')) return undefined
  let relative
  try { relative = decodeURIComponent(pathname.slice('/pvz-data/'.length)) } catch { return null }
  if (!SAFE_PVZ_DATA_PATH.test(relative) || relative.includes('//') || relative.includes('\\')) return null
  const parts = relative.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return parts.map(encodeURIComponent).join('/')
}

function pvzDataBase(value) {
  try {
    const url = new URL(String(value || PVZ_DATA_BASE_DEFAULT))
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return ''
    return url.href.replace(/\/+$/, '')
  } catch {
    return ''
  }
}

async function proxyPvzData(request, relativePath, configuredBase) {
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  const base = pvzDataBase(configuredBase)
  if (!base) return new Response('PvZ data origin is not configured', { status: 503 })

  const headers = new Headers({ 'Accept-Encoding': 'identity' })
  // Range 是大包按需读取和断点续传的基础；条件请求则避免边缘代理重复搬运未变的数据。
  for (const name of ['Range', 'If-None-Match', 'If-Modified-Since', 'If-Range']) {
    const value = request.headers.get(name)
    if (value) headers.set(name, value)
  }
  const upstream = await fetch(`${base}/${relativePath}`, {
    method: request.method,
    headers,
    redirect: 'follow',
  })
  const responseHeaders = new Headers()
  for (const name of [
    'content-type', 'content-length', 'content-range', 'accept-ranges',
    'etag', 'last-modified', 'cache-control',
  ]) {
    const value = upstream.headers.get(name)
    if (value) responseHeaders.set(name, value)
  }
  // 浏览器实际走同源；仍补 CORS，方便运维用 pages.dev / 自定义域交叉探测同一份对象。
  responseHeaders.set('Access-Control-Allow-Origin', '*')
  responseHeaders.set('Cross-Origin-Resource-Policy', 'same-origin')
  responseHeaders.set('X-Content-Type-Options', 'nosniff')
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  })
}

async function proxyRuntime(request, asset) {
  const requestHeaders = new Headers()
  requestHeaders.set('Accept-Encoding', 'identity')
  for (const name of ['If-None-Match', 'If-Modified-Since']) {
    const value = request.headers.get(name)
    if (value) requestHeaders.set(name, value)
  }

  const range = request.headers.get('Range')
  const useBrotli = !range && acceptsBrotli(request.headers.get('Accept-Encoding'))
  const candidates = useBrotli
    ? [{ url: `${asset.url}.br`, brotli: true }, { url: asset.url, brotli: false }]
    : [{ url: asset.url, brotli: false }]

  let upstream
  let selected
  for (const candidate of candidates) {
    const headers = new Headers(requestHeaders)
    if (!candidate.brotli && range) headers.set('Range', range)
    upstream = await fetch(candidate.url, {
      method: request.method === 'HEAD' ? 'HEAD' : 'GET',
      headers,
      redirect: 'follow',
    })
    if (candidate.brotli && upstream.status === 404) {
      await upstream.body?.cancel().catch(() => {})
      continue
    }
    selected = candidate
    break
  }

  if (!upstream || !selected) return new Response(null, { status: 404 })
  const headers = new Headers()
  headers.set('Content-Type', asset.contentType)
  headers.set('Cache-Control', asset.cacheControl)
  headers.set('Cross-Origin-Resource-Policy', 'same-origin')
  headers.set('X-Content-Type-Options', 'nosniff')
  for (const name of ['content-length', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  if (selected.brotli) {
    headers.set('Content-Encoding', 'br')
  } else {
    for (const name of ['content-range', 'accept-ranges']) {
      const value = upstream.headers.get(name)
      if (value) headers.set(name, value)
    }
  }
  appendVary(headers, 'Accept-Encoding')
  if (GAME.isolated) {
    headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  }

  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
    // R2 里的 `.br` 是已经压好的原始字节；让 Workers 再自动编码会造成浏览器解压失败。
    encodeBody: selected.brotli ? 'manual' : 'automatic',
  })
}

export default {
  async fetch(request, env) {
    if (!GAME) return new Response('Pages Worker 尚未构建', { status: 503 })
    const url = new URL(request.url)
    if (url.pathname === '/') return Response.redirect(new URL(GAME.entry, url), 302)

    if (GAME.name === 'cs16' && url.pathname.startsWith('/api/cs16/')) {
      return proxyCs16Api(request, env.CS16_API_ORIGIN || GAME.apiOrigin)
    }

    if (GAME.name === 'pvz') {
      const dataPath = pvzDataPath(url.pathname)
      if (dataPath === null) return new Response('bad path', { status: 400 })
      if (dataPath) return proxyPvzData(request, dataPath, env.PVZ_DATA_BASE_URL)
    }

    const base = String(env.RUNTIME_ASSET_BASE_URL || ASSET_BASE_DEFAULT).replace(/\/+$/, '')
    const asset = runtimeAsset(url.pathname, base)
    if (asset === null) return new Response('bad name', { status: 400 })
    if (asset) return proxyRuntime(request, asset)

    const response = await env.ASSETS.fetch(request)
    return commonHeaders(response, url.pathname)
  },
}
