#!/usr/bin/env node
/**
 * 引擎下载器补丁的行为回归（超时、XHR 回退与核心 Range 断点续传）。
 *
 * 直接把 public/emulatorjs/emulator.min.js 开头的下载器 / 缓存类切出来在 Node 里跑：
 *   - Fetch 没有响应头超时或包体失速时，改用 XHR arraybuffer 完整重取一次；
 *   - XHR 在后台暂停空闲计时，回到前台后才重新给完整预算；
 *   - 缓存 put 卡住时 10 秒后照样交出下载结果；
 *   - IndexedDB 封装里 transaction() 同步抛错时 Promise 必须 settle；续传库挂起只影响持久化优化。
 *   - XHR 在同 ETag 下从精确偏移续上；ETag / Content-Range 错误时只允许完整重取。
 *   - 独立 IDB 跨页面恢复已提交的 1 MiB 前缀，绝不使用未完成的小片。
 * 定时器按 1/1000 缩放，整个测试几十毫秒跑完。
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { computeCoreContentManifest } from './gen-ejs-core-versions.mjs'

const engine = readFileSync(new URL('../public/emulatorjs/emulator.min.js', import.meta.url), 'utf8')
const cut = engine.indexOf('class r{constructor(t,e){this.EJS=e,this.Module=t')
assert.ok(cut > 0, '找不到 GameManager 类，引擎结构变了')
const prelude = engine.slice(0, cut)
assert.match(prelude, /class s\{constructor\(t=null,e=null\)\{this\.storageCache=t,this\.EJS=e\}/, '下载器类名变了，更新本测试')
const coreContentManifest = computeCoreContentManifest()

function makeContext({ fetchImpl, indexedDB, localStorage, XMLHttpRequest, sessionStorage, navigator = {}, performanceImpl = performance }) {
  const realSetTimeout = setTimeout
  const visibilityListeners = new Set()
  const document = {
    visibilityState: 'visible',
    addEventListener(type, listener) { if (type === 'visibilitychange') visibilityListeners.add(listener) },
    removeEventListener(type, listener) { if (type === 'visibilitychange') visibilityListeners.delete(listener) },
    dispatchVisibilityChange() { for (const listener of visibilityListeners) listener() },
  }
  const context = {
    console: { log() {}, warn() {}, error() {} },
    setTimeout: (fn, ms = 0) => realSetTimeout(fn, Math.max(0, Math.ceil(ms / 1000))),
    clearTimeout,
    fetch: fetchImpl,
    AbortController,
    Blob,
    Response,
    Uint8Array,
    ArrayBuffer,
    TextEncoder,
    TextDecoder,
    URL,
    Headers,
    document,
    location: { href: 'https://8bitgo.test/', origin: 'https://8bitgo.test' },
    sessionStorage: sessionStorage || { getItem() { return null }, setItem() {} },
    navigator,
    ...(XMLHttpRequest ? { XMLHttpRequest } : {}),
    Date,
    Promise,
    performance: performanceImpl,
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
  assert.ok(Number(store.get('8bitgo.ejs.idbStall2')) > 0, 'get 超时要记到 localStorage，适配器据此后几天关掉缓存')
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
  // 第十二节：get / put 很快回来时，15 / 10 秒的时限定时器必须清掉，不能事后把缓存判死、写挂死标记
  // （2026-11-11 孟加拉 Android《拳皇 2002》：开局超过 15 秒的每一局都被误判，之后永远关缓存、每局重解 7z）
  const fetchImpl = async () => new Response(new Uint8Array([7]), { status: 200, headers: { 'Content-Length': '1' } })
  const store = new Map()
  const localStorage = { setItem: (k, v) => store.set(k, String(v)), getItem: (k) => store.get(k) ?? null }
  const { __classes } = makeContext({ fetchImpl, indexedDB: undefined, localStorage })
  let gets = 0
  const fastCache = { get: async () => { gets++; return null }, put: async () => {}, generateCacheKey: () => 'k' }
  const downloader = new __classes.Downloader(fastCache, null)
  await downloader.downloadFile('https://8bitgo.test/emulatorjs/cores/fceumm-wasm.data', 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer')
  // 缩放后 get 时限 15ms、put 10ms：多等一会儿，旧补丁在这里已经触发
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(store.size, 0, '缓存读写都正常时不能写挂死标记')
  assert.notEqual(downloader.__8bgCacheDead, true, '缓存读写都正常时本局不能停用缓存')
  await downloader.downloadFile('https://8bitgo.test/emulatorjs/cores/fbneo-wasm.data', 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer')
  assert.equal(gets, 2, '第二次下载照样先查缓存')
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

// 核心响应流读到一半报 NotReadableError（华为浏览器 17）：改走 XHR arraybuffer 再取一次
function fakeXhr({ status = 200, bytes, fail = false, responseHeaders = {}, responses }) {
  const opened = []
  const requests = []
  let responseIndex = 0
  class X {
    constructor() { this.headers = {} }
    open(method, url) { this.method = method; this.url = url; opened.push([method, url]); requests.push(this) }
    setRequestHeader(k, v) { this.headers[k] = v }
    getResponseHeader(name) { return (this.responseHeaders || responseHeaders)[name.toLowerCase()] ?? null }
    send() {
      const next = responses?.[responseIndex++] || { status, bytes, fail, responseHeaders }
      this.responseHeaders = next.responseHeaders || {}
      setTimeout(() => {
        if (next.fail) return this.onerror?.()
        this.onprogress?.({ lengthComputable: true, loaded: next.bytes.length, total: next.bytes.length })
        this.status = next.status
        this.response = next.bytes.buffer.slice(next.bytes.byteOffset, next.bytes.byteOffset + next.bytes.byteLength)
        this.onload?.()
      })
    }
    abort() { this.onabort?.() }
  }
  return { X, opened, requests }
}
const unreadableResponse = (url, headers = { 'Content-Length': '4' }) => {
  const res = new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]))
      setTimeout(() => controller.error(new DOMException('The requested file could not be read', 'NotReadableError')))
    },
  }), { status: 200, headers })
  Object.defineProperty(res, 'url', { value: url })
  return res
}

function makeResponse(url, bytes, { status = 206, headers = {}, failAfterChunks = false } = {}) {
  const response = new Response(new ReadableStream({
    start(controller) {
      for (const chunk of bytes) controller.enqueue(chunk)
      if (failAfterChunks) setTimeout(() => controller.error(new Error('simulated network interruption')))
      else controller.close()
    },
  }), { status, headers })
  Object.defineProperty(response, 'url', { value: url })
  return response
}

function fakeResumeDatabase({ hangOpen = false } = {}) {
  const records = new Map()
  const indexedDB = {
    open() {
      const request = {}
      if (!hangOpen) queueMicrotask(() => {
        request.result = database
        request.onsuccess?.()
      })
      return request
    },
  }
  const database = {
    objectStoreNames: { contains: () => true },
    close() {},
    transaction() {
      let pending = 0
      let failed = false
      const tx = {}
      const schedule = (request, action) => {
        pending++
        queueMicrotask(() => {
          try {
            request.result = action()
            request.onsuccess?.({ target: request })
          } catch (error) {
            failed = true
            request.error = error
            request.onerror?.({ target: request })
            tx.onerror?.({ target: tx })
          }
          pending--
          if (!pending && !failed) queueMicrotask(() => tx.oncomplete?.())
        })
        return request
      }
      const store = {
        get(key) {
          return schedule({}, () => {
            const value = records.get(key)
            return value ? { ...value, bytes: value.bytes.slice(0) } : undefined
          })
        },
        put(value) {
          return schedule({}, () => {
            records.set(value.id, { ...value, bytes: value.bytes.slice(0) })
            return value.id
          })
        },
        delete(key) { return schedule({}, () => records.delete(key)) },
        openCursor() { return schedule({}, () => null) },
      }
      tx.objectStore = () => store
      return tx
    },
  }
  return { indexedDB, records }
}

const memoryStorage = () => {
  const values = new Map()
  return {
    values,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key),
  }
}

const rangeHeaders = (etag, contentRange, contentLength) => ({
  'Content-Range': contentRange,
  'Content-Length': String(contentLength),
  ETag: etag,
  'Accept-Ranges': 'bytes',
})

{
  // Fetch 只读到前缀時，由 XHR 从准确偏移续上；字节版本与总长都必须吻合。
  const url = 'https://8bitgo.test/emulatorjs/cores/melondsds-wasm.data?v=abc123'
  const full = new Uint8Array([10, 11, 12, 13, 14, 15, 16, 17])
  const xhr = fakeXhr({
    status: 206,
    bytes: full.slice(3),
    responseHeaders: {
      'content-range': 'bytes 3-7/8',
      'content-length': '5',
      etag: '"core-a"',
      'content-type': 'application/wasm',
    },
  })
  const fetchImpl = async (_url, init) => {
    assert.equal(init.headers.get('Range'), 'bytes=0-', '首个版本化核心请求应要求 identity 字节范围')
    return makeResponse(url, [full.slice(0, 3)], {
      headers: rangeHeaders('"core-a"', 'bytes 0-7/8', 8),
      failAfterChunks: true,
    })
  }
  const { __classes } = makeContext({ fetchImpl, indexedDB: undefined, XMLHttpRequest: xhr.X })
  const downloader = new __classes.Downloader(null, null)
  const item = await downloader.downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer')
  assert.deepEqual([...item.files[0].bytes], [...full], 'XHR 后缀应与 Fetch 前缀逐字节拼成原核心')
  assert.equal(xhr.requests[0].headers.range, 'bytes=3-', 'XHR Range 必须从已收到偏移继续')
  assert.equal(xhr.requests[0].headers['if-range'], '"core-a"', '同源续传必须使用强 ETag 做 If-Range')
}

{
  // XHR 返回另一 ETag 的 206 时丢弃后缀，最多再发一次完整 GET，绝不混合两个版本。
  const url = 'https://8bitgo.test/emulatorjs/cores/melondsds-wasm.data?v=abc123'
  const oldPrefix = new Uint8Array([1, 2, 3])
  const newer = new Uint8Array([20, 21, 22, 23, 24, 25, 26, 27])
  const xhr = fakeXhr({
    responses: [
      { status: 206, bytes: new Uint8Array([4, 5, 6, 7, 8]), responseHeaders: { 'content-range': 'bytes 3-7/8', 'content-length': '5', etag: '"core-b"' } },
      { status: 200, bytes: newer, responseHeaders: { 'content-length': '8', etag: '"core-b"', 'content-type': 'application/wasm' } },
    ],
  })
  const fetchImpl = async () => makeResponse(url, [oldPrefix], {
    headers: rangeHeaders('"core-a"', 'bytes 0-7/8', 8),
    failAfterChunks: true,
  })
  const { __classes } = makeContext({ fetchImpl, indexedDB: undefined, XMLHttpRequest: xhr.X })
  const item = await new __classes.Downloader(null, null).downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer')
  assert.deepEqual([...item.files[0].bytes], [...newer], 'ETag 改变后只能交付新版本完整响应')
  assert.equal(xhr.requests.length, 2, '不匹配的 206 只允许再完整请求一次')
  assert.equal(xhr.requests[1].headers.range, undefined, '完整重试不能继续带 Range')
}

{
  // 弱 ETag 不能证明字节相同：即使服务器支持 Range，也只能完整重取，不得拼接。
  const url = 'https://8bitgo.test/emulatorjs/cores/melondsds-wasm.data?v=abc123'
  const full = new Uint8Array([31, 32, 33, 34, 35, 36, 37, 38])
  const xhr = fakeXhr({ status: 200, bytes: full, responseHeaders: { 'content-length': '8', etag: 'W/"core-weak"' } })
  const fetchImpl = async (_url, init) => {
    assert.equal(init.headers.get('Range'), 'bytes=0-')
    return makeResponse(url, [full.slice(0, 3)], {
      headers: rangeHeaders('W/"core-weak"', 'bytes 0-7/8', 8),
      failAfterChunks: true,
    })
  }
  const { __classes } = makeContext({ fetchImpl, indexedDB: undefined, XMLHttpRequest: xhr.X })
  const item = await new __classes.Downloader(null, null).downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer')
  assert.deepEqual([...item.files[0].bytes], [...full])
  assert.equal(xhr.requests[0].headers.range, undefined, '弱 ETag 下 XHR 不能发续传 Range')
}

{
  // 跨页面续传：IDB 仅记录已提交的 1 MiB 完整片，新页面读回校验后从该偏移继续。
  const url = 'https://8bitgo.test/emulatorjs/cores/fbneo-wasm.data?v=abc123'
  const partBytes = 1024 * 1024
  const total = partBytes * 2 + 257
  const core = new Uint8Array(total)
  for (let index = 0; index < total; index++) core[index] = index % 251
  const sharedDb = fakeResumeDatabase()
  const localStorage = memoryStorage()
  const expectedHeaders = [
    `bytes=0-`,
    `bytes=${partBytes}-`,
  ]
  const seen = []
  const fetchImpl = async (_url, init) => {
    const requestedRange = init.headers.get('Range')
    seen.push({ range: requestedRange, ifRange: init.headers.get('If-Range') })
    assert.equal(requestedRange, expectedHeaders[seen.length - 1], '跨局续传必须只从已持久化边界开始')
    if (seen.length === 1) {
      return makeResponse(url, [core.slice(0, partBytes), core.slice(partBytes, partBytes + 31)], {
        headers: rangeHeaders('"fbneo-build-a"', `bytes 0-${total - 1}/${total}`, total),
        failAfterChunks: true,
      })
    }
    assert.equal(init.headers.get('If-Range'), '"fbneo-build-a"', '恢复时必须带原始强 ETag')
    return makeResponse(url, [core.slice(partBytes)], {
      headers: rangeHeaders('"fbneo-build-a"', `bytes ${partBytes}-${total - 1}/${total}`, total - partBytes),
    })
  }
  const sessionStorageA = memoryStorage()
  const first = makeContext({
    fetchImpl,
    indexedDB: sharedDb.indexedDB,
    localStorage,
    sessionStorage: sessionStorageA,
    navigator: { storage: { estimate: async () => ({ quota: 128 * 1024 * 1024, usage: 0 }) } },
  })
  const firstDownloader = new first.__classes.Downloader(null, null)
  await assert.rejects(
    firstDownloader.downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer'),
    /XHR unavailable after Error: simulated network interruption/,
    '第一次断网应失败，但保留已提交的完整分片供下次开局恢复',
  )
  const manifest = JSON.parse(localStorage.getItem('8bitgo.ejs.coreResume.v1'))
  assert.equal(manifest[0].offset, partBytes, '不完整的第二片不能进入续传清单')
  assert.equal(sharedDb.records.size, 1, '只持久化一个已完成 1 MiB 分片')

  const second = makeContext({
    fetchImpl,
    indexedDB: sharedDb.indexedDB,
    localStorage,
    sessionStorage: memoryStorage(),
    navigator: { storage: { estimate: async () => ({ quota: 128 * 1024 * 1024, usage: 0 }) } },
  })
  const item = await new second.__classes.Downloader(null, null).downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer')
  assert.deepEqual(item.files[0].bytes, core, '持久化前缀和服务器后缀必须逐字节还原')
  assert.equal(localStorage.getItem('8bitgo.ejs.coreResume.v1'), '[]', '成功下载后清掉续传清单')
}

{
  // IDB 打不开时只关闭这项优化，核心仍完整下载；不能把续传库故障写成引擎缓存挂死。
  const url = 'https://8bitgo.test/emulatorjs/cores/fbneo-wasm.data?v=abc123'
  const bytes = new Uint8Array(1024 * 1024 + 8).fill(9)
  const localStorage = memoryStorage()
  const fetchImpl = async () => makeResponse(url, [bytes], {
    headers: rangeHeaders('"fbneo-build-a"', `bytes 0-${bytes.length - 1}/${bytes.length}`, bytes.length),
  })
  const { __classes } = makeContext({ fetchImpl, indexedDB: fakeResumeDatabase({ hangOpen: true }).indexedDB, localStorage })
  const item = await new __classes.Downloader(null, null).downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer')
  assert.equal(item.files[0].bytes.byteLength, bytes.byteLength, 'IDB 无响应不得阻断当前核心下载')
  assert.equal(localStorage.getItem('8bitgo.ejs.idbStall2'), null, '续传库故障不能污染 EmulatorJS 的缓存挂死标记')
}
{
  const url = 'https://8bitgo.test/emulatorjs/cores/melondsds-wasm.data?v=1'
  const xhr = fakeXhr({ bytes: new Uint8Array([4, 3, 2, 1]) })
  const { __classes } = makeContext({ fetchImpl: async () => unreadableResponse(url), indexedDB: undefined, XMLHttpRequest: xhr.X })
  const downloader = new __classes.Downloader(null, null)
  const item = await downloader.downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer')
  assert.deepEqual(xhr.opened, [['GET', url]], 'XHR 必须用响应地址重取（块内的 t 是 Content-Length，不是 URL）')
  assert.deepEqual([...item.files[0].bytes], [4, 3, 2, 1], 'XHR 拿到的整份字节交给引擎，不能拼上流里读到的前半段')
}
{
  const url = 'https://8bitgo.test/emulatorjs/cores/melondsds-wasm.data?v=1'
  const xhr = fakeXhr({ bytes: new Uint8Array([4, 3]) })
  const { __classes } = makeContext({ fetchImpl: async () => unreadableResponse(url), indexedDB: undefined, XMLHttpRequest: xhr.X })
  const downloader = new __classes.Downloader(null, null)
  await assert.rejects(
    downloader.downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer'),
    /XHR fallback incomplete response: HTTP 200, received 2 bytes, expected at least 2 \/ 4/,
    'HTTP 200 的截断核心不得被当成成功交给解压器或写入缓存',
  )
}
{
  const url = 'https://8bitgo.test/emulatorjs/cores/melondsds-wasm.data?v=1'
  const xhr = fakeXhr({
    bytes: new Uint8Array([60, 104, 116, 109]),
    responseHeaders: { 'content-type': 'text/html; charset=utf-8' },
  })
  const { __classes } = makeContext({ fetchImpl: async () => unreadableResponse(url), indexedDB: undefined, XMLHttpRequest: xhr.X })
  const downloader = new __classes.Downloader(null, null)
  await assert.rejects(
    downloader.downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer'),
    /XHR fallback incomplete response: HTTP 200, received 4 bytes, expected at least 2 \/ 4 \(text\/html; charset=utf-8\)/,
    'CDN 返回完整长度的 HTML 错误页也不得作为 WASM 核心缓存',
  )
}
{
  // Content-Length 描述压缩传输长度，XHR 返回的是已解码字节，二者不能直接比较。
  const url = 'https://8bitgo.test/emulatorjs/cores/melondsds-wasm.data?v=1'
  const xhr = fakeXhr({
    bytes: new Uint8Array([4, 3, 2, 1]),
    responseHeaders: { 'content-encoding': 'br', 'content-length': '2' },
  })
  const response = unreadableResponse(url, { 'Content-Length': '2', 'Content-Encoding': 'br' })
  const { __classes } = makeContext({ fetchImpl: async () => response, indexedDB: undefined, XMLHttpRequest: xhr.X })
  const downloader = new __classes.Downloader(null, null)
  const item = await downloader.downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer')
  assert.deepEqual([...item.files[0].bytes], [4, 3, 2, 1], '压缩响应按流已读字节下限校验，不误用传输长度拒收解码后的完整数据')
}
{
  const url = 'https://8bitgo.test/emulatorjs/cores/melondsds-wasm.data?v=1'
  const xhr = fakeXhr({ fail: true })
  const { __classes } = makeContext({ fetchImpl: async () => unreadableResponse(url), indexedDB: undefined, XMLHttpRequest: xhr.X })
  const downloader = new __classes.Downloader(null, null)
  await assert.rejects(
    downloader.downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer'),
    /Download failed: Error: XHR fallback network error after NotReadableError/,
    'XHR 也失败时照常 reject，并保留原始 NotReadableError，适配器据此按本机环境错误停止',
  )
}
{
  // Fetch 失速后必须在当前线路上尝试 XHR 完整重取
  const url = 'https://8bitgo.test/emulatorjs/cores/fbneo-wasm.data'
  const xhr = fakeXhr({ bytes: new Uint8Array(8).fill(7) })
  const fetchImpl = async (_url, init) => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(4))
        init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
      },
    }), { status: 200, headers: { 'Content-Length': '8' } })
    Object.defineProperty(response, 'url', { value: url })
    return response
  }
  const { __classes } = makeContext({ fetchImpl, indexedDB: undefined, XMLHttpRequest: xhr.X })
  const downloader = new __classes.Downloader(null, null)
  const item = await downloader.downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer')
  assert.deepEqual(xhr.opened, [['GET', url]], 'Fetch 失速后用原响应地址改走 XHR')
  assert.deepEqual([...item.files[0].bytes], new Array(8).fill(7), '只交付 XHR 完整重取的核心字节')
}

{
  // Fetch 等不到核心响应头时，自己的请求时限会 abort；只对这类版本化核心请求改走 XHR。
  const url = 'https://8bitgo.test/emulatorjs/cores/fbneo-legacy-wasm.data?v=abc123'
  const core = new Uint8Array(8).fill(5)
  const xhr = fakeXhr({ bytes: core, responseHeaders: { 'content-length': String(core.byteLength) } })
  const fetchImpl = async (_url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(new DOMException('request timed out', 'AbortError')), { once: true })
  })
  const { __classes } = makeContext({ fetchImpl, indexedDB: undefined, XMLHttpRequest: xhr.X })
  const downloader = new __classes.Downloader(null, null)
  const item = await downloader.downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer')
  assert.deepEqual(xhr.opened, [['GET', url]], '响应头超时后用原地址通过 XHR 完整取核心')
  assert.deepEqual([...item.files[0].bytes], [...core], 'Fetch 未拿到响应时只交付 XHR 校验通过的完整核心')
}

{
  // 2026-11-25 #4181：Fetch 报 TypeError，但 Resource Timing 精确显示本次已传完当前哈希版本的整个核心。
  const asset = 'cores/fbneo-legacy-wasm.data'
  const manifest = coreContentManifest[asset]
  assert.ok(manifest?.bytes > 0 && manifest.version, '核心完整长度和版本哈希必须来自当前产物')
  // 生产里的 -wasm.data URL 会在内容哈希后附 EJS_CORE_URL_EPOCH（当前为 range1）。
  const rangeVersion = `${manifest.version}.range1`
  const url = `https://cn.8bitgo.test/_cn/emulatorjs/${asset}?v=${rangeVersion}`
  const bytes = new Uint8Array(manifest.bytes).fill(5)
  const xhr = fakeXhr({ bytes, responseHeaders: { 'content-length': String(bytes.byteLength), 'content-type': 'application/wasm' } })
  const performanceImpl = {
    now: () => 100,
    getEntriesByName: (name) => name === url ? [{
      name: url,
      startTime: 101,
      encodedBodySize: manifest.bytes,
      decodedBodySize: manifest.bytes,
      transferSize: manifest.bytes + 300,
    }] : [],
  }
  const { __classes } = makeContext({
    fetchImpl: async () => { throw new TypeError('Failed to fetch') },
    indexedDB: undefined,
    XMLHttpRequest: xhr.X,
    performanceImpl,
  })
  const item = await new __classes.Downloader(null, null).downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer')
  assert.deepEqual(xhr.opened, [['GET', url]], '完整传输后 Fetch TypeError 只补一次同 URL 的 XHR')
  assert.equal(item.files[0].bytes.byteLength, manifest.bytes, 'XHR 必须返回与该 URL 版本完全相同的字节数')
}

{
  // 没有完整传输证据、旧版 URL 或本次请求之外的 Resource Timing 都不能额外发起整包下载。
  const asset = 'cores/fbneo-legacy-wasm.data'
  const manifest = coreContentManifest[asset]
  const rangeVersion = `${manifest.version}.range1`
  const cases = [
    { name: '无 Resource Timing', version: rangeVersion, entries: [] },
    { name: '旧版本 URL', version: `0000000000000000.range1`, entries: [{ startTime: 101, encodedBodySize: manifest.bytes, decodedBodySize: manifest.bytes, transferSize: manifest.bytes + 300 }] },
    { name: '未知 URL 代次', version: `${manifest.version}.other`, entries: [{ startTime: 101, encodedBodySize: manifest.bytes, decodedBodySize: manifest.bytes, transferSize: manifest.bytes + 300 }] },
    { name: '只收到部分字节', version: rangeVersion, entries: [{ startTime: 101, encodedBodySize: manifest.bytes - 1, decodedBodySize: manifest.bytes - 1, transferSize: manifest.bytes - 1 + 300 }] },
    { name: '只有旧请求的完整计时', version: rangeVersion, entries: [{ startTime: 1, encodedBodySize: manifest.bytes, decodedBodySize: manifest.bytes, transferSize: manifest.bytes + 300 }] },
  ]
  for (const item of cases) {
    const url = `https://cn.8bitgo.test/_cn/emulatorjs/${asset}?v=${item.version}`
    const xhr = fakeXhr({ bytes: new Uint8Array([1, 2, 3, 4]) })
    const performanceImpl = { now: () => 100, getEntriesByName: (name) => name === url ? item.entries.map((entry) => ({ name: url, ...entry })) : [] }
    const { __classes } = makeContext({
      fetchImpl: async () => { throw new TypeError('Failed to fetch') },
      indexedDB: undefined,
      XMLHttpRequest: xhr.X,
      performanceImpl,
    })
    await assert.rejects(
      new __classes.Downloader(null, null).downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer'),
      /Download failed: TypeError: Failed to fetch/,
      `${item.name}时应保留原错误，不重复下载完整核心`,
    )
    assert.equal(xhr.opened.length, 0, `${item.name}不能触发 XHR`)
  }
}

{
  // 即使首次 Resource Timing 显示整份文件已到，XHR 仍必须严格核对当前核心的完整字节数。
  const asset = 'cores/fbneo-legacy-wasm.data'
  const manifest = coreContentManifest[asset]
  const url = `https://8bitgo.test/emulatorjs/${asset}?v=${manifest.version}.range1`
  const xhr = fakeXhr({ bytes: new Uint8Array([1, 2, 3, 4]), responseHeaders: { 'content-length': '4', 'content-type': 'application/wasm' } })
  const performanceImpl = {
    now: () => 100,
    getEntriesByName: () => [{ name: url, startTime: 101, encodedBodySize: manifest.bytes, decodedBodySize: manifest.bytes, transferSize: manifest.bytes + 300 }],
  }
  const { __classes } = makeContext({
    fetchImpl: async () => { throw new TypeError('Failed to fetch') },
    indexedDB: undefined,
    XMLHttpRequest: xhr.X,
    performanceImpl,
  })
  await assert.rejects(
    new __classes.Downloader(null, null).downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer'),
    /XHR fallback incomplete response: HTTP 200, received 4 bytes, expected at least 0 \/ 8272960/,
    'XHR 的短响应不能冒充完整核心',
  )
}

{
  // Fetch 自身的取消 / 网络异常不能被误认成超时并额外发起 XHR。
  const url = 'https://8bitgo.test/emulatorjs/cores/fbneo-legacy-wasm.data?v=abc123'
  const xhr = fakeXhr({ fail: true })
  const { __classes } = makeContext({
    fetchImpl: async () => { throw new DOMException('request cancelled', 'AbortError') },
    indexedDB: undefined,
    XMLHttpRequest: xhr.X,
  })
  const downloader = new __classes.Downloader(null, null)
  await assert.rejects(
    downloader.downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer'),
    /Download failed/,
    '非本补丁超时引起的 AbortError 仍直接失败',
  )
  assert.equal(xhr.opened.length, 0, '主动取消或其他 Fetch 异常不应被重试成新下载')
}

{
  const url = 'https://8bitgo.test/emulatorjs/cores/fbneo-wasm.data'
  let xhrStarted
  let aborted = false
  class X {
    open() {}
    setRequestHeader() {}
    send() { xhrStarted?.() }
    abort() { aborted = true; this.onabort?.() }
  }
  const fetchImpl = async (_url, init) => {
    const response = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array([1]))
        init.signal.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
      },
    }), { status: 200, headers: { 'Content-Length': '8' } })
    Object.defineProperty(response, 'url', { value: url })
    return response
  }
  const context = makeContext({ fetchImpl, indexedDB: undefined, XMLHttpRequest: X })
  const downloader = new context.__classes.Downloader(null, null)
  context.document.visibilityState = 'hidden'
  const started = new Promise((resolve) => { xhrStarted = resolve })
  const pending = downloader.downloadFile(url, 'Core', 'GET', {}, null, null, null, 30000, 'arraybuffer')
  await started
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.equal(aborted, false, '后台冻结 / 节流期间 XHR 空闲时限暂停')
  context.document.visibilityState = 'visible'
  context.document.dispatchVisibilityChange()
  await assert.rejects(pending, /XHR fallback stalled after AbortError/)
  assert.equal(aborted, true, '回到前台后恢复完整的 XHR 空闲预算')
}

{
  const engineCore = /core:\{name:"Core",dontCache:!1,cdnFallback:!1\}/.test(engine)
  assert.ok(engineCore, '核心下载失败不能回落 cdn.emulatorjs.org（那里的 4.3.0-pre 核心起不来）')
}

console.log('✔ EmulatorJS 下载器：超时与缓存降级、完整传输后 Fetch TypeError 的受限 XHR 恢复、强 ETag / Range 校验、跨页面分片及短响应拒收')
