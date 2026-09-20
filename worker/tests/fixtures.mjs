import { createHash } from 'node:crypto'
export const TOKEN = 'local-test-token-not-a-production-secret'
export const bytes = s => new TextEncoder().encode(s)
export function req(path, method = 'GET', body, headers = {}, admin = false) {
  const opts = { method, headers: { ...(admin ? { Authorization: `Bearer ${TOKEN}` } : {}), ...headers } }
  if (body !== undefined) {
    opts.body = typeof body === 'object' && !(body instanceof Uint8Array) && !(body instanceof ReadableStream) && !(body instanceof ArrayBuffer) ? JSON.stringify(body) : body
    if (opts.body instanceof ReadableStream) opts.duplex = 'half'
  }
  return new Request('https://worker.test' + path, opts)
}
export function streamChunks(chunks, stats = {}) {
  let i = 0
  return new ReadableStream({
    pull(c) { if (i === chunks.length) c.close(); else { stats.pulls = (stats.pulls || 0) + 1; c.enqueue(chunks[i++]) } },
    cancel() { stats.cancelled = true },
  }, { highWaterMark: 0 })
}
async function consume(value, stats) {
  if (value === null || value === undefined) return new Uint8Array(0)
  if (typeof value === 'string') return bytes(value)
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
  if (value instanceof ReadableStream) {
    stats.streamWrites++
    const chunks = []; let size = 0
    const reader = value.getReader()
    try {
      while (true) { const { done, value: v } = await reader.read(); if (done) break; chunks.push(v); size += v.byteLength }
    } finally { reader.releaseLock() }
    const out = new Uint8Array(size); let at = 0
    for (const c of chunks) { out.set(c, at); at += c.byteLength }
    return out
  }
  if (value.arrayBuffer) return new Uint8Array(await value.arrayBuffer())
  throw Error('unsupported fixture body')
}
export class Bucket {
  constructor(name = 'roms', pageSize = 1000) {
    this.name = name; this.objects = new Map(); this.uploads = new Map(); this.calls = []; this.pageSize = pageSize
    this.stats = { streamWrites: 0 }; this.fail = {}; this.beforeGet = null; this.serial = 0
  }
  log(method, args) {
    this.calls.push({ method, args })
    const error = this.fail[method]
    if (error) throw typeof error === 'function' ? error() : error
  }
  seed(key, value = 'fixture', metadata = {}) {
    const data = typeof value === 'string' ? bytes(value) : value.slice()
    const etag = createHash('md5').update(data).digest('hex')
    const stored = { key, data, etag, httpEtag: `"${etag}"`, size: data.byteLength,
      uploaded: new Date('2026-09-01T01:02:03Z'), httpMetadata: {}, customMetadata: {}, ...metadata }
    this.objects.set(key, stored); return stored
  }
  view(stored, body = false, range = null) {
    const { data, ...meta } = stored
    const result = { ...meta, customMetadata: { ...meta.customMetadata }, writeHttpMetadata(headers) {
      const names = { contentType: 'Content-Type', cacheControl: 'Cache-Control', contentEncoding: 'Content-Encoding', contentDisposition: 'Content-Disposition' }
      for (const [key,value] of Object.entries(meta.httpMetadata || {})) if (names[key]) headers.set(names[key], value)
    } }
    if (range) result.range = range
    if (body) {
      let payload = data
      if (range && 'offset' in range) payload = data.slice(range.offset, range.offset + range.length)
      else if (range?.suffix !== undefined) payload = data.slice(-Math.min(range.suffix, data.length))
      result.body = new Response(payload).body
    }
    return result
  }
  async head(key) { this.log('head', key); const o = this.objects.get(key); return o ? this.view(o) : null }
  async get(key, options = {}) {
    this.log('get', { key, options })
    if (this.beforeGet) await this.beforeGet(key, options)
    const o = this.objects.get(key); if (!o) return null
    const onlyIf = options.onlyIf
    if (onlyIf instanceof Headers) {
      if ((onlyIf.has('if-match') && ![o.httpEtag, '*'].includes(onlyIf.get('if-match'))) ||
        [o.httpEtag, '*'].includes(onlyIf.get('if-none-match'))) return this.view(o)
    } else if (onlyIf?.etagMatches && onlyIf.etagMatches !== o.etag) return this.view(o)
    let range = options.range
    if (range instanceof Headers) {
      const s = range.get('Range'); range = null
      if (s) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(s)
        if (m && !m[1] && m[2]) range = { suffix: Number(m[2]) }
        else if (m && m[1]) {
          const offset = Number(m[1]); const end = m[2] ? Number(m[2]) : o.size - 1
          if (offset >= o.size || end < offset) throw Error('R2 range not satisfiable')
          range = { offset, length: Math.min(end, o.size - 1) - offset + 1 }
        }
      }
    }
    return this.view(o, true, range)
  }
  async put(key, value, options = {}) {
    this.log('put', { key, kind: value instanceof ReadableStream ? 'stream' : 'buffer' })
    const data = await consume(value, this.stats)
    return this.view(this.seed(key, data, { ...options }))
  }
  async delete(keys) {
    this.log('delete', keys)
    for (const key of Array.isArray(keys) ? keys : [keys]) this.objects.delete(key)
  }
  async list(options = {}) {
    this.log('list', options)
    let offset = 0
    if (options.cursor) {
      const prefix = this.name + ':'
      if (!options.cursor.startsWith(prefix)) throw Error('cursor belongs to another bucket')
      offset = Number(options.cursor.slice(prefix.length))
    }
    const all = [...this.objects.values()].filter(o => !options.prefix || o.key.startsWith(options.prefix)).sort((a,b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
    const n = Math.min(options.limit || 1000, this.pageSize)
    const slice = all.slice(offset, offset + n)
    const truncated = offset + slice.length < all.length
    return { objects: slice.map(o => this.view(o)), truncated, cursor: truncated ? this.name + ':' + (offset + slice.length) : undefined }
  }
  async createMultipartUpload(key, options) {
    this.log('createMultipartUpload', key)
    const uploadId = `${this.name}-upload-${++this.serial}`
    this.uploads.set(uploadId, { key, options, parts: new Map() })
    return this.resumeMultipartUpload(key, uploadId)
  }
  resumeMultipartUpload(key, uploadId) {
    const bucket = this
    function session() {
      const u = bucket.uploads.get(uploadId)
      if (!u || u.key !== key) { const e = Error('NoSuchUpload'); e.code = 'NoSuchUpload'; throw e }
      return u
    }
    return { key, uploadId,
      async uploadPart(partNumber, body) {
        bucket.log('uploadPart', { key, uploadId, kind: body instanceof ReadableStream ? 'stream' : 'buffer' })
        const u = session(), data = await consume(body, bucket.stats)
        const etag = createHash('md5').update(data).digest('hex')
        u.parts.set(partNumber, { data, etag })
        return { partNumber, etag }
      },
      async abort() { bucket.log('abort', { key, uploadId }); session(); bucket.uploads.delete(uploadId) },
      async complete(parts) {
        bucket.log('complete', { key, uploadId, parts }); const u = session()
        const arrays = parts.map(p => { const part = u.parts.get(p.partNumber); if (!part || part.etag !== p.etag) throw Error('InvalidPart'); return part.data })
        const size = arrays.reduce((n,a) => n + a.length,0), out = new Uint8Array(size); let at = 0
        for (const a of arrays) { out.set(a,at); at += a.length }
        const result = bucket.view(bucket.seed(key, out, u.options)); bucket.uploads.delete(uploadId); return result
      },
    }
  }
}
export function environment(covers = true, pageSize = 1000) {
  return { ROMS: new Bucket('roms',pageSize), ...(covers ? { COVERS: new Bucket('covers',pageSize) } : {}), ADMIN_TOKEN: TOKEN, ALLOWED_ORIGINS: '*' }
}
export function count(bucket, method) { return bucket.calls.filter(c => c.method === method).length }
