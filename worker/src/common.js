/** Shared ROM Worker helpers. No Node-only APIs or production dependencies. */
export const encoder = new TextEncoder()
export class HttpError extends Error {
  constructor(status, message, code = 'bad_request') {
    super(message)
    this.status = status
    this.code = code
  }
}
export function json(data, cors = {}, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra },
  })
}
export function positiveInt(value, fallback, maximum = Number.MAX_SAFE_INTEGER) {
  if (value === undefined || value === '') return fallback
  const n = Number(value)
  if (!Number.isSafeInteger(n) || n <= 0 || n > maximum) {
    throw new HttpError(500, 'Worker 数值配置无效', 'invalid_configuration')
  }
  return n
}
export function declaredLength(request, limit) {
  const s = request.headers.get('Content-Length')
  if (s === null) return null
  if (!/^\d+$/.test(s)) throw new HttpError(400, '无效的 Content-Length')
  const n = Number(s)
  if (!Number.isSafeInteger(n)) throw new HttpError(400, '无效的 Content-Length')
  if (n > limit) throw new HttpError(413, '请求体超过大小上限', 'body_too_large')
  return n
}
/** Bounded fallback only: never materialize arbitrary-sized JSON/unknown-length bodies. */
export async function readLimited(request, limit) {
  const declared = declaredLength(request, limit)
  if (!request.body) {
    if (declared > 0) throw new HttpError(400, '请求体长度不匹配')
    return new Uint8Array(0)
  }
  const reader = request.body.getReader()
  let length = 0
  const chunks = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.byteLength
      if (length > limit) throw new HttpError(413, '请求体超过大小上限', 'body_too_large')
      if (declared !== null && length > declared) throw new HttpError(400, '请求体长度不匹配')
      chunks.push(value)
    }
    if (declared !== null && length !== declared) throw new HttpError(400, '请求体长度不匹配')
    const out = new Uint8Array(length)
    let offset = 0
    for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength }
    return out
  } catch (error) {
    try { await reader.cancel(error) } catch { /* preserve the original error */ }
    throw error
  } finally { reader.releaseLock() }
}
export async function readJson(request, limit, allowEmpty = false) {
  const bytes = await readLimited(request, limit)
  if (!bytes.byteLength && allowEmpty) return {}
  let value
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) }
  catch { throw new HttpError(400, '无效的 JSON 请求体', 'invalid_json') }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(400, 'JSON 请求体必须是对象', 'invalid_json')
  }
  return value
}
/**
 * Known-length request streams stay streaming. Workerd's FixedLengthStream verifies
 * both too-short and too-long bodies and exposes the known length required by R2.
 * Node fallback is exclusively for the offline fixtures, not the deployed path.
 */
export async function writeBody(request, limit, writer, unknownLimit = limit) {
  const length = declaredLength(request, limit)
  if (length === null) return writer(await readLimited(request, unknownLimit))
  if (!request.body) {
    if (length !== 0) throw new HttpError(400, '请求体长度不匹配')
    return writer(new Uint8Array(0))
  }
  if (typeof FixedLengthStream === 'undefined') {
    // Only used by Node tests. Request length is normally enforced by HTTP framing.
    return writer(request.body)
  }
  const stream = new FixedLengthStream(length)
  const cancel = new AbortController()
  let pumpingError
  const pumping = request.body.pipeTo(stream.writable, { signal: cancel.signal })
    .catch((error) => { pumpingError = error })
  try {
    const result = await writer(stream.readable)
    await pumping
    if (pumpingError) throw new HttpError(400, '请求体传输不完整或长度不匹配', 'body_incomplete')
    return result
  } catch (error) {
    cancel.abort(error)
    // Abort alone can wait for an in-flight write whose reader never started.
    // Cancel an unlocked readable too, releasing backpressure before awaiting pipeTo.
    if (!stream.readable.locked) {
      try { await stream.readable.cancel(error) } catch { /* preserve storage failure */ }
    }
    await pumping
    throw error
  }
}
export function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim()).filter(Boolean)
  const origin = request.headers.get('Origin') || ''
  const headers = {
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Range, Authorization, Content-Type, If-None-Match, If-Range, If-Modified-Since, If-Match, If-Unmodified-Since',
    'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag, Last-Modified, Retry-After',
    'Access-Control-Max-Age': '86400', Vary: 'Origin',
  }
  if (allowed.includes('*')) headers['Access-Control-Allow-Origin'] = '*'
  else if (allowed.includes(origin)) headers['Access-Control-Allow-Origin'] = origin
  return headers
}
export function authorized(request, env) {
  if (typeof env.ADMIN_TOKEN !== 'string' || !env.ADMIN_TOKEN) return false
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.get('Authorization') || '')
  if (!match) return false
  const a = match[1].trim(), b = env.ADMIN_TOKEN
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
export function encodeCursor(data) {
  const bytes = encoder.encode(JSON.stringify(data))
  let raw = ''
  for (const b of bytes) raw += String.fromCharCode(b)
  return 'v2.' + btoa(raw).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}
export function decodeCursor(raw, scope, buckets) {
  const fresh = { scope, positions: Object.fromEntries(buckets.map(b => [b.name, ''])) }
  if (!raw) return fresh
  if (raw.length > 12000 || !/^v2\.[\w-]+$/.test(raw)) {
    throw new HttpError(400, '分页游标已失效，请从第一页重新读取', 'invalid_cursor')
  }
  try {
    let s = raw.slice(3).replaceAll('-', '+').replaceAll('_', '/')
    s += '='.repeat((4 - s.length % 4) % 4)
    const state = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(s), c => c.charCodeAt(0))))
    if (state.scope !== scope || !state.positions || typeof state.positions !== 'object' ||
      Object.keys(state.positions).length !== buckets.length) throw new Error('scope')
    for (const { name } of buckets) {
      const p = state.positions[name]
      if (p !== null && (typeof p !== 'string' || p.length > 4096)) throw new Error('position')
    }
    return state
  } catch { throw new HttpError(400, '分页游标无效或与 prefix/桶配置不匹配', 'invalid_cursor') }
}
export async function listAcross(buckets, options, rawCursor, scope) {
  const state = decodeCursor(rawCursor, scope, buckets)
  const pages = await Promise.all(buckets.map(async ({ name, bucket }) => {
    const cursor = state.positions[name]
    if (cursor === null) return []
    const page = await bucket.list({ ...options, ...(cursor ? { cursor } : {}) })
    if (page.truncated && (!page.cursor || page.cursor === cursor)) {
      throw new HttpError(503, '存储分页未前进，请重试', 'pagination_stalled')
    }
    state.positions[name] = page.truncated ? page.cursor : null
    return page.objects.map(object => ({ object, bucket: name }))
  }))
  const truncated = Object.values(state.positions).some(p => p !== null)
  return { entries: pages.flat(), truncated, cursor: truncated ? encodeCursor(state) : undefined }
}
/** Unknown/transient R2 failures MUST NOT invalidate a client's resumable upload. */
export function storageFailure(error, cors, operation = 'storage') {
  if (error instanceof HttpError) return json({ error: error.message, code: error.code }, cors, error.status)
  const message = error instanceof Error ? error.message : String(error)
  // Recognize only explicit NoSuchUpload. Generic 400/409/messages are not evidence.
  const gone = error?.code === 'NoSuchUpload' || /\bNoSuchUpload\b/i.test(message)
  if (gone) return json({ error: '分片会话不存在或已结束', code: 'upload_gone', fatal: true, retryable: false }, cors, 409)
  return json({ error: `${operation} 暂时失败，请保留续传信息后重试`, code: 'storage_unavailable', fatal: false, retryable: true }, cors, 503, { 'Retry-After': '2' })
}
