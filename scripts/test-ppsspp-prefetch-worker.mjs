import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

const source = readFileSync(new URL('../vendor/ppsspp/range-prefetch-worker.js', import.meta.url), 'utf8')

async function run(response) {
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
    setTimeout,
    clearTimeout,
    fetch: async () => response,
    postMessage(message) {
      if (message.type === 'done') finish(message)
    },
  }
  context.self = context
  vm.runInNewContext(source, context, { filename: 'range-prefetch-worker.js' })
  context.self.onmessage({ data: {
    type: 'fetch', id: 7, key: 'disc\n0-3', url: 'https://assets.test/disc.chd',
    start: 0, end: 3, total: 8, ifMatch: '"disc-v1"', bytes, state,
  } })
  const message = await done
  assert.equal(message.id, 7)
  assert.equal(message.key, 'disc\n0-3')
  return { state: Atomics.load(new Int32Array(state), 0), bytes: [...new Uint8Array(bytes)] }
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

assert.deepEqual(await run(response([[1, 2], [3, 4]])), { state: 1, bytes: [1, 2, 3, 4] })
assert.equal((await run(response([[1, 2, 3, 4]], { contentRange: 'bytes 4-7/8' }))).state, 2,
  '错误的 Content-Range 不能进入共享缓存')
assert.equal((await run(response([[1, 2, 3, 4]], { etag: '"disc-v2"' }))).state, 2,
  '镜像换版不能把旧版分块交给正式读盘')
assert.equal((await run(response([[1, 2, 3]]))).state, 2,
  '短响应不能把未填满的共享缓冲当成有效块')
assert.equal((await run(response([[1, 2, 3, 4, 5]]))).state, 2,
  '超长响应必须在写入共享缓冲前被拦截')

console.log('✔ PSP 独立预读 Worker：206 范围、版本、短包和超长包校验均通过')
