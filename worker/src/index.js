/**
 * 8BitGo ROM Worker：R2 桶的读写代理。
 *
 *   GET/HEAD /<key>           读取对象（带 CORS / Range / 长缓存），例如 /roms/nes/contra.zip
 *   PUT      /<key>           一次传完（需 Authorization: Bearer <ADMIN_TOKEN>），只适合小文件
 *   DELETE   /<key>           删除对象（需口令）
 *   GET      /list?prefix=&cursor=   列出对象（需口令，只认 Authorization 头）
 *   GET      /ping            健康检查
 *
 * 分片上传（大文件走这条，理由见下）：
 *
 *   POST     /<key>?uploads                开始，返回 uploadId（需口令）
 *   PUT      /<key>?uploadId=&partNumber=  传一片，返回该片 etag（需口令）
 *   POST     /<key>?uploadId=              完成，body 为 {parts:[{partNumber,etag}]}（需口令）
 *   DELETE   /<key>?uploadId=              放弃（需口令）
 *   GET      /multipart                    列出未完成的分片上传（需口令）
 *   DELETE   /multipart?marker=            只清残留标记，不动 R2（需口令）
 *
 * ## 为什么大文件必须分片
 *
 * Cloudflare 的请求体上限是**平台级的、由边缘节点执行**，在这份代码之前就生效：
 * Free / Pro 100 MB，Business 200 MB，Enterprise 500 MB。超限时边缘直接 reset 连接，
 * 浏览器**拿不到 413**（XHR 只触发 onerror），下面那句 Content-Length 检查一次都不会运行 ——
 * 于是后台传 100MB 游戏时报的是「网络错误：无法连接 Worker」，看着像 Worker 挂了，
 * 其实是文件太大。想确认是不是这个原因：失败时开 `npx wrangler tail`，
 * 被边缘拦掉的请求在 Worker 日志里**一条记录都不会有**。
 *
 * 分片是唯一不换套餐就能传大文件的办法：上限按**单个请求**算，切成 8MB 一片后每片都离上限很远。
 * 顺带换来断点续传 —— uploadId 和已传分片存在 R2 里，网络断了不用从 0 重来。
 *
 * ⚠️ R2 的 Workers binding **没有 listParts**：complete 时必须由调用方把每一片的
 * {partNumber, etag} 全部报回来。所以「传到哪了」这份账记在前端（localStorage），
 * 这里是无状态的 —— 换浏览器就续不上，只能重传。
 */

const RESERVED = new Set(['', 'ping', 'list', 'multipart'])

/**
 * 单个对象的上传上限。默认 512 MB，可在 wrangler.toml 的 [vars] 里用 MAX_UPLOAD_MB 覆盖。
 * 注意这**管不到**平台的请求体上限（见文件头），只是再卡一道防手滑。
 */
const DEFAULT_MAX_UPLOAD_MB = 512
function maxUploadBytes(env) {
  const mb = Number.parseInt(env?.MAX_UPLOAD_MB ?? '', 10)
  return (Number.isFinite(mb) && mb > 0 ? mb : DEFAULT_MAX_UPLOAD_MB) * 1024 * 1024
}

/**
 * 一片的大小上限。前端用 8MB，这里留四倍余量当护栏：
 * 分片本身也是普通请求，同样吃平台那 100MB 上限，切太大等于白分片。
 */
const MAX_PART_BYTES = 32 * 1024 * 1024

/**
 * 未完成分片上传的「标记对象」前缀。
 *
 * binding 也没有 listMultipartUploads。不留痕迹的话，一次失败的上传会在桶里留下
 * 一堆**照常计费**的分片，而且从任何界面都看不见（只能去 Cloudflare 控制台翻）。
 * 所以 create 时写一个空 body 的标记对象，信息全塞在 customMetadata 里 ——
 * 这样 list 一次就能连信息一起取回，不用给每个标记再 get 一遍（Workers 有子请求数上限）。
 * complete / abort 时删掉标记，后台「ROM 存储」页列出的就是真正的残留。
 */
const MULTIPART_PREFIX = '_uploads/'

/** 合法的对象 key：不允许 .. 、开头的斜杠、控制字符和反斜杠 */
function validKey(key) {
  if (!key || key.length > 1024) return false
  if (key.includes('..') || key.includes('\\')) return false
  if (key.startsWith('/') || key.endsWith('/')) return false
  // 标记对象是内部账本，不能当普通对象读写 —— 否则谁都能把别人的 uploadId 抹掉
  if (key.startsWith(MULTIPART_PREFIX)) return false
  // 控制字符按码位判，不写成正则字面量：那样源文件里就得躺着真的控制字符，
  // 任何一次复制粘贴都可能把它们弄坏（改这行时踩过一次）
  return ![...key].some((ch) => ch.codePointAt(0) < 32 || ch.codePointAt(0) === 127)
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
      return json(
        {
          ok: true,
          service: '8bitgo-roms',
          writable: Boolean(env.ADMIN_TOKEN),
          // 前端据此判断「这个 Worker 支不支持分片」。老版本 Worker 没这个字段，
          // 前端就退回单发 PUT —— 不至于因为忘了 wrangler deploy 而把上传整个弄挂
          multipart: true,
          time: new Date().toISOString(),
        },
        cors,
      )
    }

    if (path === 'list') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, cors, 401)
      const prefix = url.searchParams.get('prefix') || undefined
      const cursor = url.searchParams.get('cursor') || undefined
      const result = await env.ROMS.list({ prefix, cursor, limit: 1000 })
      return json(
        {
          // 前缀留空时会把 _uploads/ 的标记一起列出来，后台会显示成一堆 0 字节的怪文件
          objects: result.objects
            .filter((o) => !o.key.startsWith(MULTIPART_PREFIX))
            .map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })),
          truncated: result.truncated,
          cursor: result.truncated ? result.cursor : undefined,
        },
        cors,
      )
    }

    if (path === 'multipart') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, cors, 401)
      return handleMultipartIndex(request, env, url, cors)
    }

    const key = path
    if (RESERVED.has(key) || !validKey(key)) return json({ error: 'not found' }, cors, 404)

    // ---- 分片上传：三个动作靠查询串区分，key 始终是最终对象的 key ----
    const uploadId = url.searchParams.get('uploadId')

    if (request.method === 'POST') {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, cors, 401)
      if (url.searchParams.has('uploads')) return createMultipart(request, env, key, cors)
      if (uploadId) return completeMultipart(request, env, key, uploadId, cors)
      return json({ error: 'POST 需要 ?uploads（开始）或 ?uploadId=（完成）' }, cors, 400)
    }

    if (request.method === 'PUT' && uploadId) {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, cors, 401)
      return uploadPart(request, env, key, uploadId, url, cors)
    }

    if (request.method === 'DELETE' && uploadId) {
      if (!authorized(request, env)) return json({ error: 'unauthorized' }, cors, 401)
      return abortMultipart(env, key, uploadId, url.searchParams.get('marker'), cors)
    }

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

/* ---------------- 分片上传 ---------------- */

/**
 * 开始一次分片上传。
 *
 * httpMetadata **只能在这里设**：complete() 不接受 contentType。
 * 漏了的话对象会以 application/octet-stream 落地 —— ROM 无所谓，
 * 但封面图会变成「浏览器提示下载」而不是显示出来。
 */
async function createMultipart(request, env, key, cors) {
  const meta = await request.json().catch(() => ({}))
  const contentType = typeof meta?.contentType === 'string' && meta.contentType ? meta.contentType : guessType(key)
  const upload = await env.ROMS.createMultipartUpload(key, {
    httpMetadata: { contentType, cacheControl: OBJECT_CACHE_CONTROL },
  })

  // 标记写失败不该让上传起不来（顶多是这次的残留在后台看不见），所以吞掉异常
  const marker = `${MULTIPART_PREFIX}${crypto.randomUUID()}.marker`
  await env.ROMS.put(marker, new Uint8Array(0), {
    customMetadata: {
      key,
      uploadId: upload.uploadId,
      size: String(Number(meta?.size) || 0),
      name: typeof meta?.name === 'string' ? meta.name.slice(0, 200) : '',
      at: new Date().toISOString(),
    },
  }).catch(() => {})

  return json({ ok: true, key, uploadId: upload.uploadId, marker, maxPartBytes: MAX_PART_BYTES }, cors)
}

/** 传一片。返回的 etag 前端必须存下来 —— complete 时要把全部分片的 etag 报回来 */
async function uploadPart(request, env, key, uploadId, url, cors) {
  const partNumber = Number.parseInt(url.searchParams.get('partNumber') ?? '', 10)
  // R2 的分片编号是 1..10000；越界时 uploadPart 抛的错很难懂，先自己挡下来
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10000) {
    return json({ error: 'partNumber 必须是 1..10000 的整数' }, cors, 400)
  }
  const declared = Number(request.headers.get('Content-Length') || 0)
  if (declared > MAX_PART_BYTES) {
    return json({ error: `part too large (max ${Math.round(MAX_PART_BYTES / 1024 / 1024)} MB)` }, cors, 413)
  }

  // 用 arrayBuffer 而不是把 request.body 直接递过去：uploadPart 对未知长度的流会抱怨。
  // 一片只有几 MB，离 Worker 那 128MB 内存上限很远 —— 每片是独立的一次调用，不会叠加。
  const body = await request.arrayBuffer()
  if (body.byteLength === 0) return json({ error: 'empty part' }, cors, 400)

  const upload = env.ROMS.resumeMultipartUpload(key, uploadId)
  try {
    const part = await upload.uploadPart(partNumber, body)
    return json({ ok: true, partNumber: part.partNumber, etag: part.etag }, cors)
  } catch (err) {
    // uploadId 过期 / 已被 abort 时落到这儿。回 409 + fatal，让前端知道「这次续传作废，
    // 得重开一次」，而不是当成网络抖动一直重试同一片
    return json({ error: `uploadPart 失败：${errText(err)}`, fatal: true }, cors, 409)
  }
}

/** 完成。parts 必须是全部分片，partNumber 从 1 连续，etag 与上传时返回的一致 */
async function completeMultipart(request, env, key, uploadId, cors) {
  const body = await request.json().catch(() => null)
  const parts = Array.isArray(body?.parts) ? body.parts : null
  if (!parts?.length) return json({ error: 'body 需要 {parts:[{partNumber,etag}]}' }, cors, 400)

  const normalized = parts
    .map((p) => ({ partNumber: Number(p?.partNumber), etag: String(p?.etag ?? '') }))
    .sort((a, b) => a.partNumber - b.partNumber)
  if (normalized.some((p) => !Number.isInteger(p.partNumber) || p.partNumber < 1 || !p.etag)) {
    return json({ error: 'parts 里有非法的 partNumber 或空 etag' }, cors, 400)
  }

  const upload = env.ROMS.resumeMultipartUpload(key, uploadId)
  try {
    const object = await upload.complete(normalized)
    await dropMarker(env, key, uploadId, body?.marker)
    return json({ ok: true, key, size: object.size, etag: object.httpEtag, uploaded: object.uploaded }, cors)
  } catch (err) {
    // 分片不全、除末片外大小不等、etag 对不上都落到这儿。这类错重试一万次也一样，
    // 所以带 fatal 让前端放弃并清掉本地记账，别卡在「续传→失败→续传」的循环里
    return json({ error: `complete 失败：${errText(err)}`, fatal: true }, cors, 400)
  }
}

/** 放弃。abort 本身失败（uploadId 早就没了）也要把标记删掉，否则残留列表永远清不空 */
async function abortMultipart(env, key, uploadId, marker, cors) {
  let aborted = true
  let error = ''
  try {
    await env.ROMS.resumeMultipartUpload(key, uploadId).abort()
  } catch (err) {
    aborted = false
    error = errText(err)
  }
  await dropMarker(env, key, uploadId, marker)
  return json({ ok: true, key, aborted, error: error || undefined }, cors)
}

/** 列出 / 清理未完成的分片上传 */
async function handleMultipartIndex(request, env, url, cors) {
  if (request.method === 'DELETE') {
    const marker = url.searchParams.get('marker') || ''
    if (!marker.startsWith(MULTIPART_PREFIX)) return json({ error: 'bad marker' }, cors, 400)
    await env.ROMS.delete(marker)
    return json({ ok: true, marker }, cors)
  }
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, cors, 405)

  // include: customMetadata 让一次 list 就把信息带回来，不用逐个 get（子请求数有上限）
  const result = await env.ROMS.list({ prefix: MULTIPART_PREFIX, limit: 1000, include: ['customMetadata'] })
  const uploads = result.objects.map((o) => {
    const m = o.customMetadata ?? {}
    return {
      marker: o.key,
      key: m.key ?? '',
      uploadId: m.uploadId ?? '',
      size: Number(m.size) || 0,
      name: m.name ?? '',
      at: m.at ?? o.uploaded,
    }
  })
  uploads.sort((a, b) => String(b.at).localeCompare(String(a.at)))
  return json({ uploads, truncated: result.truncated }, cors)
}

/**
 * 删掉这次上传的标记。
 * 前端报了 marker 就直接删；没报（老前端、或本地记账丢了）就按 key + uploadId 找一遍。
 */
async function dropMarker(env, key, uploadId, marker) {
  try {
    if (typeof marker === 'string' && marker.startsWith(MULTIPART_PREFIX)) {
      await env.ROMS.delete(marker)
      return
    }
    const result = await env.ROMS.list({ prefix: MULTIPART_PREFIX, limit: 1000, include: ['customMetadata'] })
    const hit = result.objects.find((o) => o.customMetadata?.uploadId === uploadId && o.customMetadata?.key === key)
    if (hit) await env.ROMS.delete(hit.key)
  } catch {
    /* 标记删不掉只是多一条残留记录，不能让它把上传判成失败 */
  }
}

function errText(err) {
  return err instanceof Error ? err.message : String(err)
}

/* ---------------- 通用 ---------------- */

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
    // POST 是分片上传的「开始 / 完成」用的。漏了它浏览器会在预检就把请求挡下来，
    // 报的还是一句笼统的 CORS 错误，看不出是方法没放行。
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
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
