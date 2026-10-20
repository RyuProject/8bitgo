import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../vendor/ppsspp/range-read-ahead.js', import.meta.url), 'utf8')
const BLOCK = 2 * 1024 * 1024

function makeRuntime(effectiveType = '4g', saveData = false, deviceMemory = 8, hardwareConcurrency = 8, sharedWorker = false, totalBlocks = 6) {
  const total = BLOCK * totalBlocks
  const requests = []
  const pending = []
  const workers = []
  let activeAsync = 0
  let maxActiveAsync = 0
  let sharedWaits = 0
  let competingJobsAtWait = 0

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
      requests.push({ start, end, async: this.async })
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
      }
      else finish()
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

  const context = {
    XMLHttpRequest: FakeXMLHttpRequest,
    navigator: { connection: { effectiveType, saveData }, deviceMemory, hardwareConcurrency },
    console,
    Map,
    ArrayBuffer,
    Number,
    String,
    Date,
    Uint8Array,
    SharedArrayBuffer,
    URL,
    location: { href: 'https://8bitgo.test/ppsspp/v15/PPSSPPSDL.worker.js' },
    ENVIRONMENT_IS_PTHREAD: sharedWorker,
    Worker: sharedWorker ? FakeWorker : undefined,
    Atomics: {
      load: Atomics.load.bind(Atomics),
      store: Atomics.store.bind(Atomics),
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
    xhr.open('GET', 'https://assets.test/game.chd', false)
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
  }
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

console.log('✔ PSP 自适应滚动预读：共享 Worker 命中、同步等待、四路填充、追尾扩窗与版本隔离均通过')
