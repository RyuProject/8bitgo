/*
 * 8BitGo PPSSPP Range 顺序预读层。
 *
 * PPSSPP 的 C++ loader 必须用同步 XHR 阻塞模拟线程，否则 ReadAt() 不能在返回前拿到字节；
 * 但同步请求本身没有“趁核心消费当前 2 MiB 时取下一块”的能力。这里仅包住 Emscripten Fetch
 * 创建的 XHR：真实读取仍由原请求完成，成功后用一个低优先级异步请求预取后续块；核心下次
 * 请求完全相同的 Range 时直接消费这份结果。这样不改变盘内容、校验器或 C++ 的错误语义。
 *
 * 这段源码会由 scripts/build-ppsspp.mjs 精确注入生成的 PPSSPPSDL.js。不要在发布产物里
 * 手改副本，否则下一次构建会静默丢失。
 */
(() => {
  'use strict'

  const BLOCK_BYTES = 2 * 1024 * 1024
  const MAX_CACHE_BYTES = 8 * 1024 * 1024
  const PREFETCH_TIMEOUT_MS = 15_000
  const NativeXMLHttpRequest = globalThis.XMLHttpRequest
  if (typeof NativeXMLHttpRequest !== 'function' || globalThis.__8bitgoCreatePspRangeXhr) return

  const cache = new Map()
  const queued = new Map()
  const inflight = new Map()
  let cachedBytes = 0
  let lastDemand = null
  let pumping = false

  const header = (headers, name) => headers.get(String(name).toLowerCase()) || ''
  const rangeOf = (value) => {
    const match = /^bytes=(\d+)-(\d+)$/i.exec(String(value || ''))
    if (!match) return null
    const start = Number(match[1])
    const end = Number(match[2])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return null
    return { start, end }
  }
  const contentRangeOf = (value) => {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(value || '').trim())
    if (!match) return null
    const start = Number(match[1])
    const end = Number(match[2])
    const total = Number(match[3])
    if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return null
    return { start, end, total }
  }
  const responseHeader = (raw, name) => {
    const wanted = String(name).toLowerCase()
    for (const line of String(raw || '').split(/\r?\n/)) {
      const colon = line.indexOf(':')
      if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === wanted) return line.slice(colon + 1).trim()
    }
    return ''
  }
  const cacheKey = (url, start, end) => `${url}\n${start}-${end}`

  const readAheadDepth = () => {
    const connection = globalThis.navigator?.connection
    if (connection?.saveData) return 0
    const type = String(connection?.effectiveType || '').toLowerCase()
    if (type === 'slow-2g' || type === '2g') return 0
    if (type === '3g') return 1
    return 2
  }

  const dropCacheEntry = (key) => {
    const entry = cache.get(key)
    if (!entry) return null
    cache.delete(key)
    cachedBytes -= entry.response.byteLength
    return entry
  }

  const store = (key, entry) => {
    dropCacheEntry(key)
    cache.set(key, entry)
    cachedBytes += entry.response.byteLength
    for (const oldest of cache.keys()) {
      if (cachedBytes <= MAX_CACHE_BYTES) break
      dropCacheEntry(oldest)
    }
  }

  const validatorMatches = (entry, requestHeaders) => {
    const ifMatch = header(requestHeaders, 'if-match')
    if (ifMatch && responseHeader(entry.rawHeaders, 'etag') !== ifMatch) return false
    const ifUnmodifiedSince = header(requestHeaders, 'if-unmodified-since')
    if (ifUnmodifiedSince && responseHeader(entry.rawHeaders, 'last-modified') !== ifUnmodifiedSince) return false
    return true
  }

  const finishPrefetch = (key) => {
    inflight.delete(key)
    pumping = false
    pump()
  }

  const pump = () => {
    if (pumping || queued.size === 0) return
    const [key, job] = queued.entries().next().value
    queued.delete(key)
    pumping = true

    const xhr = new NativeXMLHttpRequest()
    inflight.set(key, xhr)
    let settled = false
    const finish = () => {
      // 某些浏览器在 abort 后还会补发 error/loadend；重复推进队列会把两个预读同时放行。
      if (settled) return
      settled = true
      finishPrefetch(key)
    }
    xhr.open('GET', job.url, true)
    xhr.responseType = 'arraybuffer'
    xhr.timeout = PREFETCH_TIMEOUT_MS
    xhr.setRequestHeader('Range', `bytes=${job.start}-${job.end}`)
    xhr.setRequestHeader('Accept', 'application/octet-stream')
    const ifMatch = header(job.headers, 'if-match')
    const ifUnmodifiedSince = header(job.headers, 'if-unmodified-since')
    if (ifMatch) xhr.setRequestHeader('If-Match', ifMatch)
    if (ifUnmodifiedSince) xhr.setRequestHeader('If-Unmodified-Since', ifUnmodifiedSince)
    xhr.onload = () => {
      try {
        const rawHeaders = xhr.getAllResponseHeaders()
        const actual = contentRangeOf(responseHeader(rawHeaders, 'content-range'))
        const response = xhr.response
        if (
          xhr.status === 206 &&
          response instanceof ArrayBuffer &&
          actual?.start === job.start &&
          actual.end === job.end &&
          actual.total === job.total &&
          response.byteLength === job.end - job.start + 1
        ) {
          store(key, {
            response,
            rawHeaders,
            responseURL: xhr.responseURL || job.url,
            statusText: xhr.statusText || 'Partial Content',
          })
        }
      } finally {
        finish()
      }
    }
    xhr.onerror = xhr.ontimeout = xhr.onabort = finish
    try {
      xhr.send(null)
    } catch {
      finish()
    }
  }

  const cancelQueuedAndInflight = () => {
    queued.clear()
    for (const xhr of inflight.values()) {
      try {
        xhr.abort()
      } catch {
        // 预读失败不能影响正式读盘；同步请求随后会按核心自己的三次重试处理。
      }
    }
    inflight.clear()
    pumping = false
  }

  const beforeDemand = (url, requestHeaders) => {
    const requested = rangeOf(header(requestHeaders, 'range'))
    if (!requested || requested.start % BLOCK_BYTES !== 0 || requested.end - requested.start + 1 > BLOCK_BYTES) return null
    const key = cacheKey(url, requested.start, requested.end)
    const exactPrefetch = inflight.get(key)
    if (exactPrefetch) {
      // 正式读取不能排队等低优先级请求；立即让核心自己的同步请求接管。
      try {
        exactPrefetch.abort()
      } catch {
        /* noop */
      }
      inflight.delete(key)
      pumping = false
    }
    queued.delete(key)

    if (lastDemand && (lastDemand.url !== url || requested.start !== lastDemand.start + BLOCK_BYTES)) {
      cancelQueuedAndInflight()
    }
    return requested
  }

  const afterDemand = (xhr, requested) => {
    if (!requested || xhr.status !== 206 || !(xhr.response instanceof ArrayBuffer)) return
    const actual = contentRangeOf(responseHeader(xhr.getAllResponseHeaders(), 'content-range'))
    if (
      !actual ||
      actual.start !== requested.start ||
      actual.end !== requested.end ||
      xhr.response.byteLength !== requested.end - requested.start + 1
    ) return

    // Prepare() 的 0-0 探测只负责取得盘大小和校验器；从真正的对齐块开始预读。
    const length = requested.end - requested.start + 1
    if (requested.start % BLOCK_BYTES !== 0 || (length !== BLOCK_BYTES && requested.end + 1 !== actual.total)) return
    lastDemand = { url: xhr.url_, start: requested.start }

    const depth = readAheadDepth()
    for (let step = 1; step <= depth; step++) {
      const start = requested.start + step * BLOCK_BYTES
      if (start >= actual.total) break
      const end = Math.min(actual.total, start + BLOCK_BYTES) - 1
      const key = cacheKey(xhr.url_, start, end)
      if (cache.has(key) || queued.has(key) || inflight.has(key)) continue
      queued.set(key, {
        url: xhr.url_,
        start,
        end,
        total: actual.total,
        headers: new Map(xhr.__8bitgoHeaders),
      })
    }
    pump()
  }

  class RangeWarmXMLHttpRequest {
    constructor() {
      this._inner = new NativeXMLHttpRequest()
      this._fake = null
      this._async = true
      this.__8bitgoHeaders = new Map()
      this.url_ = ''
      this._streamData = false
    }

    open(method, url, async = true, username, password) {
      this._method = String(method || 'GET').toUpperCase()
      this._async = async !== false
      this.url_ = String(url)
      this._inner.open(method, url, async, username, password)
    }

    setRequestHeader(name, value) {
      this.__8bitgoHeaders.set(String(name).toLowerCase(), String(value))
      this._inner.setRequestHeader(name, value)
    }

    overrideMimeType(value) {
      this._inner.overrideMimeType(value)
    }

    send(data) {
      const requested = !this._async && this._method === 'GET'
        ? beforeDemand(this.url_, this.__8bitgoHeaders)
        : null
      if (requested) {
        const key = cacheKey(this.url_, requested.start, requested.end)
        const entry = cache.get(key)
        if (entry && validatorMatches(entry, this.__8bitgoHeaders)) {
          this._fake = dropCacheEntry(key)
          afterDemand(this, requested)
          this.onreadystatechange?.({ target: this })
          this.onload?.({ target: this })
          return
        }
        if (entry) dropCacheEntry(key)
      }

      this._inner.onload = (event) => {
        afterDemand(this, requested)
        this.onload?.(event)
      }
      this._inner.onerror = (event) => this.onerror?.(event)
      this._inner.ontimeout = (event) => this.ontimeout?.(event)
      this._inner.onprogress = (event) => this.onprogress?.(event)
      this._inner.onreadystatechange = (event) => this.onreadystatechange?.(event)
      this._inner.send(data)
    }

    abort() {
      this._inner.abort()
    }

    getAllResponseHeaders() {
      return this._fake?.rawHeaders || this._inner.getAllResponseHeaders()
    }

    get response() { return this._fake?.response || this._inner.response }
    get readyState() { return this._fake ? 4 : this._inner.readyState }
    get status() { return this._fake ? 206 : this._inner.status }
    get statusText() { return this._fake?.statusText || this._inner.statusText }
    get responseURL() { return this._fake?.responseURL || this._inner.responseURL }
    get responseType() { return this._inner.responseType }
    set responseType(value) { this._inner.responseType = value }
    get timeout() { return this._inner.timeout }
    set timeout(value) { this._inner.timeout = value }
    get withCredentials() { return this._inner.withCredentials }
    set withCredentials(value) { this._inner.withCredentials = value }
  }

  globalThis.__8bitgoCreatePspRangeXhr = () => new RangeWarmXMLHttpRequest()
  globalThis.__8bitgoPspRangeWarmStats = () => ({
    cachedBlocks: cache.size,
    cachedBytes,
    queuedBlocks: queued.size,
    inflightBlocks: inflight.size,
    depth: readAheadDepth(),
  })
})()
