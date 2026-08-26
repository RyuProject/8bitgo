/**
 * 8BitGo ROM Worker：R2 桶的读写代理。
 *
 *   GET/HEAD /<key>           读取对象（带 CORS / Range / 长缓存），例如 /roms/nes/contra.zip
 *   PUT      /<key>           上传对象（需 Authorization: Bearer <ADMIN_TOKEN>）
 *   DELETE   /<key>           删除对象（需口令）
 *   GET      /list?prefix=&cursor=   列出对象（需口令）
 *   GET      /ping            健康检查
 *
 * 绑定：env.ROMS（R2 桶）；变量：ALLOWED_ORIGINS；密钥：ADMIN_TOKEN
 * 公开读取也可以走 R2 自定义域名（如 assets.8bitgo.com），Worker 只负责后台的上传 / 列表也可以。
 */

const RESERVED = new Set(['', 'ping', 'list'])

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
      if (!authorized(request, url, env)) return json({ error: 'unauthorized' }, cors, 401)
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
    if (RESERVED.has(key) || key.includes('..')) return json({ error: 'not found' }, cors, 404)

    if (request.method === 'PUT') {
      if (!authorized(request, url, env)) return json({ error: 'unauthorized' }, cors, 401)
      const contentType = request.headers.get('Content-Type') || guessType(key)
      const object = await env.ROMS.put(key, request.body, {
        httpMetadata: { contentType, cacheControl: 'public, max-age=31536000, immutable' },
      })
      return json({ ok: true, key, size: object.size, etag: object.httpEtag, uploaded: object.uploaded }, cors)
    }

    if (request.method === 'DELETE') {
      if (!authorized(request, url, env)) return json({ error: 'unauthorized' }, cors, 401)
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
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
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
    'Access-Control-Allow-Headers': 'Range, Authorization, Content-Type, If-None-Match',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

function authorized(request, url, env) {
  if (!env.ADMIN_TOKEN) return false
  const header = request.headers.get('Authorization') || ''
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : ''
  const token = bearer || url.searchParams.get('token') || ''
  return token === env.ADMIN_TOKEN
}

function json(data, cors, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  })
}
