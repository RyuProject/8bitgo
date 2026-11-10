#!/usr/bin/env node
/**
 * 引擎下载器补丁的行为回归（patch-emulatorjs.mjs 第十、十一节）。
 *
 * 直接把 public/emulatorjs/emulator.min.js 开头的下载器 / 缓存类切出来在 Node 里跑：
 *   - 包体发到 100% 却迟迟不结束时，20 秒无新数据必须 abort 并 reject（以前永远停在「下载游戏核心 100%」）；
 *   - 缓存 put 卡住时 10 秒后照样交出下载结果；
 *   - IndexedDB 封装里 transaction() 同步抛错时 Promise 必须 settle。
 * 定时器按 1/1000 缩放，整个测试几十毫秒跑完。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const engine = readFileSync(new URL('../public/emulatorjs/emulator.min.js', import.meta.url), 'utf8')
const cut = engine.indexOf('class r{constructor(t,e){this.EJS=e,this.Module=t')
assert.ok(cut > 0, '找不到 GameManager 类，引擎结构变了')
const prelude = engine.slice(0, cut)
assert.match(prelude, /class s\{constructor\(t=null,e=null\)\{this\.storageCache=t,this\.EJS=e\}/, '下载器类名变了，更新本测试')

function makeContext({ fetchImpl, indexedDB, localStorage }) {
  const realSetTimeout = setTimeout
  const context = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms = 0) => realSetTimeout(fn, Math.max(0, Math.ceil(ms / 1000))),
    clearTimeout,
    fetch: fetchImpl,
    AbortController,
    Blob,
    Uint8Array,
    ArrayBuffer,
    TextEncoder,
    TextDecoder,
    URL,
    Date,
    Promise,
    performance,
    window: { indexedDB },
    indexedDB,
    ...(localStorage ? { localStorage } : {}),
  }
  context.globalThis = context
  vm.runInNewContext(`${prelude};globalThis.__classes={Storage:e,Downloader:s,Cache:o}`, context)
  return context
}

const stalledBody = (bytes) => new ReadableStream({
  start(controller) { controller.enqueue(bytes) },
  // 之后再也不 close：模拟最后几个包丢了、连接半开
})

{
  const total = 1024
  const fetchImpl = async (_url, init) => {
    const body = stalledBody(new Uint8Array(total))
    init.signal.addEventListener('abort', () => body.cancel().catch(() => {}))
    return new Response(new ReadableStream({
      async start(controller) {
        controller.enqueue(new Uint8Array(total))
        init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
      },
    }), { status: 200, headers: { 'Content-Length': String(total) } })
  }
  const { __classes } = makeContext({ fetchImpl, indexedDB: undefined })
  const downloader = new __classes.Downloader(null, null)
  const progress = []
  const started = Date.now()
  await assert.rejects(
    downloader.downloadFile('https://8bitgo.test/emulatorjs/cores/fbneo-legacy-wasm.data', 'Core', 'GET', {}, null, (...a) => progress.push(a), null, 30000, 'arraybuffer'),
    /Download failed/,
    '包体卡在 100% 时必须 reject，交给播放器重试',
  )
  assert.ok(progress.some(([phase, pct]) => phase === 'downloading' && pct === 100), '确实先到了 100%')
  assert.ok(Date.now() - started < 2000, '按缩放后的 20 秒中止')
}

{
  // 正常下载 + 缓存 put 永远不返回：10 秒后照样交出结果
  const fetchImpl = async () => new Response(new Uint8Array([1, 2, 3, 4]), { status: 200, headers: { 'Content-Length': '4' } })
  const { __classes } = makeContext({ fetchImpl, indexedDB: undefined })
  const hangingCache = {
    get: () => new Promise(() => {}),
    put: () => new Promise(() => {}),
    generateCacheKey: () => 'k',
  }
  const downloader = new __classes.Downloader(hangingCache, null)
  const item = await downloader.downloadFile('https://8bitgo.test/emulatorjs/cores/mgba-wasm.data', 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer')
  assert.deepEqual([...item.files[0].bytes], [1, 2, 3, 4], '缓存 get / put 卡住也要交出下载结果')
}

{
  // transaction() 在 onsuccess 里同步抛错（表不存在 / 库正在关闭）
  const indexedDB = {
    open() {
      const request = {}
      setTimeout(() => {
        request.result = { transaction() { throw new DOMException('One of the specified object stores was not found.', 'NotFoundError') } }
        request.onsuccess?.()
      })
      return request
    },
  }
  const { __classes } = makeContext({ fetchImpl: fetch, indexedDB })
  const storage = new __classes.Storage('EmulatorJS-Cache', 'blobs')
  const value = await Promise.race([storage.get('x'), new Promise((resolve) => setTimeout(() => resolve('hung'), 500))])
  assert.equal(value, undefined, 'transaction 抛错时 get 立即当作没有缓存')
  const put = await Promise.race([storage.put('x', 1).then(() => 'ok'), new Promise((resolve) => setTimeout(() => resolve('hung'), 500))])
  assert.equal(put, 'ok')
}

{
  // 第十一节：IndexedDB 挂死时只等一次。get 超时后本局后续下载不再查缓存，并在 localStorage 记下来
  const fetchImpl = async () => new Response(new Uint8Array([5, 6]), { status: 200, headers: { 'Content-Length': '2' } })
  const store = new Map()
  const localStorage = { setItem: (k, v) => store.set(k, String(v)), getItem: (k) => store.get(k) ?? null }
  const { __classes } = makeContext({ fetchImpl, indexedDB: undefined, localStorage })
  let gets = 0
  let puts = 0
  const hangingCache = {
    get: () => { gets++; return new Promise(() => {}) },
    put: () => { puts++; return new Promise(() => {}) },
    generateCacheKey: () => 'k',
  }
  const downloader = new __classes.Downloader(hangingCache, null)
  const t0 = Date.now()
  await downloader.downloadFile('https://8bitgo.test/emulatorjs/cores/reports/fceumm.json', 'Reports', 'GET', {}, null, null, null, 30000, 'text', !1, !0)
  assert.equal(gets, 1)
  assert.ok(Number(store.get('8bitgo.ejs.idbStall')) > 0, 'get 超时要记到 localStorage，适配器据此后几天关掉缓存')
  const progress = []
  const item = await downloader.downloadFile('https://8bitgo.test/emulatorjs/cores/fceumm-wasm.data', 'Core', 'GET', {}, null, (...a) => progress.push(a), null, 30000, 'arraybuffer')
  assert.deepEqual([...item.files[0].bytes], [5, 6])
  assert.equal(gets, 1, '缓存判死以后，核心下载不再先等一次 get')
  assert.equal(puts, 0, '缓存判死以后也不再 put')
  assert.ok(progress.some(([phase]) => phase === 'downloading'), '核心下载立刻出进度文字，不会被判卡住')
  // 缩放后：一次 get 超时 15ms，远小于两次（以前要连等 2 × 20 秒）
  assert.ok(Date.now() - t0 < 1000)
}

{
  // 文本响应（核心报告）的包体读不完：20 秒后 reject，不能永远挂着
  const fetchImpl = async (_url, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"buildStart":'))
      init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
    },
  }), { status: 200 })
  const { __classes } = makeContext({ fetchImpl, indexedDB: undefined })
  const downloader = new __classes.Downloader(null, null)
  await assert.rejects(
    downloader.downloadFile('https://8bitgo.test/emulatorjs/cores/reports/fceumm.json', 'Reports', 'GET', {}, null, null, null, 30000, 'text', !1, !0),
    /Download failed/,
  )
}

{
  // 缓存过期后的 HEAD 复验卡住：8 秒后放弃复验，直接用缓存
  const fetchImpl = (_url, init) => init.method === 'HEAD' ? new Promise(() => {}) : Promise.reject(new Error('不该走到 GET'))
  const { __classes } = makeContext({ fetchImpl, indexedDB: undefined })
  const cached = { cacheExpiry: 1, files: [{ filename: 'fceumm-wasm.data', bytes: new Uint8Array([9]) }] }
  const cache = { get: async () => cached, put: async () => {}, generateCacheKey: () => 'k' }
  const downloader = new __classes.Downloader(cache, null)
  const item = await Promise.race([
    downloader.downloadFile('https://8bitgo.test/emulatorjs/cores/fceumm-wasm.data', 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer'),
    new Promise((resolve) => setTimeout(() => resolve('hung'), 1000)),
  ])
  assert.equal(item, cached, 'HEAD 复验卡住时用缓存继续')
}

{
  const engineCore = /core:\{name:"Core",dontCache:!1,cdnFallback:!1\}/.test(engine)
  assert.ok(engineCore, '核心下载失败不能回落 cdn.emulatorjs.org（那里的 4.3.0-pre 核心起不来）')
}

console.log('✔ EmulatorJS 下载器：包体卡住 20 秒中止、缓存卡住不挡开局且只等一次、报告包体与 HEAD 复验有时限、IndexedDB 同步异常可收敛、核心不回落官方 CDN')
