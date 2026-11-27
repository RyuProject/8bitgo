// 从管理页的真实调用入口测试：200 HTML、错大小和清理失败都不能伪装成成功。
import assert from 'node:assert/strict'

const storage = () => {
  const values = new Map()
  const writes = new Map()
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      writes.set(key, (writes.get(key) ?? 0) + 1)
      values.set(key, String(value))
    },
    removeItem: (key) => values.delete(key),
    writeCount: (key) => writes.get(key) ?? 0,
  }
}
globalThis.localStorage = storage()
globalThis.sessionStorage = storage()
globalThis.__viteEnv = { VITE_API_URL: 'same-origin' }
globalThis.localStorage.setItem('8bitgo.rom.api', 'https://w.test')
globalThis.localStorage.setItem('8bitgo.rom.base', 'https://assets.test')
globalThis.sessionStorage.setItem('8bitgo.rom.token', 'test-token')
// Sockdrive 轮询的退避不应让离线回归真的等十几秒；这里仍保留异步边界，能抓同步递归。
const windowListeners = new Map()
globalThis.window = {
  setInterval,
  clearInterval,
  setTimeout: (fn) => { queueMicrotask(fn); return 1 },
  clearTimeout,
  addEventListener: (type, listener) => {
    const listeners = windowListeners.get(type) ?? new Set()
    listeners.add(listener)
    windowListeners.set(type, listeners)
  },
  dispatchEvent: (event) => {
    for (const listener of windowListeners.get(event.type) ?? []) listener(event)
    return true
  },
}

let xhrResponse = () => ({ status: 200, body: '<html>wrong endpoint</html>' })
let xhrNeverCompletes = false
let xhrSendOverride = null
globalThis.XMLHttpRequest = class {
  upload = {}
  headers = {}
  status = 0
  responseText = ''
  open(method, url) { this.method = method; this.url = url }
  setRequestHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value) }
  send(blob) {
    if (xhrSendOverride) return xhrSendOverride(this, blob)
    if (xhrNeverCompletes) return
    queueMicrotask(() => {
      if (!String(this.url).includes('uploadId=') && blob?.size > 0) {
        this.upload.onprogress?.({ lengthComputable: true, loaded: blob.size, total: blob.size })
        this.upload.onload?.()
      }
      const result = xhrResponse(this, blob)
      if (result.error) {
        this.onerror?.()
        return
      }
      this.status = result.status
      this.responseText = result.body
      this.onload?.()
    })
  }
  abort() { this.onabort?.() }
}

const { uploadRom, deleteRomDir, deleteRomObjectsExactly, headRom, listRomObjects } = await import('../src/services/roms.ts')
const { adaptiveUploadConcurrency, preferredUploadConcurrency, warmUploadSampleBytes, PART_SIZE, uploadRomMultipart, listOrphanUploads, abortOrphanUpload, listPendingUploads, MultipartUploadGate, UploadTransferPool, askJson } = await import('../src/services/romMultipart.ts')
const { fingerprintRomPart, fingerprintRomUploadFile } = await import('../src/services/romFingerprint.ts')
const { createRomIntegrityWork } = await import('../src/services/romIntegrityData.ts')
const { matchesRomPackSource, romPackWorkerConcurrency } = await import('../src/services/romPack.ts')
const {
  clearPendingSockdriveCreation,
  createSockdriveConversion,
  preserveSockdriveSourceAfterCreateError,
  rememberPendingSockdriveCreation,
  rememberedPendingSockdriveCreation,
  waitForSockdriveConversion,
} = await import('../src/services/sockdriveConversion.ts')
const { ApiError } = await import('../src/services/api.ts')

// 两条 HTTP/2 PUT 同时被 reset 后，后续任务必须单路恢复；不能各自重试再制造一次连接级风暴。
{
  const gate = new MultipartUploadGate(2, 2)
  let rejectFirst
  let rejectSecond
  const first = gate.run(() => new Promise((_resolve, reject) => { rejectFirst = reject }))
  const second = gate.run(() => new Promise((_resolve, reject) => { rejectSecond = reject }))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(gate.snapshot().active, 2)
  rejectFirst({ status: 0 })
  rejectSecond({ status: 0 })
  await Promise.allSettled([first, second])
  assert.equal(gate.snapshot().limit, 1)

  let releaseRecovery
  const recovery = gate.run(() => new Promise((resolve) => { releaseRecovery = resolve }))
  let laterStarted = false
  const later = gate.run(async () => { laterStarted = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(laterStarted, false, '网络错误后只能有一片进入新连接')
  releaseRecovery()
  await recovery
  await later
  assert.equal(gate.snapshot().limit, 1, '少量成功不能过早恢复并发')
}
console.log('✅ HTTP/2 连接级错误会把分片上传收敛到单路，避免并发重试风暴')

// 多盘组取消时，等待并发闸门的分片应立即离队，不要留着文件片和取消监听等前一请求结束。
{
  const gate = new MultipartUploadGate(1, 1)
  let releaseActive
  const active = gate.run(() => new Promise((resolve) => { releaseActive = resolve }))
  await new Promise((resolve) => setImmediate(resolve))
  const controller = new AbortController()
  let queuedStarted = false
  const queued = gate.run(async () => { queuedStarted = true }, 0, undefined, controller.signal)
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(gate.snapshot().waiting, 1)
  controller.abort()
  await assert.rejects(queued, /上传已取消/)
  assert.equal(gate.snapshot().active, 1, '取消排队任务不能改变在途任务计数')
  assert.equal(gate.snapshot().waiting, 0, '取消后应立即从并发队列移除')
  assert.equal(queuedStarted, false, '排队的 PUT 不得在取消后启动')
  releaseActive()
  await active
}
console.log('✅ 取消上传时会立即移除仍在并发闸门排队的分片')

// 多文件共享上传预算也必须响应取消，否则取消中的文件仍会等其他文件释放所有并发槽。
{
  const pool = new UploadTransferPool()
  const releaseActive = []
  const active = Array.from({ length: preferredUploadConcurrency() }, () => pool.run(
    () => new Promise((resolve) => { releaseActive.push(resolve) }),
  ))
  await new Promise((resolve) => setImmediate(resolve))
  const controller = new AbortController()
  let queuedStarted = false
  const queued = pool.run(async () => { queuedStarted = true }, controller.signal)
  await new Promise((resolve) => setImmediate(resolve))
  controller.abort()
  await assert.rejects(queued, /上传已取消/)
  for (const release of releaseActive) release()
  await Promise.all(active)
  assert.equal(queuedStarted, false, '取消的多盘上传不能在共享并发槽释放后突然启动')
}
console.log('✅ 取消多盘组时会立即从共享上传预算队列离队')

assert.equal(adaptiveUploadConcurrency(8 * 1024 * 1024, 2_000, { hardwareConcurrency: 8 }), 4)
assert.equal(adaptiveUploadConcurrency(8 * 1024 * 1024, 8_000, { hardwareConcurrency: 8 }), 3)
assert.equal(adaptiveUploadConcurrency(8 * 1024 * 1024, 30_000, { hardwareConcurrency: 8 }), 1)
assert.equal(adaptiveUploadConcurrency(8 * 1024 * 1024, 2_000, { effectiveType: '3g', hardwareConcurrency: 8 }), 4)
assert.equal(adaptiveUploadConcurrency(8 * 1024 * 1024, 8_000, { effectiveType: '3g', hardwareConcurrency: 8 }), 3)
assert.equal(adaptiveUploadConcurrency(0, 0, { effectiveType: '3g', downlinkMbps: 24, hardwareConcurrency: 8 }), 1)
assert.equal(adaptiveUploadConcurrency(0, 0, {}), 2, '没有网络样本时按两路基线启动，不假装已测到高速')
assert.equal(adaptiveUploadConcurrency(8 * 1024 * 1024, 2_000, { saveData: true, hardwareConcurrency: 8 }), 1)
assert.equal(adaptiveUploadConcurrency(8 * 1024 * 1024, 2_000, { deviceMemoryGb: 2, hardwareConcurrency: 8 }), 2)
assert.equal(preferredUploadConcurrency({ effectiveType: '3g', deviceMemoryGb: 8, hardwareConcurrency: 8 }), 4, '3G 标签不能压住实测上行可升到的路数')
assert.equal(preferredUploadConcurrency({}), 4, '浏览器隐藏硬件并发数时不能默认当成双核')
assert.equal(preferredUploadConcurrency({ hardwareConcurrency: 2 }), 2, '明确的双核设备仍保持低并发')
assert.equal(preferredUploadConcurrency({ deviceMemoryGb: 2 }), 2, '明确的低内存设备仍保持低并发')
assert.equal(preferredUploadConcurrency({ saveData: true }), 1, '省流量意图继续限制为单路')
console.log('✅ 首个真实分片会按实测上行速度、设备内存与省流量模式选择 1–4 路')

// 首片达到安全样本后可提前放行第二路；首片完整耗时若低于突发样本，必须修正最终并发目标。
{
  let now = 0
  const gate = new MultipartUploadGate(4, 1, () => now, { effectiveType: '3g', hardwareConcurrency: 8, deviceMemoryGb: 8 })
  let reportProgress
  let markUploadComplete
  let finishFirst
  const first = gate.run((report, markStarted, markComplete) => {
    markStarted()
    reportProgress = report
    markUploadComplete = markComplete
    return new Promise((resolve) => { finishFirst = resolve })
  }, PART_SIZE)
  await new Promise((resolve) => setImmediate(resolve))
  now = 200
  reportProgress(1024 * 1024)
  assert.equal(gate.snapshot().limit, 1, '样本还没持续 250 ms 时不能相信首段突发')
  now = 300
  reportProgress(1024 * 1024)
  assert.equal(gate.snapshot().calibrated, true, '达到 1 MiB 与最短观测时长后即可测上行')
  assert.equal(gate.snapshot().limit, 2, '测速首片未完成时最多试探第二路')
  assert.ok(gate.snapshot().measuredMbps > 20)

  let secondStarted = false
  let thirdStarted = false
  let finishSecond
  const second = gate.run(() => {
    secondStarted = true
    return new Promise((resolve) => { finishSecond = resolve })
  })
  const third = gate.run(async () => { thirdStarted = true })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(secondStarted, true, '首片仍在传输时可以启动下一片')
  assert.equal(thirdStarted, false, '更高并发须等测速首片成功')

  now = 4_300 // 请求体整片 / 4.3 s 约 15.6 Mbps。
  markUploadComplete()
  now = 9_000 // 模拟上行已结束后，R2 确认与响应回程又等了 4.7 秒。
  finishFirst()
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(thirdStarted, true, '首片完整吞吐仍允许三路时应放开第三路')
  assert.ok(gate.snapshot().measuredMbps >= 15 && gate.snapshot().measuredMbps < 16, '完整首片应覆盖早期突发样本')
  finishSecond()
  await Promise.all([first, second, third])
  assert.equal(gate.snapshot().limit, 3, '最终并发应按完整首片吞吐，而不是缓冲突发选择')
}
{
  let now = 0
  const gate = new MultipartUploadGate(4, 1, () => now, { hardwareConcurrency: 8, deviceMemoryGb: 8 })
  let reportProgress
  let markUploadComplete
  let finishFirst
  const first = gate.run((report, _markStarted, markComplete) => {
    reportProgress = report
    markUploadComplete = markComplete
    return new Promise((resolve) => { finishFirst = resolve })
  }, PART_SIZE)
  await new Promise((resolve) => setImmediate(resolve))
  now = 2_000 // 初始 1 MiB 样本约 4.2 Mbps，暂定为两路。
  reportProgress(1024 * 1024)
  assert.equal(gate.snapshot().limit, 2)
  now = 30_000 // 完整首片只有约 2.2 Mbps，最终目标必须降回单路。
  finishFirst()
  await first
  assert.equal(gate.snapshot().limit, 1, '即使早期估算目标是两路，也必须用整片吞吐校正')
  assert.ok(gate.snapshot().measuredMbps < 3)
}
{
  let now = 0
  const gate = new MultipartUploadGate(4, 1, () => now, { hardwareConcurrency: 8, deviceMemoryGb: 8 })
  await gate.run(async (reportProgress) => {
    now = 30_000
    reportProgress(1024 * 1024)
    assert.equal(gate.snapshot().limit, 1, '慢上行样本不能提前增加并发')
  }, PART_SIZE)
  assert.equal(gate.snapshot().limit, 1)
}
{
  let now = 0
  const gate = new MultipartUploadGate(4, 1, () => now, { hardwareConcurrency: 8, deviceMemoryGb: 8 })
  let reportProgress
  let markUploadComplete
  let finishFirst
  const first = gate.run((report, _markStarted, markComplete) => {
    reportProgress = report
    markUploadComplete = markComplete
    return new Promise((resolve) => { finishFirst = resolve })
  }, PART_SIZE)
  await new Promise((resolve) => setImmediate(resolve))
  now = 300
  reportProgress(1024 * 1024)
  assert.equal(gate.snapshot().limit, 2)
  await assert.rejects(gate.run(async () => { throw { status: 503 } }))
  assert.equal(gate.snapshot().limit, 1, '试探并发遇到网关故障后立即收敛')
  now = 4_300
  markUploadComplete()
  now = 9_000
  finishFirst()
  await first
  assert.equal(gate.snapshot().limit, 1, '测速首片完成不能覆盖刚发生的故障降档')
  assert.ok(gate.snapshot().measuredMbps >= 15 && gate.snapshot().measuredMbps < 16, '同组分片故障后仍须用测速首片的完整上行耗时校正目标')
}
{
  let now = 0
  const gate = new MultipartUploadGate(4, 1, () => now, { hardwareConcurrency: 8, deviceMemoryGb: 8 })
  let reportProgress
  let rejectFirst
  const first = gate.run((report) => {
    reportProgress = report
    return new Promise((_resolve, reject) => { rejectFirst = reject })
  }, PART_SIZE)
  await new Promise((resolve) => setImmediate(resolve))
  now = 300
  reportProgress(1024 * 1024)
  assert.equal(gate.snapshot().limit, 2)
  rejectFirst({ status: 503 })
  await assert.rejects(first)
  assert.equal(gate.snapshot().calibrated, false, '测速首片失败后不能保留早期突发样本')

  await gate.run(async (_report, _markStarted, markComplete) => {
    now = 2_300
    markComplete()
    return 'recovered'
  }, PART_SIZE)
  assert.equal(gate.snapshot().calibrated, true)
  assert.ok(gate.snapshot().measuredMbps >= 33 && gate.snapshot().measuredMbps < 34, '重试成功时应重新建立完整上行样本')
  assert.equal(gate.snapshot().limit, 4, '重试样本可以恢复到真实吞吐支持的并发')
}
console.log('✅ ROM 分片在首片早期样本后保守启动并发，慢速与失败时仍收敛到单路')

// 验证真实分片路径也会把 XHR 进度送入并发闸：首片未完成时，第二片即可启动。
{
  const file = new File([new Uint8Array(2 * PART_SIZE + 1)], 'early-upload-sample.iso', { lastModified: 712 })
  const originalXHR = globalThis.XMLHttpRequest
  const originalFetch = globalThis.fetch
  let firstPartFinished = false
  let overlapObserved = false
  const startedParts = []
  const uploadedStages = []
  const hashStages = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('?uploads')) return Response.json({ uploadId: 'up-early-sample', marker: '_uploads/early-sample.marker', partNumberInHeader: true })
    if (target.includes('uploadId=up-early-sample') && init?.method === 'POST') {
      return Response.json({ ok: true, key: 'roms/ps2/early-upload-sample.iso', size: file.size })
    }
    throw new Error(`unexpected request: ${target}`)
  }
  globalThis.XMLHttpRequest = class {
    upload = {}
    headers = {}
    status = 0
    responseText = ''
    open(_method, _url) {}
    setRequestHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value) }
    getResponseHeader(name) {
      if (String(name).toLowerCase() !== 'server-timing') return null
      const part = Number(this.headers['x-8bg-part-number'])
      return `worker;dur=${part === 1 ? 1000 : 700}, edge;desc="MISS"`
    }
    send(blob) {
      this.upload.onloadstart?.()
      const part = Number(this.headers['x-8bg-part-number'])
      startedParts.push(part)
      const progress = (loaded) => this.upload.onprogress?.({ lengthComputable: true, loaded, total: blob.size })
      const finish = () => {
        this.upload.onload?.()
        this.status = 200
        this.responseText = JSON.stringify({ etag: `early-${part}` })
        this.onload?.()
      }
      if (part === 1) {
        setTimeout(() => progress(1024 * 1024), 300)
        setTimeout(() => {
          firstPartFinished = true
          progress(blob.size)
          finish()
        }, 550)
        return
      }
      if (!firstPartFinished) overlapObserved = true
      queueMicrotask(() => { progress(blob.size); finish() })
    }
    abort() { this.onabort?.() }
  }
  try {
    const result = await uploadRomMultipart(file, 'roms/ps2/early-upload-sample.iso', (_pct, stage) => {
      if (stage?.serverWaitMs !== undefined) uploadedStages.push({ ms: stage.serverWaitMs, samples: stage.serverWaitSamples })
      if (stage?.hashWaitMs !== undefined) hashStages.push({ ms: stage.hashWaitMs, samples: stage.hashWaitSamples })
    })
    assert.equal(result.size, file.size)
  } finally {
    globalThis.XMLHttpRequest = originalXHR
    globalThis.fetch = originalFetch
  }
  assert.equal(overlapObserved, true, '必须在第一片完成前启动至少一片后续分片')
  assert.deepEqual([...startedParts].sort((a, b) => a - b), [1, 2, 3])
  assert.equal(warmUploadSampleBytes('https://w.test', 4), 512 * 1024, '同一 Worker 的近期干净测速可减半观察量，但不直接放开并发')
  assert.equal(warmUploadSampleBytes('https://other-worker.test', 4), 1024 * 1024, '换 Worker 域名后不能复用旧线路速度')
  assert.equal(warmUploadSampleBytes('https://w.test', 4, Date.now() + 10 * 60 * 1000), 1024 * 1024, '测速过期后回到完整样本')
  assert.equal(warmUploadSampleBytes('https://w.test', 1), 1024 * 1024, '省流量或低性能设备继续走单路完整样本')
  const averageWaitMs = uploadedStages.at(-1)?.ms
  assert.ok(Number.isFinite(averageWaitMs) && averageWaitMs >= 0 && averageWaitMs <= 1000,
    '应按多个分片的 Worker Server-Timing 与真实上传体时长估算有界的平均确认等待')
  assert.equal(uploadedStages.at(-1)?.samples, 3, '应显示参与等待均值的已测分片数')
  assert.ok(hashStages.at(-1)?.ms >= 0, '应显示上传结束后本地摘要仍未完成的平均等待，即使摘要已提前完成')
  assert.equal(hashStages.at(-1)?.samples, 3, '应显示参与本地摘要等待均值的成功分片数')
}
console.log('✅ 实际上传链路在首片完成前启动后续分片，并正确合并校验对象大小')

// 分片上传把清单放进不可逆的 complete 请求；Worker 确认发布后客户端不再追加 POST。
{
  const key = 'roms/ps2/atomic-integrity-multipart.iso'
  const file = new File([new Uint8Array(PART_SIZE + 1)], 'atomic-integrity-multipart.iso', { lastModified: 7121 })
  const originalSlice = file.slice.bind(file)
  let fileReads = 0
  Object.defineProperty(file, 'slice', { value: (start, end, type) => {
    const blob = originalSlice(start, end, type)
    const read = blob.arrayBuffer.bind(blob)
    Object.defineProperty(blob, 'arrayBuffer', { value: () => { fileReads++; return read() } })
    return blob
  } })
  const integrityWork = createRomIntegrityWork(file, key)
  const originalFetch = globalThis.fetch
  const originalXHR = globalThis.XMLHttpRequest
  let completeBody
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('?uploads')) {
      const createBody = JSON.parse(init.body)
      assert.equal(createBody.integrityRequired, true)
      return Response.json({ uploadId: 'up-atomic-integrity', marker: '_uploads/atomic-integrity.marker',
        requestSignature: 'atomic-integrity-signature', partNumberInHeader: true })
    }
    if (target.includes('uploadId=up-atomic-integrity') && init?.method === 'POST') {
      completeBody = JSON.parse(init.body)
      const ledger = JSON.parse(globalThis.localStorage.getItem('8bitgo.rom.multipart') || '{}')
      assert.ok(ledger[key]?.parts.every((part) => part.contentHashVersion === 2),
        '新续传指纹必须复用完整性块摘要并记录独立算法版本')
      return Response.json({ ok: true, key, size: file.size, etag: 'atomic-multipart-v1', integrityPublished: true })
    }
    throw new Error(`unexpected request: ${target}`)
  }
  globalThis.XMLHttpRequest = class {
    upload = {}
    headers = {}
    status = 0
    responseText = ''
    open(_method, _url) {}
    setRequestHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value) }
    send(blob) {
      queueMicrotask(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: blob.size, total: blob.size })
        this.status = 200
        this.responseText = JSON.stringify({ etag: `atomic-part-${this.headers['x-8bg-part-number']}` })
        this.onload?.()
      })
    }
    abort() { this.onabort?.() }
  }
  try {
    const result = await uploadRomMultipart(file, key, undefined, undefined,
      integrityWork.manifest, true, integrityWork.fingerprintPart)
    assert.equal(result.integrityPublished, true)
    assert.equal(completeBody.integrityRequired, true)
    assert.deepEqual(completeBody.integrityManifest, await integrityWork.manifest)
    assert.equal(completeBody.requestSignature, 'atomic-integrity-signature')
    assert.equal(fileReads, 3 + Math.ceil(file.size / (2 * 1024 * 1024)),
      '首传应只读三段轻量身份样本和完整性块，不再重复读取每个 R2 分片计算另一种摘要')
  } finally {
    globalThis.fetch = originalFetch
    globalThis.XMLHttpRequest = originalXHR
  }
}
console.log('✅ ROM 分片合并随请求原子发布 SHA-256 清单，并返回 Worker 确认状态')

// 两份大文件同传时，共享传输预算不得因每份文件都各自自适应而突破四条活动连接。
{
  const files = [
    new File([new Uint8Array(2 * PART_SIZE + 1)], 'parallel-a.iso', { lastModified: 713 }),
    new File([new Uint8Array(2 * PART_SIZE + 3)], 'parallel-b.iso', { lastModified: 714 }),
  ]
  const originalXHR = globalThis.XMLHttpRequest
  const originalFetch = globalThis.fetch
  const sizesByKey = new Map(files.map((file) => [`roms/ps2/${file.name}`, file.size]))
  const keysByUploadId = new Map()
  let session = 0
  let active = 0
  let maxActive = 0
  globalThis.fetch = async (url, init) => {
    const target = new URL(String(url))
    const key = decodeURIComponent(target.pathname.replace(/^\//, ''))
    if (target.search === '?uploads') {
      const uploadId = `up-pool-${++session}`
      keysByUploadId.set(uploadId, key)
      return Response.json({ uploadId, marker: `_uploads/${uploadId}.marker`, partNumberInHeader: true })
    }
    const uploadId = target.searchParams.get('uploadId')
    if (uploadId && init?.method === 'POST') {
      const uploadKey = keysByUploadId.get(uploadId)
      return Response.json({ ok: true, key: uploadKey, size: sizesByKey.get(uploadKey) })
    }
    throw new Error(`unexpected request: ${target}`)
  }
  globalThis.XMLHttpRequest = class {
    upload = {}
    headers = {}
    status = 0
    responseText = ''
    settled = false
    open(_method, url) { this.url = url }
    setRequestHeader(name, value) { this.headers[String(name).toLowerCase()] = String(value) }
    send(blob) {
      const part = this.headers['x-8bg-part-number']
      active++
      maxActive = Math.max(maxActive, active)
      setTimeout(() => {
        this.upload.onprogress?.({ lengthComputable: true, loaded: blob.size, total: blob.size })
        this.status = 200
        this.responseText = JSON.stringify({ etag: `pool-${part}` })
        this.settled = true
        active--
        this.onload?.()
      }, 20)
    }
    abort() {
      if (!this.settled) active--
      this.onabort?.()
    }
  }
  try {
    const results = await Promise.all(files.map((file) => uploadRomMultipart(file, `roms/ps2/${file.name}`)))
    assert.deepEqual(results.map((result) => result.size), files.map((file) => file.size))
  } finally {
    globalThis.XMLHttpRequest = originalXHR
    globalThis.fetch = originalFetch
  }
  assert.ok(maxActive > 1, '多文件上传应能利用共享预算并行传输')
  assert.ok(maxActive <= 4, `多文件总并发不得超过四路（实际 ${maxActive}）`)
}
console.log('✅ 多文件 ROM 上传共享四路总预算，避免每个文件分别开满并发')

assert.equal(romPackWorkerConcurrency(100 * 1024 * 1024, { hardwareConcurrency: 8, deviceMemory: 8 }), 4)
assert.equal(romPackWorkerConcurrency(100 * 1024 * 1024, { hardwareConcurrency: 4, deviceMemory: 4 }), 2)
assert.equal(romPackWorkerConcurrency(100 * 1024 * 1024, { hardwareConcurrency: 8, deviceMemory: 2 }), 1)
assert.equal(romPackWorkerConcurrency(8 * 1024 * 1024, { hardwareConcurrency: 16, deviceMemory: 16 }), 1)
console.log('✅ 8BG 压缩加密按 CPU、内存与分块数选择 1–4 路 Worker，不会在低内存设备上过载')

// 失败重试只能复用“逐块原文 SHA 全部一致”的密文；同名、同大小、同 mtime 仍不够安全。
{
  const chunkSize = 8 * 1024 * 1024
  const source = new Uint8Array(chunkSize + 17)
  source[123] = 7
  source[chunkSize + 3] = 9
  const sha256 = async (bytes) => Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex')
  const chunks = []
  for (let at = 0; at < source.byteLength; at += chunkSize) {
    const bytes = source.slice(at, Math.min(source.byteLength, at + chunkSize))
    chunks.push({ sourceSize: bytes.byteLength, sha256: await sha256(bytes), encodedSize: bytes.byteLength, cipherSize: bytes.byteLength + 16 })
  }
  const header = { originalSize: source.byteLength, chunkSize, chunks }
  const original = new File([source], 'retry.zip', { lastModified: 123 })
  let verified = 0
  assert.equal(await matchesRomPackSource(original, header, ({ loaded }) => { verified = loaded }), true)
  assert.equal(verified, source.byteLength)

  const changed = source.slice()
  changed[Math.floor(chunkSize / 2)] ^= 1
  assert.equal(await matchesRomPackSource(new File([changed], 'retry.zip', { lastModified: 123 }), header), false)
}
console.log('✅ 8BG 失败重试会逐块校验源 ROM；内容变化时绝不复用旧密文')

// 第一片是真实测速；高速链路直接放开，故障后仍须单路恢复，不能把多条重试一起打回边缘。
{
  let now = 0
  const hints = { effectiveType: '3g', hardwareConcurrency: 8, deviceMemoryGb: 8 }
  const gate = new MultipartUploadGate(preferredUploadConcurrency(hints), 1, () => now, hints)
  assert.equal(gate.snapshot().limit, 1)
  await gate.run(async () => { now += 2_000 }, 8 * 1024 * 1024)
  assert.equal(gate.snapshot().limit, 4)
  assert.equal(gate.snapshot().calibrated, true)
  assert.ok(gate.snapshot().measuredMbps > 30)
  await assert.rejects(gate.run(async () => { throw { status: 503 } }))
  assert.equal(gate.snapshot().limit, 1)
  for (let i = 0; i < 4; i++) await gate.run(async () => { now += 2_000 }, 8 * 1024 * 1024)
  assert.equal(gate.snapshot().limit, 2, '故障后每四片只恢复一档')
}
console.log('✅ 高速上传测速后可升至四路；HTTP/2、限流和网关故障会降为单路并逐档恢复')

const headRequests = []
globalThis.fetch = async (url, init) => {
  headRequests.push({ url: String(url), method: init?.method ?? 'GET' })
  if (String(url).endsWith('/ping')) return Response.json({ features: { integrityManifest: true } })
  if (String(url).includes('/integrity?')) {
    const body = JSON.parse(init?.body || '{}')
    return Response.json({ ok: true, key: body.key, etag: body.etag, size: body.size })
  }
  if (String(url).includes('prefix=covers%2Fdemo.webp')) {
    return Response.json({ objects: [
      { key: 'covers/demo.webp', size: 11, bucket: 'ROMS' },
      { key: 'covers/demo.webp', size: 22, bucket: 'COVERS' },
    ] })
  }
  return Response.json({ objects: [] })
}
assert.deepEqual(await headRom('covers/demo.webp'), { exists: true, size: 22 })
assert.deepEqual(await headRom('roms/nes/missing.nes.8bg'), { exists: false })
assert.equal(headRequests.every((request) => request.method === 'GET' && request.url.includes('/list?prefix=')), true)
console.log('✅ 上传前对象检测用 200 列表响应；不存在不再制造 HEAD 404，封面优先检查 COVERS 桶')

const small = new Blob(['abc'])
await assert.rejects(uploadRom(small, 'roms/nes/demo.nes'), /上传响应不完整/)
console.log('✅ 200 HTML 不会被当成成功上传')

xhrResponse = () => ({ status: 200, body: JSON.stringify({ ok: true, key: 'roms/nes/demo.nes', size: 2 }) })
await assert.rejects(uploadRom(small, 'roms/nes/demo.nes'), /对象大小不符/)
console.log('✅ 单发 PUT 的返回大小必须与原文件相同')
xhrResponse = () => ({ status: 200, body: JSON.stringify({ ok: true, key: 'roms/nes/demo.nes', size: 3, etag: 'single-put-v1' }) })
const singlePutProgress = []
assert.equal((await uploadRom(small, 'roms/nes/demo.nes', (pct) => singlePutProgress.push(pct))).size, 3)
assert.deepEqual(singlePutProgress, [99, 100], '请求体传完先停在 99%，校验对象后才到 100%')
console.log('✅ 正常的小文件上传仍可完成')

// 新 Worker 能力允许把摘要与 PUT 一起提交，避免上传成功后再多等一次完整性绑定请求。
{
  const originalFetch = globalThis.fetch
  const originalApi = localStorage.getItem('8bitgo.rom.api')
  let sentHeaders
  let releasePing
  let probeReturned = false
  let digestStartedBeforeProbeReturned = false
  try {
    localStorage.setItem('8bitgo.rom.api', 'https://atomic-worker.test')
    const atomicFile = new File(['abc'], 'atomic-demo.nes', { lastModified: 456 })
    const originalSlice = atomicFile.slice.bind(atomicFile)
    Object.defineProperty(atomicFile, 'slice', {
      value: (...args) => {
        if (!probeReturned) digestStartedBeforeProbeReturned = true
        return originalSlice(...args)
      },
    })
    globalThis.fetch = async (url) => {
      assert.equal(String(url), 'https://atomic-worker.test/ping', '原子上传只探测一次 Worker 能力')
      return new Promise((resolve) => {
        releasePing = () => {
          probeReturned = true
          resolve(Response.json({ features: { integrityManifest: true, integrityAtomicUpload: true } }))
        }
      })
    }
    xhrResponse = (xhr) => {
      sentHeaders = xhr.headers
      return { status: 200, body: JSON.stringify({
        ok: true, key: 'roms/nes/demo.nes', size: 3, etag: 'atomic-put-v1', integrityPublished: true,
      }) }
    }
    const upload = uploadRom(atomicFile, 'roms/nes/demo.nes')
    for (let attempt = 0; attempt < 100 && !releasePing; attempt++) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(typeof releasePing, 'function', 'ROM 清单生成应与 Worker 能力探测同时开始')
    releasePing()
    releasePing = null
    const result = await upload
    assert.equal(digestStartedBeforeProbeReturned, true, '完整性摘要应在能力探测回包前已经开始')
    assert.equal(result.integrityPublished, true)
    assert.equal(sentHeaders['x-8bg-integrity-required'], 'sha256-v1')
    const encodedManifest = sentHeaders['x-8bg-integrity-manifest']
    assert.equal(typeof encodedManifest, 'string', '摘要随 PUT 原子提交')
    const manifest = JSON.parse(Buffer.from(encodedManifest, 'base64url').toString('utf8'))
    assert.equal(manifest.key, 'roms/nes/demo.nes')
    assert.equal(manifest.size, small.size)
    assert.equal(manifest.blocks.length, 1)
  } finally {
    releasePing?.(Response.json({ features: { integrityManifest: true, integrityAtomicUpload: true } }))
    globalThis.fetch = originalFetch
    localStorage.setItem('8bitgo.rom.api', originalApi || '')
    xhrResponse = () => ({ status: 200, body: JSON.stringify({
      ok: true, key: 'roms/nes/demo.nes', size: 3, etag: 'single-put-v1',
    }) })
  }
}
console.log('✅ 新 Worker 的小文件 PUT 随请求发布校验清单，无需第二次绑定请求')

// 多盘 CHD 低于分片阈值时也要响应同组取消，不能让单发 PUT 在后台继续占上行。
{
  const originalXHR = globalThis.XMLHttpRequest
  let abortCount = 0
  let sent = false
  globalThis.XMLHttpRequest = class {
    upload = {}
    open() {}
    setRequestHeader() {}
    send() { sent = true }
    abort() { abortCount++; this.onabort?.() }
  }
  const controller = new AbortController()
  try {
    // 用非 ROM 路径隔离单发 XHR 的取消行为；ROM 上传还会先检查 Worker 完整性能力并计算摘要。
    const pending = uploadRom(small, 'test/psx/small-disc.chd', undefined, undefined, controller.signal)
    for (let attempt = 0; attempt < 100 && !sent; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    assert.equal(sent, true, '摘要完成后应进入实际上传请求')
    controller.abort()
    await assert.rejects(pending, /上传已取消/)
    assert.equal(abortCount, 1)
  } finally {
    globalThis.XMLHttpRequest = originalXHR
  }
}
console.log('✅ 单发小盘上传也会响应多盘组取消')

// 小文件单发 PUT 的静默断线必须结束为可重试错误，不能永远挂在后台上传中。
{
  const originalNow = Date.now
  const originalSetInterval = window.setInterval
  let now = 100_000
  let checkStall
  Date.now = () => now
  window.setInterval = (fn, ms) => {
    if (ms === 5_000) checkStall = fn
    return 12345
  }
  xhrNeverCompletes = true
  try {
    // 只验证单发 XHR 看门狗；ROM 路径会先等完整性能力与摘要，不属于这个计时器用例。
    const pending = uploadRom(new Blob(['stalled']), 'test/nes/stalled.nes')
    assert.equal(typeof checkStall, 'function', '单发上传安装停滞看门狗')
    now += 45_001
    checkStall()
    await assert.rejects(pending, /45 秒没有收到上传进度或服务器确认/)
  } finally {
    xhrNeverCompletes = false
    Date.now = originalNow
    window.setInterval = originalSetInterval
  }
}
console.log('✅ 小文件单发 PUT 45 秒无进展会退出，不会永久挂起')

const uploads = [
  { marker: '_uploads/one.marker', key: 'roms/ps2/one.iso', uploadId: 'up-1', size: 1, name: 'one.iso', at: '2026-09-15' },
  { marker: '_uploads/two.marker', key: 'roms/ps2/two.iso', uploadId: 'up-2', size: 1, name: 'two.iso', at: '2026-09-15' },
]
const seen = []
globalThis.fetch = async (url) => {
  seen.push(String(url))
  if (String(url).endsWith('/multipart')) return Response.json({ uploads: [uploads[0]], truncated: true, cursor: 'next' })
  if (String(url).includes('cursor=next')) return Response.json({ uploads: [uploads[1]], truncated: false })
  return Response.json({ error: 'abort denied' }, { status: 500 })
}
assert.deepEqual(await listOrphanUploads(), uploads)
assert.equal(seen.length, 2)
await assert.rejects(abortOrphanUpload(uploads[0]), /abort denied/)
console.log('✅ 残留列表翻完所有页；清理失败会报错')

// 新 Worker 把分片号放请求头后，同一上传的所有片应命中同一个 CORS 预检缓存项。
{
  const file = new File([new Uint8Array(24 * 1024 * 1024 + 1)], 'stable-url.iso', { lastModified: 321 })
  const partUrls = []
  const partNumbers = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('?uploads')) return Response.json({ uploadId: 'up-header', marker: '_uploads/header.marker', partNumberInHeader: true })
    if (target.includes('uploadId=up-header') && init?.method === 'POST') {
      const parts = JSON.parse(init.body).parts
      assert.deepEqual(parts.map(part => part.partNumber), [1, 2, 3, 4])
      return Response.json({ ok: true, key: 'roms/ps2/stable-url.iso', size: file.size })
    }
    throw new Error(`unexpected request: ${target}`)
  }
  xhrResponse = (xhr) => {
    partUrls.push(new URL(xhr.url).href)
    partNumbers.push(xhr.headers['x-8bg-part-number'])
    return { status: 200, body: JSON.stringify({ etag: `header-${xhr.headers['x-8bg-part-number']}` }) }
  }
  assert.equal((await uploadRomMultipart(file, 'roms/ps2/stable-url.iso')).size, file.size)
  assert.equal(new Set(partUrls).size, 1, '所有分片共用 uploadId URL，不再把 partNumber 放入 query')
  assert.deepEqual(partNumbers.sort(), ['1', '2', '3', '4'])
}
console.log('✅ 新 Worker 能力协商后，分片 URL 固定且 partNumber 请求头逐片递增')

// 大文件账本按最多四个已完成分片批量落盘，合并前仍完整保存所有 ETag。
{
  const key = 'roms/ps2/batched-ledger.iso'
  const virtualBlob = (size) => ({
    size,
    slice: (start, end) => virtualBlob(Math.max(0, end - start)),
    arrayBuffer: async () => new ArrayBuffer(0),
  })
  const file = {
    name: 'batched-ledger.iso',
    lastModified: 54321,
    type: 'application/octet-stream',
    size: 8 * PART_SIZE,
    slice: (start, end) => virtualBlob(Math.max(0, end - start)),
  }
  const writesBefore = globalThis.localStorage.writeCount('8bitgo.rom.multipart')
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('?uploads')) return Response.json({ uploadId: 'up-batched-ledger', marker: '_uploads/batched-ledger.marker', partNumberInHeader: true })
    if (target.includes('uploadId=up-batched-ledger') && init?.method === 'POST') {
      assert.equal(JSON.parse(init.body).parts.length, 8)
      return Response.json({ ok: true, key, size: file.size })
    }
    throw new Error(`unexpected request: ${target}`)
  }
  xhrResponse = (xhr) => ({ status: 200, body: JSON.stringify({ etag: `batched-${xhr.headers['x-8bg-part-number']}` }) })
  assert.equal((await uploadRomMultipart(file, key)).size, file.size)
  const writes = globalThis.localStorage.writeCount('8bitgo.rom.multipart') - writesBefore
  assert.ok(writes <= 6, `8 片上传应批量写账，实际同步重写 ${writes} 次`)
  assert.equal(listPendingUploads().some((item) => item.key === key), false, '合并完成后不应留下账本')
}
console.log('✅ 大文件续传账本每最多四片批量落盘，合并前完整保存并在成功后清理')

// 新 Worker 的一次普通连接重置会临时用旧参数重试；成功响应确认能力后，后续片仍保持稳定 URL。
{
  const file = new File([new Uint8Array(16 * 1024 * 1024 + 1)], 'transient-reset.iso', { lastModified: 6542 })
  const headerAttempts = []
  const legacyParts = []
  let resetFirstHeader = true
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('?uploads')) return Response.json({ uploadId: 'up-transient-reset', marker: '_uploads/transient-reset.marker', partNumberInHeader: true })
    if (target.includes('uploadId=up-transient-reset') && init?.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body).parts.map(part => part.partNumber), [1, 2, 3])
      return Response.json({ ok: true, key: 'roms/ps2/transient-reset.iso', size: file.size })
    }
    throw new Error(`unexpected request: ${target}`)
  }
  xhrResponse = (xhr) => {
    const partNumber = xhr.headers['x-8bg-part-number']
    if (partNumber) {
      headerAttempts.push(partNumber)
      if (partNumber === '1' && resetFirstHeader) {
        resetFirstHeader = false
        return { error: true }
      }
      return { status: 200, body: JSON.stringify({ etag: `header-${partNumber}`, partNumberInHeader: true }) }
    }
    const legacyPart = new URL(xhr.url).searchParams.get('partNumber')
    legacyParts.push(legacyPart)
    return { status: 200, body: JSON.stringify({ etag: `legacy-${legacyPart}`, partNumberInHeader: true }) }
  }
  assert.equal((await uploadRomMultipart(file, 'roms/ps2/transient-reset.iso')).size, file.size)
  assert.deepEqual(legacyParts, ['1'], '只把发生连接重置的当前片临时退回查询参数')
  assert.deepEqual(headerAttempts, ['1', '2', '3'], '新 Worker 在成功响应中确认能力后，剩余分片仍走稳定 URL')
}
console.log('✅ 瞬时网络重置只临时回退当前分片，不让整次上传失去稳定 URL')

// Worker 在上传中途回滚时，旧版会因自定义头的 CORS 预检失败；同片退回原查询参数应能续完。
{
  const file = new File([new Uint8Array(24 * 1024 * 1024 + 1)], 'worker-rollback.iso', { lastModified: 654 })
  const headerAttempts = []
  const legacyParts = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('?uploads')) return Response.json({ uploadId: 'up-rollback', marker: '_uploads/rollback.marker', partNumberInHeader: true })
    if (target.includes('uploadId=up-rollback') && init?.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body).parts.map(part => part.partNumber), [1, 2, 3, 4])
      return Response.json({ ok: true, key: 'roms/ps2/worker-rollback.iso', size: file.size })
    }
    throw new Error(`unexpected request: ${target}`)
  }
  xhrResponse = (xhr) => {
    if (xhr.headers['x-8bg-part-number']) {
      headerAttempts.push(xhr.headers['x-8bg-part-number'])
      return { error: true }
    }
    const partNumber = new URL(xhr.url).searchParams.get('partNumber')
    legacyParts.push(partNumber)
    return { status: 200, body: JSON.stringify({ etag: `rollback-${partNumber}` }) }
  }
  assert.equal((await uploadRomMultipart(file, 'roms/ps2/worker-rollback.iso')).size, file.size)
  assert.ok(headerAttempts.length > 0, '必须先尝试能力协商出的请求头协议')
  assert.deepEqual(legacyParts.sort(), ['1', '2', '3', '4'], '失败分片及后续分片都应改走可兼容的旧协议')
}
console.log('✅ Worker 回滚导致请求头预检失败时，会自动以同一分片号退回旧协议')

// 旧 Worker 也可能用 400 文字拒绝请求头协议；这种明确可降级的错误不能被并发闸误当成致命失败。
{
  const file = new File([new Uint8Array(PART_SIZE + 1)], 'legacy-400.iso', { lastModified: 6541 })
  const headerAttempts = []
  const legacyParts = []
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('?uploads')) return Response.json({ uploadId: 'up-legacy-400', marker: '_uploads/legacy-400.marker', partNumberInHeader: true })
    if (target.includes('uploadId=up-legacy-400') && init?.method === 'POST') {
      assert.deepEqual(JSON.parse(init.body).parts.map((part) => part.partNumber), [1, 2])
      return Response.json({ ok: true, key: 'roms/ps2/legacy-400.iso', size: file.size })
    }
    throw new Error(`unexpected request: ${target}`)
  }
  xhrResponse = (xhr) => {
    if (xhr.headers['x-8bg-part-number']) {
      headerAttempts.push(xhr.headers['x-8bg-part-number'])
      return { status: 400, body: JSON.stringify({ error: 'partNumber 必须是整数' }) }
    }
    legacyParts.push(new URL(xhr.url).searchParams.get('partNumber'))
    return { status: 200, body: JSON.stringify({ etag: `legacy-400-${legacyParts.at(-1)}` }) }
  }
  assert.equal((await uploadRomMultipart(file, 'roms/ps2/legacy-400.iso')).size, file.size)
  assert.ok(headerAttempts.length > 0, '必须先尝试新协议')
  assert.deepEqual(legacyParts.sort(), ['1', '2'], '400 协议错误后应成功退回旧协议，不得提前停止队列')
}
console.log('✅ Worker 用 400 拒绝新协议时会降级到旧分片号参数')

// 首片遇到致命鉴权错误时，并发闸门里排队的分片不得继续发，避免白传最多 24 MiB。
{
  const file = new File([new Uint8Array(40 * 1024 * 1024)], 'expired-token.iso', { lastModified: 6543 })
  const sentParts = []
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('?uploads')) return Response.json({ uploadId: 'up-expired-token', marker: '_uploads/expired-token.marker', partNumberInHeader: true })
    throw new Error(`unexpected request: ${url}`)
  }
  xhrResponse = (xhr) => {
    sentParts.push(Number(xhr.headers['x-8bg-part-number']))
    return { status: 403, body: JSON.stringify({ error: 'test credential expired' }) }
  }
  await assert.rejects(uploadRomMultipart(file, 'roms/ps2/expired-token.iso'), /test credential expired/)
  assert.deepEqual(sentParts, [1], '首片 403 后只允许保留首个请求，排队分片不应消耗上行流量')
  for (const key of ['8bitgo.rom.multipart', '8bitgo.rom.multipart.create-request']) {
    const records = JSON.parse(globalThis.localStorage.getItem(key) || '{}')
    delete records['roms/ps2/expired-token.iso']
    globalThis.localStorage.setItem(key, JSON.stringify(records))
  }
}
console.log('✅ 首个分片遇到鉴权错误时会阻止并发队列继续上传')

// 多盘组一张盘失败后取消同组请求：已确认分片保留续传，挂起的分片不再重试或合并。
{
  const key = 'roms/psx/cancel-sibling.iso'
  const file = new File([new Uint8Array(25 * 1024 * 1024)], 'cancel-sibling.iso', { lastModified: 6544 })
  const controller = new AbortController()
  let completes = 0
  let part1Finished = false
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('?uploads')) return Response.json({ uploadId: 'up-cancel-sibling', marker: '_uploads/cancel-sibling.marker', partNumberInHeader: true })
    if (target.includes('uploadId=up-cancel-sibling') && init?.method === 'POST') {
      completes++
      return Response.json({ ok: true, key, size: file.size })
    }
    if (init?.method === 'DELETE') throw new Error('resumable cancellation must retain the session')
    throw new Error(`unexpected request: ${target}`)
  }
  xhrSendOverride = (xhr) => {
    if (xhr.headers['x-8bg-part-number'] !== '1') return
    queueMicrotask(() => {
      xhr.status = 200
      xhr.responseText = JSON.stringify({ etag: 'cancel-sibling-part-1' })
      part1Finished = true
      xhr.onload?.()
    })
  }
  const task = uploadRomMultipart(file, key, undefined, controller.signal)
  for (let attempt = 0; attempt < 100 && !part1Finished; attempt++) {
    await new Promise((resolve) => setImmediate(resolve))
  }
  assert.equal(part1Finished, true, '首片应在取消前完成')
  let saved
  for (let attempt = 0; attempt < 100; attempt++) {
    await new Promise((resolve) => setImmediate(resolve))
    window.dispatchEvent({ type: 'pagehide' })
    saved = listPendingUploads().find((item) => item.key === key)
    if (saved?.parts.some((part) => part.partNumber === 1)) break
  }
  assert.ok(saved?.parts.some((part) => part.partNumber === 1), '取消前完成的盘片分片应进入本地续传账本')
  controller.abort()
  await assert.rejects(task, /上传已取消/)
  const afterAbort = listPendingUploads().find((item) => item.key === key)
  assert.deepEqual(afterAbort?.parts.map((part) => part.partNumber), [1], '被取消的在途分片不能伪记为完成')
  assert.equal(completes, 0, '组内取消后不得合并不完整对象')
  xhrSendOverride = null
  const records = JSON.parse(globalThis.localStorage.getItem('8bitgo.rom.multipart') || '{}')
  delete records[key]
  globalThis.localStorage.setItem('8bitgo.rom.multipart', JSON.stringify(records))
}
console.log('✅ 多盘组失败会取消同组在途分片，并保留已完成片供重试续传')

let aborts = 0
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('?uploads')) return Response.json({ uploadId: 'up-large', marker: '_uploads/large.marker' })
  if (String(url).includes('uploadId=up-large') && init?.method === 'POST') return Response.json({ ok: true, key: 'roms/ps2/demo.iso', size: 1 })
  if (init?.method === 'DELETE') aborts++
  throw new Error(`unexpected request: ${url}`)
}
xhrResponse = (xhr) => ({ status: 200, body: JSON.stringify({ etag: `etag-${new URL(xhr.url).searchParams.get('partNumber')}` }) })
const large = new Blob([new Uint8Array(25 * 1024 * 1024)])
await assert.rejects(uploadRomMultipart(large, 'roms/ps2/demo.iso'), /R2 已完成上传，但对象大小/)
assert.equal(aborts, 0, '完成后的大小不符不能再重试或 abort 已经完成的对象')
console.log('✅ 分片合并后大小不符会阻止绑定，也不会重试 complete')

// 初始分片会话遇到 Worker 明确标记的临时 R2 503 时，应退避重试；其它未知状态不能重发 POST。
{
  const file = new File([new Uint8Array(25 * 1024 * 1024)], 'demo.cso', { lastModified: 456 })
  let starts = 0
  let completes = 0
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('/roms/psp/demo.cso?uploads')) {
      starts++
      if (starts === 1) return Response.json({ error: '开始分片上传暂时失败，请保留续传信息后重试', code: 'storage_unavailable', retryable: true }, { status: 503 })
      return Response.json({ uploadId: 'up-cso-retry', marker: '_uploads/cso-retry.marker' })
    }
    if (target.includes('uploadId=up-cso-retry') && init?.method === 'POST') {
      completes++
      return Response.json({ ok: true, key: 'roms/psp/demo.cso', size: file.size })
    }
    throw new Error(`unexpected request: ${target}`)
  }
  xhrResponse = (xhr) => ({ status: 200, body: JSON.stringify({ etag: `cso-${new URL(xhr.url).searchParams.get('partNumber')}` }) })
  assert.equal((await uploadRomMultipart(file, 'roms/psp/demo.cso')).size, file.size)
  assert.equal(starts, 2, '明确可重试的 503 应只重试创建会话一次')
  assert.equal(completes, 1, '成功创建后只合并一次')
}
console.log('✅ PSP CSO 创建分片会话遇到临时 503 会退避重试并完成上传')

// 头 / 中 / 尾样本相同、但已上传分片内部内容不同的镜像也不能复用旧 ETag。
const bytes = new Uint8Array(25 * 1024 * 1024)
const firstFile = new File([bytes], 'same.iso', { lastModified: 123 })
bytes[2 * 1024 * 1024] = 1 // 落在首片中，避开原来的头 / 中 / 尾指纹采样点
const changedFile = new File([bytes], 'same.iso', { lastModified: 123 })
assert.equal(await fingerprintRomUploadFile(firstFile), await fingerprintRomUploadFile(changedFile), '复现旧稀疏指纹漏掉局部修改的条件')
const key = 'roms/ps2/collision.iso'
let creates = 0
let round = 0
let failAfterFirstPart = true
const uploadedParts = [[], []]
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.endsWith('?uploads')) {
    creates++
    return Response.json({ uploadId: `up-ident-${creates}`, marker: `_uploads/ident-${creates}.marker`, requestSignature: 'same-metadata-signature', partNumberInHeader: true })
  }
  if (target.includes('uploadId=up-ident-1') && init?.method === 'POST') {
    const parts = JSON.parse(init.body).parts
    assert.deepEqual(parts.map((part) => part.partNumber), [1, 2, 3, 4])
    assert.ok(parts.every((part) => !('contentHash' in part)), '本地摘要不能泄漏到 R2 complete 协议')
    return Response.json({ ok: true, key, size: changedFile.size })
  }
  throw new Error(`unexpected request: ${url}`)
}
xhrResponse = (xhr) => {
  const number = Number(xhr.headers['x-8bg-part-number'])
  uploadedParts[round].push(number)
  if (failAfterFirstPart && number !== 1) return { status: 403, body: JSON.stringify({ error: 'test credential expired' }) }
  return { status: 200, body: JSON.stringify({ etag: `etag-${number}` }) }
}
await assert.rejects(uploadRomMultipart(firstFile, key), /test credential expired/)
const saved = listPendingUploads().find((item) => item.key === key)
assert.equal(saved?.parts.length, 1, '首片成功、后续鉴权失败时应保留已确认片')
assert.equal(saved?.parts[0].contentHash, await fingerprintRomPart(firstFile.slice(0, PART_SIZE)), '本地账本必须为已上传片保存强摘要')
round = 1
failAfterFirstPart = false
const checkingProgress = []
await uploadRomMultipart(changedFile, 'roms/ps2/collision.iso', (_pct, stage) => {
  if (stage?.checkingTotal !== undefined) checkingProgress.push([stage.checkingParts, stage.checkingTotal])
})
assert.equal(creates, 1, '相同文件元数据可以安全续用原 R2 multipart 会话')
assert.equal(uploadedParts[1].filter((part) => part === 1).length, 1, '未命中稀疏样本的已上传片必须重新核验并覆盖')
assert.deepEqual([...uploadedParts[1]].sort((a, b) => a - b), [1, 2, 3, 4])
assert.deepEqual(checkingProgress, [[0, 1], [1, 1]], '续传核验应向后台界面报告开始和完成状态')
assert.equal(listPendingUploads().length, 0, '完成后续传账本应清理')
console.log('✅ 稀疏指纹相同但分片内容不同的 ISO 会重传差异片，不会静默拼接旧字节')

// 摘要 API 在上传期间临时失败时，R2 已确认的当前分片仍可合并；缺摘要片下次续传会安全重传。
{
  const originalFetch = globalThis.fetch
  const originalXhrResponse = xhrResponse
  const originalCryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'crypto')
  const originalCrypto = globalThis.crypto
  let digestCalls = 0
  const digestFallbackKey = 'roms/ps2/digest-fallback.iso'
  const file = new File([new Uint8Array(PART_SIZE + 1)], 'digest-fallback.iso', { lastModified: 456 })
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto),
      subtle: {
        digest: (...args) => {
          digestCalls += 1
          return digestCalls === 1
            ? originalCrypto.subtle.digest.apply(originalCrypto.subtle, args)
            : Promise.reject(new Error('temporary digest failure'))
        },
      },
    },
  })
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('?uploads')) {
      return Response.json({ uploadId: 'up-digest-fallback', marker: '_uploads/digest-fallback.marker', partNumberInHeader: true })
    }
    if (target.includes('uploadId=up-digest-fallback') && init?.method === 'POST') {
      const pending = listPendingUploads().find((item) => item.key === digestFallbackKey)
      assert.equal(pending?.parts.length, 2)
      assert.ok(pending.parts.every((part) => !('contentHash' in part)), '摘要失败的片必须保留 ETag 但不能标记为可复用')
      return Response.json({ ok: true, key: digestFallbackKey, size: file.size })
    }
    throw new Error(`unexpected request: ${target}`)
  }
  xhrResponse = (xhr) => ({ status: 200, body: JSON.stringify({ etag: `digest-${xhr.headers['x-8bg-part-number']}` }) })
  try {
    assert.equal((await uploadRomMultipart(file, digestFallbackKey)).size, file.size)
    assert.ok(digestCalls >= 3, '文件指纹成功后应实际触发分片摘要故障')
  } finally {
    globalThis.fetch = originalFetch
    xhrResponse = originalXhrResponse
    if (originalCryptoDescriptor) Object.defineProperty(globalThis, 'crypto', originalCryptoDescriptor)
    else delete globalThis.crypto
  }
}
console.log('✅ 浏览器摘要短暂失败不会丢弃已成功上传的 R2 分片；后续续传只重传未核验片')

// 内容相同的已完成片仍然复用；完整核验不能退化成每次续传都从头上传。
const verifiedKey = 'roms/ps2/verified-resume.iso'
globalThis.localStorage.setItem('8bitgo.rom.multipart', JSON.stringify({ [verifiedKey]: {
  key: verifiedKey,
  uploadId: 'up-ident-verified',
  marker: '_uploads/ident-verified.marker',
  partSize: PART_SIZE,
  fileName: changedFile.name,
  fileSize: changedFile.size,
  lastModified: changedFile.lastModified,
  fileFingerprint: await fingerprintRomUploadFile(changedFile),
  requestId: 'abcdef0123456789abcdef0123456789',
  requestSignature: 'same-metadata-signature',
  partNumberInHeader: true,
  contentType: 'application/octet-stream',
  parts: [{ partNumber: 1, etag: 'verified-part-1', contentHash: await fingerprintRomPart(changedFile.slice(0, PART_SIZE)) }],
  updatedAt: Date.now(),
} }))
const verifiedUploads = []
globalThis.fetch = async (url, init) => {
  const target = String(url)
  if (target.includes('uploadId=up-ident-verified') && init?.method === 'POST') {
    const parts = JSON.parse(init.body).parts
    assert.deepEqual(parts.map((part) => part.partNumber), [1, 2, 3, 4])
    return Response.json({ ok: true, key: verifiedKey, size: changedFile.size })
  }
  throw new Error(`unexpected request: ${target}`)
}
xhrResponse = (xhr) => {
  const number = Number(xhr.headers['x-8bg-part-number'])
  verifiedUploads.push(number)
  return { status: 200, body: JSON.stringify({ etag: `verified-${number}` }) }
}
await uploadRomMultipart(changedFile, verifiedKey)
assert.deepEqual(verifiedUploads.sort((a, b) => a - b), [2, 3, 4], '核验一致的首片应直接复用，不重复上传')
console.log('✅ 内容一致的续传分片经强摘要核验后继续复用')

const verifiedV2Key = 'roms/ps2/verified-resume-v2.iso'
const verifiedV2File = new File([new Uint8Array(PART_SIZE + 1)], 'verified-resume-v2.iso', { lastModified: 3211 })
const verifiedV2Work = createRomIntegrityWork(verifiedV2File, verifiedV2Key)
globalThis.localStorage.setItem('8bitgo.rom.multipart', JSON.stringify({ [verifiedV2Key]: {
  key: verifiedV2Key,
  uploadId: 'up-ident-verified-v2',
  marker: '_uploads/ident-verified-v2.marker',
  partSize: PART_SIZE,
  fileName: verifiedV2File.name,
  fileSize: verifiedV2File.size,
  lastModified: verifiedV2File.lastModified,
  fileFingerprint: await fingerprintRomUploadFile(verifiedV2File),
  requestId: 'abcdef0123456789abcdef012345678a',
  requestSignature: 'same-v2-metadata-signature',
  partNumberInHeader: true,
  contentType: 'application/octet-stream',
  parts: [{
    partNumber: 1,
    etag: 'verified-v2-part-1',
    contentHash: await verifiedV2Work.fingerprintPart(0, PART_SIZE),
    contentHashVersion: 2,
  }],
  updatedAt: Date.now(),
} }))
const verifiedV2Uploads = []
globalThis.fetch = async (url, init) => {
  if (String(url).includes('uploadId=up-ident-verified-v2') && init?.method === 'POST') {
    const parts = JSON.parse(init.body).parts
    assert.deepEqual(parts.map((part) => part.partNumber), [1, 2], 'v2 完整性块指纹应保留已核验首片')
    return Response.json({ ok: true, key: verifiedV2Key, size: verifiedV2File.size, integrityPublished: true })
  }
  throw new Error(`unexpected request: ${url}`)
}
xhrResponse = (xhr) => {
  const number = Number(xhr.headers['x-8bg-part-number'])
  verifiedV2Uploads.push(number)
  return { status: 200, body: JSON.stringify({ etag: `verified-v2-${number}` }) }
}
await uploadRomMultipart(verifiedV2File, verifiedV2Key, undefined, undefined,
  verifiedV2Work.manifest, true, verifiedV2Work.fingerprintPart)
assert.deepEqual(verifiedV2Uploads, [2], 'v2 本地续传验证成功时只上传缺失分片')
console.log('✅ 新版完整性块指纹可跨刷新核验并复用已上传分片')

const changedV2Key = 'roms/ps2/changed-resume-v2.iso'
const oldV2File = new File([new Uint8Array(PART_SIZE + 1)], 'changed-resume-v2.iso', { lastModified: 3212 })
const oldV2Work = createRomIntegrityWork(oldV2File, changedV2Key)
const oldV2Fingerprint = await fingerprintRomUploadFile(oldV2File)
const oldV2PartHash = await oldV2Work.fingerprintPart(0, PART_SIZE)
const changedV2Bytes = new Uint8Array(PART_SIZE + 1)
changedV2Bytes[2 * 1024 * 1024 + 17] = 1
const changedV2File = new File([changedV2Bytes], oldV2File.name, { lastModified: oldV2File.lastModified })
assert.equal(await fingerprintRomUploadFile(changedV2File), oldV2Fingerprint,
  '碰撞测试只改变头 / 中 / 尾抽样之外的内容')
const changedV2Work = createRomIntegrityWork(changedV2File, changedV2Key)
globalThis.localStorage.setItem('8bitgo.rom.multipart', JSON.stringify({ [changedV2Key]: {
  key: changedV2Key,
  uploadId: 'up-ident-changed-v2',
  marker: '_uploads/ident-changed-v2.marker',
  partSize: PART_SIZE,
  fileName: changedV2File.name,
  fileSize: changedV2File.size,
  lastModified: changedV2File.lastModified,
  fileFingerprint: oldV2Fingerprint,
  requestId: 'abcdef0123456789abcdef012345678b',
  requestSignature: 'same-v2-metadata-signature',
  partNumberInHeader: true,
  contentType: 'application/octet-stream',
  parts: [{ partNumber: 1, etag: 'old-content-v2', contentHash: oldV2PartHash, contentHashVersion: 2 }],
  updatedAt: Date.now(),
} }))
const changedV2Uploads = []
globalThis.fetch = async (url, init) => {
  if (String(url).includes('uploadId=up-ident-changed-v2') && init?.method === 'POST') {
    assert.deepEqual(JSON.parse(init.body).parts.map((part) => part.partNumber), [1, 2])
    return Response.json({ ok: true, key: changedV2Key, size: changedV2File.size, integrityPublished: true })
  }
  throw new Error(`unexpected request: ${url}`)
}
xhrResponse = (xhr) => {
  const number = Number(xhr.headers['x-8bg-part-number'])
  changedV2Uploads.push(number)
  return { status: 200, body: JSON.stringify({ etag: `changed-v2-${number}` }) }
}
await uploadRomMultipart(changedV2File, changedV2Key, undefined, undefined,
  changedV2Work.manifest, true, changedV2Work.fingerprintPart)
assert.deepEqual(changedV2Uploads.sort((a, b) => a - b), [1, 2],
  'v2 完整性块发现抽样之外字节变化时必须重传对应分片')
console.log('✅ v2 续传摘要发现稀疏样本之外的内容变化后会重传')

const legacyKey = 'roms/ps2/legacy-resume.iso'
globalThis.localStorage.setItem('8bitgo.rom.multipart', JSON.stringify({ [legacyKey]: {
  key: legacyKey,
  uploadId: 'up-ident-legacy',
  marker: '_uploads/ident-legacy.marker',
  partSize: PART_SIZE,
  fileName: changedFile.name,
  fileSize: changedFile.size,
  lastModified: changedFile.lastModified,
  fileFingerprint: await fingerprintRomUploadFile(changedFile),
  requestId: '123456789abcdef0123456789abcdef0',
  requestSignature: 'same-metadata-signature',
  partNumberInHeader: true,
  contentType: 'application/octet-stream',
  parts: [{ partNumber: 1, etag: 'legacy-part-1' }],
  updatedAt: Date.now(),
} }))
const legacyUploads = []
globalThis.fetch = async (url, init) => {
  if (String(url).includes('uploadId=up-ident-legacy') && init?.method === 'POST') {
    return Response.json({ ok: true, key: legacyKey, size: changedFile.size })
  }
  throw new Error(`unexpected request: ${url}`)
}
xhrResponse = (xhr) => {
  const number = Number(xhr.headers['x-8bg-part-number'])
  legacyUploads.push(number)
  return { status: 200, body: JSON.stringify({ etag: `legacy-${number}` }) }
}
await uploadRomMultipart(changedFile, legacyKey)
assert.deepEqual(legacyUploads.sort((a, b) => a - b), [1, 2, 3, 4], '旧账本没有强摘要时必须重传对应远端分片')
console.log('✅ 升级前留下的续传账本会安全重传未核验分片')

// 多个大文件账本接近 localStorage 配额时，新上传仍要留下可恢复的最新状态。
const largeLedger = Object.fromEntries(Array.from({ length: 20 }, (_, index) => {
  const oldKey = `roms/ps2/old-${index}.iso`
  return [oldKey, {
    key: oldKey,
    uploadId: `old-upload-${index}`,
    marker: `_uploads/old-${index}.marker`,
    partSize: PART_SIZE,
    fileName: `old-${index}.iso`,
    fileSize: PART_SIZE * 1000,
    lastModified: index,
    fileFingerprint: 'a'.repeat(64),
    requestId: `old-request-${String(index).padStart(16, '0')}`,
    contentType: 'application/octet-stream',
    parts: Array.from({ length: 1000 }, (_, part) => ({ partNumber: part + 1, etag: `etag-${part}`, contentHash: 'a'.repeat(32) })),
    updatedAt: Date.now() - index - 1,
  }]
}))
globalThis.localStorage.setItem('8bitgo.rom.multipart', JSON.stringify(largeLedger))
const budgetKey = 'roms/ps2/newest.iso'
const budgetFile = new File([new Uint8Array(25 * 1024 * 1024)], 'newest.iso', { lastModified: 999 })
globalThis.fetch = async (url) => {
  if (String(url).endsWith('?uploads')) return Response.json({ uploadId: 'budget-upload', marker: '_uploads/budget.marker' })
  throw new Error(`unexpected request: ${url}`)
}
xhrResponse = (xhr) => Number(xhr.headers['x-8bg-part-number']) === 1
  ? { status: 200, body: JSON.stringify({ etag: 'budget-part-1' }) }
  : { status: 403, body: JSON.stringify({ error: 'test credential expired' }) }
await assert.rejects(uploadRomMultipart(budgetFile, budgetKey), /test credential expired/)
const boundedLedger = JSON.parse(globalThis.localStorage.getItem('8bitgo.rom.multipart'))
assert.ok(boundedLedger[budgetKey], '账本裁剪必须优先保留当前最新上传')
assert.ok(JSON.stringify(boundedLedger).length <= 1_500_000, '账本必须留在约定的 localStorage 字符预算内')
globalThis.localStorage.setItem('8bitgo.rom.multipart', '{}')
console.log('✅ 多个大分片账本接近配额时，新上传状态仍可保存且总量有界')

const deleted = []
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/list?')) return Response.json({ objects: [
    { key: 'roms/flash/demo/a.swf', size: 1 },
    { key: 'roms/flash/demo/b.swf', size: 1 },
  ], truncated: false })
  if (String(url).endsWith('/bulk')) {
    const keys = JSON.parse(init.body).keys
    deleted.push(keys)
    return Response.json({ ok: true, deleted: keys })
  }
  throw new Error(`unexpected request: ${url}`)
}
assert.deepEqual(await deleteRomDir('roms/flash/demo'), ['roms/flash/demo/a.swf', 'roms/flash/demo/b.swf'])
assert.equal(deleted.length, 1)
console.log('✅ 多文件包通过一次 R2 批量请求删除')

let oldDeletes = 0
globalThis.fetch = async (url, init) => {
  if (String(url).includes('/list?')) return Response.json({ objects: [
    { key: 'roms/flash/demo/a.swf', size: 1 },
    { key: 'roms/flash/demo/b.swf', size: 1 },
  ], truncated: false })
  if (String(url).endsWith('/bulk')) return Response.json({ error: 'POST 需要 ?uploads（开始）或 ?uploadId=（完成）' }, { status: 400 })
  if (init?.method === 'DELETE') {
    oldDeletes++
    return Response.json({ ok: true })
  }
  throw new Error(`unexpected request: ${url}`)
}
assert.equal((await deleteRomDir('roms/flash/demo')).length, 2)
assert.equal(oldDeletes, 2)
console.log('✅ 旧 Worker 会退回原来的逐文件删除')

const exactKeys = ['roms/flash/demo/old-a.swf', 'roms/flash/demo/old-b.swf']
const exactBulk = []
globalThis.fetch = async (url, init) => {
  if (String(url).endsWith('/bulk')) {
    const keys = JSON.parse(init.body).keys
    exactBulk.push(keys)
    return Response.json({ ok: true, deleted: keys })
  }
  throw new Error(`unexpected request: ${url}`)
}
assert.deepEqual(await deleteRomObjectsExactly(exactKeys), { removed: exactKeys, failed: [] })
assert.deepEqual(exactBulk, [exactKeys], '精确清理应复用一次批量删除，不应重新列目录或逐项请求')
console.log('✅ Flash 包旧文件按核对过的精确 key 一次批量清理')

globalThis.fetch = async (url) => Response.json({ objects: [], truncated: true, cursor: String(Number(new URL(url).searchParams.get('cursor') || 0) + 1) })
await assert.rejects(listRomObjects('roms/ps2'), /文件过多/)
console.log('✅ R2 列表超过页面上限时明确报错，不会静默遗漏文件')

const pendingSockdrive = {
  sourceKey: 'sockdrive-staging/12345678-1234-1234-1234-123456789abc.zip',
  sourceSize: 123456,
  gameSlug: 'demo',
  lang: 'zh-Hant',
  targetRomKey: 'roms/dos/demo.zh-Hant.zip.8bg',
  expectedRomKey: 'roms/dos/demo.zh-Hant.zip.8bg',
  executable: 'GAME.EXE',
  version: 'v123',
  expectedSockdrive: '',
  encoding: 'br',
}
rememberPendingSockdriveCreation('demo', pendingSockdrive, 'zh-Hant')
assert.deepEqual(rememberedPendingSockdriveCreation('demo', 'zh-Hant'), pendingSockdrive)
clearPendingSockdriveCreation('demo', 'zh-Hant')
assert.equal(rememberedPendingSockdriveCreation('demo', 'zh-Hant'), null)
console.log('✅ 已上传的 Sockdrive staging 请求可跨刷新恢复，成功后能清账')

const completedJob = {
  id: '12345678-1234-1234-1234-123456789abc',
  sourceKey: pendingSockdrive.sourceKey,
  targetPrefix: 'sockdrives/demo-zh-hant-v123',
  status: 'completed',
  progress: 100,
  sourceSize: pendingSockdrive.sourceSize,
  outputBytes: 1,
  outputFiles: 1,
  gameSlug: 'demo',
  lang: 'zh-Hant',
  targetRomKey: pendingSockdrive.targetRomKey,
  executable: 'GAME.EXE',
  bound: true,
  message: '',
  error: '',
}
let createAttempts = 0
globalThis.fetch = async (url, init) => {
  assert.equal(init?.method, 'POST')
  assert.match(String(url), /\/api\/admin\/sockdrive-conversions$/)
  createAttempts++
  if (createAttempts < 3) return Response.json({ error: 'temporary gateway' }, { status: createAttempts === 1 ? 502 : 504 })
  return Response.json(completedJob, { status: 202 })
}
assert.equal((await createSockdriveConversion(pendingSockdrive)).id, completedJob.id)
assert.equal(createAttempts, 3)
assert.equal(preserveSockdriveSourceAfterCreateError(new ApiError('bad gateway', 502, null)), true)
assert.equal(preserveSockdriveSourceAfterCreateError(new ApiError('conflict', 409, null)), false)
console.log('✅ 创建任务遇到 502/504 会幂等重试；不确定结果不会触发 staging 误删')

let polls = 0
const reconnects = []
globalThis.fetch = async (url, init) => {
  assert.equal(init?.method, 'GET')
  assert.match(String(url), /\/api\/admin\/sockdrive-conversions\//)
  polls++
  if (polls < 3) return Response.json({ error: 'temporary gateway' }, { status: polls === 1 ? 502 : 504 })
  return Response.json(completedJob)
}
const polled = await waitForSockdriveConversion(
  completedJob.id,
  undefined,
  undefined,
  (_error, attempt) => reconnects.push(attempt),
)
assert.equal(polled.status, 'completed')
assert.equal(polls, 3)
assert.deepEqual(reconnects, [1, 2])
console.log('✅ 状态查询的瞬时 502/504 只会自动重连，不再把运行中的后台任务误判为失败')

// Worker 创建 / 完成等 JSON 控制请求不能像旧 fetch 一样在弱网下无限等待；取消要能中止响应体读取。
{
  let abortedByTimeout = false
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => {
      abortedByTimeout = true
      reject(new DOMException('aborted', 'AbortError'))
    }, { once: true })
  })
  await assert.rejects(
    askJson({ api: 'https://w.test', token: 'test-token' }, 'https://w.test/ping', { method: 'POST' }, '测试控制请求', undefined, 15),
    (error) => error?.status === 0 && /响应超时/.test(error.message),
  )
  assert.equal(abortedByTimeout, true, '控制请求超时必须主动取消底层连接')

  globalThis.fetch = async () => new Response(new ReadableStream({
    start(stream) { stream.error(new TypeError('connection reset while reading JSON')) },
  }), { status: 200 })
  await assert.rejects(
    askJson({ api: 'https://w.test', token: 'test-token' }, 'https://w.test/ping', { method: 'POST' }, '测试响应正文'),
    (error) => error?.status === 0 && /正文未完整/.test(error.message),
  )

  // Worker 已创建会话、但响应正文断流时，客户端必须用同一 requestId 找回原会话。
  // 不能把一次读取失败变成第二个 R2 multipart upload 残留。
  {
    const key = 'roms/ps2/create-body-reset.iso'
    const file = new File([new Uint8Array(25 * 1024 * 1024)], 'create-body-reset.iso', { lastModified: 90110 })
    const sessions = new Map()
    const createIds = []
    let createAttempts = 0
    let completes = 0
    globalThis.fetch = async (url, init) => {
      const target = String(url)
      if (target.endsWith('?uploads')) {
        createAttempts++
        const requestId = JSON.parse(init.body).requestId
        createIds.push(requestId)
        let session = sessions.get(requestId)
        if (!session) {
          session = { uploadId: 'up-create-body-reset', marker: '_uploads/create-body-reset.marker' }
          sessions.set(requestId, session)
        }
        if (createAttempts === 1) {
          return new Response(new ReadableStream({
            start(stream) {
              stream.enqueue(new TextEncoder().encode('{"uploadId":"up-create-body-reset"'))
              stream.error(new TypeError('connection reset while reading JSON'))
            },
          }), { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return Response.json({ ...session, partNumberInHeader: true })
      }
      if (target.includes('uploadId=up-create-body-reset') && init?.method === 'POST') {
        completes++
        return Response.json({ ok: true, key, size: file.size })
      }
      throw new Error(`unexpected request: ${target}`)
    }
    xhrResponse = (xhr) => ({ status: 200, body: JSON.stringify({ etag: `body-reset-${xhr.headers['x-8bg-part-number']}` }) })
    assert.equal((await uploadRomMultipart(file, key)).size, file.size)
    assert.equal(createAttempts, 2, '响应正文断流后应重试会话创建')
    assert.equal(new Set(createIds).size, 1, '重试必须复用稳定 requestId')
    assert.equal(sessions.size, 1, 'Worker 幂等恢复应只保留一个 multipart 会话')
    assert.equal(completes, 1)
  }

  const key = 'roms/psx/cancel-create-weaknet.iso'
  const file = new File([new Uint8Array(1024)], 'cancel-create-weaknet.iso', { lastModified: 90111 })
  const controller = new AbortController()
  let requestSignal
  globalThis.fetch = async (_url, init) => new Promise((_resolve, reject) => {
    requestSignal = init.signal
    requestSignal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
  })
  const task = uploadRomMultipart(file, key, undefined, controller.signal)
  for (let attempt = 0; attempt < 100 && !requestSignal; attempt++) await new Promise((resolve) => setImmediate(resolve))
  assert.ok(requestSignal, '取消测试必须进入会话创建请求')
  controller.abort()
  await assert.rejects(task, /上传已取消/)
  assert.equal(requestSignal.aborted, true, '取消按钮要传到 Worker 控制请求')
  for (const storeKey of ['8bitgo.rom.multipart', '8bitgo.rom.multipart.create-request']) {
    const records = JSON.parse(globalThis.localStorage.getItem(storeKey) || '{}')
    delete records[key]
    globalThis.localStorage.setItem(storeKey, JSON.stringify(records))
  }
}
console.log('✅ 弱网下 Worker 控制请求有总时限，用户取消可立即中止会话创建')

// 合并是有副作用的提交点：取消恰好发生在请求发出后，不能掐掉 R2 已完成对象的唯一确认响应。
{
  const key = 'roms/psx/cancel-during-complete.iso'
  const file = new File([new Uint8Array(25 * 1024 * 1024)], 'cancel-during-complete.iso', { lastModified: 90112 })
  const controller = new AbortController()
  let completeSignal
  let completeCalls = 0
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('?uploads')) {
      return Response.json({ uploadId: 'up-cancel-during-complete', marker: '_uploads/cancel-during-complete.marker', partNumberInHeader: true })
    }
    if (target.includes('uploadId=up-cancel-during-complete') && init?.method === 'POST') {
      completeCalls++
      completeSignal = init.signal
      controller.abort()
      return Response.json({ ok: true, key, size: file.size })
    }
    throw new Error(`unexpected request: ${target}`)
  }
  xhrResponse = (xhr) => ({ status: 200, body: JSON.stringify({ etag: `cancel-complete-${xhr.headers['x-8bg-part-number']}` }) })
  const result = await uploadRomMultipart(file, key, undefined, controller.signal)
  assert.equal(completeCalls, 1)
  assert.equal(completeSignal.aborted, false, '合并开始后继续等待有界确认响应')
  assert.equal(controller.signal.aborted, true, '测试确实在合并过程中触发了取消')
  assert.equal(result.size, file.size, 'R2 确认完成后客户端报告真实成功')
}
console.log('✅ 用户在 R2 合并确认期间取消时，不会误报未完成或遗留旧 uploadId')

// 合并请求第一次确认丢失时，提交点之后的取消不能阻止幂等重试。
{
  const key = 'roms/psx/cancel-after-complete-timeout.iso'
  const file = new File([new Uint8Array(25 * 1024 * 1024)], 'cancel-after-complete-timeout.iso', { lastModified: 90113 })
  const controller = new AbortController()
  let completeCalls = 0
  globalThis.fetch = async (url, init) => {
    const target = String(url)
    if (target.endsWith('?uploads')) {
      return Response.json({ uploadId: 'up-cancel-after-complete-timeout', marker: '_uploads/cancel-after-complete-timeout.marker', partNumberInHeader: true })
    }
    if (target.includes('uploadId=up-cancel-after-complete-timeout') && init?.method === 'POST') {
      completeCalls++
      if (completeCalls === 1) {
        controller.abort()
        throw new TypeError('Failed to fetch')
      }
      return Response.json({ ok: true, key, size: file.size })
    }
    throw new Error(`unexpected request: ${target}`)
  }
  xhrResponse = (xhr) => ({ status: 200, body: JSON.stringify({ etag: `cancel-retry-${xhr.headers['x-8bg-part-number']}` }) })
  const result = await uploadRomMultipart(file, key, undefined, controller.signal)
  assert.equal(completeCalls, 2, '合并确认的瞬时网络错误后，即使用户取消也必须完成幂等确认重试')
  assert.equal(controller.signal.aborted, true, '测试确实在第一次合并确认失败时触发取消')
  assert.equal(result.size, file.size, '最终结果应以 Worker 的完整合并确认作为准据')
}
console.log('✅ 合并确认丢失后，提交阶段会完成有界幂等重试')
