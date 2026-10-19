import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../vendor/ppsspp/range-read-ahead.js', import.meta.url), 'utf8')
const BLOCK = 2 * 1024 * 1024
const TOTAL = BLOCK * 6

function makeRuntime(effectiveType = '4g', saveData = false, deviceMemory = 8, hardwareConcurrency = 8) {
  const requests = []
  const pending = []
  let activeAsync = 0
  let maxActiveAsync = 0

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
        this.rawHeaders = `content-range: bytes ${start}-${end}/${TOTAL}\r\netag: "disc-v1"\r\n`
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
  }
}

{
  const runtime = makeRuntime()
  runtime.demand(0, 0, '')
  assert.equal(runtime.pending.length, 0, '取得盘大小的 1 字节探测不能误触发 2MB 预读')

  runtime.demand(0, BLOCK - 1)
  assert.equal(runtime.activeAsync(), 4, '快速网络应并行填充滚动缓冲，隐藏单个 Range 的长尾')
  runtime.flushOne()
  assert.equal(runtime.activeAsync(), 4, '第一块完成后应立即从队列补足下一块，不留下带宽空洞')
  for (let i = 0; i < 7; i++) runtime.flushOne()
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().cachedBlocks, 5, '测试盘剩余五块应全部进入滚动缓冲')

  const before = runtime.requests.filter((request) => !request.async).length
  const cached = runtime.demand(BLOCK, BLOCK * 2 - 1)
  assert.equal(cached.response.byteLength, BLOCK)
  assert.equal(
    runtime.requests.filter((request) => !request.async).length,
    before,
    '命中预读块时不能再发同步网络请求',
  )
  assert.ok(runtime.context.__8bitgoPspRangeWarmStats().cachedBlocks <= 12, '预读缓存必须受 24MB 上限约束')
}

{
  const runtime = makeRuntime('3g')
  runtime.demand(0, BLOCK - 1)
  assert.equal(runtime.activeAsync(), 2, '3G 网络保留双路小窗口，避免持续媒体读取必然追上单路预读')
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().concurrency, 2)
}

{
  const runtime = makeRuntime('4g', false, 2, 2)
  runtime.demand(0, BLOCK - 1)
  assert.equal(runtime.activeAsync(), 2, '低内存双核设备必须把预读并发封顶为两路')
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().depth, 4)
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
  assert.equal(runtime.activeAsync(), 4)
  runtime.demand(BLOCK * 4, BLOCK * 5 - 1)
  assert.equal(runtime.requests.filter((request) => !request.async).at(-1).start, BLOCK * 4, '随机寻道必须让正式请求立即接管')
  assert.ok(runtime.context.__8bitgoPspRangeWarmStats().queuedBlocks <= 6)
}

{
  const runtime = makeRuntime('3g')
  runtime.demand(0, BLOCK - 1)
  assert.equal(runtime.activeAsync(), 2)
  // 正式请求追上正在预读的下一块时必须先清空两个投机请求，再围绕新位置重建窗口。
  runtime.demand(BLOCK, BLOCK * 2 - 1)
  assert.equal(runtime.activeAsync(), 3, '同步读盘追上预读后应自动扩到三路，避免周期性再次追尾')
  assert.equal(runtime.maxActiveAsync(), 3, '取消回调不能越过自适应策略放出额外请求')
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().demandTakeovers, 1)
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().pressureLevel, 1)
}

{
  const runtime = makeRuntime()
  runtime.demand(0, BLOCK - 1)
  assert.equal(runtime.activeAsync(), 4)
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().queuedBlocks, 1)
  // 第五个预读块还在队列里；正式读盘追到它时也必须让同步 Range 优先。
  runtime.demand(BLOCK * 5, BLOCK * 6 - 1)
  assert.equal(runtime.activeAsync(), 0, '追到排队块时必须取消仍在占带宽的四条投机请求')
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().demandTakeovers, 1)
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().pressureLevel, 1)
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

console.log('✔ PSP 自适应滚动预读：四路填充、低配限流、追尾扩窗、同步命中、随机寻道与版本隔离均通过')
