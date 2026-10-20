import assert from 'node:assert/strict'
import { downloadPspDisc } from '../src/emulator/pspFullDownload.ts'

class MemoryDirectory {
  constructor() {
    this.files = new Map()
    this.directories = new Map()
  }
  async getDirectoryHandle(name, options = {}) {
    if (!this.directories.has(name) && options.create) this.directories.set(name, new MemoryDirectory())
    const value = this.directories.get(name)
    if (!value) throw new Error('NotFoundError')
    return value
  }
  async getFileHandle(name, options = {}) {
    if (!this.files.has(name) && options.create) this.files.set(name, new Uint8Array())
    if (!this.files.has(name)) throw new Error('NotFoundError')
    return {
      getFile: async () => new File([this.files.get(name)], name),
      createWritable: async () => {
        let bytes = new Uint8Array()
        return {
          write: async (input) => {
            if (typeof input === 'string') {
              bytes = new TextEncoder().encode(input)
              return
            }
            const data = input.data
            const next = new Uint8Array(Math.max(bytes.byteLength, input.position + data.byteLength))
            next.set(bytes)
            next.set(data, input.position)
            bytes = next
          },
          close: async () => { this.files.set(name, bytes) },
          abort: async () => {},
        }
      },
    }
  }
  async removeEntry(name) { this.files.delete(name) }
}

const root = new MemoryDirectory()
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { storage: { getDirectory: async () => root, estimate: async () => ({ quota: 100_000_000, usage: 0 }) } },
})
globalThis.location = { href: 'https://8bitgo.test/games/test' }
const size = 17 * 1024 * 1024
const discBytes = new Uint8Array(size)
for (let offset = 0; offset < size; offset += 4096) discBytes[offset] = offset / 4096 % 251
let requests = []
const successfulFetch = async (_url, init) => {
  const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range)
  assert.ok(match, '整包只能用有界 Range 请求')
  const start = Number(match[1])
  const end = Number(match[2])
  requests.push([start, end])
  assert.ok(end - start + 1 <= 8 * 1024 * 1024, '任何请求都不能把整张盘读进内存')
  return new Response(discBytes.subarray(start, end + 1), {
    status: 206,
    headers: { 'Content-Range': `bytes ${start}-${end}/${size}`, ETag: '"rom-v1"' },
  })
}
globalThis.fetch = successfulFetch

const progress = []
const url = 'https://assets.8bitgo.test/roms/psp/test.chd?romv=v1'
const file = await downloadPspDisc(url, 'test.chd', size, new AbortController().signal, (p) => progress.push(p))
assert.equal(file.name, 'test.chd', '本地盘必须保留 PSP 可识别的扩展名')
assert.equal(file.size, size)
assert.deepEqual(requests, [[0, 8 * 1024 * 1024 - 1], [8 * 1024 * 1024, 16 * 1024 * 1024 - 1], [16 * 1024 * 1024, size - 1]])
assert.equal(progress.at(-1).ratio, 1)
const sample = new Uint8Array(await file.slice(0, 4097).arrayBuffer())
assert.equal(sample[4096], 1, '随机写入后的本地镜像字节不能错位')

requests = []
const cached = await downloadPspDisc(url, 'test.chd', size, new AbortController().signal)
assert.equal(cached.size, size)
assert.equal(requests.length, 0, '同一版本的完整镜像必须直接复用浏览器本地副本')

requests = []
const unversionedUrl = 'https://assets.8bitgo.test/roms/psp/unversioned.chd'
await downloadPspDisc(unversionedUrl, 'unversioned.chd', size, new AbortController().signal)
requests = []
await downloadPspDisc(unversionedUrl, 'unversioned.chd', size, new AbortController().signal)
assert.equal(requests.length, 3, '没有版本键的外链不能仅凭旧文件大小复用缓存')

requests = []
const emptyVersionUrl = 'https://assets.8bitgo.test/roms/psp/empty-version.chd?romv='
await downloadPspDisc(emptyVersionUrl, 'empty-version.chd', size, new AbortController().signal)
requests = []
await downloadPspDisc(emptyVersionUrl, 'empty-version.chd', size, new AbortController().signal)
assert.equal(requests.length, 3, '空 romv 不能冒充内容版本并复用旧镜像')

globalThis.fetch = async (target, init) => {
  if (init.headers.Range.startsWith('bytes=0-')) return successfulFetch(target, init)
  const match = /^bytes=(\d+)-(\d+)$/.exec(init.headers.Range)
  return new Response(discBytes.subarray(Number(match[1]), Number(match[2]) + 1), {
    status: 206,
    headers: { 'Content-Range': `bytes ${match[1]}-${match[2]}/${size}`, ETag: '"rom-v2"' },
  })
}
await assert.rejects(downloadPspDisc(`${url}-changed`, 'changed.chd', size, new AbortController().signal), /版本发生变化/)

globalThis.fetch = async () => new Response('bad', { status: 200 })
await assert.rejects(downloadPspDisc(`${url}-bad`, 'bad.chd', size, new AbortController().signal), /响应无效/)
const cache = await root.getDirectoryHandle('8bitgo-psp-discs')
assert.equal([...cache.directories.values()].filter((dir) => dir.files.has('bad.chd')).length, 0,
  '错误的 Range 响应不能留下可误用的半张盘')

console.log('✔ PSP 整包下载：有界 Range、版本校验、本地复用和失败清理通过')
