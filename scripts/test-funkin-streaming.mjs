import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../deploy/cloudflare-pages/funkin/sw.js', import.meta.url), 'utf8')
  .replaceAll('__STREAM_VERSION__', 'test-v1')

const listeners = new Map()
const stored = new Map()
let fetchCount = 0
let releaseFetch

const cache = {
  async match(request) {
    return stored.get(request.url)?.clone()
  },
  async put(request, response) {
    stored.set(request.url, response.clone())
  },
}

const context = {
  URL,
  Request,
  Response,
  console,
  setTimeout,
  clearTimeout,
  caches: {
    async open() { return cache },
    async keys() { return ['8bitgo-funkin-test-v1'] },
    async delete() { return true },
  },
  fetch: async () => {
    fetchCount += 1
    await new Promise((resolve) => { releaseFetch = resolve })
    return new Response('cached-once', { headers: { 'Content-Length': '11' } })
  },
  self: {
    location: { origin: 'https://funkin.test' },
    registration: { scope: 'https://funkin.test/' },
    clients: { async claim() {} },
    async skipWaiting() {},
    addEventListener(type, listener) { listeners.set(type, listener) },
  },
}
vm.runInNewContext(source, context)

function dispatchFetch(path, init) {
  const pending = []
  const event = {
    request: new Request(`https://funkin.test${path}`, init),
    respondWith(value) { this.response = Promise.resolve(value) },
    waitUntil(value) { pending.push(Promise.resolve(value)) },
  }
  listeners.get('fetch')(event)
  return { event, pending }
}

const first = dispatchFetch('/assets/test.png')
const second = dispatchFetch('/assets/test.png')
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(fetchCount, 1, '同一资源并发请求必须合并')
releaseFetch()
assert.equal(await (await first.event.response).text(), 'cached-once')
assert.equal(await (await second.event.response).text(), 'cached-once')
await Promise.all([...first.pending, ...second.pending])
assert(stored.has('https://funkin.test/assets/test.png'), '响应流交给游戏时必须旁路写入缓存')

const cached = dispatchFetch('/assets/test.png')
assert.equal(await (await cached.event.response).text(), 'cached-once')
assert.equal(fetchCount, 1, '再次访问必须命中 Cache Storage')

const range = dispatchFetch('/assets/videos/test.mp4', { headers: { Range: 'bytes=0-99' } })
assert.equal(range.event.response, undefined, 'Range 请求必须交给网络原生处理')

const manifest = dispatchFetch('/manifest/tutorial.json')
await new Promise((resolve) => setTimeout(resolve, 0))
assert.equal(fetchCount, 2, '游戏分包清单必须进入按需缓存')
releaseFetch()
await manifest.event.response
await Promise.all(manifest.pending)

console.log('Funkin 流式回归通过：并发合并、旁路缓存、二次命中、Range 绕行、分包清单缓存')

const loaderSource = readFileSync(new URL('../deploy/cloudflare-pages/funkin/8bitgo-streaming.js', import.meta.url), 'utf8')
  .replaceAll('__STREAM_VERSION__', 'test-v1')
  .replaceAll('__MAIN_JS_VERSION__', 'main-test')
const serviceWorkerEvents = new Map()
const appendedScripts = []
const registration = {
  scope: 'https://funkin.test/',
  active: { postMessage() {} },
}
const browserWindow = {
  setTimeout(callback, milliseconds) {
    const timer = setTimeout(callback, milliseconds)
    timer.unref?.()
    return timer
  },
  clearTimeout,
  addEventListener() {},
  requestIdleCallback() {},
}
const serviceWorker = {
  controller: { scriptURL: 'https://funkin.test/sw.js?v=old-v1' },
  async register() { return registration },
  ready: Promise.resolve(registration),
  addEventListener(type, listener) { serviceWorkerEvents.set(type, listener) },
  removeEventListener(type, listener) {
    if (serviceWorkerEvents.get(type) === listener) serviceWorkerEvents.delete(type)
  },
}
const loaderContext = {
  URL,
  console,
  document: {
    readyState: 'complete',
    documentElement: { dataset: {} },
    createElement() { return {} },
    head: {
      append(script) {
        appendedScripts.push(script.src)
        queueMicrotask(script.onload)
      },
    },
  },
  navigator: { serviceWorker },
  window: browserWindow,
}
vm.runInNewContext(loaderSource, loaderContext)
// 老版本控制器的升级窗口不能在普通 2 秒启动预算到点时抢先运行新主程序。
await new Promise((resolve) => setTimeout(resolve, 2_100))
assert.deepEqual(appendedScripts, [], '旧 Worker 仍接管时不能提前装载新主程序')
serviceWorker.controller = { scriptURL: 'https://funkin.test/sw.js?v=test-v1' }
serviceWorkerEvents.get('controllerchange')?.()
await browserWindow.__8bitgoFunkinReady
assert.deepEqual(appendedScripts, ['./Funkin.js?v=main-test'], '缓存接管后必须只加载一次主程序')
assert.equal(loaderContext.document.documentElement.dataset.funkinStreaming, 'active', '首次访问必须等当前 Worker 接管后启动')

console.log('Funkin 启动门闩回归通过：当前 Worker 接管后加载主程序')
