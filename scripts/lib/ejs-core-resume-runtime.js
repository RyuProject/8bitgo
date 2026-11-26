/*
 * EmulatorJS 核心下载续传助手，由 patch-emulatorjs.mjs 内嵌进自托管引擎。
 * 只处理带内容版本号的 cores/*-wasm.data GET；其它引擎资源与 ROM 不经过这里。
 */
const __8bgCoreResume = (() => {
  const DB_NAME = '8bitgo-ejs-core-resume-v1'
  const STORE_NAME = 'parts'
  const MANIFEST_KEY = '8bitgo.ejs.coreResume.v1'
  const IDB_STALL_KEY = '8bitgo.ejs.idbStall2'
  const PART_BYTES = 1024 * 1024
  const MAX_CORE_BYTES = 64 * 1024 * 1024
  const MAX_STORED_BYTES = 48 * 1024 * 1024
  const MAX_ENTRIES = 4
  const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000
  const DB_TIMEOUT_MS = 1500
  const TX_TIMEOUT_MS = 1500
  const SPACE_CHECK_TIMEOUT_MS = 200
  const CORE_CONTENT_MANIFEST = Object.freeze({})
  let dbPromise = null
  let storageDisabled = false
  let availableBytes = null

  function currentTime() {
    return Date.now()
  }

  function storage() {
    try { return typeof localStorage === 'undefined' ? null : localStorage } catch { return null }
  }

  function idbPreviouslyStalled() {
    const ls = storage()
    if (!ls) return false
    try {
      const at = Number(ls.getItem(IDB_STALL_KEY))
      const age = currentTime() - at
      return Number.isFinite(at) && at > 0 && age >= 0 && age < 3 * 24 * 60 * 60 * 1000
    } catch { return true }
  }

  function canonicalUrl(raw) {
    try {
      const base = typeof location !== 'undefined' && location.href ? location.href : 'https://8bitgo.invalid/'
      const url = new URL(raw, base)
      // 大陆入口和同源入口指向同一个内容哈希对象，允许两条线路共用安全的已校验分片。
      if (url.hostname.startsWith('cn.') && url.pathname.startsWith('/_cn/emulatorjs/')) {
        url.hostname = url.hostname.slice(3)
        url.pathname = url.pathname.slice('/_cn'.length)
      }
      return url.href
    } catch { return '' }
  }

  function isCoreUrl(raw, method, body) {
    if (method !== 'GET' || (body !== null && body !== undefined)) return false
    try {
      const base = typeof location !== 'undefined' && location.href ? location.href : 'https://8bitgo.invalid/'
      const url = new URL(raw, base)
      return url.pathname.includes('/cores/') && url.pathname.endsWith('-wasm.data') && Boolean(url.searchParams.get('v'))
    } catch { return false }
  }

  function expectedCoreBytes(rawUrl) {
    try {
      const base = typeof location !== 'undefined' && location.href ? location.href : 'https://8bitgo.invalid/'
      const url = new URL(rawUrl, base)
      const marker = '/cores/'
      const at = url.pathname.lastIndexOf(marker)
      if (at < 0) return 0
      const record = CORE_CONTENT_MANIFEST[url.pathname.slice(at + 1)]
      if (!record || !Number.isSafeInteger(record.bytes) || record.bytes <= 0) return 0
      const requestedVersion = url.searchParams.get('v') || ''
      // Range 核心 URL 形如 `<内容哈希>.range1`：后缀只绕过边缘上旧的 Range 响应头缓存，不改变文件内容。
      // 只接受已知的 rangeN 代次，不能把任意查询参数误认成当前内容版本。
      const epochSuffix = requestedVersion.startsWith(`${record.version}.`)
        ? requestedVersion.slice(record.version.length + 1)
        : ''
      const versionMatches = requestedVersion === record.version || /^range\d+$/.test(epochSuffix)
      return versionMatches ? record.bytes : 0
    } catch { return 0 }
  }

  /** 只有本次请求的完整 identity 核心恰好全量到达时，才为 Fetch 的网络 TypeError 额外尝试 XHR。 */
  function fullCoreTransferObserved(rawUrl, startedAt) {
    const expected = expectedCoreBytes(rawUrl)
    if (!expected || !Number.isFinite(startedAt)) return false
    try {
      if (typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') return false
      const entries = performance.getEntriesByName(rawUrl, 'resource')
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]
        const start = Number(entry.startTime)
        const encoded = Number(entry.encodedBodySize)
        const decoded = Number(entry.decodedBodySize)
        const transferred = Number(entry.transferSize)
        // 必须是本次网络请求；缓存命中（transferSize=0）、部分字节、旧 URL 代次都不重试。
        if (!Number.isFinite(start) || start < startedAt - 5 || !Number.isFinite(transferred) ||
            encoded !== expected || decoded !== expected || transferred < expected) continue
        return true
      }
    } catch { return false }
    return false
  }

  function manifest() {
    const ls = storage()
    if (!ls) return []
    try {
      const value = JSON.parse(ls.getItem(MANIFEST_KEY) || '[]')
      return Array.isArray(value) ? value.filter((entry) => entry && typeof entry.url === 'string') : []
    } catch { return [] }
  }

  function validHint(entry, url) {
    const now = currentTime()
    return Boolean(
      entry && entry.url === url && typeof entry.etag === 'string' && entry.etag.length > 0 && !entry.etag.startsWith('W/') &&
      Number.isSafeInteger(entry.total) && entry.total > PART_BYTES && entry.total <= MAX_CORE_BYTES &&
      Number.isSafeInteger(entry.offset) && entry.offset > 0 && entry.offset < entry.total &&
      entry.offset % PART_BYTES === 0 && entry.partBytes === PART_BYTES &&
      Number.isFinite(entry.updatedAt) && entry.updatedAt > 0 && now - entry.updatedAt >= 0 && now - entry.updatedAt < MAX_AGE_MS
    )
  }

  function findHint(url) {
    if (idbPreviouslyStalled()) return null
    return manifest().find((entry) => validHint(entry, url)) || null
  }

  function sameOrigin(raw) {
    try {
      if (typeof location === 'undefined' || !location.origin) return false
      return new URL(raw, location.href).origin === location.origin
    } catch { return false }
  }

  function partId(url, etag, offset) {
    return JSON.stringify([url, etag, offset])
  }

  function responseHeader(response, name) {
    try { return String(response.headers?.get(name) || '').trim() } catch { return '' }
  }

  function contentRange(raw) {
    const match = /^bytes\s+(\d+)-(\d+)\/(\d+)$/i.exec(String(raw || '').trim())
    if (!match) return null
    const start = Number(match[1])
    const end = Number(match[2])
    const total = Number(match[3])
    if (![start, end, total].every(Number.isSafeInteger) || start < 0 || end < start || total <= end) return null
    return { start, end, total }
  }

  function encodingIsIdentity(raw) {
    const encoding = String(raw || '').trim().toLowerCase()
    return !encoding || encoding === 'identity'
  }

  function plan(rawUrl, method, body, originalHeaders) {
    if (!isCoreUrl(rawUrl, method, body)) return null
    const url = canonicalUrl(rawUrl)
    if (!url) return null
    const hint = findHint(url)
    let headers
    try { headers = new Headers(originalHeaders || {}) } catch { return null }
    const start = hint ? hint.offset : 0
    try {
      // Range 0- 同时绕过源站预压缩副本，让首响与后续字节偏移属于同一份 identity 内容。
      headers.set('Range', `bytes=${start}-`)
      // If-Range 只发给同源强 ETag；跨源入口靠暴露的响应头比对，避免额外 CORS 预检。
      if (hint && sameOrigin(rawUrl) && !hint.etag.startsWith('W/')) headers.set('If-Range', hint.etag)
      else headers.delete('If-Range')
    } catch { return null }
    return { rawUrl, url, start, hint, headers }
  }

  function fullState(response, plan) {
    const encoding = responseHeader(response, 'Content-Encoding')
    const length = encodingIsIdentity(encoding) ? Number(responseHeader(response, 'Content-Length')) : 0
    return {
      url: plan.url,
      start: 0,
      total: Number.isSafeInteger(length) && length > 0 ? length : 0,
      etag: responseHeader(response, 'ETag'),
      encoding,
      canResume: false,
      persist: false,
      owner: ownerId(),
      startedAt: currentTime(),
    }
  }

  function cancelBody(response) {
    try {
      const cancelled = response?.body?.cancel?.()
      cancelled?.catch?.(() => {})
    } catch {}
  }

  function removeHint(url, etag) {
    const ls = storage()
    if (!ls) return
    const before = manifest()
    const removed = before.filter((entry) => entry.url === url && (!etag || entry.etag === etag))
    const after = before.filter((entry) => !removed.includes(entry))
    try { ls.setItem(MANIFEST_KEY, JSON.stringify(after)) } catch {}
    for (const entry of removed) deleteParts(entry.url, entry.etag, entry.total, entry.offset)
  }

  function restartFull(plan, response, retryFull, reason) {
    cancelBody(response)
    if (plan.hint) removeHint(plan.url, plan.hint.etag)
    return Promise.resolve().then(retryFull).then((fresh) => {
      // 不允许把代理错误返回的另一段 206 当成完整核心交给解压器。
      if (fresh.status !== 200) {
        cancelBody(fresh)
        throw new Error(`Core range recovery failed (${reason}; full retry HTTP ${fresh.status})`)
      }
      return { response: fresh, state: fullState(fresh, plan) }
    })
  }

  async function readPrefix(url, etag, total, offset) {
    const db = await openDatabase()
    if (!db) return null
    return transactionResult((resolve, fail) => {
      let tx
      try { tx = db.transaction(STORE_NAME, 'readonly') } catch { return fail() }
      let store
      try { store = tx.objectStore(STORE_NAME) } catch { return fail() }
      const count = offset / PART_BYTES
      const parts = new Array(count)
      let requestsDone = 0
      let transactionDone = false
      const finishIfReady = () => {
        if (!transactionDone || requestsDone !== count) return
        resolve(parts)
      }
      tx.oncomplete = () => { transactionDone = true; finishIfReady() }
      tx.onerror = tx.onabort = () => fail()
      for (let index = 0; index < count; index++) {
        const partOffset = index * PART_BYTES
        let request
        try { request = store.get(partId(url, etag, partOffset)) } catch { return fail() }
        request.onsuccess = () => {
          const record = request.result
          const bytes = record?.bytes instanceof ArrayBuffer
            ? new Uint8Array(record.bytes)
            : ArrayBuffer.isView(record?.bytes)
              ? new Uint8Array(record.bytes.buffer, record.bytes.byteOffset, record.bytes.byteLength)
              : null
          if (!record || record.url !== url || record.etag !== etag || record.total !== total ||
              record.offset !== partOffset || !bytes || bytes.byteLength !== PART_BYTES) return fail()
          parts[index] = bytes
          requestsDone++
          finishIfReady()
        }
        request.onerror = () => fail()
      }
    })
  }

  async function accept(plan, response, retryFull) {
    if (!plan) return { response, state: null }
    if (response.status === 200) {
      if (plan.hint) removeHint(plan.url, plan.hint.etag)
      return { response, state: fullState(response, plan) }
    }
    if (response.status !== 206) {
      if (plan.start > 0 || response.status === 416 || response.status === 412) {
        return restartFull(plan, response, retryFull, `HTTP ${response.status}`)
      }
      return { response, state: null }
    }

    const range = contentRange(responseHeader(response, 'Content-Range'))
    const etag = responseHeader(response, 'ETag')
    const encoding = responseHeader(response, 'Content-Encoding')
    const identity = encodingIsIdentity(encoding)
    const isWholeRemainder = Boolean(range && range.start === plan.start && range.end === range.total - 1 && identity)
    if (!isWholeRemainder) return restartFull(plan, response, retryFull, 'invalid Content-Range or encoded response')

    if (plan.start > 0) {
      if (!plan.hint || !etag || etag !== plan.hint.etag || range.total !== plan.hint.total) {
        return restartFull(plan, response, retryFull, 'validator changed while resuming')
      }
      const prefix = await readPrefix(plan.url, etag, range.total, plan.start)
      if (!prefix) return restartFull(plan, response, retryFull, 'persistent prefix is incomplete')
      return {
        response,
        state: {
          url: plan.url,
          start: plan.start,
          total: range.total,
          etag,
          encoding,
          canResume: true,
          persist: range.total <= MAX_CORE_BYTES && !idbPreviouslyStalled(),
          owner: ownerId(),
          startedAt: currentTime(),
        },
        prefix,
      }
    }

    const versioned = Boolean(new URL(plan.url).searchParams.get('v'))
    // Weak ETag 只能证明语义等价，不能证明每个字节相同；断点拼接必须用强校验器。
    const resumable = Boolean(etag && !etag.startsWith('W/') && versioned)
    const declaredLength = Number(responseHeader(response, 'Content-Length'))
    if (Number.isSafeInteger(declaredLength) && declaredLength > 0 && declaredLength !== range.total) {
      return restartFull(plan, response, retryFull, 'range length mismatch')
    }
    return {
      response,
      state: {
        url: plan.url,
        start: 0,
        total: range.total,
        etag,
        encoding,
        canResume: resumable,
        persist: resumable && range.total <= MAX_CORE_BYTES && !idbPreviouslyStalled(),
        owner: ownerId(),
        startedAt: currentTime(),
      },
      prefix: [],
    }
  }

  function ownerId() {
    try {
      const key = '8bitgo.ejs.coreResumeOwner'
      let owner = sessionStorage.getItem(key)
      if (!owner) {
        owner = `${currentTime().toString(36)}-${Math.random().toString(36).slice(2)}`
        sessionStorage.setItem(key, owner)
      }
      return owner
    } catch { return `${currentTime().toString(36)}-${Math.random().toString(36).slice(2)}` }
  }

  function openDatabase() {
    if (storageDisabled || idbPreviouslyStalled()) return Promise.resolve(null)
    if (dbPromise) return dbPromise
    dbPromise = new Promise((resolve) => {
      let settled = false
      let timer = setTimeout(() => finish(null), DB_TIMEOUT_MS)
      const finish = (db) => {
        if (settled) { db?.close?.(); return }
        settled = true
        clearTimeout(timer)
        if (!db) storageDisabled = true
        else {
          try { db.onversionchange = () => db.close() } catch {}
          pruneExpired(db)
        }
        resolve(db || null)
      }
      let request
      try {
        if (!window?.indexedDB) return finish(null)
        request = window.indexedDB.open(DB_NAME, 1)
      } catch { return finish(null) }
      request.onupgradeneeded = () => {
        try {
          const db = request.result
          if (!db.objectStoreNames.contains(STORE_NAME)) {
            const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' })
            store.createIndex('updatedAt', 'updatedAt', { unique: false })
          }
        } catch { try { request.transaction?.abort() } catch {} }
      }
      request.onsuccess = () => finish(request.result)
      request.onerror = request.onblocked = () => finish(null)
    })
    return dbPromise
  }

  function pruneExpired(db) {
    const ls = storage()
    if (!ls) return
    const pruneKey = `${MANIFEST_KEY}.pruned`
    try {
      const previous = Number(ls.getItem(pruneKey))
      if (previous > 0 && currentTime() - previous < 24 * 60 * 60 * 1000) return
      ls.setItem(pruneKey, String(currentTime()))
    } catch { return }
    // 游标只扫有限条，清理是旁路任务，不得占住开局。
    setTimeout(() => {
      try {
        const tx = db.transaction(STORE_NAME, 'readwrite')
        const request = tx.objectStore(STORE_NAME).openCursor()
        let scanned = 0
        request.onsuccess = () => {
          const cursor = request.result
          if (!cursor || scanned++ >= 1000) return
          if (!Number.isFinite(cursor.value?.updatedAt) || currentTime() - cursor.value.updatedAt >= MAX_AGE_MS) cursor.delete()
          cursor.continue()
        }
      } catch {}
    }, 0)
  }

  function transactionResult(register) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(value)
      }
      const timer = setTimeout(() => {
        storageDisabled = true
        finish(null)
      }, TX_TIMEOUT_MS)
      try { register((value) => finish(value), () => finish(null)) } catch { finish(null) }
    })
  }

  async function hasSpace(total) {
    if (Number.isFinite(availableBytes)) return availableBytes >= total + 2 * PART_BYTES
    try {
      const estimate = typeof navigator !== 'undefined' ? navigator.storage?.estimate?.() : null
      if (!estimate) return true
      let timer
      const result = await Promise.race([
        estimate,
        new Promise((resolve) => { timer = setTimeout(() => resolve(null), SPACE_CHECK_TIMEOUT_MS) }),
      ]).finally(() => clearTimeout(timer))
      if (Number.isFinite(result?.quota) && Number.isFinite(result?.usage)) {
        availableBytes = Math.max(0, result.quota - result.usage)
      }
    } catch { availableBytes = null }
    return !Number.isFinite(availableBytes) || availableBytes >= total + 2 * PART_BYTES
  }

  function writePart(record) {
    return openDatabase().then((db) => {
      if (!db) return false
      return transactionResult((resolve, fail) => {
        let tx
        try { tx = db.transaction(STORE_NAME, 'readwrite') } catch { return fail() }
        let request
        try { request = tx.objectStore(STORE_NAME).put(record) } catch { return fail() }
        let requestDone = false
        let transactionDone = false
        const finish = () => { if (requestDone && transactionDone) resolve(true) }
        request.onsuccess = () => { requestDone = true; finish() }
        request.onerror = tx.onerror = tx.onabort = () => fail()
        tx.oncomplete = () => { transactionDone = true; finish() }
      })
    })
  }

  function updateManifest(entry) {
    const ls = storage()
    if (!ls) return false
    let entries = manifest().filter((item) => !(item.url === entry.url && item.etag === entry.etag))
    entries.push(entry)
    entries.sort((a, b) => b.updatedAt - a.updatedAt)
    const kept = []
    let stored = 0
    const evicted = []
    for (const item of entries) {
      if (!validHint(item, item.url) || kept.length >= MAX_ENTRIES || stored + item.offset > MAX_STORED_BYTES) {
        evicted.push(item)
        continue
      }
      kept.push(item)
      stored += item.offset
    }
    try { ls.setItem(MANIFEST_KEY, JSON.stringify(kept)) } catch { storageDisabled = true; return false }
    for (const item of evicted) deleteParts(item.url, item.etag, item.total, item.offset)
    return kept.some((item) => item.url === entry.url && item.etag === entry.etag)
  }

  function deleteParts(url, etag, total, offset) {
    if (!Number.isSafeInteger(total) || total <= 0) return
    openDatabase().then((db) => {
      if (!db) return
      transactionResult((resolve, fail) => {
        let tx
        try { tx = db.transaction(STORE_NAME, 'readwrite') } catch { return fail() }
        let store
        try { store = tx.objectStore(STORE_NAME) } catch { return fail() }
        try {
          for (let at = 0; at < Math.min(total, offset || total); at += PART_BYTES) store.delete(partId(url, etag, at))
          tx.oncomplete = () => resolve(true)
          tx.onerror = tx.onabort = () => fail()
        } catch { fail() }
      })
    }).catch(() => {})
  }

  function writer(state) {
    if (!state?.persist || !state.etag || !state.total || state.total > MAX_CORE_BYTES) return null
    let buffer = new Uint8Array(PART_BYTES)
    let filled = 0
    let offset = state.start
    let disabled = false
    let checkedSpace = false
    return {
      async push(chunk) {
        if (disabled || storageDisabled) return
        let sourceOffset = 0
        while (sourceOffset < chunk.byteLength && !disabled) {
          const take = Math.min(PART_BYTES - filled, chunk.byteLength - sourceOffset)
          buffer.set(chunk.subarray(sourceOffset, sourceOffset + take), filled)
          filled += take
          sourceOffset += take
          if (filled !== PART_BYTES) continue
          const nextOffset = offset + PART_BYTES
          // 最后一段不落盘；下一次开局仍需收到一个经 ETag / Content-Range 验证的网络响应。
          if (nextOffset >= state.total) { disabled = true; buffer = null; return }
          if (!checkedSpace) {
            checkedSpace = true
            if (!await hasSpace(state.total)) { disabled = true; buffer = null; return }
          }
          const now = currentTime()
          const record = {
            id: partId(state.url, state.etag, offset),
            url: state.url,
            etag: state.etag,
            total: state.total,
            offset,
            bytes: buffer.buffer,
            updatedAt: now,
          }
          const saved = await writePart(record)
          if (!saved) {
            disabled = true
            buffer = null
            removeHint(state.url, state.etag)
            return
          }
          offset = nextOffset
          const hint = {
            url: state.url,
            etag: state.etag,
            total: state.total,
            offset,
            partBytes: PART_BYTES,
            updatedAt: now,
            owner: state.owner,
          }
          if (!updateManifest(hint)) { disabled = true; buffer = null; return }
          buffer = new Uint8Array(PART_BYTES)
          filled = 0
        }
      },
    }
  }

  function complete(state) {
    if (!state?.url || !state.etag || !state.total) return
    const entries = manifest()
    const current = entries.find((item) => item.url === state.url && item.etag === state.etag)
    if (!current || (current.owner !== state.owner && current.updatedAt > state.startedAt)) return
    const ls = storage()
    if (!ls) return
    try { ls.setItem(MANIFEST_KEY, JSON.stringify(entries.filter((item) => item !== current))) } catch { return }
    deleteParts(current.url, current.etag, current.total, current.offset)
  }

  function rangeHeaders(rawUrl, originalHeaders, state, offset) {
    try {
      const headers = new Headers(originalHeaders || {})
      headers.delete('Range')
      headers.delete('If-Range')
      const useRange = Boolean(state?.canResume && state.etag && offset > 0 && offset < state.total)
      if (useRange) {
        headers.set('Range', `bytes=${offset}-`)
        if (sameOrigin(rawUrl) && !state.etag.startsWith('W/')) headers.set('If-Range', state.etag)
      }
      return { headers, useRange }
    } catch { return { headers: new Headers(), useRange: false } }
  }

  function xhrFallback({ url, originalHeaders, state, offset, progress, readError, expectedBytes = 0 }) {
    return new Promise((resolve, reject) => {
      if (typeof XMLHttpRequest === 'undefined') return reject(new Error(`XHR unavailable after ${readError}`))
      let timer = 0
      let xhr = null
      let settled = false
      const clearIdle = () => { clearTimeout(timer); timer = 0 }
      const finish = (error, result) => {
        if (settled) return
        settled = true
        clearIdle()
        try { document.removeEventListener('visibilitychange', onVisibility) } catch {}
        if (error) reject(error)
        else resolve(result)
      }
      const armIdle = () => {
        clearIdle()
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
        timer = setTimeout(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return armIdle()
          try { xhr?.abort() } catch {}
        }, 20_000)
      }
      const onVisibility = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') clearIdle()
        else armIdle()
      }
      try { document.addEventListener('visibilitychange', onVisibility) } catch {}
      const send = (tryRange) => {
        const request = rangeHeaders(url, originalHeaders, tryRange ? state : null, offset)
        const useRange = tryRange && request.useRange
        xhr = new XMLHttpRequest()
        try {
          xhr.open('GET', url)
          xhr.responseType = 'arraybuffer'
          request.headers.forEach((value, name) => xhr.setRequestHeader(name, value))
        } catch (error) { return finish(new Error(`XHR setup failed after ${readError}: ${error}`)) }
        xhr.onprogress = (event) => {
          armIdle()
          if (!progress || !event.lengthComputable) return
          const loaded = (useRange ? offset : 0) + event.loaded
          const total = useRange && state?.total ? state.total : event.total
          progress('downloading', Math.floor(loaded / total * 100), loaded, total)
        }
        xhr.onload = () => {
          clearIdle()
          const body = xhr.response
          const bytes = body?.byteLength || 0
          const header = (name) => { try { return xhr.getResponseHeader?.(name) || '' } catch { return '' } }
          const mime = String(header('Content-Type')).split(';')[0].trim().toLowerCase()
          const badMime = mime === 'text/html' || mime === 'application/json' || mime === 'application/xml'
          const encoding = header('Content-Encoding')
          if (xhr.status === 206) {
            const range = contentRange(header('Content-Range'))
            const valid = Boolean(
              useRange && range && range.start === offset && range.end === state.total - 1 &&
              range.total === state.total && bytes === state.total - offset &&
              header('ETag') === state.etag && encodingIsIdentity(encoding) && !badMime
            )
            if (valid) return finish(null, { body, resumed: true })
            if (useRange) return send(false)
            return finish(new Error(`XHR fallback invalid partial response: ${header('Content-Range') || 'missing Content-Range'}`))
          }
          const declared = encodingIsIdentity(encoding) ? Number(header('Content-Length')) : 0
          const versionMatches = !state?.etag || !header('ETag') || header('ETag') === state.etag
          const expected = Number.isSafeInteger(expectedBytes) && expectedBytes > 0
            ? expectedBytes
            : versionMatches && state?.total ? state.total : declared
          const minimum = useRange ? state.total : offset
          if (xhr.status === 200 && body && bytes > 0 && !badMime && bytes >= minimum &&
              (!expected || bytes === expected) && (!state?.total || versionMatches || bytes === declared)) {
            return finish(null, { body, resumed: false })
          }
          if (useRange && xhr.status >= 200 && xhr.status < 300) return send(false)
          finish(new Error(`XHR fallback incomplete response: HTTP ${xhr.status}, received ${bytes} bytes, expected at least ${minimum}${expected ? ` / ${expected}` : ''}${badMime ? ` (${header('Content-Type')})` : ''}`))
        }
        xhr.onerror = () => finish(new Error(`XHR fallback network error after ${readError}`))
        xhr.onabort = () => finish(new Error(`XHR fallback stalled after ${readError}`))
        armIdle()
        try { xhr.send() } catch (error) { finish(new Error(`XHR fallback send failed after ${readError}: ${error}`)) }
      }
      send(Boolean(state?.canResume && offset > 0 && offset < state.total))
    })
  }

  return { plan, accept, writer, complete, xhrFallback, expectedCoreBytes, fullCoreTransferObserved }
})()
