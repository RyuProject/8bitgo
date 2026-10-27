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

console.log('✅ MAME CHD 热区预读、OPFS 续传与正式下载复用通过')
