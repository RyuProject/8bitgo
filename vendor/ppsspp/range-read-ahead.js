/* 8BITGO_PSP_RANGE_READ_AHEAD_START */
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
  const MAX_CACHE_BYTES = 24 * 1024 * 1024
  const MAX_DEPTH = 10
  const MAX_CONCURRENCY = 4
  const MIN_RANGE_TIMEOUT_MS = 20_000
  const UNMEASURED_RANGE_TIMEOUT_MS = 120_000
  const MEASURED_SLOW_RANGE_TIMEOUT_MS = 120_000
  const MAX_RANGE_TIMEOUT_MS = 180_000
  /**
   * 正式读盘遇到网络层失败（status 0：连接被重置、断线、超时）时，先在这一层就地重试。
   *
   * 2026-11-10 后台：阿尔及利亚、智利的玩家已经进了游戏（game_playable），几十秒后一次 Range
   * 失败就整局报「Range request failed: HTTP 0」。C++ loader 只重试 3 次、间隔 250 / 500ms，
   * 跨洲线路上一次几秒的断流就能把三次全部吃掉。这里每次 C++ 请求再给最多 4 次退避重试，
   * 合计等待约 15 秒；连续快速失败累计超过 45 秒就不再重试，交回 C++ 处理。只重试 status 0：
   * HTTP 412 / 4xx 等确定的结果原样交还。
   *
   * 超时另算（v19/v29）：网络测速 API 在 Worker 中可能报出虚高 downlink；尚无完整盘块样本时
   * 至少给首块 120 秒，实际无 API 且估算为 0.1 Mbps 时用 180 秒。超时重试逐步放宽、封顶 180 秒，
   * 避免慢链路反复从头丢弃已收字节；响应仍失败时有限退避后交回核心处理。
   */
  const SYNC_RETRY_DELAYS_MS = [800, 2000, 4000, 8000]
  const SYNC_RETRY_BUDGET_MS = 45_000
  const SYNC_TIMEOUT_BUDGET_MS = 180_000
  // 同步读盘必须接受与预估一致的上限；低于这里会把 180 秒估算反向缩短到 120 秒。
  const SYNC_TIMEOUT_MAX_MS = MAX_RANGE_TIMEOUT_MS
  const NativeXMLHttpRequest = globalThis.XMLHttpRequest
  if (typeof NativeXMLHttpRequest !== 'function' || globalThis.__8bitgoCreatePspRangeXhr) return

  const cache = new Map()
  const queued = new Map()
  const inflight = new Map()
  const discTotals = new Map()
  const sharedDemandStates = new Map()
  let cachedBytes = 0
  let lastDemand = null
  let activePrefetches = 0
  let cancellingPrefetches = false
  let prefetchHits = 0
  let demandTakeovers = 0
  let prefetchedBytes = 0
  let pressureLevel = 0
  let stableHits = 0
  let measuredMbps = 0
  let prefetchWorker = null
  let prefetchWorkerIsShared = false
  let prefetchWorkerReady = false
  let prefetchWorkerFailed = false
  let sharedJobId = 0
  const sharedOwnerId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  let sharedPrefetchWaits = 0
  let sharedPrefetchWaitMs = 0
  let sharedDemandRequests = 0
  let sharedDemandJoins = 0
  let assessedDemandBlocks = 0
  let assessedHits = 0
  let sequentialDemandRun = 0
  let syncRetries = 0
  let syncRecovered = 0
  let syncTimeouts = 0

  /** pthread 里可以同步睡；拿不到 SharedArrayBuffer 时直接重试（不会发生在跨源隔离页） */
  const sleepSync = (ms) => {
    try {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
    } catch { /* 不能睡就立刻重试 */ }
  }

  const initPrefetchWorker = () => {
    if (prefetchWorker || prefetchWorkerFailed) return
    // Atomics.wait 只允许在 Worker 中使用；不能把页面主线程卡在读盘等待上。
    if (
      typeof ENVIRONMENT_IS_PTHREAD === 'undefined' || !ENVIRONMENT_IS_PTHREAD ||
      (typeof globalThis.__8bitgoRangeBrokerPort !== 'object' && typeof globalThis.SharedWorker !== 'function' && typeof globalThis.Worker !== 'function') ||
      typeof globalThis.SharedArrayBuffer !== 'function' ||
      typeof Atomics.wait !== 'function'
    ) return
    try {
      const workerUrl = new URL('range-prefetch-worker.js', location.href)
      const prefetchAllowed = readAheadPolicy().concurrency > 0
      if (globalThis.__8bitgoRangeBrokerPort && typeof globalThis.__8bitgoRangeBrokerPort.postMessage === 'function') {
        // 页内专用 Broker 通过 Emscripten pthread 的启动消息分发 MessagePort；直接共享 SAB，避免跨代理复制分片。
        prefetchWorker = globalThis.__8bitgoRangeBrokerPort
        prefetchWorkerIsShared = true
      } else if (typeof globalThis.SharedWorker === 'function') {
        try {
          const worker = new SharedWorker(workerUrl, { name: '8bitgo-ppsspp-range-v1' })
          prefetchWorker = worker.port
          prefetchWorkerIsShared = true
        } catch {
          // 部分浏览器暴露构造器却不允许在 pthread 内创建 SharedWorker。
          if (!prefetchAllowed) {
            prefetchWorkerFailed = true
            return
          }
          prefetchWorker = new Worker(workerUrl)
        }
      } else if (prefetchAllowed) {
        prefetchWorker = new Worker(workerUrl)
      } else {
        return
      }
      const port = prefetchWorker
      port.onmessage = ({ data }) => {
        if (data?.type === 'ready') {
          prefetchWorkerReady = true
          console.info(`[ppsspp] ${prefetchWorkerIsShared ? '共享' : '独立'} Range 预读 Worker 已就绪`)
          pump()
        } else if (data?.type === 'done') {
          const entry = inflight.get(data.key)
          // 取消后同一块可能立刻重新排队；旧消息绝不能结算新请求。
          if (entry?.shared && entry.id === data.id) entry.complete()
        }
      }
      port.onerror = () => {
        console.warn('[ppsspp] Range 预读 Worker 不可用，回退到原有预读方式')
        prefetchWorkerFailed = true
        prefetchWorkerReady = false
        for (const entry of [...inflight.values()]) {
          if (!entry.shared) continue
          Atomics.store(entry.state, 0, 2)
          Atomics.notify(entry.state, 0)
          entry.complete()
        }
        for (const state of sharedDemandStates.values()) {
          Atomics.store(state, 0, 2)
          Atomics.notify(state, 0)
        }
        try {
          if (prefetchWorkerIsShared) port.close()
          else port.terminate()
        } catch { /* 错误处理不能改变正式读盘回退。 */ }
        prefetchWorker = null
      }
      port.start?.()
      if (prefetchWorkerIsShared) port.postMessage({ type: 'ping', id: `ready:${sharedOwnerId}` })
    } catch {
      console.warn('[ppsspp] 无法启动 Range 预读 Worker，回退到原有预读方式')
      prefetchWorkerFailed = true
    }
  }

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
  /*
   * 带 `romv=<ETag>` 的播放地址已经把镜像代次钉死在 URL 里：R2 Worker 每次 Range 都拿它比对
   * 当前 ETag，不一致回 412；浏览器 HTTP 缓存也按完整 URL 存，换版就是另一个缓存键。
   *
   * 这种地址**不能再发 If-Match / If-Unmodified-Since**：Chromium 的 HTTP 缓存对带这两个头的
   * 请求直接绕过缓存（kPassThroughHeaders）。2026-11-04《GT 赛车》实测同一个已缓存的 2MB 分片，
   * 带 If-Match 每次 2.4 秒走网络，去掉后 15 毫秒从磁盘缓存返回 —— 以前每次进游戏、每次进选车
   * 都要把读过的块重新下载一遍。响应里的 ETag 仍照常交给 C++ 校验（缓存里存的也是同一个 ETag），
   * 校验语义不变；没有 romv 的外链继续带条件头。
   */
  const versionPinned = (url) => /[?&]romv=[^&#]+/.test(String(url || ''))
  const validatorHeader = (name) => {
    const lower = String(name).toLowerCase()
    return lower === 'if-match' || lower === 'if-unmodified-since'
  }

  const readAheadPolicy = () => {
    const connection = globalThis.navigator?.connection
    if (connection?.saveData) return { depth: 0, concurrency: 0, cacheBytes: 0 }
    const type = String(connection?.effectiveType || '').toLowerCase()
    if (type === 'slow-2g' || type === '2g') return { depth: 0, concurrency: 0, cacheBytes: 0 }

    const hasNetworkEstimate = ['slow-2g', '2g', '3g', '4g'].includes(type) ||
      (Number.isFinite(Number(connection?.downlink)) && Number(connection?.downlink) > 0)
    if (!hasNetworkEstimate && measuredMbps <= 0) {
      // 不支持 Network Information API 的手机不能按桌面宽带并发预读；先让正式读盘建立样本。
      return { depth: 0, concurrency: 0, cacheBytes: 0 }
    }
    const mobileInput = Number(globalThis.navigator?.maxTouchPoints) > 0 ||
      /Android|iPhone|iPad|iPod|Mobile/i.test(String(globalThis.navigator?.userAgent || ''))
    if (mobileInput) {
      // 手机的测速常把拥塞线路报成 4G；先用单路，取到实测样本后最多扩为两路，给游戏留带宽。
      if (measuredMbps < 2) return { depth: 1, concurrency: 1, cacheBytes: BLOCK_BYTES }
      return { depth: 4, concurrency: 2, cacheBytes: 8 * 1024 * 1024 }
    }
    if (measuredMbps > 0 && measuredMbps < 1) {
      // 一兆以下的链路只保留一块滚动预读；随机寻道取消它时，不让多路投机流浪费弱网带宽。
      return { depth: 1, concurrency: 1, cacheBytes: BLOCK_BYTES }
    }
    if (!hasNetworkEstimate && measuredMbps < 3) {
      // 无网络测速 API 时，中等速度也只开一条小窗口，避免把桌面核数误当成链路能力。
      return { depth: 2, concurrency: 1, cacheBytes: 2 * BLOCK_BYTES }
    }

    const cores = Math.max(1, Number(globalThis.navigator?.hardwareConcurrency) || 4)
    const memory = Math.max(0, Number(globalThis.navigator?.deviceMemory) || 0)
    const constrained = cores <= 2 || (memory > 0 && memory <= 2)
    const balanced = cores <= 4 || (memory > 0 && memory <= 4)
    // CHD 可在两个 pthread 上交错随机寻道；投机块若一直没被正式读盘使用，多路预读
    // 只会挤占慢链路。按真实需求命中率收缩，并保留一条探测流以便顺序阶段自动恢复。
    const lowHitRate = assessedDemandBlocks >= 4 && assessedHits * 4 < assessedDemandBlocks
    if (sequentialDemandRun === 0 || (lowHitRate && sequentialDemandRun < 3)) {
      return { depth: 2, concurrency: 1, cacheBytes: 4 * 1024 * 1024 }
    }
    if (lowHitRate) {
      // 单路预读追不上连续读盘时，命中率会一直低，旧策略因此永久锁在单路小窗。
      // 连续四块证明当前确实是顺序阶段；只恢复到双路，下一次随机寻道仍立刻收回。
      return {
        depth: constrained ? 4 : 6,
        concurrency: 2,
        cacheBytes: constrained ? 8 * 1024 * 1024 : 12 * 1024 * 1024,
      }
    }
    if (constrained) return { depth: 4, concurrency: 2, cacheBytes: 8 * 1024 * 1024 }

    let depth = type === '3g' ? 4 : balanced ? 6 : 8
    let concurrency = type === '3g' ? 2 : balanced ? 3 : 4
    /*
     * 单路实测速率低或正式读盘曾追上预读，都说明两块窗口装不下链路抖动。扩的是“提前量”，
     * 不是 C++ 的 2 MiB 真实读取块；因此不会改变 CHD 偏移、校验器或最终文件内容。
     */
    if (measuredMbps > 0 && measuredMbps < 6) {
      depth = Math.max(depth, 8)
      concurrency = Math.max(concurrency, type === '3g' ? 3 : 4)
    }
    depth = Math.min(MAX_DEPTH, depth + pressureLevel * 2)
    concurrency = Math.min(MAX_CONCURRENCY, concurrency + pressureLevel)
    const cacheBytes = Math.min(MAX_CACHE_BYTES, Math.max(8 * 1024 * 1024, depth * BLOCK_BYTES))
    return { depth, concurrency, cacheBytes }
  }

  /**
   * 一块 2 MiB 在 0.2 Mbps 上就要约 84 秒。固定 20/30 秒会不断丢弃已收字节并从头重拉，
   * 所以 Range 时限按浏览器下行估计与本局实测吞吐放宽；上限仍有限，防止断线无限等。
   */
  const rangeTimeoutMs = (bytes) => {
    const connection = globalThis.navigator?.connection
    const effectiveType = String(connection?.effectiveType || '').toLowerCase()
    const fallbackMbps = {
      'slow-2g': 0.1,
      '2g': 0.2,
      '3g': 0.5,
      '4g': 4,
    }[effectiveType] || 0.1
    const candidates = [Number(connection?.downlink), measuredMbps]
      .filter((value) => Number.isFinite(value) && value > 0)
    const mbps = candidates.length ? Math.min(...candidates) : fallbackMbps
    if (!mbps) return MIN_RANGE_TIMEOUT_MS
    const expectedMs = Math.max(0, bytes) * 8 / (mbps * 1_000_000) * 1000
    const estimate = Math.max(MIN_RANGE_TIMEOUT_MS, Math.ceil(expectedMs * 1.5 + 10_000))
    // Worker 上的 downlink 可能仍报 4G 高速，但实际链路已被节流或跨洲拥塞；首块没实测前留出启动余量。
    const timeout = measuredMbps > 0
      ? Math.max(estimate, measuredMbps < 1 ? MEASURED_SLOW_RANGE_TIMEOUT_MS : MIN_RANGE_TIMEOUT_MS)
      : Math.max(estimate, UNMEASURED_RANGE_TIMEOUT_MS)
    return Math.min(MAX_RANGE_TIMEOUT_MS, timeout)
  }

  /** 正式读盘也贡献吞吐样本；Safari 等没有 Network Information API 的浏览器靠实测更新后续时限。 */
  const recordTransferRate = (bytes, durationMs) => {
    if (!Number.isFinite(bytes) || bytes <= 0 || !Number.isFinite(durationMs) || durationMs <= 0) return
    const sampleMbps = bytes * 8 / durationMs / 1000
    measuredMbps = measuredMbps > 0 ? measuredMbps * 0.7 + sampleMbps * 0.3 : sampleMbps
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
    const { cacheBytes } = readAheadPolicy()
    for (const oldest of cache.keys()) {
      if (cachedBytes <= cacheBytes) break
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

  const startSharedPrefetch = (key, job) => {
    if (!prefetchWorkerReady || !prefetchWorker) return false
    const length = job.end - job.start + 1
    try {
      const bytes = new SharedArrayBuffer(length)
      const state = new Int32Array(new SharedArrayBuffer(8))
      const id = `${sharedOwnerId}:${++sharedJobId}`
      const startedAt = Date.now()
      const timeoutMs = rangeTimeoutMs(length)
      let settled = false
      const finish = () => {
        if (settled) return
        settled = true
        if (inflight.get(key)?.id === id) {
          inflight.delete(key)
          activePrefetches = Math.max(0, activePrefetches - 1)
        }
        if (Atomics.load(state, 0) === 1) {
          const ifMatch = header(job.headers, 'if-match')
          const ifUnmodifiedSince = header(job.headers, 'if-unmodified-since')
          const rawHeaders = `content-range: bytes ${job.start}-${job.end}/${job.total}\r\n` +
            (ifMatch ? `etag: ${ifMatch}\r\n` : '') +
            (ifUnmodifiedSince ? `last-modified: ${ifUnmodifiedSince}\r\n` : '')
          const response = new Uint8Array(bytes).slice().buffer
          prefetchedBytes += response.byteLength
          recordTransferRate(response.byteLength, Date.now() - startedAt)
          store(key, { response, rawHeaders, responseURL: job.url, statusText: 'Partial Content' })
        }
        if (!cancellingPrefetches) pump()
      }
      const cancel = () => {
        if (settled) return
        settled = true
        if (inflight.get(key)?.id === id) {
          inflight.delete(key)
          activePrefetches = Math.max(0, activePrefetches - 1)
        }
        try { prefetchWorker?.postMessage({ type: 'cancel', id }) } catch { /* 正式读盘会接管。 */ }
      }
      const entry = { shared: true, id, state, startedAt, timeoutMs, headers: job.headers, complete: finish, cancel }
      inflight.set(key, entry)
      activePrefetches++
      prefetchWorker.postMessage({
        type: 'fetch', id, key, dedupeKey: key, url: job.url, start: job.start, end: job.end, total: job.total,
        timeoutMs,
        ifMatch: header(job.headers, 'if-match'),
        ifUnmodifiedSince: header(job.headers, 'if-unmodified-since'),
        // 校验器仍用来核对响应头；只是不放进请求，免得绕过浏览器 HTTP 缓存
        sendValidators: !versionPinned(job.url),
        bytes, state: state.buffer,
      })
      return true
    } catch {
      const entry = inflight.get(key)
      if (entry?.shared) entry.cancel()
      return false
    }
  }

  const startPrefetch = (key, job) => {
    if (startSharedPrefetch(key, job)) return
    const xhr = new NativeXMLHttpRequest()
    const startedAt = Date.now()
    let settled = false
    let receivedBytes = 0
    const finish = () => {
      // 某些浏览器在 abort 后还会补发 error/loadend；只允许第一次回调释放并发槽位。
      if (settled) return
      settled = true
      if (inflight.delete(key)) activePrefetches = Math.max(0, activePrefetches - 1)
      if (receivedBytes > 0) {
        recordTransferRate(receivedBytes, Date.now() - startedAt)
      }
      if (!cancellingPrefetches) pump()
    }
    const cancel = () => {
      if (settled) return
      // 先封住回调再 abort。否则同步触发的 onabort 会在正式读盘接管前重新占满两条连接。
      settled = true
      if (inflight.delete(key)) activePrefetches = Math.max(0, activePrefetches - 1)
      try {
        xhr.abort()
      } catch {
        // 正式读盘会接管同一块，取消预读失败不应改变核心的错误语义。
      }
    }
    inflight.set(key, { xhr, cancel })
    activePrefetches++
    xhr.open('GET', job.url, true)
    xhr.responseType = 'arraybuffer'
    xhr.timeout = rangeTimeoutMs(job.end - job.start + 1)
    xhr.setRequestHeader('Range', `bytes=${job.start}-${job.end}`)
    xhr.setRequestHeader('Accept', 'application/octet-stream')
    const ifMatch = header(job.headers, 'if-match')
    const ifUnmodifiedSince = header(job.headers, 'if-unmodified-since')
    // 钉了代次的地址不发条件头，好让浏览器 HTTP 缓存接住（见 versionPinned）
    if (!versionPinned(job.url)) {
      if (ifMatch) xhr.setRequestHeader('If-Match', ifMatch)
      if (ifUnmodifiedSince) xhr.setRequestHeader('If-Unmodified-Since', ifUnmodifiedSince)
    }
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
          receivedBytes = response.byteLength
          prefetchedBytes += response.byteLength
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

  const pump = () => {
    const { concurrency } = readAheadPolicy()
    while (!cancellingPrefetches && activePrefetches < concurrency && queued.size > 0) {
      const [key, job] = queued.entries().next().value
      queued.delete(key)
      startPrefetch(key, job)
    }
  }

  const cancelQueuedAndInflight = () => {
    cancellingPrefetches = true
    queued.clear()
    for (const entry of [...inflight.values()]) entry.cancel()
    inflight.clear()
    activePrefetches = 0
    cancellingPrefetches = false
  }

  const beforeDemand = (url, requestHeaders) => {
    const requested = rangeOf(header(requestHeaders, 'range'))
    if (!requested || requested.start % BLOCK_BYTES !== 0 || requested.end - requested.start + 1 > BLOCK_BYTES) return null
    if (requested.end - requested.start + 1 === BLOCK_BYTES) {
      sequentialDemandRun = lastDemand?.url === url && requested.start === lastDemand.start + BLOCK_BYTES
        ? sequentialDemandRun + 1 : 0
      assessedDemandBlocks++
      if (assessedDemandBlocks >= 32) {
        assessedDemandBlocks = Math.ceil(assessedDemandBlocks / 2)
        assessedHits = Math.ceil(assessedHits / 2)
      }
    }
    const key = cacheKey(url, requested.start, requested.end)
    const exactPrefetch = inflight.get(key)
    const exactQueued = queued.has(key)
    if (
      exactPrefetch?.shared &&
      header(exactPrefetch.headers, 'if-match') === header(requestHeaders, 'if-match') &&
      header(exactPrefetch.headers, 'if-unmodified-since') === header(requestHeaders, 'if-unmodified-since')
    ) {
      // 当前正式读盘正等这块时，其余投机连接会与它争夺 CDN/用户带宽。只保留命中的
      // SharedArrayBuffer 请求，先取消别的预读；否则核心虽然能等到它，仍可能被另三路
      // 无用的预读拖出数秒卡顿。等完以后再围绕新位置建窗口。
      queued.clear()
      cancellingPrefetches = true
      for (const [otherKey, entry] of [...inflight]) {
        if (otherKey !== key) entry.cancel()
      }
      cancellingPrefetches = false
      // 模拟线程正被同步读盘阻塞时，它自己的 onmessage 也无法执行；独立 Worker 用
      // SharedArrayBuffer 直接唤醒这里，避免取消已下载大半的预读后再取一遍同一块。
      const remaining = Math.max(0, exactPrefetch.timeoutMs - (Date.now() - exactPrefetch.startedAt))
      if (Atomics.load(exactPrefetch.state, 0) === 0 && remaining > 0) {
        sharedPrefetchWaits++
        const began = Date.now()
        Atomics.wait(exactPrefetch.state, 0, 0, remaining)
        sharedPrefetchWaitMs += Date.now() - began
      }
      if (Atomics.load(exactPrefetch.state, 0) === 1) exactPrefetch.complete()
    }
    if ((exactPrefetch && !cache.has(key)) || exactQueued) {
      // 正式读取不能和投机请求争抢带宽。核心追上进行中或排队中的预读时全部取消，
      // 由同步请求立即接管；成功后再围绕新的读取位置重建窗口，避免慢预读继续堵住模拟线程。
      demandTakeovers++
      pressureLevel = Math.min(2, pressureLevel + 1)
      stableHits = 0
      cancelQueuedAndInflight()
    }
    queued.delete(key)

    if (lastDemand && (lastDemand.url !== url || requested.start !== lastDemand.start + BLOCK_BYTES)) {
      cancelQueuedAndInflight()
    }
    return requested
  }

  const afterDemand = (xhr, requested, startedAt) => {
    if (xhr.status !== 206) return
    const actual = contentRangeOf(responseHeader(xhr.getAllResponseHeaders(), 'content-range'))
    if (actual && xhr.url_) {
      xhr._knownTotal = actual.total
      discTotals.set(xhr.url_, actual.total)
      while (discTotals.size > 16) discTotals.delete(discTotals.keys().next().value)
    }
    if (!requested || !(xhr.response instanceof ArrayBuffer)) return
    if (
      !actual ||
      actual.start !== requested.start ||
      actual.end !== requested.end ||
      xhr.response.byteLength !== requested.end - requested.start + 1
    ) return

    // Prepare() 的 0-0 探测只负责取得盘大小和校验器；从真正的对齐块开始预读。
    const length = requested.end - requested.start + 1
    if (requested.start % BLOCK_BYTES !== 0 || (length !== BLOCK_BYTES && requested.end + 1 !== actual.total)) return

    // 只记录真实盘块；1 字节探测和任意非对齐读取不能代表持续读盘吞吐。
    if (Number.isFinite(startedAt)) recordTransferRate(xhr.response.byteLength, Date.now() - startedAt)
    lastDemand = { url: xhr.url_, start: requested.start }

    const { depth } = readAheadPolicy()
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

  /** 多个模拟线程同时首次读同一片时，共享同一份网络响应与各自的同步结果缓冲。 */
  const sharedDemand = (xhr, requested) => {
    // 首次 Range 探测的同步 XHR 会阻塞当前线程，Broker 的 ready 消息可能要到本次调用栈结束后才派发；
    // 只要共享通道已创建就先投递正式请求，由 SAB 的接手状态确认 Broker 是否在途可用。
    if (!prefetchWorkerIsShared || !prefetchWorker || xhr._responseType !== 'arraybuffer') return false
    const length = requested.end - requested.start + 1
    const total = Number(xhr._knownTotal) || discTotals.get(xhr.url_)
    if (!Number.isSafeInteger(total) || total <= requested.end) return false
    const key = cacheKey(xhr.url_, requested.start, requested.end)
    const bytes = new SharedArrayBuffer(length)
    // 前两个整数给状态与共享命中数；剩余区域由 Worker 同步返回 ETag / Last-Modified。
    const stateBuffer = new SharedArrayBuffer(1024)
    const state = new Int32Array(stateBuffer)
    const id = `${sharedOwnerId}:${++sharedJobId}`
    const timeoutMs = Math.max(rangeTimeoutMs(length), xhr._timeout || 0)
    const ifMatch = header(xhr.__8bitgoHeaders, 'if-match')
    const ifUnmodifiedSince = header(xhr.__8bitgoHeaders, 'if-unmodified-since')
    const startedAt = Date.now()
    sharedDemandStates.set(id, state)
    try {
      prefetchWorker.postMessage({
        type: 'fetch', id, key, dedupeKey: key, url: xhr.url_,
        start: requested.start, end: requested.end,
        total,
        timeoutMs, ifMatch, ifUnmodifiedSince,
        sendValidators: !versionPinned(xhr.url_),
        bytes, state: stateBuffer,
      })
      const waitMs = Math.min(MAX_RANGE_TIMEOUT_MS + 1_000, timeoutMs + 1_000)
      const deadline = Date.now() + waitMs
      // Worker 先写 -1 表示已接手。若代理意外退出且没人确认，本次最多等 1 秒就回退原生 XHR。
      let status = Atomics.load(state, 0)
      if (status === 0) Atomics.wait(state, 0, 0, Math.min(1_000, waitMs))
      status = Atomics.load(state, 0)
      if (status === 0) {
        try { prefetchWorker.postMessage({ type: 'cancel', id }) } catch { /* 同步 XHR 会接手请求。 */ }
        return false
      }
      if (status === -1) Atomics.wait(state, 0, -1, Math.max(0, deadline - Date.now()))
      if (Atomics.load(state, 0) !== 1) {
        try { prefetchWorker.postMessage({ type: 'cancel', id }) } catch { /* 同步 XHR 会接手请求。 */ }
        return false
      }
      // Chromium 的 TextDecoder 不接受 SharedArrayBuffer 视图；响应头很短，先复制到普通缓冲区再解码。
      const metadata = new TextDecoder().decode(new Uint8Array(stateBuffer, 8).slice()).split('\0', 1)[0]
      const fallbackHeaders = `content-range: bytes ${requested.start}-${requested.end}/${total}\r\n` +
        (ifMatch ? `etag: ${ifMatch}\r\n` : '') +
        (ifUnmodifiedSince ? `last-modified: ${ifUnmodifiedSince}\r\n` : '')
      xhr._fake = {
        response: new Uint8Array(bytes).slice().buffer,
        rawHeaders: metadata || fallbackHeaders,
        responseURL: xhr.url_,
        statusText: 'Partial Content',
      }
      sharedDemandRequests++
      if (Atomics.load(state, 1) > 0) sharedDemandJoins++
      afterDemand(xhr, requested, startedAt)
      xhr.onreadystatechange?.({ target: xhr })
      xhr.onload?.({ target: xhr })
      return true
    } catch {
      try { prefetchWorker.postMessage({ type: 'cancel', id }) } catch { /* 同步 XHR 会接手请求。 */ }
      return false
    } finally {
      sharedDemandStates.delete(id)
    }
  }

  class RangeWarmXMLHttpRequest {
    constructor() {
      this._inner = new NativeXMLHttpRequest()
      this._fake = null
      this._async = true
      this.__8bitgoHeaders = new Map()
      this.url_ = ''
      this._streamData = false
      // 重试要原样重建请求，这些都得记下来
      this._openArgs = null
      this._sentHeaders = []
      this._mime = null
      this._responseType = ''
      this._timeout = 0
      this._withCredentials = false
    }

    open(method, url, async = true, username, password) {
      this._method = String(method || 'GET').toUpperCase()
      this._async = async !== false
      this.url_ = String(url)
      this._activeRouteUrl = this.url_
      this._openArgs = [method, url, async, username, password]
      this._inner.open(method, url, async, username, password)
    }

    setRequestHeader(name, value) {
      this.__8bitgoHeaders.set(String(name).toLowerCase(), String(value))
      // 记下来给预读比对用，但钉了代次的地址不真的发出去（见 versionPinned）
      if (validatorHeader(name) && versionPinned(this.url_)) return
      this._sentHeaders.push([name, value])
      this._inner.setRequestHeader(name, value)
    }

    overrideMimeType(value) {
      this._mime = value
      this._inner.overrideMimeType(value)
    }

    /** 换一个全新的原生 XHR，按原样重放 open / 头 / 属性（失败过的 XHR 不能再 send） */
    _reopen() {
      const inner = new NativeXMLHttpRequest()
      const openArgs = [...this._openArgs]
      if (this._activeRouteUrl) openArgs[1] = this._activeRouteUrl
      inner.open(...openArgs)
      if (this._responseType) inner.responseType = this._responseType
      if (this._timeout) inner.timeout = this._timeout
      if (this._withCredentials) inner.withCredentials = true
      if (this._mime) inner.overrideMimeType(this._mime)
      for (const [name, value] of this._sentHeaders) inner.setRequestHeader(name, value)
      this._inner = inner
    }

    /** 同步 Range 读：网络层失败（status 0）就地退避重试，见 SYNC_RETRY_DELAYS_MS */
    _sendSyncWithRetry(data, requested) {
      const startedAt = Date.now()
      let lastTimedOut = false
      const configuredRoutes = Array.isArray(globalThis.__8bitgoPspRangeUrls)
        ? globalThis.__8bitgoPspRangeUrls.filter((url) => typeof url === 'string' && /^https?:\/\//i.test(url))
        : []
      const routes = [...new Set([this.url_, ...configuredRoutes])]
      let routeIndex = Math.max(0, routes.indexOf(this._activeRouteUrl || this.url_))
      for (let attempt = 0; ; attempt++) {
        const budget = lastTimedOut ? SYNC_TIMEOUT_BUDGET_MS : SYNC_RETRY_BUDGET_MS
        const final = attempt >= SYNC_RETRY_DELAYS_MS.length || Date.now() - startedAt > budget
        const inner = this._inner
        let failed = false
        let timedOut = false
        inner.onload = (event) => {
          if (!final && inner.status === 0) { failed = true; return }
          if (attempt > 0) syncRecovered++
          afterDemand(this, requested, sentAt)
          this.onload?.(event)
        }
        inner.onerror = (event) => { if (final) this.onerror?.(event); else failed = true }
        inner.ontimeout = (event) => { if (final) this.ontimeout?.(event); else failed = timedOut = true }
        inner.onprogress = (event) => this.onprogress?.(event)
        inner.onreadystatechange = (event) => {
          // 要重试的那次失败不让 Emscripten 看到 readyState 4 + status 0
          if (!final && inner.readyState === 4 && inner.status === 0) return
          this.onreadystatechange?.(event)
        }
        const sentAt = Date.now()
        try {
          inner.send(data)
        } catch (error) {
          if (final) throw error
          failed = true
          // 同步 XHR 超时多数浏览器是抛 TimeoutError，不一定触发 ontimeout
          timedOut = error?.name === 'TimeoutError' || (this._timeout > 0 && Date.now() - sentAt >= this._timeout - 50)
        }
        if (final || (!failed && inner.status !== 0)) return
        syncRetries++
        lastTimedOut = timedOut
        if (timedOut) {
          syncTimeouts++
          this._timeout = Math.min(Math.max(this._timeout || 30_000, 30_000) * 2, SYNC_TIMEOUT_MAX_MS)
        }
        if (routes.length > 1) {
          const failedRoute = this._activeRouteUrl || this.url_
          routeIndex = (routeIndex + 1) % routes.length
          this._activeRouteUrl = routes[routeIndex]
          console.warn(`[ppsspp] Range 线路失败，尝试备用源：${failedRoute} → ${this._activeRouteUrl}`)
        }
        console.warn(`[ppsspp] Range ${this.__8bitgoHeaders.get('range') || ''} ${timedOut ? '超时' : '网络失败'}，${SYNC_RETRY_DELAYS_MS[attempt]}ms 后第 ${attempt + 1} 次重试${timedOut ? `（时限放宽到 ${this._timeout / 1000} 秒）` : ''}`)
        sleepSync(SYNC_RETRY_DELAYS_MS[attempt])
        this._reopen()
      }
    }

    send(data) {
      const requested = !this._async && this._method === 'GET'
        ? beforeDemand(this.url_, this.__8bitgoHeaders)
        : null
      if (requested) {
        this._timeout = Math.max(this._timeout || 0, rangeTimeoutMs(requested.end - requested.start + 1))
        this._inner.timeout = this._timeout
      }
      if (requested) {
        const key = cacheKey(this.url_, requested.start, requested.end)
        const entry = cache.get(key)
        if (entry && validatorMatches(entry, this.__8bitgoHeaders)) {
          prefetchHits++
          assessedHits++
          stableHits++
          // 连续命中说明滚动窗口已经足够；缓慢收回压力档，避免一次旧抖动让整局永久保持最大投机量。
          if (stableHits >= 12 && pressureLevel > 0) {
            pressureLevel--
            stableHits = 0
          }
          this._fake = dropCacheEntry(key)
          afterDemand(this, requested)
          this.onreadystatechange?.({ target: this })
          this.onload?.({ target: this })
          return
        }
        if (entry) {
          dropCacheEntry(key)
          // 校验器已变化时，旁边的投机请求也属于旧对象代次；继续让它们占连接既无用又会拖慢
          // 当前同步读取。全部中止后由带新 If-Match 的正式响应重建窗口。
          cancelQueuedAndInflight()
        }
      }
      // SharedWorker 中的在途请求按 URL/Range/校验器合并；并发 pthread 读同一块只传一份。
      if (requested && sharedDemand(this, requested)) return

      if (!this._async && this._method === 'GET' && this.__8bitgoHeaders.has('range') && this._openArgs) {
        this._sendSyncWithRetry(data, requested)
        return
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
    set responseType(value) { this._responseType = value; this._inner.responseType = value }
    get timeout() { return this._inner.timeout }
    set timeout(value) { this._timeout = value; this._inner.timeout = value }
    get withCredentials() { return this._inner.withCredentials }
    set withCredentials(value) { this._withCredentials = Boolean(value); this._inner.withCredentials = value }
  }

  globalThis.__8bitgoCreatePspRangeXhr = () => {
    // SaveData / 弱网只关投机预读；页面分发的 Broker 端口仍合并 pthread 正式读盘。
    if (readAheadPolicy().concurrency > 0 || globalThis.__8bitgoRangeBrokerPort || typeof globalThis.SharedWorker === 'function') initPrefetchWorker()
    return new RangeWarmXMLHttpRequest()
  }
  globalThis.__8bitgoPspRangeWarmStats = () => ({
    cachedBlocks: cache.size,
    cachedBytes,
    queuedBlocks: queued.size,
    inflightBlocks: inflight.size,
    ...readAheadPolicy(),
    activePrefetches,
    prefetchHits,
    demandTakeovers,
    prefetchedBytes,
    pressureLevel,
    measuredMbps: Math.round(measuredMbps * 100) / 100,
    rangeTimeoutMs: rangeTimeoutMs(BLOCK_BYTES),
    sharedPrefetchReady: prefetchWorkerReady,
    sharedPrefetchWaits,
    sharedPrefetchWaitMs,
    sharedDemandRequests,
    sharedDemandJoins,
    assessedDemandBlocks,
    assessedHits,
    sequentialDemandRun,
    syncRetries,
    syncRecovered,
    syncTimeouts,
  })
})()
/* 8BITGO_PSP_RANGE_READ_AHEAD_END */
