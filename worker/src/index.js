/**
 * 8BitGo ROM Worker：R2 桶的读写代理。
 *
 *   GET/HEAD /<key>           读取对象（带 CORS / Range / 长缓存），例如 /roms/nes/contra.zip
 *   PUT      /<key>           上传对象（需 Authorization: Bearer <ADMIN_TOKEN>）
 *   DELETE   /<key>           删除对象（需口令）
 *   GET      /list?prefix=&cursor=   列出对象（需口令，只认 Authorization 头）
 *   GET      /ping            健康检查
 *
 * 绑定：env.ROMS（R2 桶）；变量：ALLOWED_ORIGINS；密钥：ADMIN_TOKEN
 * 公开读取也可以走 R2 自定义域名（如 assets.8bitgo.com），Worker 只负责后台的上传 / 列表也可以。
 */

const RESERVED = new Set(['', 'ping', 'list'])

/**
 * 单个对象的上传上限。默认 512 MB，可在 wrangler.toml 的 [vars] 里用 MAX_UPLOAD_MB 覆盖。
 * Cloudflare 自己对请求体也有上限（免费版 100 MB），这里只是再卡一道防手滑。
 */
const DEFAULT_MAX_UPLOAD_MB = 512
function maxUploadBytes(env) {
  const mb = Number.parseInt(env?.MAX_UPLOAD_MB ?? '', 10)
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024
}

/** 合法的对象 key：不允许 .. 、开头的斜杠、控制字符和反斜杠 */
function validKey(key) {
  if (!key || key.length > 1024) return false
  if (key.includes('..') || key.includes('\\')) return false
  if (key.startsWith('/') || key.endsWith('/')) return false
  // eslint-disable-next-line no-control-regex
  return !/[\u0000-\u001f\u007f]/.test(key)
}

const MIME = {
  zip: 'application/zip',
  '7z': 'application/x-7z-compressed',
  swf: 'application/x-shockwave-flash',
  json: 'application/json',
  txt: 'text/plain; charset=utf-8',
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const cors = corsHeaders(request, env)

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors })
    }

    const path = decodeURIComponent(url.pathname.replace(/^\/+/, ''))

    if (path === '' || path === 'ping') {
      return json({ ok: true, service: '8bitgo-roms', writable: Boolean(env.ADMIN_TOKEN), time: new Date().toISOString() }, cors)
    }

    if (path === 'list') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, cors, 401)
      const prefix = url.searchParams.get('prefix') || undefined
      const cursor = url.searchParams.get('cursor') || undefined
      const result = await env.ROMS.list({ prefix, cursor, limit: 1000 })
      return json(
        {
          objects: result.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })),
          truncated: result.truncated,
          cursor: result.truncated ? result.cursor : undefined,
        },
        cors,
      )
    }

    const key = path
    if (RESERVED.has(key) || !validKey(key)) return json({ error: 'not found' }, cors, 404)

    if (request.method === 'PUT') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, cors, 401)
      // 先看 Content-Length，超限直接回 413，不要把整个文件读进来再拒绝
      const limit = maxUploadBytes(env)
      const declared = Number(request.headers.get('Content-Length') || 0)
      if (declared > limit) {
        return json({ error: `file too large (max ${Math.round(limit / 1024 / 1024)} MB)` }, cors, 413)
      }
      const contentType = request.headers.get('Content-Type') || guessType(key)
      const object = await env.ROMS.put(key, request.body, {
        httpMetadata: { contentType, cacheControl: OBJECT_CACHE_CONTROL },
      })
      return json({ ok: true, key, size: object.size, etag: object.httpEtag, uploaded: object.uploaded }, cors)
    }

    if (request.method === 'DELETE') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, cors, 401)
      await env.ROMS.delete(key)
      return json({ ok: true, key }, cors)
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'method not allowed' }, cors, 405)
    }

    const object =
      request.method === 'HEAD'
        ? await env.ROMS.head(key)
        : await env.ROMS.get(key, { range: request.headers, onlyIf: request.headers })
    if (!object) return json({ error: 'not found' }, cors, 404)

    const headers = new Headers(cors)
    object.writeHttpMetadata(headers)
    headers.set('ETag', object.httpEtag)
    headers.set('Accept-Ranges', 'bytes')
    headers.set('Cache-Control', OBJECT_CACHE_CONTROL)
    if (!headers.get('Content-Type')) headers.set('Content-Type', guessType(key))
    const filename = key.split('/').pop() || 'rom'
    headers.set('Content-Disposition', `inline; filename="${encodeURIComponent(filename)}"`)

    // 条件请求命中（onlyIf）时 R2 返回不带 body 的对象
    if (request.method === 'GET' && !('body' in object)) {
      return new Response(null, { status: 304, headers })
    }

    let status = 200
    if (object.range && 'offset' in object.range) {
      const start = object.range.offset ?? 0
      const length = object.range.length ?? object.size - start
      const end = start + length - 1
      headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`)
      headers.set('Content-Length', String(length))
      status = 206
    } else {
      headers.set('Content-Length', String(object.size))
    }

    return new Response(request.method === 'HEAD' ? null : object.body, { status, headers })
  },
}

function guessType(key) {
  const ext = key.split('.').pop()?.toLowerCase() ?? ''
  return MIME[ext] || 'application/octet-stream'
}

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  const origin = request.headers.get('Origin') || ''
  const allowOrigin = allowed.includes('*') ? '*' : allowed.includes(origin) ? origin : allowed[0] || '*'
  return {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Authorization, Content-Type, If-None-Match, If-Range, If-Modified-Since',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

/**
 * 对象的缓存策略。
 *
 * 以前是 immutable + 一年：同一个 key 换了文件（重新上传封面 / 修正版 ROM）之后，
 * 已经访问过的浏览器一年之内都不会再问服务器一次，永远拿的是旧文件，
 * 而且没有任何办法让它们更新。现在保留长 max-age（省流量），但去掉 immutable ——
 * 用户刷新时会带 If-None-Match 回来问一句，没变就是一个 304，变了立刻拿到新的。
 */
const OBJECT_CACHE_CONTROL = 'public, max-age=86400, s-maxage=2592000, stale-while-revalidate=86400'

/** 定长比较，避免用 === 逐字符短路泄露口令长度 / 前缀 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}

/**
 * 只认 Authorization: Bearer <ADMIN_TOKEN>。
 *
 * 以前还支持 ?token=xxx。查询串会被写进 Cloudflare 的访问日志、浏览器历史，
 * 页面上任何一个外链的 Referer 里也会带上 —— 等于把可以删光整个桶的口令
 * 到处抄送一遍。前端从来没用过这条路径，直接去掉。
 */
function authorized(request, env) {
  if (!env.ADMIN_TOKEN) return false
  const header = request.headers.get('Authorization') || ''
  if (!header.startsWith('Bearer ')) return false
  return timingSafeEqual(header.slice(7).trim(), env.ADMIN_TOKEN)
}

function json(data, cors, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
