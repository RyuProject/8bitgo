/**
 * MAME CHD 热区 / OPFS 续传回归。
 *
 * 这里不用真实 160MB 媒体盘：伪造一份可通过 v5 固定头校验的小 CHD，验证“悬停只取首段 →
 * OPFS 落片 → 点击正式下载零重复请求并清理临时片”。真正的 MAME 读盘仍由既有媒体回归覆盖。
 */
import assert from 'node:assert/strict'

class MemoryDirectory {
  kind = 'directory'
  files = new Map()
  directories = new Map()

  async getDirectoryHandle(name, options = {}) {
    if (!this.directories.has(name) && options.create) this.directories.set(name, new MemoryDirectory())
    const value = this.directories.get(name)
    if (!value) throw new Error('NotFoundError')
    return value
  }

  async getFileHandle(name, options = {}) {
    if (!this.files.has(name) && options.create) this.files.set(name, new Blob())
    if (!this.files.has(name)) throw new Error('NotFoundError')
    return {
      kind: 'file',
      getFile: async () => new File([this.files.get(name)], name),
      createWritable: async () => {
        let value = new Blob()
        return {
          write: async (next) => { value = typeof next === 'string' ? new Blob([next]) : next },
          close: async () => { this.files.set(name, value) },
          abort: async () => {},
        }
      },
    }
  }

  async removeEntry(name) {
    this.files.delete(name)
    this.directories.delete(name)
  }

  async *entries() {
    for (const [name, dir] of this.directories) yield [name, dir]
    for (const [name] of this.files) yield [name, await this.getFileHandle(name)]
  }
}

const root = new MemoryDirectory()
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { storage: { getDirectory: async () => root } },
})

const {
  CHUNK_BYTES,
  fetchBlobWithProgress,
  prewarmBlobChunks,
} = await import('../src/emulator/loadProgress.ts')
const {
  mameChdCacheKey,
  prewarmMameChd,
} = await import('../src/emulator/mameChdWarm.ts')
const { mameChdResumeStore } = await import('../src/emulator/downloadResume.ts')

const hex = (value) => Uint8Array.from(value.match(/../g).map((part) => Number.parseInt(part, 16)))
const dataSha1 = '1'.repeat(40)
const chdSha1 = '2'.repeat(40)
const logicalBytes = 123_456
const bytes = new Uint8Array(2048)
bytes.set(new TextEncoder().encode('MComprHD'), 0)
const view = new DataView(bytes.buffer)
view.setUint32(8, 124, false)
view.setUint32(12, 5, false)
view.setUint32(36, logicalBytes, false)
view.setUint32(56, 2448, false)
view.setUint32(60, 2448, false)
bytes.set(hex(dataSha1), 64)
bytes.set(hex(chdSha1), 84)
for (let index = 124; index < bytes.length; index += 1) bytes[index] = index % 251

const disk = {
  romset: 'taiko2',
  name: 'nm-002',
  url: 'https://assets.8bitgo.test/roms/arcade-media/nm-002.chd',
  chdSha1,
  dataSha1,
  storedBytes: bytes.byteLength,
  logicalBytes,
}

let calls = []
globalThis.fetch = async (_url, init = {}) => {
  const range = init.headers?.Range
  calls.push(range)
  const match = /^bytes=(\d+)-(\d+)$/.exec(range ?? '')
  assert.ok(match, '热区必须使用有界 Range 请求')
  const start = Number(match[1])
  const end = Math.min(Number(match[2]), bytes.byteLength - 1)
  return new Response(bytes.subarray(start, end + 1), {
    status: 206,
    headers: {
      'Content-Range': `bytes ${start}-${end}/${bytes.byteLength}`,
      'Content-Length': String(end - start + 1),
      'Content-Type': 'application/octet-stream',
    },
  })
}

await prewarmMameChd(disk)
assert.deepEqual(calls, [`bytes=0-${bytes.byteLength - 1}`], '小 CHD 的热区只能取它实际存在的首片')

const key = mameChdCacheKey(disk)
const warmed = await mameChdResumeStore.load(key, CHUNK_BYTES)
assert.equal(warmed?.total, bytes.byteLength, '热区必须带上已验证的完整长度')
assert.equal(warmed?.parts.get(0)?.size, bytes.byteLength, '首片必须实际持久化到 OPFS/回退仓库')

calls = []
const complete = await fetchBlobWithProgress(disk.url, {
  chunkBytes: CHUNK_BYTES,
  resumeKey: key,
  resumeStore: mameChdResumeStore,
})
assert.equal(calls.length, 0, '点击后的正式下载必须直接复用已预读片，不能重复请求首段')
assert.deepEqual(new Uint8Array(await complete.arrayBuffer()), bytes, 'OPFS 热区恢复后的字节不能错位')

const bad = { ...disk, url: `${disk.url}?bad=1`, chdSha1: '3'.repeat(40) }
await prewarmMameChd(bad)
assert.equal(await mameChdResumeStore.load(mameChdCacheKey(bad), CHUNK_BYTES), null, 'CHD 头身份不符时不能留下可被正式下载拼接的热区片')

const tinyParts = new Map()
const tinyStore = {
  load: async (key, chunkBytes) => {
    const part = tinyParts.get(key)
    return part ? { total: 4, chunkBytes, parts: new Map([[0, part]]) } : null
  },
  put: async (key, _total, _chunkBytes, _index, part) => { tinyParts.set(key, part); return true },
  clear: async (key) => { tinyParts.delete(key) },
}
let stalledFetchAborted = false
let warmFetches = 0
await prewarmBlobChunks('https://assets.8bitgo.test/roms/arcade-media/stall.chd', {
  resumeKey: 'mame-chd:stall-test',
  expectedBytes: 4,
  chunkBytes: 4,
  stallMs: 5,
  resumeStore: tinyStore,
  fetchImpl: (_url, init) => {
    warmFetches += 1
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => {
        stalledFetchAborted = true
        reject(new DOMException('stalled', 'AbortError'))
      }, { once: true })
    })
  },
})
assert.equal(stalledFetchAborted, true, '悬停预热必须在连续无字节时主动中止网络请求')
await prewarmBlobChunks('https://assets.8bitgo.test/roms/arcade-media/stall.chd', {
  resumeKey: 'mame-chd:stall-test',
  expectedBytes: 4,
  chunkBytes: 4,
  stallMs: 5,
  resumeStore: tinyStore,
  fetchImpl: async () => {
    warmFetches += 1
    return new Response(new Uint8Array([1, 2, 3, 4]), {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-3/4', 'Content-Length': '4' },
    })
  },
})
assert.equal(warmFetches, 2, '停滞任务结束后，同键再次预热必须能发起新请求')
assert.equal((await tinyStore.load('mame-chd:stall-test', 4))?.parts.get(0)?.size, 4, '重试后热区分片应正常落盘')

const clickParts = new Map()
const clickStore = {
  load: async (key, chunkBytes) => {
    const part = clickParts.get(key)
    return part ? { total: 4, chunkBytes, parts: new Map([[0, part]]) } : null
  },
  put: async (key, _total, _chunkBytes, _index, part) => { clickParts.set(key, part); return true },
  clear: async (key) => { clickParts.delete(key) },
}
let warmStarted
const warmStartedPromise = new Promise((resolve) => { warmStarted = resolve })
let warmCancelledByClick = false
const clickUrl = 'https://assets.8bitgo.test/roms/arcade-media/click.chd'
const clickKey = 'mame-chd:click-test'
const clickWarm = prewarmBlobChunks(clickUrl, {
  resumeKey: clickKey,
  expectedBytes: 4,
  chunkBytes: 4,
  resumeStore: clickStore,
  stallMs: 1000,
  fetchImpl: (_url, init) => new Promise((_resolve, reject) => {
    warmStarted()
    init.signal.addEventListener('abort', () => {
      warmCancelledByClick = true
      reject(new DOMException('cancelled by game start', 'AbortError'))
    }, { once: true })
  }),
})
await warmStartedPromise
let fullRangeRequests = 0
const clicked = await fetchBlobWithProgress(clickUrl, {
  chunkBytes: 4,
  resumeKey: clickKey,
  resumeStore: clickStore,
  stallMs: 100,
  fetchImpl: async (_url, init) => {
    fullRangeRequests += 1
    assert.equal(init.headers?.Range, 'bytes=0-3')
    return new Response(new Uint8Array([5, 6, 7, 8]), {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-3/4', 'Content-Length': '4' },
    })
  },
})
await clickWarm
assert.equal(warmCancelledByClick, true, '正式下载开始时必须取消仍在路上的悬停请求')
assert.equal(fullRangeRequests, 1, '正式下载只应发送自己的那一份 Range，不与悬停预读重叠')
assert.deepEqual(new Uint8Array(await clicked.arrayBuffer()), new Uint8Array([5, 6, 7, 8]))

console.log('✅ MAME CHD 热区预读、OPFS 续传与正式下载复用通过')
