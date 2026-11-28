import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../vendor/ppsspp/range-prefetch-worker.js', import.meta.url), 'utf8')

async function run(response, extra = {}) {
  const seen = []
  let timeoutMs = 0
  const bytes = new SharedArrayBuffer(4)
  const state = new SharedArrayBuffer(4)
  let finish
  const done = new Promise((resolve) => { finish = resolve })
  const context = {
    Map,
    Number,
    String,
    Uint8Array,
    Int32Array,
    Atomics,
    AbortController,
    setTimeout(callback, delay) {
      timeoutMs = delay
      return setTimeout(callback, delay)
    },
    clearTimeout,
    fetch: async (url, init) => {
      seen.push(init.headers)
      return response
    },
    postMessage(message) {
      if (message.type === 'done') finish(message)
    },
  }
  context.self = context
  vm.runInNewContext(source, context, { filename: 'range-prefetch-worker.js' })
  context.self.onmessage({ data: {
    type: 'fetch', id: 7, key: 'disc\n0-3', url: 'https://assets.test/disc.chd',
    start: 0, end: 3, total: 8, ifMatch: '"disc-v1"', bytes, state, timeoutMs: 90_000, ...extra,
  } })
  const message = await done
  assert.equal(message.id, 7)
  assert.equal(message.key, 'disc\n0-3')
  return { state: Atomics.load(new Int32Array(state), 0), bytes: [...new Uint8Array(bytes)], headers: seen[0], timeoutMs }
}

async function runSharedPair(cancelFirst = false) {
  const fetchCalls = []
  const sharedContext = {
    Map,
    Number,
    String,
    Uint8Array,
    Int32Array,
    Atomics,
    AbortController,
    TextEncoder,
    setTimeout,
    clearTimeout,
    fetch: async (url, init) => {
      fetchCalls.push({ url, signal: init.signal })
      await new Promise((resolve) => setTimeout(resolve, 10))
      return response([[1, 2], [3, 4]])
    },
  }
  sharedContext.self = sharedContext
  sharedContext.onconnect = null
  vm.runInNewContext(source, sharedContext, { filename: 'range-prefetch-shared-worker.js' })

  const makePort = () => {
    const port = {
      messages: [],
      postMessage(message) { this.messages.push(message) },
      start() {},
    }
    sharedContext.onconnect({ ports: [port] })
    return {
      port,
      send(data) { port.onmessage({ data }) },
      completed: () => port.messages.find((message) => message.type === 'done'),
    }
  }
  const first = makePort()
  const second = makePort()
  const makeJob = (id) => ({
    type: 'fetch', id, key: 'disc\n0-3', dedupeKey: 'https://assets.test/disc.chd\n0-3',
    url: 'https://assets.test/disc.chd', start: 0, end: 3, total: 8,
    ifMatch: '"disc-v1"', sendValidators: false,
    bytes: new SharedArrayBuffer(4), state: new SharedArrayBuffer(8), timeoutMs: 90_000,
  })
  const firstJob = makeJob('worker-a:1')
  const secondJob = makeJob('worker-b:1')
  first.send(firstJob)
  second.send(secondJob)
  if (cancelFirst) first.send({ type: 'cancel', id: firstJob.id })

  const deadline = Date.now() + 1_000
  while (!second.completed() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 2))
  assert.ok(second.completed(), '第二个 pthread 必须收到共享分片完成信号')
  assert.equal(fetchCalls.length, 1, '两个 pthread 同时读同一个 Range 只能发出一条网络请求')
  assert.equal(Atomics.load(new Int32Array(secondJob.state), 0), 1)
  assert.deepEqual([...new Uint8Array(secondJob.bytes)], [1, 2, 3, 4])
  if (cancelFirst) {
    assert.equal(Atomics.load(new Int32Array(firstJob.state), 0), -1, '已取消的 pthread 只保留接手确认，不收到最终数据')
    assert.equal(fetchCalls[0].signal.aborted, false, '一个 pthread 取消不能中止另一个仍在等待的共享请求')
  } else {
    assert.equal(Atomics.load(new Int32Array(firstJob.state), 0), 1)
    assert.deepEqual([...new Uint8Array(firstJob.bytes)], [1, 2, 3, 4])
    assert.equal(Atomics.load(new Int32Array(secondJob.state), 1), 1, '重复等待者应记录共享命中')
  }
}

async function runPortPair(cancelFirst = false) {
  const fetchCalls = []
  const context = {
    Map, Number, String, Uint8Array, Int32Array, SharedArrayBuffer, Atomics, AbortController, TextEncoder, TextDecoder,
    navigator: {},
    setTimeout, clearTimeout,
    fetch: async (url, init) => {
      fetchCalls.push({ url, signal: init.signal })
      await new Promise((resolve) => setTimeout(resolve, 10))
      return response([[1, 2], [3, 4]])
    },
    postMessage() {},
  }
  context.self = context
  vm.runInNewContext(source, context, { filename: 'range-prefetch-messageport-broker.js' })
  const makePort = () => {
    const port = {
      messages: [],
      postMessage(message) { this.messages.push(message) },
      start() {},
    }
    context.onmessage({ data: { cmd: 'connect', port } })
    return {
      port,
      send(data) { port.onmessage({ data }) },
      ready: port.messages.find((message) => message.type === 'ready'),
      completed: () => port.messages.find((message) => message.type === 'done'),
    }
  }
  const first = makePort()
  const second = makePort()
  const makeJob = (id) => ({
    type: 'fetch', id, key: 'disc\n0-3', dedupeKey: 'https://assets.test/disc.chd\n0-3',
    url: 'https://assets.test/disc.chd', start: 0, end: 3, total: 8,
    ifMatch: '"disc-v1"', sendValidators: false,
    bytes: new SharedArrayBuffer(4), state: new SharedArrayBuffer(1024), timeoutMs: 90_000,
  })
  const firstJob = makeJob('port-a:1')
  const secondJob = makeJob('port-b:1')
  assert.equal(first.ready?.type, 'ready')
  assert.equal(second.ready?.type, 'ready')
  first.send(firstJob)
  second.send(secondJob)
  if (cancelFirst) first.send({ type: 'cancel', id: firstJob.id })
  const deadline = Date.now() + 1_000
  while (!second.completed() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  assert.equal(Atomics.load(new Int32Array(firstJob.state), 0), cancelFirst ? -1 : 1,
    'MessagePort Broker 的取消只能移除发起取消的 pthread，已接手确认不算数据完成')
  assert.equal(Atomics.load(new Int32Array(secondJob.state), 0), 1,
    'DedicatedWorker Broker 必须唤醒所有仍等待的 pthread')
  assert.deepEqual([...new Uint8Array(secondJob.bytes)], [1, 2, 3, 4])
  assert.equal(fetchCalls.length, 1, '不同 MessagePort 上的相同 Range 请求必须在唯一 Broker 内合并')
  if (cancelFirst) assert.equal(fetchCalls[0].signal.aborted, false)
}

function response(chunks, { status = 206, contentRange = 'bytes 0-3/8', etag = '"disc-v1"' } = {}) {
  let index = 0
  return {
    status,
    headers: { get(name) {
      return name === 'content-range' ? contentRange : name === 'etag' ? etag : null
    } },
    body: { getReader() {
      return {
        async read() {
          if (index >= chunks.length) return { done: true }
          return { done: false, value: Uint8Array.from(chunks[index++]) }
        },
        async cancel() {},
      }
    } },
  }
}

{
  const ok = await run(response([[1, 2], [3, 4]]))
  assert.deepEqual({ state: ok.state, bytes: ok.bytes }, { state: 1, bytes: [1, 2, 3, 4] })
  assert.equal(ok.timeoutMs, 90_000, 'Worker 必须使用 Range 调度器根据链路计算的时限')
  assert.equal(ok.headers['If-Match'], '"disc-v1"', '外链预读照常带 If-Match')
  const pinned = await run(response([[1, 2], [3, 4]]), { sendValidators: false })
  assert.equal(pinned.state, 1)
  assert.equal(pinned.headers['If-Match'], undefined, '钉了 romv 的预读不能带 If-Match（会绕过浏览器 HTTP 缓存）')
  assert.equal((await run(response([[1, 2, 3, 4]], { etag: '"disc-v2"' }), { sendValidators: false })).state, 2,
    '不发条件头时仍必须核对响应 ETag')
}
assert.equal((await run(response([[1, 2, 3, 4]], { contentRange: 'bytes 4-7/8' }))).state, 2,
  '错误的 Content-Range 不能进入共享缓存')
assert.equal((await run(response([[1, 2, 3, 4]], { etag: '"disc-v2"' }))).state, 2,
  '镜像换版不能把旧版分块交给正式读盘')
assert.equal((await run(response([[1, 2, 3]]))).state, 2,
  '短响应不能把未填满的共享缓冲当成有效块')
assert.equal((await run(response([[1, 2, 3, 4, 5]]))).state, 2,
  '超长响应必须在写入共享缓冲前被拦截')

await runSharedPair()
await runSharedPair(true)
await runPortPair()
await runPortPair(true)

console.log('✔ PSP Range Broker：SharedWorker / MessagePort 精确响应、跨 pthread 去重和独立取消均通过')
