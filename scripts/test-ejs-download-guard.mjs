#!/usr/bin/env node
/**
 * 引擎下载器补丁的行为回归（patch-emulatorjs.mjs 第十节）。
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

function makeContext({ fetchImpl, indexedDB }) {
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
  const engineCore = /core:\{name:"Core",dontCache:!1,cdnFallback:!1\}/.test(engine)
  assert.ok(engineCore, '核心下载失败不能回落 cdn.emulatorjs.org（那里的 4.3.0-pre 核心起不来）')
}

console.log('✔ EmulatorJS 下载器：包体卡住 20 秒中止、缓存卡住不挡开局、IndexedDB 同步异常可收敛、核心不回落官方 CDN')
