/*
 * Cloudflare Pages 高级模式 Worker 模板。
 * 构建脚本会把下一行的 null 换成当前游戏的配置；模板本身保持合法 JavaScript，
 * 这样编辑器和静态检查不会因为占位符误报。
 */
const GAME = /*__GAME_CONFIG__*/ null

const ASSET_BASE_DEFAULT = 'https://assets.8bitgo.com'
const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const SAFE_DIABLO_CORE = /^(?:Diablo|DiabloSpawn|MpqCmp)\.[a-f0-9]{8}\.wasm$/
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

    const base = String(env.RUNTIME_ASSET_BASE_URL || ASSET_BASE_DEFAULT).replace(/\/+$/, '')
    const asset = runtimeAsset(url.pathname, base)
    if (asset === null) return new Response('bad name', { status: 400 })
    if (asset) return proxyRuntime(request, asset)

    const response = await env.ASSETS.fetch(request)
    return commonHeaders(response, url.pathname)
  },
}
