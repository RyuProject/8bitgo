/** HTTP representation / Range handling. Plain GET remains one R2 get(). */
import { HttpError, json } from './common.js'

export function thumbBaseKey(key) {
  const match = /^(.*\/)?([^/]+)-96\.(png|jpe?g|webp|avif)$/i.exec(key || '')
  return match ? `${match[1] || ''}${match[2]}.${match[3]}` : null
}
function etags(value) { return value?.match(/(?:W\/)?"[^"\r\n]*"|\*/g) || [] }
function matches(value, tag, weak) {
  return etags(value).some(v => v === '*' || (weak ? v.replace(/^W\//, '') === tag.replace(/^W\//, '') : !v.startsWith('W/') && v === tag))
}
function etagVersion(tag) {
  return String(tag || '').replace(/^W\//, '').replaceAll('"', '').trim()
}
function secondTime(date) {
  const n = date instanceof Date ? date.getTime() : Date.parse(date)
  return Number.isFinite(n) ? Math.floor(n / 1000) * 1000 : NaN
}
export function conditionStatus(headers, object) {
  const tag = object.httpEtag
  const time = secondTime(object.uploaded)
  const match = headers.get('If-Match')
  const none = headers.get('If-None-Match')
  if (match !== null && !matches(match, tag, false)) return 412
  const unmodified = secondTime(headers.get('If-Unmodified-Since'))
  if (match === null && Number.isFinite(unmodified) && time > unmodified) return 412
  if (none !== null && matches(none, tag, true)) return 304
  const modified = secondTime(headers.get('If-Modified-Since'))
  if (none === null && Number.isFinite(modified) && time <= modified) return 304
  return 200
}
export function ifRangeMatches(value, object) {
  if (!value) return true
  if (value.startsWith('W/')) return false
  if (value.startsWith('"')) return value === object.httpEtag
  // Arbitrary R2 writes may occur twice within a second. We cannot establish that
  // Last-Modified is a strong validator (RFC 9110 13.1.5), so date-only If-Range
  // conservatively gets the complete object. Clients receive a strong ETag.
  return false
}
/** Invalid syntax / multiple ranges are ignored (200); unsatisfiable single ranges get 416. */
export function parseRange(value, size) {
  if (!value || !value.startsWith('bytes=')) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(value.trim())
  if (!m || (!m[1] && !m[2])) return null
  const a = m[1] ? Number(m[1]) : null
  const b = m[2] ? Number(m[2]) : null
  if ((a !== null && !Number.isSafeInteger(a)) || (b !== null && !Number.isSafeInteger(b))) return { unsatisfiable: true }
  if (size === 0) return { unsatisfiable: true }
  if (a === null) {
    if (b === 0) return { unsatisfiable: true }
    const length = Math.min(b, size)
    return { offset: size - length, length }
  }
  if (a >= size || (b !== null && b < a)) return { unsatisfiable: true }
  const end = b === null ? size - 1 : Math.min(b, size - 1)
  return { offset: a, length: end - a + 1 }
}
function isWebGameKey(key) {
  return key.startsWith('web/cs15/') || key.startsWith('web/cs16/')
}
function readBuckets(env, key) {
  // CS 的大包已经迁到独立桶。迁移期仍回退旧 ROM 桶，避免漏传一个对象就让线上整局黑屏；
  // 新桶绑定缺失时也保留旧部署行为，便于 Worker 与数据分两步发布。
  if (isWebGameKey(key) && env.WEBGAMES && env.WEBGAMES !== env.ROMS) return [env.WEBGAMES, env.ROMS]
  return key.startsWith('covers/') && env.COVERS && env.COVERS !== env.ROMS
    ? [env.COVERS, env.ROMS] : [env.ROMS]
}
async function locate(env, key, method) {
  const buckets = readBuckets(env, key)
  const base = thumbBaseKey(key)
  for (const servedKey of base ? [key, base] : [key]) {
    for (const bucket of buckets) {
      const object = await bucket[method](servedKey)
      if (object) return { object, servedKey, bucket }
    }
  }
  return null
}
function objectHeaders(object, servedKey, cors, policy, guessType) {
  const headers = new Headers(cors)
  object.writeHttpMetadata(headers)
  headers.set('ETag', object.httpEtag)
  headers.set('Last-Modified', new Date(object.uploaded).toUTCString())
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Cache-Control', policy)
  headers.set('X-Content-Type-Options', 'nosniff')
  // 这些对象本来就是公开读取且 CORS=*；显式允许跨源嵌入后，启用 COEP 的 PSP 详情页
  // 仍能显示 image.8bitgo.com 的封面/视频，而不会被 require-corp 当场拦掉。
  headers.set('Cross-Origin-Resource-Policy', 'cross-origin')
  if (!headers.has('Content-Type')) headers.set('Content-Type', guessType(servedKey))
  const filename = encodeURIComponent(servedKey.split('/').pop() || 'rom')
  headers.set('Content-Disposition', `inline; filename="${filename}"; filename*=UTF-8''${filename}`)
  return headers
}
async function cancelBody(object) {
  if (object?.body && !object.body.locked) {
    try { await object.body.cancel() } catch { /* response already closed */ }
  }
}
export async function serveObject(request, env, key, cors, policy, guessType, expectedVersion = '') {
  const h = request.headers
  const conditional = ['If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since'].some(n => h.has(n))
  const needsMetadata = request.method === 'HEAD' || conditional || h.has('Range')
  if (!needsMetadata) {
    const found = await locate(env, key, 'get')
    if (!found) return json({ error: 'not found' }, cors, 404)
    const headers = objectHeaders(found.object, found.servedKey, cors, policy, guessType)
    headers.set('Content-Length', String(found.object.size))
    return new Response(found.object.body, { headers })
  }
  // Pin head->get to the ETag. If a concurrent overwrite happens, retry metadata,
  // never combine the previous object's size/validator with new object bytes.
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await locate(env, key, 'head')
    if (!found) return json({ error: h.has('If-Match') ? 'precondition failed' : 'not found' }, cors, h.has('If-Match') ? 412 : 404)
    const { object: metadata, bucket, servedKey } = found
    const headers = objectHeaders(metadata, servedKey, cors, policy, guessType)
    // Range v1 的旧 PPSSPP 核心还不会发 If-Match，但播放 URL 已带对象 ETag。
    // Worker 在这里补上代次校验，宁可 412 明确中止，也不能在同一局里混读新旧光盘扇区。
    if (expectedVersion && etagVersion(metadata.httpEtag) !== expectedVersion) {
      return new Response(null, { status: 412, headers })
    }
    const status = conditionStatus(h, metadata)
    if (status !== 200) return new Response(null, { status, headers })
    if (request.method === 'HEAD') {
      // RFC 9110: Range is a GET-only modifier, not a HEAD modifier.
      headers.set('Content-Length', String(metadata.size))
      return new Response(null, { headers })
    }
    const range = ifRangeMatches(h.get('If-Range'), metadata) ? parseRange(h.get('Range'), metadata.size) : null
    if (range?.unsatisfiable) {
      headers.set('Content-Range', `bytes */${metadata.size}`)
      return new Response(null, { status: 416, headers })
    }
    const object = await bucket.get(servedKey, {
      onlyIf: { etagMatches: metadata.etag }, ...(range ? { range } : {}),
    })
    if (!object || !object.body || object.httpEtag !== metadata.httpEtag) {
      await cancelBody(object)
      continue
    }
    const finalHeaders = objectHeaders(object, servedKey, cors, policy, guessType)
    if (range) {
      finalHeaders.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${object.size}`)
      finalHeaders.set('Content-Length', String(range.length))
    } else finalHeaders.set('Content-Length', String(object.size))
    return new Response(object.body, { status: range ? 206 : 200, headers: finalHeaders })
  }
  throw new HttpError(503, '文件正在被并发更新，请重试', 'object_changed')
}
