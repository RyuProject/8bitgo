import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../vendor/ppsspp/range-read-ahead.js', import.meta.url), 'utf8')
const BLOCK = 2 * 1024 * 1024
const TOTAL = BLOCK * 6

function makeRuntime(effectiveType = '4g', saveData = false) {
  const requests = []
  const pending = []

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
        this.status = 206
        this.statusText = 'Partial Content'
        this.readyState = 4
        this.response = new ArrayBuffer(end - start + 1)
        this.rawHeaders = `content-range: bytes ${start}-${end}/${TOTAL}\r\netag: "disc-v1"\r\n`
        this.onreadystatechange?.({ target: this })
        this.onload?.({ target: this })
      }
      if (this.async) pending.push(finish)
      else finish()
    }

    abort() {
      if (this.aborted) return
      this.aborted = true
      this.onabort?.({ target: this })
    }

    getAllResponseHeaders() {
      return this.rawHeaders || ''
    }
  }

  const context = {
    XMLHttpRequest: FakeXMLHttpRequest,
    navigator: { connection: { effectiveType, saveData } },
    console,
    Map,
    ArrayBuffer,
    Number,
    String,
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
  return { context, demand, flushOne, requests, pending }
}

{
  const runtime = makeRuntime()
  runtime.demand(0, 0, '')
  assert.equal(runtime.pending.length, 0, '取得盘大小的 1 字节探测不能误触发 2MB 预读')

  runtime.demand(0, BLOCK - 1)
  assert.equal(runtime.pending.length, 1, '首个真实块读完后应该启动一个低优先级预读')
  runtime.flushOne()
  assert.equal(runtime.pending.length, 1, '预读串行执行，第一块完成后才取第二块')
  runtime.flushOne()
  assert.equal(runtime.context.__8bitgoPspRangeWarmStats().cachedBlocks, 2)

  const before = runtime.requests.filter((request) => !request.async).length
  const cached = runtime.demand(BLOCK, BLOCK * 2 - 1)
  assert.equal(cached.response.byteLength, BLOCK)
  assert.equal(
    runtime.requests.filter((request) => !request.async).length,
    before,
    '命中预读块时不能再发同步网络请求',
  )
  assert.ok(runtime.context.__8bitgoPspRangeWarmStats().cachedBlocks <= 4, '预读缓存必须受 8MB 上限约束')
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
  assert.equal(runtime.pending.length, 1)
  runtime.demand(BLOCK * 4, BLOCK * 5 - 1)
  assert.equal(runtime.requests.filter((request) => !request.async).at(-1).start, BLOCK * 4, '随机寻道必须让正式请求立即接管')
  assert.ok(runtime.context.__8bitgoPspRangeWarmStats().queuedBlocks <= 2)
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

console.log('✔ PSP 自适应顺序预读：同步命中、串行限流、弱网降级、随机寻道取消、版本隔离均通过')
