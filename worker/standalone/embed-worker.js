/**
 * reVCDOS static hosting / fixed-upstream resource proxy.
 * Retains BASE_PATH, /vcsky/, /vcbr/, GET/HEAD, isolation headers and ASSETS.
 * Does NOT include dist/ or implement cloud-save APIs (neither was in the upload).
 */
const READ_METHODS = new Set(['GET', 'HEAD'])
const FORWARD_HEADERS = [
  'range', 'if-range', 'if-none-match', 'if-modified-since', 'if-match',
  'if-unmodified-since', 'accept', 'accept-encoding',
]
const STRIP_HEADERS = new Set([
  'set-cookie', 'connection', 'keep-alive', 'transfer-encoding', 'proxy-authenticate',
  'proxy-authorization', 'te', 'trailer', 'upgrade',
  'cross-origin-opener-policy', 'cross-origin-embedder-policy',
])
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const HTML_LIMIT = 1024 * 1024
class ProxyError extends Error {
  constructor(status, message) { super(message); this.status = status }
}
function errorResponse(error) {
  return new Response(JSON.stringify({ error: error instanceof ProxyError ? error.message : '资源服务暂时不可用' }), {
    status: error instanceof ProxyError ? error.status : 502,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  })
}
function basePath(env) {
  const value = String(env.BASE_PATH ?? '').trim().replace(/\/+$/, '')
  if (!value) return ''
  if (!value.startsWith('/') || value.startsWith('//') || /[\\<>"'?#%\x00-\x20\x7f]/.test(value) || value.split('/').some(p => p === '.' || p === '..')) {
    throw new ProxyError(500, 'BASE_PATH 配置无效')
  }
  return value
}
function stripBase(path, base) {
  if (base && path === base) return '/'
  return base && path.startsWith(base + '/') ? path.slice(base.length) : path
}
function parseNumber(value, fallback, maximum) {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n < 0 || n > maximum) throw new ProxyError(500, '代理数值配置无效')
  return n
}
/** Reject absolute/network paths, traversal, encoded separators and nested encodings. */
function validateRelative(rest) {
  if (rest.length > 8192 || /^[\\/]/.test(rest) || /^[a-z][a-z\d+.-]*:/i.test(rest)) throw new ProxyError(400, '资源路径无效')
  for (const segment of rest.split('/')) {
    let value = segment
    for (let i = 0; i < 4; i++) {
      if (/[\\/\x00-\x1f\x7f]/.test(value) || value === '.' || value === '..') throw new ProxyError(400, '资源路径无效')
      if (!/%[\da-f]{2}/i.test(value)) break
      try { value = decodeURIComponent(value) } catch { throw new ProxyError(400, '资源路径编码无效') }
      if (i === 3) throw new ProxyError(400, '资源路径编码层数过多')
    }
    // Also catch a bare/invalid percent escape, not just recognized %xx sequences.
    try { decodeURIComponent(segment) } catch { throw new ProxyError(400, '资源路径编码无效') }
  }
}
function upstreamURL(base, rest, search) {
  let root
  try { root = new URL(base) } catch { throw new ProxyError(500, '上游配置无效') }
  if (root.protocol !== 'https:' || root.username || root.password || root.search || root.hash) throw new ProxyError(500, '上游必须是不含认证和查询串的 HTTPS 基址')
  if (!root.pathname.endsWith('/')) root.pathname += '/'
  validateRelative(rest)
  const url = new URL(root)
  // Append to PATH, never resolve user-controlled input as an absolute URL.
  url.pathname = root.pathname + rest
  url.search = search
  if (url.origin !== root.origin || !url.pathname.startsWith(root.pathname)) throw new ProxyError(400, '资源路径越界')
  return { root, url }
}
function safeRedirect(location, current, root) {
  let next
  try { next = new URL(location, current) } catch { throw new ProxyError(502, '无效上游重定向') }
  if (next.origin !== root.origin || next.protocol !== 'https:' || next.username || next.password || !next.pathname.startsWith(root.pathname)) {
    throw new ProxyError(502, '上游重定向超出配置的资源目录')
  }
  validateRelative(next.pathname.slice(root.pathname.length))
  return next
}
async function cancelBody(response) {
  if (response.body && !response.body.locked) { try { await response.body.cancel() } catch { /* already closed */ } }
}
async function proxy(request, upstreamBase, rest, ttl, timeout, search) {
  let { root, url } = upstreamURL(upstreamBase, rest, search)
  const headers = new Headers()
  for (const name of FORWARD_HEADERS) {
    if (request.headers.has(name)) headers.set(name, request.headers.get(name))
  }
  const controller = new AbortController()
  const onAbort = () => controller.abort(request.signal.reason)
  if (request.signal.aborted) onAbort()
  else request.signal.addEventListener('abort', onAbort, { once: true })
  // Headers deadline across redirects. Body stays streaming; no unbounded buffering.
  // There is intentionally no hard total download timeout for large game assets.
  let expired = false
  const timer = setTimeout(() => { expired = true; controller.abort() }, timeout)
  let upstream
  try {
    for (let redirect = 0; ; redirect++) {
      upstream = await fetch(url.toString(), {
        method: request.method, headers, redirect: 'manual', signal: controller.signal,
        cf: { cacheEverything: true, cacheTtlByStatus: { '200-299': ttl, '300-599': -1 } },
      })
      if (!REDIRECTS.has(upstream.status)) break
      const location = upstream.headers.get('Location')
      await cancelBody(upstream)
      if (!location || redirect >= 3) throw new ProxyError(502, '上游重定向过多或缺少 Location')
      url = safeRedirect(location, url, root)
    }
  } catch (error) {
    if (expired) throw new ProxyError(504, '上游响应头超时')
    throw error
  } finally {
    clearTimeout(timer)
    request.signal.removeEventListener('abort', onAbort)
  }
  const out = new Headers()
  const connectionTokens = new Set((upstream.headers.get('Connection') || '').toLowerCase().split(',').map(s => s.trim()))
  for (const [k,v] of upstream.headers) if (!STRIP_HEADERS.has(k.toLowerCase()) && !connectionTokens.has(k.toLowerCase())) out.set(k,v)
  out.set('Cross-Origin-Resource-Policy', 'same-origin')
  out.set('X-Content-Type-Options', 'nosniff')
  if (upstream.ok) out.set('Cache-Control', `public, max-age=${ttl}${ttl === 0 ? ', must-revalidate' : ''}`)
  else if (upstream.status === 304) out.set('Cache-Control', `public, max-age=${ttl}`)
  else out.set('Cache-Control', 'no-store')
  if (request.method === 'HEAD') await cancelBody(upstream)
  return new Response(request.method === 'HEAD' ? null : upstream.body, {
    status: upstream.status, statusText: upstream.statusText, headers: out,
  })
}
async function boundedHtml(response) {
  const length = Number(response.headers.get('Content-Length'))
  if (length > HTML_LIMIT) { await cancelBody(response); throw new ProxyError(502, 'HTML 超过处理上限') }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let result = '', size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > HTML_LIMIT) throw new ProxyError(502, 'HTML 超过处理上限')
      result += decoder.decode(value, { stream: true })
    }
    return result + decoder.decode()
  } catch (error) {
    try { await reader.cancel(error) } catch { /* keep original error */ }
    throw error
  } finally { reader.releaseLock() }
}
async function decorateHtml(response, base, method) {
  const headers = new Headers(response.headers)
  headers.set('Cross-Origin-Opener-Policy', 'same-origin')
  headers.set('Cross-Origin-Embedder-Policy', 'require-corp')
  headers.delete('X-Frame-Options')
  headers.set('Cache-Control', 'no-cache')
  if (!base) return new Response(method === 'HEAD' ? null : response.body, { status: response.status, headers })
  // The representation is transformed; upstream validators and byte lengths no longer apply.
  for (const name of ['Content-Length', 'Content-Encoding', 'ETag', 'Last-Modified', 'Content-MD5', 'Digest', 'Content-Digest', 'Repr-Digest', 'Accept-Ranges']) headers.delete(name)
  if (method === 'HEAD') { await cancelBody(response); return new Response(null, { status: response.status, headers }) }
  if ([204, 205, 304].includes(response.status)) return new Response(null, { status: response.status, headers })
  // Keep existing <base> unchanged (same public behavior as the original Worker).
  let html = await boundedHtml(response)
  if (!/<base\s/i.test(html)) html = html.replace(/<head([^>]*)>/i, `<head$1><base href="${base}/">`)
  return new Response(html, { status: response.status, headers })
}
async function handle(request, env) {
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { Allow: 'GET, HEAD, OPTIONS' } })
  if (!READ_METHODS.has(request.method)) return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD, OPTIONS', 'Cache-Control': 'no-store' } })
  const url = new URL(request.url)
  const base = basePath(env)
  const path = stripBase(url.pathname, base)
  const ttl = parseNumber(env.UPSTREAM_CACHE_TTL, 86400, 31536000)
  const timeout = parseNumber(env.UPSTREAM_HEADER_TIMEOUT_MS, 15000, 120000)
  if (!timeout) throw new ProxyError(500, '上游超时不能为零')
  if (path.startsWith('/vcsky/')) return proxy(request, env.VCSKY_UPSTREAM, path.slice(7), ttl, timeout, url.search)
  if (path.startsWith('/vcbr/')) return proxy(request, env.VCBR_UPSTREAM, path.slice(6), ttl, timeout, url.search)
  if (!env.ASSETS) throw new ProxyError(503, '静态资源 ASSETS 绑定缺失')
  // Setting pathname, instead of resolving "//host", prevents host changes here too.
  const assetURL = new URL(url.origin)
  assetURL.pathname = path
  assetURL.search = url.search
  const headers = new Headers(request.headers)
  const likelyHtml = path.endsWith('/') || /\.html?$/i.test(path) || !path.split('/').pop().includes('.')
  if (base && likelyHtml) {
    for (const name of ['If-None-Match', 'If-Modified-Since', 'If-Match', 'If-Unmodified-Since', 'Range', 'If-Range']) headers.delete(name)
  }
  let response = await env.ASSETS.fetch(new Request(assetURL, { method: request.method, headers }))
  let type = response.headers.get('Content-Type') || ''
  // Unknown SPA routes can also produce HTML 304s. Re-fetch before transformation.
  if (base && response.status === 304 && type.includes('text/html')) {
    response = await env.ASSETS.fetch(new Request(assetURL, { method: request.method }))
    type = response.headers.get('Content-Type') || ''
  }
  if (type.toLowerCase().includes('text/html')) return decorateHtml(response, base, request.method)
  return response
}
export default {
  async fetch(request, env) {
    let response
    try { response = await handle(request, env) } catch (error) { response = errorResponse(error) }
    if (request.method === 'HEAD' && response.body) {
      await cancelBody(response)
      return new Response(null, { status: response.status, headers: response.headers })
    }
    return response
  },
}
