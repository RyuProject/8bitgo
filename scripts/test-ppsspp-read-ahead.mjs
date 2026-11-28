import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../vendor/ppsspp/range-read-ahead.js', import.meta.url), 'utf8')
const BLOCK = 2 * 1024 * 1024

class BrowserTextDecoder extends TextDecoder {
  decode(input, options) {
    if (input?.buffer instanceof SharedArrayBuffer) {
      throw new TypeError("Failed to execute 'decode' on 'TextDecoder': The provided ArrayBufferView value must not be shared.")
    }
    return super.decode(input, options)
  }
}

function makeRuntime(effectiveType = '4g', saveData = false, deviceMemory = 8, hardwareConcurrency = 8, sharedWorker = false, totalBlocks = 6, discUrl = 'https://assets.test/game.chd', downlink, syncDurationMs = 0, mobile = false, sharedPortMode = false, brokerPortMode = false) {
  const total = BLOCK * totalBlocks
  const requests = []
  const pending = []
  const workers = []
  let activeAsync = 0
  let maxActiveAsync = 0
  let sharedWaits = 0
  let competingJobsAtWait = 0
  let syncFailures = 0
  let syncFailMode = 'throw'
  let fakeNow = 1_000_000
  const timeoutsSeen = []

  class FakeWorker {
    constructor() {
      this.jobs = new Map()
      workers.push(this)
    }

    postMessage(data) {
      if (data.type === 'fetch') this.jobs.set(data.start, data)
      if (data.type === 'cancel') {
        for (const [start, job] of this.jobs) {
          if (job.id === data.id) this.jobs.delete(start)
        }
      }
    }

    complete(start, notifyParent = false) {
      const job = this.jobs.get(start)
      assert.ok(job, `预读 Worker 没有 ${start} 块`)
      new Uint8Array(job.bytes).fill(7)
      Atomics.store(new Int32Array(job.state), 0, 1)
      this.jobs.delete(start)
      if (notifyParent) this.onmessage?.({ data: { type: 'done', id: job.id, key: job.key } })
    }

    terminate() {}
  }

  class FakeSharedWorker {
    constructor() {
      this.port = {
        onmessage: null,
        onerror: null,
        close() {},
        start: () => this.port.onmessage?.({ data: { type: 'ready' } }),
        postMessage: (data) => {
          if (data.type === 'cancel') return
          if (data.type !== 'fetch') return
          requests.push({
            start: data.start, end: data.end, async: true, shared: true, timeout: data.timeoutMs,
            headers: new Map(),
          })
          new Uint8Array(data.bytes).fill(7)
          const state = new Int32Array(data.state)
          if (data.state.byteLength > 8) {
            const rawHeaders = new TextEncoder().encode(
              `content-range: bytes ${data.start}-${data.end}/${data.total}\r\netag: \"disc-v1\"\r\n`,
            )
            new Uint8Array(data.state, 8).set(rawHeaders)
          }
          Atomics.store(state, 0, 1)
          Atomics.notify(state, 0)
          this.port.onmessage?.({ data: { type: 'done', id: data.id, key: data.key } })
        },
      }
    }
  }

  class FakeBrokerPort {
    constructor() {
      this.onmessage = null
      this.onerror = null
    }
    start() {}
    close() {}
    postMessage(data) {
      if (data.type === 'ping') {
        this.onmessage?.({ data: { type: 'ready', id: data.id } })
        return
      }
      if (data.type === 'cancel') return
      if (data.type !== 'fetch') return
      requests.push({
        start: data.start, end: data.end, async: true, shared: true, timeout: data.timeoutMs,
        headers: new Map(),
      })
      new Uint8Array(data.bytes).fill(7)
      const state = new Int32Array(data.state)
      if (data.state.byteLength > 8) {
        const rawHeaders = new TextEncoder().encode(
          `content-range: bytes ${data.start}-${data.end}/${data.total}\r\netag: "disc-v1"\r\n`,
        )
        new Uint8Array(data.state, 8).set(rawHeaders)
      }
      Atomics.store(state, 0, 1)
      Atomics.notify(state, 0)
      this.onmessage?.({ data: { type: 'done', id: data.id, key: data.key } })
    }
  }

  class FakeXMLHttpRequest {
    constructor() {
      this.headers = new Map()
      this.readyState = 0
      this.status = 0
      this.statusText = ''
      this.response = null
      this.responseURL = ''
      this.responseType = ''
      this.timeout = 0
      this.withCredentials = false
      this.aborted = false
      this.asyncActive = false
    }

    open(method, url, async = true) {
      this.method = method
      this.url = url
      this.async = async !== false
      this.responseURL = url
      this.readyState = 1
    }

    setRequestHeader(name, value) {
      this.headers.set(String(name).toLowerCase(), String(value))
    }

    overrideMimeType() {}

    send() {
      const match = /^bytes=(\d+)-(\d+)$/.exec(this.headers.get('range') || '')
      assert.ok(match, '测试请求必须是 Range')
      const start = Number(match[1])
      const end = Number(match[2])
      requests.push({ start, end, async: this.async, timeout: this.timeout, headers: new Map(this.headers) })
      if (!this.async && syncFailures > 0) {
        syncFailures--
        // 同步 XHR 的网络失败：浏览器要么直接抛 NetworkError，要么以 status 0 收尾
        if (syncFailMode === 'throw') throw new Error('NetworkError: Failed to execute send')
        if (syncFailMode === 'timeout') {
          timeoutsSeen.push(this.timeout)
          fakeNow += this.timeout
          const error = new Error('Timed out'); error.name = 'TimeoutError'; throw error
        }
        this.readyState = 4
        this.status = 0
        this.onreadystatechange?.({ target: this })
        this.onerror?.({ target: this })
        return
      }
      const finish = () => {
        if (this.aborted) return
        if (this.asyncActive) {
          this.asyncActive = false
          activeAsync--
        }
        this.status = 206
        this.statusText = 'Partial Content'
        this.readyState = 4
        this.response = new ArrayBuffer(end - start + 1)
        this.rawHeaders = `content-range: bytes ${start}-${end}/${total}\r\netag: "disc-v1"\r\n`
        this.onreadystatechange?.({ target: this })
        this.onload?.({ target: this })
      }
      if (this.async) {
        this.asyncActive = true
        activeAsync++
        maxActiveAsync = Math.max(maxActiveAsync, activeAsync)
        pending.push(finish)
      } else {
        fakeNow += syncDurationMs
        finish()
      }
    }

    abort() {
      if (this.aborted) return
      this.aborted = true
      if (this.asyncActive) {
        this.asyncActive = false
        activeAsync--
      }
      this.onabort?.({ target: this })
    }

    getAllResponseHeaders() {
      return this.rawHeaders || ''
    }
  }

  const navigator = {
    deviceMemory,
    hardwareConcurrency,
    maxTouchPoints: mobile ? 5 : 0,
    userAgent: mobile ? 'Mozilla/5.0 (Linux; Android 10) Mobile' : 'Desktop Test Browser',
  }
  if (effectiveType !== null) {
    navigator.connection = { effectiveType, saveData, ...(downlink === undefined ? {} : { downlink }) }
  }
  const context = {
    XMLHttpRequest: FakeXMLHttpRequest,
    navigator,
    console,
    Map,
    ArrayBuffer,
    Number,
    String,
    Date: { now: () => fakeNow },
    Uint8Array,
    SharedArrayBuffer,
    TextEncoder,
    TextDecoder: BrowserTextDecoder,
    SharedWorker: sharedPortMode ? FakeSharedWorker : undefined,
    __8bitgoRangeBrokerPort: brokerPortMode ? new FakeBrokerPort() : undefined,
    URL,
    location: { href: 'https://8bitgo.test/ppsspp/v15/PPSSPPSDL.worker.js' },
    ENVIRONMENT_IS_PTHREAD: sharedWorker || sharedPortMode || brokerPortMode,
    Worker: sharedWorker || sharedPortMode ? FakeWorker : undefined,
    Atomics: {
      load: Atomics.load.bind(Atomics),
      store: Atomics.store.bind(Atomics),
      add: Atomics.add.bind(Atomics),
      notify: Atomics.notify.bind(Atomics),
      wait(view, index, expected) {
        sharedWaits++
        competingJobsAtWait = Math.max(competingJobsAtWait, Math.max(0, (workers[0]?.jobs.size ?? 0) - 1))
        const job = workers[0]?.jobs.values().find((item) => item.state === view.buffer)
        if (job && Atomics.load(view, index) === expected) workers[0].complete(job.start)
        return 'ok'
      },
    },
  }
  context.globalThis = context
  vm.runInNewContext(source, context, { filename: 'range-read-ahead.js' })

  const demand = (start, end, validator = '"disc-v1"') => {
    const xhr = context.__8bitgoCreatePspRangeXhr()
    xhr.open('GET', discUrl, false)
    xhr.responseType = 'arraybuffer'
    xhr.setRequestHeader('Range', `bytes=${start}-${end}`)
    xhr.setRequestHeader('Accept', 'application/octet-stream')
    if (validator) xhr.setRequestHeader('If-Match', validator)
    let loaded = false
    xhr.onload = () => { loaded = true }
    xhr.send(null)
    assert.equal(loaded, true, '同步读盘必须在 send 返回前完成')
    return xhr
  }

  const flushOne = () => pending.shift()?.()
  return {
    context,
    demand,
    flushOne,
    requests,
    pending,
    activeAsync: () => activeAsync,
    maxActiveAsync: () => maxActiveAsync,
    readyWorker: () => {
      context.__8bitgoCreatePspRangeXhr()
      workers[0]?.onmessage?.({ data: { type: 'ready' } })
    },
    completeShared: (start, notifyParent = false) => workers[0]?.complete(start, notifyParent),
    sharedJob: (start) => workers[0]?.jobs.get(start),
    deliverSharedDone: (job) => workers[0]?.onmessage?.({ data: { type: 'done', id: job.id, key: job.key } }),
    sharedJobs: () => workers[0]?.jobs.size ?? 0,
    sharedWaits: () => sharedWaits,
    competingJobsAtWait: () => competingJobsAtWait,
    failNextSync: (count, mode = 'throw') => { syncFailures = count; syncFailMode = mode },
    timeoutsSeen,
  }
}

{
  // Chromium DedicatedWorker 没有 SharedWorker 构造器。没有网络测速 API 时仍要用页面 Broker 合并需求 Range，
  // 但不能因此打开投机预读。
  const runtime = makeRuntime(null, false, 8, 8, false, 6, 'https://assets.test/no-network-api.chd', undefined, 0, true, false, true)
  runtime.demand(0, 0, '')
  const before = runtime.requests.filter((request) => !request.async).length
  const shared = runtime.demand(0, BLOCK - 1)
  assert.equal(shared.status, 206)
  assert.equal(runtime.requests.filter((request) => !request.async).length, before,
    'pthread 的 MessagePort Broker 命中时不应再发同步 XHR')
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().sharedDemandRequests, 1,
    '弱网无预读时仍应启用跨 pthread 正式读盘 Broker')
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().concurrency, 0,
    'Broker 去重不能隐式开启投机下载')
}

{
  const runtime = makeRuntime()
  runtime.demand(0, 0, '')
  assert.equal(runtime.pending.length, 0, '取得盘大小的 1 字节探测不能误触发 2MB 预读')

  runtime.demand(0, BLOCK - 1)
  assert.equal(runtime.activeAsync(), 1, '尚未确认顺序读取时只留一条投机连接，避免压住正式读盘')
  runtime.flushOne()
  assert.equal(runtime.activeAsync(), 1, '第一块完成后应补足第二块小窗口')
  runtime.flushOne()

  const before = runtime.requests.filter((request) => !request.async).length
  const cached = runtime.demand(BLOCK, BLOCK * 2 - 1)
  assert.equal(cached.response.byteLength, BLOCK)
  assert.equal(
    runtime.requests.filter((request) => !request.async).length,
    before,
    '命中预读块时不能再发同步网络请求',
  )
  assert.equal(runtime.activeAsync(), 3, '确认顺序消费后应扩充滚动窗口')
  while (runtime.activeAsync()) runtime.flushOne()
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().cachedBlocks, 4,
    '测试盘剩余四块应进入滚动缓冲')
  assert.ok(runtime.context.__8bitgoPspRangeWarmStats().cachedBlocks <= 12, '预读缓存必须受 24MB 上限约束')
}

{
  const runtime = makeRuntime('4g', false, 8, 8, false, 20)
  for (const start of [0, BLOCK * 5, BLOCK * 10, BLOCK * 15]) {
    runtime.demand(start, start + BLOCK - 1)
  }
  const policy = runtime.context.__8bitgoPspRangeWarmStats()
  assert.equal(policy.concurrency, 1, '连续随机寻道且预读没有命中时应给正式读盘留足带宽')
  assert.equal(policy.depth, 2, '低命中阶段仍保留小窗口以探测后续顺序读取')
  assert.equal(policy.cacheBytes, 4 * 1024 * 1024, '无效投机不得长期占住 24MB 缓存')
}

{
  const runtime = makeRuntime('4g', false, 8, 8, false, 24)
  // 模拟首批分片都慢到被正式读取追上：即使还没命中，持续顺序读取也不能永远锁死在单路。
  for (let block = 0; block < 5; block++) runtime.demand(block * BLOCK, (block + 1) * BLOCK - 1)
  const policy = runtime.context.__8bitgoPspRangeWarmStats()
  assert.equal(policy.assessedHits, 0)
  assert.ok(policy.sequentialDemandRun >= 3)
  assert.equal(policy.concurrency, 2, '持续顺序读盘在低命中后应恢复有限双路预读')
  assert.equal(policy.depth, 6, '恢复窗口仍受限，不能直接冲到十块最大档')
  runtime.demand(BLOCK * 15, BLOCK * 16 - 1)
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().concurrency, 1,
    '一旦重新随机寻道，应立即收回到单路小窗口')
}

{
  const runtime = makeRuntime('4g', false, 8, 8, true)
  runtime.readyWorker()
  runtime.demand(0, BLOCK - 1)
  assert.equal(runtime.sharedJobs(), 1, '首次需求只启动一条独立 Worker 预读')
  runtime.completeShared(BLOCK)
  const before = runtime.requests.filter((request) => !request.async).length
  const hit = runtime.demand(BLOCK, BLOCK * 2 - 1)
  assert.equal(hit.response.byteLength, BLOCK)
  assert.equal(new Uint8Array(hit.response)[0], 7)
  assert.equal(runtime.requests.filter((request) => !request.async).length, before,
    '模拟线程尚未处理 Worker 完成消息时，正式读盘也必须直接消费共享分片')
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().prefetchHits, 1)
}

{
  const runtime = makeRuntime('4g', false, 8, 8, true)
  runtime.readyWorker()
  runtime.demand(0, BLOCK - 1)
  const before = runtime.requests.filter((request) => !request.async).length
  runtime.demand(BLOCK, BLOCK * 2 - 1)
  assert.equal(runtime.sharedWaits(), 1, '正式读盘追上进行中的共享预读时必须等待已在路上的数据')
  assert.equal(runtime.requests.filter((request) => !request.async).length, before,
    '等待共享预读完成后不得重复下载同一块')
  runtime.demand(BLOCK * 2, BLOCK * 3 - 1)
  assert.equal(runtime.competingJobsAtWait(), 0,
    '正式读盘等待共享分片时，其他投机连接必须先让出带宽')
}

{
  const runtime = makeRuntime('4g', false, 8, 8, true)
  runtime.readyWorker()
  runtime.demand(0, BLOCK - 1)
  runtime.demand(BLOCK, BLOCK * 2 - 1, '"disc-v2"')
  assert.equal(runtime.sharedWaits(), 0, '镜像校验器变化后不能等待旧版预读')
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().demandTakeovers, 1)
}

{
  const runtime = makeRuntime('4g', false, 8, 8, true)
  runtime.readyWorker()
  runtime.demand(0, BLOCK - 1)
  const old = runtime.sharedJob(BLOCK)
  runtime.demand(BLOCK * 4, BLOCK * 5 - 1)
  runtime.demand(0, BLOCK - 1)
  const replacement = runtime.sharedJob(BLOCK)
  assert.ok(replacement && replacement.id !== old.id, '取消后同一范围应有新的独立请求身份')
  const before = runtime.context.__8bitgoPspRangeWarmStats().activePrefetches
  runtime.deliverSharedDone(old)
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().activePrefetches, before,
    '旧请求的延迟完成消息不能释放新请求的并发槽')
}

{
  const runtime = makeRuntime('3g')
  runtime.demand(0, BLOCK - 1)
  assert.equal(runtime.activeAsync(), 1, '3G 未确认顺序读取前不能立即占两路连接')
  runtime.demand(BLOCK, BLOCK * 2 - 1)
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().concurrency, 3,
    '3G 连续读取且追上预读后应扩到三路隐藏延迟')
}

{
  const runtime = makeRuntime('4g', false, 2, 2)
  runtime.demand(0, BLOCK - 1)
  assert.equal(runtime.activeAsync(), 1, '低内存双核设备首次只开一条投机流')
  runtime.demand(BLOCK, BLOCK * 2 - 1)
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().concurrency, 2,
    '低内存双核设备确认顺序读取后预读并发仍封顶两路')
}

{
  const runtime = makeRuntime('2g')
  runtime.demand(0, BLOCK - 1)
  assert.equal(runtime.pending.length, 0, '2G 网络不能让后台预读与正式读盘争抢带宽')
}

{
  const slow = makeRuntime('3g', false, 8, 8, false, 6, 'https://assets.test/slow.chd', 0.2)
  slow.demand(0, BLOCK - 1)
  const demand = slow.requests.find((request) => !request.async)
  const prefetch = slow.requests.find((request) => request.async)
  assert.ok(demand.timeout >= 130_000, '0.2 Mbps 下正式 2 MiB Range 不应在 30 秒时丢弃并重下')
  assert.ok(prefetch.timeout >= 130_000, '弱网预读应沿用可完成 2 MiB 的自适应时限')
  assert.equal(slow.context.__8bitgoPspRangeWarmStats().rangeTimeoutMs, demand.timeout,
    '诊断快照应显示当前网络采用的实际 Range 时限')
}

{
  const overreported = makeRuntime('4g', false, 8, 8, false, 6, 'https://assets.test/overreported.chd', 10)
  overreported.demand(0, BLOCK - 1)
  const first = overreported.requests.find((request) => !request.async)
  assert.ok(first.timeout >= 120_000,
    '工作线程尚无实测吞吐时不能因为 4G downlink 虚高而把首个 2 MiB Range 限在 20 秒')
}

{
  const mobile = makeRuntime('4g', false, 8, 8, false, 6, 'https://assets.test/mobile-slow.chd', 10, 17_000, true)
  mobile.demand(0, BLOCK - 1)
  assert.equal(mobile.requests.filter((request) => !request.async).at(-1).timeout, 120_000,
    '手机 4G 虚高但尚无实测时首块至少保留 120 秒')
  assert.equal(mobile.context.__8bitgoPspRangeWarmStats().concurrency, 1,
    '手机首块不能因虚高测速立即发多路投机 Range')
  assert.ok(Math.abs(mobile.context.__8bitgoPspRangeWarmStats().measuredMbps - 0.99) < 0.03,
    '手机正式盘块应更新实际吞吐样本')
  mobile.demand(BLOCK, BLOCK * 2 - 1)
  assert.equal(mobile.requests.filter((request) => !request.async).at(-1).timeout, 120_000,
    '手机低于 1 Mbps 的实测盘块也必须保留至少 120 秒')
  assert.equal(mobile.context.__8bitgoPspRangeWarmStats().concurrency, 1,
    '手机低实测速率下只能保留一条滚动预读')
}

{
  // 没有 Network Information API 的浏览器先用保守时限；有效盘块的实测吞吐应接管后续估算。
  const probe = makeRuntime(null)
  probe.context.__8bitgoCreatePspRangeXhr()
  assert.equal(probe.context.__8bitgoPspRangeWarmStats().concurrency, 0,
    '无网络测速 API 且尚无正文样本时不能按设备核心数启动投机预读')
  probe.demand(0, 0, '')
  assert.equal(probe.context.__8bitgoPspRangeWarmStats().measuredMbps, 0,
    '单字节盘大小探测不能污染真实读盘吞吐')

  const slowUnknown = makeRuntime(null, false, 8, 8, false, 6, 'https://assets.test/slow-unknown.chd', undefined, 168_000)
  slowUnknown.demand(0, BLOCK - 1)
  const first = slowUnknown.requests.filter((request) => !request.async).at(-1)
  assert.equal(first.timeout, 180_000, '无网络测速信息时首块 2 MiB 读盘应允许弱网完成')
  assert.ok(Math.abs(slowUnknown.context.__8bitgoPspRangeWarmStats().measuredMbps - 0.1) < 0.01,
    '正式读盘成功后应记录约 0.1 Mbps 的实测吞吐')
  assert.equal(slowUnknown.activeAsync(), 1,
    '实测低于 1 Mbps 后最多只允许一条滚动预读，不能让投机请求挤满弱链路')
  assert.equal(slowUnknown.context.__8bitgoPspRangeWarmStats().depth, 1,
    '实测低于 1 Mbps 后预读窗口必须只保留一块')

  slowUnknown.demand(BLOCK, BLOCK * 2 - 1)
  const syncRequests = slowUnknown.requests.filter((request) => !request.async)
  assert.equal(syncRequests.length, 2, '慢速连续读盘每块只请求一次，不应反复超时重下')
  assert.equal(syncRequests[1].timeout, 180_000,
    '实测低速后下一块仍应保留有限但足够的时限')
}

{
  const slowShared = makeRuntime('3g', false, 8, 8, true, 6, 'https://assets.test/slow.chd', 0.2)
  slowShared.readyWorker()
  slowShared.demand(0, BLOCK - 1)
  assert.ok(slowShared.sharedJob(BLOCK).timeoutMs >= 130_000,
    '独立预读 Worker 必须收到与正式 XHR 一致的弱网时限')
}

{
  const runtime = makeRuntime('4g', true)
  runtime.demand(0, BLOCK - 1)
  assert.equal(runtime.pending.length, 0, '省流量模式必须完全关闭 PSP 预读')
}

{
  const runtime = makeRuntime()
  runtime.demand(0, BLOCK - 1)
  assert.equal(runtime.activeAsync(), 1)
  runtime.demand(BLOCK * 4, BLOCK * 5 - 1)
  assert.equal(runtime.requests.filter((request) => !request.async).at(-1).start, BLOCK * 4, '随机寻道必须让正式请求立即接管')
  assert.ok(runtime.context.__8bitgoPspRangeWarmStats().queuedBlocks <= 6)
}

{
  const runtime = makeRuntime('3g')
  runtime.demand(0, BLOCK - 1)
  assert.equal(runtime.activeAsync(), 1)
  // 正式请求追上小窗口后应围绕确认的顺序位置扩窗。
  runtime.demand(BLOCK, BLOCK * 2 - 1)
  assert.equal(runtime.activeAsync(), 3, '同步读盘追上预读后应自动扩到三路，避免周期性再次追尾')
  assert.equal(runtime.maxActiveAsync(), 3, '取消回调不能越过自适应策略放出额外请求')
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().demandTakeovers, 1)
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().pressureLevel, 1)
}

{
  const runtime = makeRuntime('4g', false, 8, 8, false, 20)
  runtime.demand(0, BLOCK - 1)
  runtime.demand(BLOCK, BLOCK * 2 - 1)
  assert.equal(runtime.activeAsync(), 4)
  assert.ok(runtime.context.__8bitgoPspRangeWarmStats().queuedBlocks >= 1)
  // 第五个预读块还在队列里；随机寻道追到它时必须优先正式 Range。
  runtime.demand(BLOCK * 6, BLOCK * 7 - 1)
  assert.equal(runtime.activeAsync(), 1, '追到排队块时应取消旧窗口，仅重开一条小窗口')
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().demandTakeovers, 2)
}

{
  const runtime = makeRuntime()
  runtime.demand(0, BLOCK - 1)
  runtime.flushOne()
  const before = runtime.requests.filter((request) => !request.async).length
  runtime.demand(BLOCK, BLOCK * 2 - 1, '"disc-v2"')
  assert.equal(
    runtime.requests.filter((request) => !request.async).length,
    before + 1,
    '资源校验器变化后必须丢弃旧预读，不能把两版游戏镜像拼在一起',
  )
}

{
  // 钉了 romv 的地址：条件头只记不发，好让浏览器 HTTP 缓存接住重复读取（Chromium 对带
  // If-Match / If-Unmodified-Since 的请求一律绕过缓存）。外链仍照常发。
  const pinned = makeRuntime('4g', false, 8, 8, false, 6, 'https://assets.test/game.chd?romv=abc-1')
  pinned.demand(0, BLOCK - 1)
  const demandReq = pinned.requests.find((request) => !request.async)
  assert.equal(demandReq.headers.get('if-match'), undefined, '钉了代次的正式读盘不能再带 If-Match')
  assert.equal(demandReq.headers.get('range'), `bytes=0-${BLOCK - 1}`)
  pinned.flushOne()
  const prefetchReq = pinned.requests.find((request) => request.async)
  assert.ok(prefetchReq, '仍会发预读')
  assert.equal(prefetchReq.headers.get('if-match'), undefined, '同线程预读同样不带条件头')
  // 不带条件头的预读结果仍要按 ETag 认：同一个校验器命中，换了校验器作废
  const hits = pinned.context.__8bitgoPspRangeWarmStats().prefetchHits
  pinned.demand(BLOCK, BLOCK * 2 - 1)
  assert.equal(pinned.context.__8bitgoPspRangeWarmStats().prefetchHits, hits + 1, '同一校验器的预读照常命中')

  const external = makeRuntime()
  external.demand(0, BLOCK - 1)
  assert.equal(external.requests.find((request) => !request.async).headers.get('if-match'), '"disc-v1"', '没有 romv 的外链必须继续带 If-Match')

  const shared = makeRuntime('4g', false, 8, 8, true, 6, 'https://assets.test/game.chd?romv=abc-1')
  shared.readyWorker()
  shared.demand(0, BLOCK - 1)
  const job = shared.sharedJob(BLOCK)
  assert.ok(job, '共享 Worker 预读已排上')
  assert.equal(job.sendValidators, false, '共享 Worker 的钉代次预读也不发条件头')
  assert.equal(job.ifMatch, '"disc-v1"', '但校验器仍随任务带过去，用来核对响应')
}

{
  // 2026-11-10：海外玩家进游戏后一次断流就整局报 HTTP 0；同步读盘先在 JS 层退避重试
  for (const mode of ['throw', 'status0']) {
    const runtime = makeRuntime('4g', false, 8, 8, false, 6, 'https://assets.test/game.chd?romv=abc-1')
    runtime.failNextSync(2, mode)
    let errors = 0
    const states = []
    const xhr = runtime.context.__8bitgoCreatePspRangeXhr()
    xhr.open('GET', 'https://assets.test/game.chd?romv=abc-1', false)
    xhr.responseType = 'arraybuffer'
    xhr.timeout = 30_000
    xhr.setRequestHeader('Range', `bytes=0-${BLOCK - 1}`)
    xhr.setRequestHeader('If-Match', '"disc-v1"')
    let loaded = false
    xhr.onload = () => { loaded = true }
    xhr.onerror = () => { errors++ }
    xhr.onreadystatechange = () => states.push([xhr.readyState, xhr.status])
    xhr.send(null)
    assert.equal(loaded, true, `${mode}：两次网络失败后第三次成功，send 返回前就拿到数据`)
    assert.equal(errors, 0, `${mode}：被重试吃掉的失败不能报给 Emscripten`)
    assert.equal(xhr.status, 206)
    assert.equal(xhr.response.byteLength, BLOCK)
    assert.ok(states.every(([state, status]) => !(state === 4 && status === 0)), `${mode}：重试中的 readyState 4 / status 0 不外泄`)
    const sync = runtime.requests.filter((request) => !request.async)
    assert.equal(sync.length, 3, `${mode}：一共发了三次正式请求`)
    assert.equal(sync[2].headers.get('range'), `bytes=0-${BLOCK - 1}`, '重试原样重放 Range 头')
    assert.equal(sync[2].headers.get('if-match'), undefined, '钉了 romv 的条件头重试时同样不发')
    const stats = runtime.context.__8bitgoPspRangeWarmStats()
    assert.equal(stats.syncRetries, 2)
    assert.equal(stats.syncRecovered, 1)
  }

  // 一直失败：用完重试次数后把错误交回 C++（它再决定重试或报错），不能无限卡住模拟线程
  const broken = makeRuntime()
  broken.failNextSync(100, 'throw')
  const xhr = broken.context.__8bitgoCreatePspRangeXhr()
  xhr.open('GET', 'https://assets.test/game.chd', false)
  xhr.setRequestHeader('Range', `bytes=0-${BLOCK - 1}`)
  assert.throws(() => xhr.send(null), /NetworkError/, '最后一次失败原样抛给 Emscripten')
  assert.equal(broken.requests.filter((request) => !request.async).length, 5, '首发 + 4 次重试')

  // 慢线路：无实测吞吐时首块至少留 120 秒，超时后的退避仍不会超过 180 秒上限。
  const slow = makeRuntime('4g', false, 8, 8, false, 6, 'https://assets.test/game.chd?romv=abc-1')
  slow.failNextSync(2, 'timeout')
  const slowXhr = slow.context.__8bitgoCreatePspRangeXhr()
  slowXhr.open('GET', 'https://assets.test/game.chd?romv=abc-1', false)
  slowXhr.timeout = 30_000
  slowXhr.setRequestHeader('Range', `bytes=0-${BLOCK - 1}`)
  let slowLoaded = false
  slowXhr.onload = () => { slowLoaded = true }
  slowXhr.send(null)
  assert.equal(slowLoaded, true)
  assert.deepEqual(slow.timeoutsSeen, [120_000, 180_000], '未实测首块至少 120 秒，后续超时放宽到 180 秒')
  assert.equal(slowXhr.timeout, 180_000, '时限不能超过 180 秒上限')
  assert.equal(slow.context.__8bitgoPspRangeWarmStats().syncTimeouts, 2)

  // 网络估算允许超过 120 秒时，失败退避不能把原有长时限反向缩短。
  const long = makeRuntime('4g', false, 8, 8, false, 6, 'https://assets.test/game.chd?romv=abc-1')
  long.failNextSync(1, 'timeout')
  const longXhr = long.context.__8bitgoCreatePspRangeXhr()
  longXhr.open('GET', 'https://assets.test/game.chd?romv=abc-1', false)
  longXhr.timeout = 100_000
  longXhr.setRequestHeader('Range', `bytes=0-${BLOCK - 1}`)
  longXhr.send(null)
  assert.deepEqual(long.timeoutsSeen, [120_000], '长时限超时前仍须应用更高的弱网首块下限')
  assert.equal(longXhr.timeout, 180_000, '长时限超时后应放宽到 180 秒总上限，不能降为 120 秒')
}

{
  const runtime = makeRuntime('4g', false, 8, 8, false, 6, 'https://assets.test/shared.chd', undefined, 0, false, true)
  runtime.demand(0, 0, '')
  const before = runtime.requests.filter((request) => !request.shared).length
  const xhr = runtime.demand(0, BLOCK - 1)
  assert.equal(xhr.status, 206)
  assert.equal(xhr.response.byteLength, BLOCK)
  assert.match(xhr.getAllResponseHeaders(), /etag: "disc-v1"/i,
    '共享 Range 必须把核心后续校验要用的 ETag 交还给 PPSSPP')
  assert.equal(runtime.requests.filter((request) => !request.shared).length, before,
    'SharedWorker 能用同步共享缓冲返回正文时不能再发一条原生同步 XHR')
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().sharedDemandRequests, 1)
}

{
  const runtime = makeRuntime(null, false, 8, 8, false, 6, 'https://assets.test/messageport-first-demand.chd', undefined, 0, false, false, true)
  runtime.demand(0, 0, '')
  const before = runtime.requests.filter((request) => !request.shared).length
  const xhr = runtime.demand(0, BLOCK - 1)
  assert.equal(xhr.status, 206)
  assert.equal(runtime.requests.filter((request) => !request.shared).length, before,
    'pthread 通过 MessagePort 初始化 Broker 后应直接共享响应，不能再发原生同步请求')
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().sharedDemandRequests, 1)
}

console.log('✔ PSP 自适应 Range：独立与共享 Worker 命中、同步等待、跨线程按需读取和版本隔离均通过')
